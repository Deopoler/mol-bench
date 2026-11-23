/**
 * Deterministic DOM work-budget & CLS probe (v0.2):
 * - budget.dom_work_profile: minimum across 3 channels:
 *   1. dom_mutations_per_step (full <= 55, zero >= 300)
 *   2. layout_reads_per_step    (full <= 4,  zero >= 25)
 *   3. dom_nodes                (full <= 650, zero >= 1800)
 * - perf.cls: deterministic PerformanceObserver('layout-shift', buffered: true) CLS
 *
 * Uses Playwright trusted input, deterministic quiescence (virtual time flush +
 * double rAF), shadow-DOM/iframe-aware counting, and a single host adapter so
 * tamper-proofing refactors in WP-0b `host.js` require only updating the adapter.
 */

export const probeName = 'perf_dom';
export const aliases = ['budget.dom_work_profile', 'perf.cls'];

export const DEFAULT_DOM_BUDGET_THRESHOLDS = Object.freeze({
  dom_mutations_per_step: { full: 55, zero: 300 },
  layout_reads_per_step: { full: 4, zero: 25 },
  dom_nodes: { full: 650, zero: 1800 },
});

export const DEFAULT_MIN_STEPS = 3;

function lowerRamp(val, full, zero) {
  if (val <= full) return 1.0;
  if (val >= zero) return 0.0;
  return (zero - val) / (zero - full);
}

/**
 * Pure computation of `budget.dom_work_profile` from interceptor or self-instrumented stats.
 */
export function computeDomWorkProfile(stats = {}, thresholds = {}) {
  const th = {
    dom_mutations_per_step: {
      ...DEFAULT_DOM_BUDGET_THRESHOLDS.dom_mutations_per_step,
      ...(thresholds.dom_mutations_per_step || {}),
    },
    layout_reads_per_step: {
      ...DEFAULT_DOM_BUDGET_THRESHOLDS.layout_reads_per_step,
      ...(thresholds.layout_reads_per_step || {}),
    },
    dom_nodes: {
      ...DEFAULT_DOM_BUDGET_THRESHOLDS.dom_nodes,
      ...(thresholds.dom_nodes || {}),
    },
  };

  if (stats.steps !== undefined && Number(stats.steps) <= 0) {
    return {
      value: 0.0,
      dom_mutations_per_step: 0,
      layout_reads_per_step: 0,
      dom_nodes: Number(stats.dom_nodes ?? 0),
      channels: {
        dom_mutations_per_step: 0.0,
        layout_reads_per_step: 0.0,
        dom_nodes: 0.0,
      },
    };
  }

  const steps = Math.max(1, Number(stats.steps ?? 1));
  const mutationsPerStep =
    stats.dom_mutations_per_step !== undefined
      ? Number(stats.dom_mutations_per_step)
      : Number(stats.dom_mutations ?? 0) / steps;
  const layoutReadsPerStep =
    stats.layout_reads_per_step !== undefined
      ? Number(stats.layout_reads_per_step)
      : Number(stats.layout_reads ?? 0) / steps;
  const domNodes = Number(stats.dom_nodes ?? 0);

  const chMutations = lowerRamp(mutationsPerStep, th.dom_mutations_per_step.full, th.dom_mutations_per_step.zero);
  const chLayoutReads = lowerRamp(layoutReadsPerStep, th.layout_reads_per_step.full, th.layout_reads_per_step.zero);
  const chDomNodes = lowerRamp(domNodes, th.dom_nodes.full, th.dom_nodes.zero);

  return {
    value: Math.min(chMutations, chLayoutReads, chDomNodes),
    dom_mutations_per_step: mutationsPerStep,
    layout_reads_per_step: layoutReadsPerStep,
    dom_nodes: domNodes,
    channels: {
      dom_mutations_per_step: chMutations,
      layout_reads_per_step: chLayoutReads,
      dom_nodes: chDomNodes,
    },
  };
}

/**
 * Single adapter isolating all WP-0b host DOM counter access.
 * Supports both token/control-based reset APIs and monotonic snapshot diffs.
 */
export function createDomHostAdapter(pageHandle) {
  const { page } = pageHandle || {};

  async function readStats() {
    if (pageHandle && typeof pageHandle.getDomBudgetStats === 'function') {
      const viaHandle = await pageHandle.getDomBudgetStats().catch(() => null);
      if (viaHandle && typeof viaHandle === 'object' && viaHandle.ready === true) {
        return viaHandle;
      }
    }
    if (!page) return null;
    return page.evaluate(() => {
      const ctrl = window.__benchHostControl;
      if (ctrl && typeof ctrl.getDomBudgetStats === 'function') {
        const s = ctrl.getDomBudgetStats();
        return s && s.ready === true ? s : null;
      }
      if (window.__benchDomBudget && window.__benchDomBudget.ready === true) {
        return window.__benchDomBudget;
      }
      return null;
    }).catch(() => null);
  }

  async function resetMetrics(opts = { steps: 0, resetCls: false }) {
    if (pageHandle && typeof pageHandle.resetDomMetrics === 'function') {
      await pageHandle.resetDomMetrics(opts).catch(() => {});
      return;
    }
    if (!page) return;
    await page.evaluate((o) => {
      window.__benchHostControl?.resetDomMetrics?.(o);
    }, opts).catch(() => {});
  }

  async function markStep(count = 1) {
    if (pageHandle && typeof pageHandle.markDomStep === 'function') {
      await pageHandle.markDomStep(count).catch(() => {});
      return;
    }
    if (!page) return;
    await page.evaluate((n) => {
      window.__benchHostControl?.markDomStep?.(n);
    }, count).catch(() => {});
  }

  async function isAvailable() {
    const stats = await readStats();
    return Boolean(stats && stats.ready === true);
  }

  async function beginMeasurement() {
    await resetMetrics({ steps: 0, resetCls: false });
    const baseline = await readStats();
    return {
      dom_mutations: Number(baseline?.dom_mutations ?? 0),
      layout_reads: Number(baseline?.layout_reads ?? 0),
      cls: Number(baseline?.cls ?? 0),
    };
  }

  return {
    isAvailable,
    readStats,
    beginMeasurement,
    markStep,
  };
}

/**
 * Deterministic quiescence signal: await fonts/promises, step two virtual rAF ticks
 * via host.js `stepRafVirtual` (when available) without altering Blink's compositor
 * timestamp clock (preserving real `hadRecentInput`), then drain microtasks & paint.
 */
async function settleDeterministic(pageHandle, page, minTimerFlushMs = 0) {
  if (pageHandle && typeof pageHandle.installRafOverride === 'function' && typeof pageHandle.stepRafVirtual === 'function') {
    try {
      await pageHandle.installRafOverride();
      await pageHandle.stepRafVirtual(34, 60);
    } catch {
      // ignore if raf override unavailable
    } finally {
      if (typeof pageHandle.uninstallRafOverride === 'function') {
        await pageHandle.uninstallRafOverride().catch(() => {});
      }
    }
  }
  await page.evaluate(async (waitMs) => {
    try {
      if (document.fonts && document.fonts.ready) {
        await document.fonts.ready;
      }
    } catch {
      // ignore
    }
    if (waitMs > 0) {
      await new Promise((r) => setTimeout(r, waitMs));
    }
    await new Promise((resolve) => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          queueMicrotask(() => setTimeout(resolve, 0));
        });
      });
    });
  }, minTimerFlushMs);
}

async function countDeepDomNodes(page) {
  return page.evaluate(() => {
    let count = 0;
    const visitRoot = (root) => {
      if (!root) return;
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
      let node = root.nodeType === Node.ELEMENT_NODE ? root : walker.nextNode();
      while (node) {
        count += 1;
        if (node.shadowRoot) {
          visitRoot(node.shadowRoot);
        }
        if (node.tagName === 'IFRAME') {
          try {
            if (node.contentDocument?.documentElement) {
              visitRoot(node.contentDocument.documentElement);
            }
          } catch {
            // cross-origin iframe
          }
        }
        node = walker.nextNode();
      }
    };
    if (document.documentElement) {
      visitRoot(document.documentElement);
    }
    return count;
  }).catch(() => 0);
}

async function installSelfInstrumentation(page) {
  await page.evaluate(() => {
    if (window.__benchSelfDomInst) return;

    let clsTotal = 0;
    let nodeMutations = 0;
    let layoutReads = 0;
    const restores = [];
    const observedRoots = new WeakSet();

    let clsObs = null;
    try {
      clsObs = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (!entry.hadRecentInput) {
            clsTotal += entry.value || 0;
          }
        }
      });
      clsObs.observe({ type: 'layout-shift', buffered: true });
    } catch {
      clsObs = null;
    }

    const mutObs = new MutationObserver((records) => {
      for (const rec of records) {
        if (rec.type === 'childList') {
          nodeMutations += (rec.addedNodes?.length || 0) + (rec.removedNodes?.length || 0);
        } else if (rec.type === 'attributes' || rec.type === 'characterData') {
          nodeMutations += 1;
        }
      }
    });

    const observeTree = (root) => {
      if (!root || observedRoots.has(root)) return;
      observedRoots.add(root);
      try {
        mutObs.observe(root, {
          childList: true,
          subtree: true,
          attributes: true,
          characterData: true,
        });
      } catch {
        // ignore
      }
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
      let cur = walker.currentNode;
      while (cur) {
        if (cur.shadowRoot) observeTree(cur.shadowRoot);
        cur = walker.nextNode();
      }
    };

    observeTree(document.documentElement || document);

    const origAttachShadow = Element.prototype.attachShadow;
    if (typeof origAttachShadow === 'function') {
      Element.prototype.attachShadow = function wrappedAttachShadow(init) {
        const sr = origAttachShadow.call(this, init);
        observeTree(sr);
        return sr;
      };
      restores.push(() => {
        Element.prototype.attachShadow = origAttachShadow;
      });
    }

    const wrapMethod = (target, prop) => {
      if (!target || typeof target[prop] !== 'function') return;
      const orig = target[prop];
      target[prop] = function wrappedLayoutMethod(...a) {
        layoutReads += 1;
        return orig.apply(this, a);
      };
      restores.push(() => {
        target[prop] = orig;
      });
    };

    const wrapGetter = (proto, prop) => {
      if (!proto) return;
      const desc = Object.getOwnPropertyDescriptor(proto, prop);
      if (!desc || !desc.get || !desc.configurable) return;
      Object.defineProperty(proto, prop, {
        configurable: true,
        enumerable: desc.enumerable,
        get() {
          layoutReads += 1;
          return desc.get.call(this);
        },
        set: desc.set,
      });
      restores.push(() => Object.defineProperty(proto, prop, desc));
    };

    wrapMethod(window, 'getComputedStyle');
    wrapMethod(Element.prototype, 'getBoundingClientRect');
    wrapMethod(Element.prototype, 'getClientRects');
    wrapMethod(Document.prototype, 'elementFromPoint');
    if (typeof ShadowRoot !== 'undefined') wrapMethod(ShadowRoot.prototype, 'elementFromPoint');
    if (typeof Range !== 'undefined') {
      wrapMethod(Range.prototype, 'getBoundingClientRect');
      wrapMethod(Range.prototype, 'getClientRects');
    }
    if (typeof SVGGraphicsElement !== 'undefined') {
      wrapMethod(SVGGraphicsElement.prototype, 'getBBox');
    }

    for (const p of ['offsetWidth', 'offsetHeight', 'offsetTop', 'offsetLeft', 'offsetParent', 'innerText']) {
      wrapGetter(HTMLElement.prototype, p);
    }
    for (const p of ['clientWidth', 'clientHeight', 'clientLeft', 'clientTop', 'scrollWidth', 'scrollHeight', 'scrollLeft', 'scrollTop']) {
      wrapGetter(Element.prototype, p);
    }

    window.__benchSelfDomInst = {
      resetCounters() {
        mutObs.takeRecords();
        nodeMutations = 0;
        layoutReads = 0;
      },
      read({ teardown = false } = {}) {
        for (const rec of mutObs.takeRecords()) {
          if (rec.type === 'childList') {
            nodeMutations += (rec.addedNodes?.length || 0) + (rec.removedNodes?.length || 0);
          } else if (rec.type === 'attributes' || rec.type === 'characterData') {
            nodeMutations += 1;
          }
        }
        if (clsObs && typeof clsObs.takeRecords === 'function') {
          for (const entry of clsObs.takeRecords()) {
            if (!entry.hadRecentInput) {
              clsTotal += entry.value || 0;
            }
          }
        }
        const snap = {
          dom_mutations: nodeMutations,
          layout_reads: layoutReads,
          cls: clsTotal,
        };
        if (teardown) {
          mutObs.disconnect();
          clsObs?.disconnect();
          for (let i = restores.length - 1; i >= 0; i--) {
            restores[i]();
          }
          delete window.__benchSelfDomInst;
        }
        return snap;
      },
    };
  });
}

async function readAndTeardownSelfInstrumentation(page, teardown = false) {
  return page.evaluate((td) => {
    const inst = window.__benchSelfDomInst;
    if (!inst) return { dom_mutations: 0, layout_reads: 0, cls: 0 };
    return inst.read({ teardown: td });
  }, teardown).catch(() => ({ dom_mutations: 0, layout_reads: 0, cls: 0 }));
}

export async function runProbe(pageHandle, args = {}, invokedName = probeName) {
  // 1. Allow explicit synthetic/pre-collected interceptor payload via args.domStats
  if (args.domStats && typeof args.domStats === 'object') {
    const profile = computeDomWorkProfile(args.domStats, args.thresholds);
    const cls = Number(args.domStats.cls ?? 0);
    return formatResult(invokedName, profile, cls, { source: 'args.domStats', rawStats: args.domStats });
  }

  const { page } = pageHandle;
  const adapter = createDomHostAdapter(pageHandle);
  const hostAvailable = await adapter.isAvailable();

  // Only consume pre-existing host stats when explicitly instructed by caller/plan.mjs
  // (never trust page-mutable hostApi.stats.steps > 1 as a bypass).
  if (hostAvailable && args.useExistingHostStats === true) {
    const existingStats = await adapter.readStats();
    const profile = computeDomWorkProfile(existingStats, args.thresholds);
    const cls = Number(existingStats.cls ?? 0);
    return formatResult(invokedName, profile, cls, { source: 'host.js', rawStats: existingStats });
  }

  const minSteps = typeof args.minSteps === 'number' ? Math.max(0, args.minSteps) : DEFAULT_MIN_STEPS;
  const queries = Array.isArray(args.queries) && args.queries.length > 0 ? args.queries : ['a', 'au', 'aur', ''];

  if (!hostAvailable) {
    await installSelfInstrumentation(page);
  }

  let stepsExecuted = 0;
  let baseline = { dom_mutations: 0, layout_reads: 0, cls: 0 };
  let measured = null;

  try {
    // Allow initial load, fonts, and async load-phase shifts to settle deterministically
    await settleDeterministic(pageHandle, page, 30);

    if (hostAvailable) {
      baseline = await adapter.beginMeasurement();
    } else {
      await page.evaluate(() => window.__benchSelfDomInst?.resetCounters?.());
    }

    // Tag visible interactive controls once (non-mutating if none exist)
    const controls = await page.evaluate(() => {
      const isVisible = (el) => {
        if (!el) return false;
        const st = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        return !el.hidden && st.display !== 'none' && st.visibility !== 'hidden' && r.width > 0 && r.height > 0;
      };
      const searchEl = document.querySelector('[data-bench="search-input"]');
      const hasSearch = isVisible(searchEl);

      const filterBar = document.querySelector('[data-bench="filter-bar"]');
      const filterButtons = filterBar
        ? Array.from(filterBar.querySelectorAll('button, [role="button"]')).filter(isVisible).slice(0, 4)
        : [];
      filterButtons.forEach((btn, idx) => btn.setAttribute('data-bench-perf-btn', String(idx)));

      const sortEl = document.querySelector('[data-bench="sort-select"]');
      let sortOptions = [];
      let sortOrigVal = null;
      if (isVisible(sortEl) && sortEl.options && sortEl.options.length > 1) {
        sortOrigVal = sortEl.value;
        sortOptions = Array.from(sortEl.options)
          .slice(0, 3)
          .map((o) => o.value);
      }

      return {
        hasSearch,
        filterBtnCount: filterButtons.length,
        sortOptions,
        sortOrigVal,
      };
    });

    // Clear attribute-tagging mutation from baseline
    if (controls.filterBtnCount > 0) {
      if (hostAvailable) {
        baseline = await adapter.beginMeasurement();
      } else {
        await page.evaluate(() => window.__benchSelfDomInst?.resetCounters?.());
      }
    }

    // Execute scripted steps using Playwright trusted user input (click + keyboard so
    // isTrusted === true, 1 input event per step, and Blink marks user-driven shifts as hadRecentInput)
    if (controls.hasSearch) {
      const searchLoc = page.locator('[data-bench="search-input"]').first();
      for (const q of queries) {
        const val = String(q);
        await searchLoc.click({ timeout: 2000 });
        await page.keyboard.press('ControlOrMeta+A');
        if (val.length > 0) {
          await page.keyboard.insertText(val);
        } else if ((await searchLoc.inputValue().catch(() => '')) !== '') {
          await page.keyboard.press('Backspace');
        } else {
          await page.keyboard.press('Backspace');
        }
        await settleDeterministic(pageHandle, page, 0);
        stepsExecuted += 1;
        if (hostAvailable) await adapter.markStep(1);
      }
    }

    for (let i = 0; i < controls.filterBtnCount; i++) {
      await page.locator(`[data-bench-perf-btn="${i}"]`).first().click({ timeout: 2000 });
      await settleDeterministic(pageHandle, page, 0);
      stepsExecuted += 1;
      if (hostAvailable) await adapter.markStep(1);
    }

    if (controls.sortOptions.length > 1) {
      const sortLoc = page.locator('[data-bench="sort-select"]').first();
      for (const optVal of controls.sortOptions) {
        await sortLoc.selectOption(optVal, { timeout: 2000 });
        await settleDeterministic(pageHandle, page, 0);
        stepsExecuted += 1;
        if (hostAvailable) await adapter.markStep(1);
      }
    }

    // Final deterministic flush before reading counters & re-reading post-step CLS
    await settleDeterministic(pageHandle, page, 0);
    const deepDomNodes = await countDeepDomNodes(page);

    if (hostAvailable) {
      const after = await adapter.readStats();
      const domMutations = Math.max(0, Number(after?.dom_mutations ?? 0) - baseline.dom_mutations);
      const hostLayoutReads = Math.max(0, Number(after?.layout_reads ?? 0) - baseline.layout_reads);
      const effectiveSteps = Math.max(1, stepsExecuted);
      measured = {
        source: 'host.js',
        steps: stepsExecuted,
        stepsExecuted,
        dom_mutations: domMutations,
        dom_mutations_per_step: domMutations / effectiveSteps,
        layout_reads: hostLayoutReads,
        layout_reads_per_step: hostLayoutReads / effectiveSteps,
        dom_nodes: Math.max(Number(after?.dom_nodes ?? 0), deepDomNodes),
        cls: Number(after?.cls ?? baseline.cls ?? 0),
      };
    } else {
      const selfSnap = await readAndTeardownSelfInstrumentation(page, true);
      const effectiveSteps = Math.max(1, stepsExecuted);
      measured = {
        source: 'self-instrumented',
        steps: stepsExecuted,
        stepsExecuted,
        dom_mutations: Number(selfSnap.dom_mutations ?? 0),
        dom_mutations_per_step: Number(selfSnap.dom_mutations ?? 0) / effectiveSteps,
        layout_reads: Number(selfSnap.layout_reads ?? 0),
        layout_reads_per_step: Number(selfSnap.layout_reads ?? 0) / effectiveSteps,
        dom_nodes: deepDomNodes,
        cls: Number(selfSnap.cls ?? 0),
      };
    }

    // Cleanup temporary test attributes & sort restoration after measurement snapshot
    if (controls.sortOrigVal !== null) {
      await page.locator('[data-bench="sort-select"]').first().selectOption(controls.sortOrigVal, { timeout: 1000 }).catch(() => {});
    }
    await page.evaluate(() => {
      for (const el of document.querySelectorAll('[data-bench-perf-btn]')) {
        el.removeAttribute('data-bench-perf-btn');
      }
    }).catch(() => {});
  } finally {
    if (!hostAvailable) {
      await readAndTeardownSelfInstrumentation(page, true).catch(() => {});
    }
  }

  if (stepsExecuted === 0 || stepsExecuted < minSteps) {
    const failedProfile = {
      value: 0.0,
      dom_mutations_per_step: measured?.dom_mutations_per_step ?? 0,
      layout_reads_per_step: measured?.layout_reads_per_step ?? 0,
      dom_nodes: measured?.dom_nodes ?? 0,
      channels: {
        dom_mutations_per_step: 0.0,
        layout_reads_per_step: 0.0,
        dom_nodes: 0.0,
      },
    };
    return formatResult(invokedName, failedProfile, measured?.cls ?? 0, {
      source: measured?.source || (hostAvailable ? 'host.js' : 'self-instrumented'),
      failed: true,
      reason: stepsExecuted === 0 ? 'no_interactive_controls' : 'insufficient_interactive_steps',
      stepsExecuted,
      minSteps,
      rawStats: measured,
    });
  }

  const profile = computeDomWorkProfile(measured, args.thresholds);
  return formatResult(invokedName, profile, measured.cls, {
    source: measured.source,
    stepsExecuted,
    minSteps,
    rawStats: measured,
  });
}

function formatResult(invokedName, profile, cls, meta) {
  const details = {
    ...meta,
    dom_mutations_per_step: Number(profile.dom_mutations_per_step.toFixed(3)),
    layout_reads_per_step: Number(profile.layout_reads_per_step.toFixed(3)),
    dom_nodes: profile.dom_nodes,
    channels: profile.channels,
    cls: Number(cls.toFixed(6)),
  };

  if (invokedName === 'perf.cls') {
    return { 'perf.cls': cls, details };
  }
  if (invokedName === 'budget.dom_work_profile') {
    return { 'budget.dom_work_profile': profile.value, details };
  }
  return {
    'budget.dom_work_profile': profile.value,
    'perf.cls': cls,
    details,
  };
}
