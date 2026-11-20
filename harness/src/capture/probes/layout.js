/**
 * DOM layout probes:
 * - layout.overflow_count
 * - layout.tap_targets
 * - layout.bboxes (helper for Renovation layout.shift_px)
 */

export async function probeLayout(page, args = {}) {
  return page.evaluate((opts) => {
    const innerW = window.innerWidth;
    const innerH = window.innerHeight;
    const scrollingEl = document.scrollingElement || document.documentElement;
    const scrollH = Math.max(scrollingEl.scrollHeight, innerH);
    const savedScrollX = window.scrollX;
    const savedScrollY = window.scrollY;

    function isStyleVisible(el) {
      const style = getComputedStyle(el);
      if (style.display === 'none') return false;
      if (style.visibility === 'hidden' || style.visibility === 'collapse') return false;
      if (parseFloat(style.opacity) <= 0) return false;
      return true;
    }

    function intersectsViewport(rect) {
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        rect.bottom > 0 &&
        rect.top < innerH &&
        rect.right > 0 &&
        rect.left < innerW
      );
    }

    function hasClippingOverflowXAncestor(el) {
      let cur = el.parentElement;
      while (cur && cur !== document.documentElement && cur !== document.body) {
        const ox = getComputedStyle(cur).overflowX;
        if (ox === 'auto' || ox === 'scroll' || ox === 'hidden' || ox === 'clip') {
          return true;
        }
        cur = cur.parentElement;
      }
      return false;
    }

    // Collect all visible elements across viewport-height scroll steps
    const overflowElements = new Set();
    const tapTargetElements = new Set();
    const interactiveSelector = 'a, button, input, select, [role="button"], [tabindex="0"]';

    const steps = [];
    for (let y = 0; y < scrollH; y += Math.max(1, innerH)) {
      steps.push(y);
    }
    if (steps.length === 0) steps.push(0);

    for (const y of steps) {
      window.scrollTo(0, y);
      const all = document.body ? document.body.querySelectorAll('*') : [];
      for (let i = 0; i < all.length; i++) {
        const el = all[i];
        if (!isStyleVisible(el)) continue;
        const rect = el.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) continue;
        // Vertically intersects current viewport slice (allow overflowing horizontally)
        if (rect.bottom <= 0 || rect.top >= innerH) continue;

        if (rect.right > innerW + 1 && !hasClippingOverflowXAncestor(el)) {
          overflowElements.add(el);
        }
      }

      const interactives = document.querySelectorAll(interactiveSelector);
      for (let i = 0; i < interactives.length; i++) {
        const el = interactives[i];
        if (!isStyleVisible(el)) continue;
        const rect = el.getBoundingClientRect();
        if (intersectsViewport(rect)) {
          tapTargetElements.add(el);
        }
      }
    }

    window.scrollTo(savedScrollX, savedScrollY);

    // layout.overflow_count
    const pageOverflows = scrollingEl.scrollWidth > innerW ? 1 : 0;
    const overflowCount = pageOverflows + overflowElements.size;

    // layout.tap_targets
    // Compute document-space rects for all visible interactive targets
    const targets = [];
    for (const el of tapTargetElements) {
      const r = el.getBoundingClientRect();
      const left = r.left + window.scrollX;
      const top = r.top + window.scrollY;
      targets.push({
        el,
        left,
        top,
        right: left + r.width,
        bottom: top + r.height,
        width: r.width,
        height: r.height,
        cx: left + r.width / 2,
        cy: top + r.height / 2,
      });
    }

    function rectsOverlap(a, b) {
      return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
    }

    let passingTargets = 0;
    for (let i = 0; i < targets.length; i++) {
      const t = targets[i];
      if (t.width >= 44 && t.height >= 44) {
        passingTargets += 1;
        continue;
      }
      const box44 = {
        left: t.cx - 22,
        right: t.cx + 22,
        top: t.cy - 22,
        bottom: t.cy + 22,
      };
      let overlapsAnother = false;
      for (let j = 0; j < targets.length; j++) {
        if (i === j) continue;
        if (rectsOverlap(box44, targets[j])) {
          overlapsAnother = true;
          break;
        }
      }
      if (!overlapsAnother) {
        passingTargets += 1;
      }
    }

    const tapTargetsFrac = targets.length > 0 ? passingTargets / targets.length : 1;

    // Optional protected element bboxes (for layout.shift_px)
    const bboxes = {};
    if (Array.isArray(opts.selectors)) {
      for (const sel of opts.selectors) {
        const els = document.querySelectorAll(sel);
        bboxes[sel] = Array.from(els).map((el) => {
          const r = el.getBoundingClientRect();
          return {
            x: r.left + window.scrollX,
            y: r.top + window.scrollY,
            width: r.width,
            height: r.height,
          };
        });
      }
    }

    return {
      'layout.overflow_count': overflowCount,
      'layout.tap_targets': tapTargetsFrac,
      details: {
        page_scroll_overflow: pageOverflows === 1,
        overflow_elements: overflowElements.size,
        tap_targets_passed: passingTargets,
        tap_targets_total: targets.length,
        bboxes,
      },
    };
  }, args);
}
