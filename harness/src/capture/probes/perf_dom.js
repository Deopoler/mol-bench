/**
 * Deterministic DOM work-budget & CLS probe (v0.2):
 * - budget.dom_work_profile: minimum across 3 channels:
 *   1. dom_mutations_per_step (full <= 55, zero >= 300)
 *   2. layout_reads_per_step    (full <= 4,  zero >= 25)
 *   3. dom_nodes                (full <= 650, zero >= 1800)
 * - perf.cls: deterministic PerformanceObserver('layout-shift', buffered: true) CLS
 */

export const probeName = 'perf_dom';
export const aliases = ['budget.dom_work_profile', 'perf.cls'];

export const DEFAULT_DOM_BUDGET_THRESHOLDS = Object.freeze({
  dom_mutations_per_step: { full: 55, zero: 300 },
  layout_reads_per_step: { full: 4, zero: 25 },
  dom_nodes: { full: 650, zero: 1800 },
});

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

export async function runProbe(pageHandle, args = {}, invokedName = probeName) {
  // 1. Allow explicit synthetic/pre-collected interceptor payload via args.domStats
  if (args.domStats && typeof args.domStats === 'object') {
    const profile = computeDomWorkProfile(args.domStats, args.thresholds);
    const cls = Number(args.domStats.cls ?? 0);
    return formatResult(invokedName, profile, cls, { source: 'args.domStats', rawStats: args.domStats });
  }

  const { page } = pageHandle;

  // 2. Check if WP-0b host.js already collected DOM interceptor stats
  const hostStats = await page.evaluate(() => {
    const fn = window.__benchHostControl?.getDomBudgetStats;
    if (typeof fn === 'function') return fn();
    if (window.__benchDomBudget && typeof window.__benchDomBudget === 'object') {
      return window.__benchDomBudget;
    }
    return null;
  });

  if (hostStats && typeof hostStats === 'object' && hostStats.ready === true) {
    const profile = computeDomWorkProfile(hostStats, args.thresholds);
    const cls = Number(hostStats.cls ?? 0);
    return formatResult(invokedName, profile, cls, { source: 'host.js', rawStats: hostStats });
  }

  // 3. Self-instrument in-page: MutationObserver + forced-layout property hooks + CLS observer
  const measured = await page.evaluate(async (opts) => {
    let clsTotal = 0;
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

    let nodeMutations = 0;
    const mutObs = new MutationObserver((records) => {
      for (const rec of records) {
        nodeMutations += (rec.addedNodes?.length || 0) + (rec.removedNodes?.length || 0);
      }
    });
    if (document.body) {
      mutObs.observe(document.body, { childList: true, subtree: true });
    }

    // Wrap forced-layout reads cleanly and restore in finally
    let layoutReads = 0;
    const restores = [];

    const origGetComputedStyle = window.getComputedStyle;
    window.getComputedStyle = function wrappedGetComputedStyle(...a) {
      layoutReads += 1;
      return origGetComputedStyle.apply(this, a);
    };
    restores.push(() => {
      window.getComputedStyle = origGetComputedStyle;
    });

    const origGetBcr = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function wrappedGetBcr() {
      layoutReads += 1;
      return origGetBcr.call(this);
    };
    restores.push(() => {
      Element.prototype.getBoundingClientRect = origGetBcr;
    });

    const wrapGetter = (proto, prop) => {
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

    for (const p of ['offsetWidth', 'offsetHeight', 'offsetTop', 'offsetLeft']) {
      wrapGetter(HTMLElement.prototype, p);
    }
    for (const p of ['clientWidth', 'clientHeight', 'scrollWidth', 'scrollHeight']) {
      wrapGetter(Element.prototype, p);
    }

    let stepsExecuted = 0;
    try {
      // Allow initial load / font-ready / async layout shifts to settle and record load-phase CLS
      // before running synthetic dispatchEvent stress steps (synthetic DOM events do not set hadRecentInput).
      await new Promise((r) => setTimeout(r, 40));
      if (clsObs && typeof clsObs.takeRecords === 'function') {
        for (const entry of clsObs.takeRecords()) {
          if (!entry.hadRecentInput) clsTotal += entry.value || 0;
        }
        clsObs.disconnect();
        clsObs = null;
      }

      // Execute deterministic filter/sort steps if interactive controls exist
      const searchInput = document.querySelector('[data-bench="search-input"]');
      const filterBar = document.querySelector('[data-bench="filter-bar"]');
      const sortSelect = document.querySelector('[data-bench="sort-select"]');
      const filterButtons = filterBar
        ? Array.from(filterBar.querySelectorAll('button, [role="button"]'))
        : [];

      const queries = opts.queries || ['a', 'au', 'aur', ''];
      if (searchInput) {
        for (const q of queries) {
          searchInput.value = q;
          searchInput.dispatchEvent(new Event('input', { bubbles: true }));
          await new Promise((r) => setTimeout(r, 10));
          stepsExecuted += 1;
        }
      }

      for (const btn of filterButtons.slice(0, 4)) {
        btn.click();
        await new Promise((r) => setTimeout(r, 10));
        stepsExecuted += 1;
      }

      if (sortSelect && sortSelect.options?.length > 1) {
        const origVal = sortSelect.value;
        for (let i = 0; i < Math.min(3, sortSelect.options.length); i++) {
          sortSelect.value = sortSelect.options[i].value;
          sortSelect.dispatchEvent(new Event('change', { bubbles: true }));
          await new Promise((r) => setTimeout(r, 10));
          stepsExecuted += 1;
        }
        sortSelect.value = origVal;
        sortSelect.dispatchEvent(new Event('change', { bubbles: true }));
      }

      // Allow any microtasks/MutationObserver callbacks to flush
      await new Promise((r) => setTimeout(r, 20));
      for (const rec of mutObs.takeRecords()) {
        nodeMutations += (rec.addedNodes?.length || 0) + (rec.removedNodes?.length || 0);
      }
    } finally {
      mutObs.disconnect();
      clsObs?.disconnect();
      for (let i = restores.length - 1; i >= 0; i--) {
        restores[i]();
      }
    }

    const domNodes = document.querySelectorAll('*').length;
    const steps = Math.max(1, stepsExecuted);
    return {
      steps,
      stepsExecuted,
      dom_mutations: nodeMutations,
      dom_mutations_per_step: nodeMutations / steps,
      layout_reads: layoutReads,
      layout_reads_per_step: layoutReads / steps,
      dom_nodes: domNodes,
      cls: clsTotal,
    };
  }, { queries: args.queries || null });

  const profile = computeDomWorkProfile(measured, args.thresholds);
  return formatResult(invokedName, profile, measured.cls, { source: 'self-instrumented', rawStats: measured });
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
