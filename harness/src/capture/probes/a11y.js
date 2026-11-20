import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { decodePng, wcagContrast } from './shared.js';

const require = createRequire(import.meta.url);
let cachedAxeSource = null;

async function getAxeSource() {
  if (!cachedAxeSource) {
    const axePath = require.resolve('axe-core/axe.min.js');
    cachedAxeSource = await fs.readFile(axePath, 'utf8');
  }
  return cachedAxeSource;
}

/**
 * Run axe-core in-page and return serious+critical violation count and color-contrast count.
 */
export async function probeAxe(page) {
  const hasAxe = await page.evaluate(() => Boolean(window.axe && typeof window.axe.run === 'function'));
  if (!hasAxe) {
    const src = await getAxeSource();
    await page.addScriptTag({ content: src });
  }

  const results = await page.evaluate(async () => {
    const res = await window.axe.run(document, {
      resultTypes: ['violations'],
    });
    const seriousOrCritical = res.violations.filter(
      (v) => v.impact === 'serious' || v.impact === 'critical',
    );
    const colorContrast = res.violations.filter((v) => v.id === 'color-contrast');
    return {
      seriousOrCriticalCount: seriousOrCritical.length,
      colorContrastCount: colorContrast.length,
      violations: seriousOrCritical.map((v) => ({
        id: v.id,
        impact: v.impact,
        description: v.description,
        nodes: v.nodes.length,
      })),
    };
  });

  return {
    'a11y.axe_violations': results.seriousOrCriticalCount,
    colorContrastViolations: results.colorContrastCount,
    violations: results.violations,
  };
}

const DEFAULT_REQUIRED_SELECTOR =
  '[data-bench="room-card"] a, [data-bench="room-card"][tabindex], [data-bench="theme-toggle"], [data-bench="lang-toggle"], [data-bench="footer"] a';

/**
 * Measure a11y.keyboard_reach:
 * Tab from document start for up to 200 stops; measure fraction of required targets
 * that receive focus (and for navigable targets, verify Enter activates them).
 */
export async function probeKeyboardReach(page, args = {}) {
  const selector = args.requiredSelector || DEFAULT_REQUIRED_SELECTOR;
  const maxStops = Number(args.maxStops || 200);

  // Identify required target elements by tagging them temporarily with a unique data attribute
  const targetMeta = await page.evaluate((sel) => {
    let nodes = Array.from(document.querySelectorAll(sel));
    // Fallback to visible focusable interactive elements if no room-specific selectors match
    if (nodes.length === 0) {
      nodes = Array.from(document.querySelectorAll('a[href], button, [role="button"], [tabindex="0"]'));
    }
    const visible = [];
    for (const el of nodes) {
      const st = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      if (st.display === 'none' || st.visibility === 'hidden' || parseFloat(st.opacity) <= 0) continue;
      if (r.width <= 0 || r.height <= 0) continue;
      // Avoid double-counting a card and its inner link if both matched
      if (visible.some((v) => v.contains(el) || el.contains(v))) continue;
      visible.push(el);
    }
    visible.forEach((el, idx) => {
      el.setAttribute('data-bench-kb-id', String(idx));
    });
    return visible.map((el, idx) => ({
      id: String(idx),
      tag: el.tagName.toLowerCase(),
      href: el.getAttribute('href') || null,
      isRoomCard: Boolean(el.closest('[data-bench="room-card"]')),
    }));
  }, selector);

  if (targetMeta.length === 0) {
    return {
      'a11y.keyboard_reach': 1,
      details: { reached: 0, total: 0, stops: 0 },
    };
  }

  // Start focus at document start (blur active element & focus body)
  await page.evaluate(() => {
    if (document.activeElement && typeof document.activeElement.blur === 'function') {
      document.activeElement.blur();
    }
    window.scrollTo(0, 0);
  });

  const reachedIds = new Set();
  const seenSequence = [];
  let stopsUsed = 0;

  for (let i = 0; i < maxStops; i++) {
    await page.keyboard.press('Tab');
    stopsUsed += 1;
    const focused = await page.evaluate(() => {
      const active = document.activeElement;
      if (!active || active === document.body || active === document.documentElement) {
        return { id: null, isBody: true };
      }
      const ownId = active.getAttribute('data-bench-kb-id');
      if (ownId !== null) return { id: ownId, isBody: false };
      const ancestor = active.closest('[data-bench-kb-id]');
      if (ancestor) return { id: ancestor.getAttribute('data-bench-kb-id'), isBody: false };
      return { id: null, isBody: false };
    });

    if (focused.id !== null) {
      reachedIds.add(focused.id);
    }
    seenSequence.push(focused.id);
    if (reachedIds.size === targetMeta.length) {
      break;
    }
  }

  // Verify pressing Enter on reached navigable targets (hash links / room cards) navigates properly
  let validCount = 0;
  for (const t of targetMeta) {
    if (!reachedIds.has(t.id)) continue;
    if (t.isRoomCard && t.href && t.href.startsWith('#')) {
      const beforeUrl = page.url();
      await page.evaluate((id) => {
        const el = document.querySelector(`[data-bench-kb-id="${id}"]`);
        if (el) el.focus();
      }, t.id);
      await page.keyboard.press('Enter');
      await page.waitForTimeout(50);
      const afterUrl = page.url();
      const expectedHash = t.href;
      const navigated = afterUrl.includes(expectedHash) && afterUrl !== beforeUrl;
      if (navigated) {
        validCount += 1;
        await page.goBack().catch(() => {});
        await page.waitForTimeout(50);
      } else {
        // Still check if href was already active
        if (beforeUrl.includes(expectedHash)) validCount += 1;
      }
    } else {
      validCount += 1;
    }
  }

  // Cleanup temporary attributes
  await page.evaluate(() => {
    for (const el of document.querySelectorAll('[data-bench-kb-id]')) {
      el.removeAttribute('data-bench-kb-id');
    }
  });

  return {
    'a11y.keyboard_reach': validCount / targetMeta.length,
    details: {
      reached: reachedIds.size,
      validated: validCount,
      total: targetMeta.length,
      stops: stopsUsed,
    },
  };
}

/**
 * Measure a11y.focus_visible:
 * For each required target, screenshot bbox + 8 px when focused vs blurred.
 * Passes if changed pixels >= 2 * bbox perimeter and changed pixels have WCAG contrast >= 3:1
 * against their unfocused values.
 */
export async function probeFocusVisible(page, args = {}) {
  const selector = args.requiredSelector || DEFAULT_REQUIRED_SELECTOR;

  const targetCount = await page.evaluate((sel) => {
    let nodes = Array.from(document.querySelectorAll(sel));
    if (nodes.length === 0) {
      nodes = Array.from(document.querySelectorAll('a[href], button, [role="button"], [tabindex="0"]'));
    }
    const visible = [];
    for (const el of nodes) {
      const st = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      if (st.display === 'none' || st.visibility === 'hidden' || parseFloat(st.opacity) <= 0) continue;
      if (r.width <= 0 || r.height <= 0) continue;
      if (visible.some((v) => v.contains(el) || el.contains(v))) continue;
      visible.push(el);
    }
    visible.forEach((el, idx) => el.setAttribute('data-bench-fv-id', String(idx)));
    return visible.length;
  }, selector);

  if (targetCount === 0) {
    return {
      'a11y.focus_visible': 1,
      details: { passed: 0, total: 0, per_target: [] },
    };
  }

  const vp = page.viewportSize() || { width: 1440, height: 900 };
  let passed = 0;
  const perTarget = [];

  for (let i = 0; i < targetCount; i++) {
    // Scroll into view & blur
    const box = await page.evaluate((idx) => {
      const el = document.querySelector(`[data-bench-fv-id="${idx}"]`);
      if (!el) return null;
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      if (document.activeElement && typeof document.activeElement.blur === 'function') {
        document.activeElement.blur();
      }
      const r = el.getBoundingClientRect();
      return { x: r.left, y: r.top, width: r.width, height: r.height };
    }, i);

    if (!box || box.width <= 0 || box.height <= 0) continue;

    const pad = 8;
    const clipX = Math.max(0, Math.floor(box.x - pad));
    const clipY = Math.max(0, Math.floor(box.y - pad));
    const clipW = Math.min(vp.width - clipX, Math.ceil(box.width + pad * 2));
    const clipH = Math.min(vp.height - clipY, Math.ceil(box.height + pad * 2));
    if (clipW <= 0 || clipH <= 0) continue;

    const clip = { x: clipX, y: clipY, width: clipW, height: clipH };
    const blurredBuf = await page.screenshot({ type: 'png', clip });

    // Trigger keyboard focus (focus-visible matches when triggered via keyboard; use Tab or focus({ focusVisible: true }))
    await page.evaluate((idx) => {
      const el = document.querySelector(`[data-bench-fv-id="${idx}"]`);
      if (el) {
        try {
          el.focus({ preventScroll: true, focusVisible: true });
        } catch {
          el.focus({ preventScroll: true });
        }
      }
    }, i);
    // Wait one rAF for repaint (with fallback timeout in case rAF is paused/overridden)
    await page.evaluate(() => new Promise((resolve) => {
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      const t = setTimeout(finish, 150);
      requestAnimationFrame(() => requestAnimationFrame(() => {
        clearTimeout(t);
        finish();
      }));
    }));

    const focusedBuf = await page.screenshot({ type: 'png', clip });

    const a = decodePng(blurredBuf);
    const b = decodePng(focusedBuf);
    let changedCount = 0;
    let contrastPassCount = 0;

    if (a.width === b.width && a.height === b.height) {
      for (let p = 0; p < a.data.length; p += 4) {
        const dr = Math.abs(a.data[p] - b.data[p]);
        const dg = Math.abs(a.data[p + 1] - b.data[p + 1]);
        const db = Math.abs(a.data[p + 2] - b.data[p + 2]);
        if (dr + dg + db > 6) {
          changedCount += 1;
          const cr = wcagContrast(
            a.data[p], a.data[p + 1], a.data[p + 2],
            b.data[p], b.data[p + 1], b.data[p + 2],
          );
          if (cr >= 3.0) {
            contrastPassCount += 1;
          }
        }
      }
    }

    const perimeter = 2 * (box.width + box.height);
    const requiredPixels = 2 * perimeter;
    const ok = changedCount >= requiredPixels && contrastPassCount >= requiredPixels;
    if (ok) passed += 1;
    perTarget.push({
      index: i,
      pass: ok,
      changedCount,
      contrastPassCount,
      requiredPixels: Math.round(requiredPixels),
    });
  }

  await page.evaluate(() => {
    for (const el of document.querySelectorAll('[data-bench-fv-id]')) {
      el.removeAttribute('data-bench-fv-id');
    }
    if (document.activeElement && typeof document.activeElement.blur === 'function') {
      document.activeElement.blur();
    }
  });

  return {
    'a11y.focus_visible': passed / targetCount,
    details: { passed, total: targetCount, per_target: perTarget },
  };
}

export async function probeA11y(page, args = {}) {
  const axe = await probeAxe(page);
  const kb = await probeKeyboardReach(page, args);
  const fv = await probeFocusVisible(page, args);
  return {
    'a11y.axe_violations': axe['a11y.axe_violations'],
    'a11y.keyboard_reach': kb['a11y.keyboard_reach'],
    'a11y.focus_visible': fv['a11y.focus_visible'],
    details: {
      axe: axe.violations,
      colorContrastViolations: axe.colorContrastViolations,
      keyboard_reach: kb.details,
      focus_visible: fv.details,
    },
  };
}
