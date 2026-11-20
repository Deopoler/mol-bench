/**
 * DOM spacing & alignment probes:
 * - space.grid4_frac
 * - align.column_count
 */

export async function probeSpaceAndAlign(page, args = {}) {
  return page.evaluate(() => {
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

    function isBlockLike(style) {
      const d = style.display;
      return (
        d === 'block' ||
        d === 'flex' ||
        d === 'grid' ||
        d === 'list-item' ||
        d === 'table' ||
        d === 'flow-root'
      );
    }

    function hasDirectText(el) {
      for (let n = el.firstChild; n; n = n.nextSibling) {
        if (n.nodeType === 3 && n.nodeValue && n.nodeValue.trim().length > 0) {
          return true;
        }
      }
      return false;
    }

    const visibleElements = new Set();
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
        if (intersectsViewport(rect)) {
          visibleElements.add(el);
        }
      }
    }

    window.scrollTo(0, 0);

    // ---- space.grid4_frac ----
    const spacingSamples = [];

    // (a) Vertical gaps between consecutive visible block siblings
    const visitedParents = new Set();
    for (const el of visibleElements) {
      const parent = el.parentElement;
      if (!parent || visitedParents.has(parent)) continue;
      visitedParents.add(parent);

      const blockChildren = [];
      for (let c = parent.firstElementChild; c; c = c.nextElementSibling) {
        if (!visibleElements.has(c)) continue;
        const st = getComputedStyle(c);
        if (!isBlockLike(st)) continue;
        if (st.position === 'absolute' || st.position === 'fixed') continue;
        const r = c.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) continue;
        blockChildren.push(r);
      }

      for (let i = 0; i < blockChildren.length - 1; i++) {
        const gap = blockChildren[i + 1].top - blockChildren[i].bottom;
        if (gap > 0.5) {
          spacingSamples.push(gap);
        }
      }
    }

    // (b) Non-zero paddings and gap values of visible containers
    for (const el of visibleElements) {
      const st = getComputedStyle(el);
      const isContainer = el.children.length > 0 || isBlockLike(st);
      if (!isContainer) continue;

      for (const prop of ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'rowGap', 'columnGap']) {
        const val = parseFloat(st[prop]);
        if (Number.isFinite(val) && val > 0.5) {
          spacingSamples.push(val);
        }
      }
    }

    let onGrid = 0;
    for (const v of spacingSamples) {
      const nearest = Math.round(v / 4) * 4;
      if (Math.abs(v - nearest) <= 0.5 + 1e-6) {
        onGrid += 1;
      }
    }
    const grid4Frac = spacingSamples.length > 0 ? onGrid / spacingSamples.length : 1;

    // ---- align.column_count ----
    // Left edges of visible text-block boxes, merged when within 2 px
    const leftEdges = [];
    for (const el of visibleElements) {
      const st = getComputedStyle(el);
      if (!isBlockLike(st)) continue;
      if (!hasDirectText(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      leftEdges.push(r.left + window.scrollX);
    }

    leftEdges.sort((a, b) => a - b);
    const clusters = [];
    for (const edge of leftEdges) {
      if (clusters.length === 0) {
        clusters.push([edge]);
      } else {
        const lastCluster = clusters[clusters.length - 1];
        const anchor = lastCluster[0];
        if (edge - anchor <= 2 + 1e-6) {
          lastCluster.push(edge);
        } else {
          clusters.push([edge]);
        }
      }
    }

    window.scrollTo(savedScrollX, savedScrollY);

    return {
      'space.grid4_frac': grid4Frac,
      'align.column_count': clusters.length,
      details: {
        spacing_samples: spacingSamples.length,
        spacing_on_grid4: onGrid,
        column_edges_px: clusters.map((c) => Number((c.reduce((a, b) => a + b, 0) / c.length).toFixed(2))),
      },
    };
  }, args);
}
