/**
 * DOM element overlap probe (v0.2):
 * - layout.overlap_count: Pairwise AABB intersection check among visible sibling
 *   block/interactive elements (> 2 px^2, excluding closed overlays).
 */

export const probeName = 'overlap';
export const aliases = ['layout.overlap_count'];

export async function runProbe(pageHandle, args = {}) {
  const { page } = pageHandle;
  const minArea = typeof args.minOverlapArea === 'number' ? args.minOverlapArea : 2.0;
  const zoom200 = Boolean(args.zoom200);

  if (zoom200) {
    await page.evaluate(() => {
      if (!document.getElementById('__bench_zoom200_style')) {
        const st = document.createElement('style');
        st.id = '__bench_zoom200_style';
        st.textContent = 'html { font-size: 32px !important; }';
        document.head.appendChild(st);
      }
    });
  }

  try {
    return await page.evaluate((minPx2) => {
      const savedX = window.scrollX;
      const savedY = window.scrollY;
      window.scrollTo(0, 0);

      const BLOCK_DISPLAYS = new Set([
        'block',
        'flex',
        'grid',
        'list-item',
        'table',
        'table-row',
        'table-cell',
        'flow-root',
        'inline-block',
        'inline-flex',
        'inline-grid',
      ]);

      const INTERACTIVE_SEL = 'a, button, input, select, textarea, [role="button"], [tabindex="0"], [data-bench]';

      function isClosedOverlay(el) {
        const st = getComputedStyle(el);
        if (el.hasAttribute('hidden') && st.display === 'none') return true;
        if (el.tagName === 'DIALOG' && !el.hasAttribute('open')) return true;
        const bench = el.getAttribute('data-bench');
        if (bench === 'detail-drawer' || el.getAttribute('role') === 'dialog') {
          if (st.display === 'none' || st.visibility === 'hidden' || parseFloat(st.opacity) <= 0) {
            return true;
          }
          const r = el.getBoundingClientRect();
          if (r.width <= 0 || r.height <= 0) return true;
          if (
            r.right <= 0 ||
            r.left >= window.innerWidth ||
            r.bottom <= 0 ||
            r.top >= document.documentElement.scrollHeight
          ) {
            return true;
          }
        }
        return false;
      }

      function isElementVisible(el) {
        if (!el || el.nodeType !== 1) return false;
        let cur = el;
        while (cur && cur.nodeType === 1) {
          if (isClosedOverlay(cur)) return false;
          const st = getComputedStyle(cur);
          if (st.display === 'none') return false;
          if (st.visibility === 'hidden' || st.visibility === 'collapse') return false;
          if (parseFloat(st.opacity) <= 0) return false;
          if (cur === document.body) break;
          cur = cur.parentElement;
        }
        const r = el.getBoundingClientRect();
        return r.width > 0.5 && r.height > 0.5;
      }

      function clippedDocRect(el) {
        const raw = el.getBoundingClientRect();
        let left = raw.left + window.scrollX;
        let top = raw.top + window.scrollY;
        let right = raw.right + window.scrollX;
        let bottom = raw.bottom + window.scrollY;

        let cur = el.parentElement;
        while (cur && cur !== document.documentElement) {
          const st = getComputedStyle(cur);
          const ox = st.overflowX;
          const oy = st.overflowY;
          if (ox === 'hidden' || ox === 'clip' || ox === 'scroll' || ox === 'auto') {
            const cr = cur.getBoundingClientRect();
            left = Math.max(left, cr.left + window.scrollX);
            right = Math.min(right, cr.right + window.scrollX);
          }
          if (oy === 'hidden' || oy === 'clip' || oy === 'scroll' || oy === 'auto') {
            const cr = cur.getBoundingClientRect();
            top = Math.max(top, cr.top + window.scrollY);
            bottom = Math.min(bottom, cr.bottom + window.scrollY);
          }
          cur = cur.parentElement;
        }
        if (right <= left || bottom <= top) return null;
        return { left, top, right, bottom, width: right - left, height: bottom - top };
      }

      function isCandidate(el) {
        const tag = el.tagName;
        if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'LINK' || tag === 'META' || tag === 'BR' || tag === 'HR') {
          return false;
        }
        const st = getComputedStyle(el);
        if (BLOCK_DISPLAYS.has(st.display)) return true;
        if (el.matches(INTERACTIVE_SEL)) return true;
        return false;
      }

      function intersectionArea(a, b) {
        const ix = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        const iy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        if (ix <= 0 || iy <= 0) return 0;
        return ix * iy;
      }

      function describe(el) {
        const tag = el.tagName.toLowerCase();
        const bench = el.getAttribute('data-bench');
        const id = el.id ? `#${el.id}` : '';
        return bench ? `${tag}[data-bench="${bench}"]` : `${tag}${id}`;
      }

      const rectMap = new Map();
      const all = document.body ? Array.from(document.body.querySelectorAll('*')) : [];
      for (const el of all) {
        if (!isCandidate(el) || !isElementVisible(el)) continue;
        const rect = clippedDocRect(el);
        if (rect && rect.width > 0.5 && rect.height > 0.5) {
          rectMap.set(el, rect);
        }
      }

      const overlaps = [];
      const overlappingElementPairs = new Set();

      function recordOverlap(elA, elB, area) {
        overlaps.push({
          a: describe(elA),
          b: describe(elB),
          areaPx2: Number(area.toFixed(2)),
        });
        overlappingElementPairs.add(elA);
        overlappingElementPairs.add(elB);
      }

      function hasOverlappingAncestorPair(elA, elB) {
        for (const o of overlaps) {
          if (o._elA && o._elB) {
            if (
              (o._elA.contains(elA) && o._elB.contains(elB)) ||
              (o._elA.contains(elB) && o._elB.contains(elA))
            ) {
              return true;
            }
          }
        }
        return false;
      }

      // 1. Pairwise check among visible siblings sharing the same parentElement
      const byParent = new Map();
      for (const el of rectMap.keys()) {
        const p = el.parentElement;
        if (!p) continue;
        if (!byParent.has(p)) byParent.set(p, []);
        byParent.get(p).push(el);
      }

      const checkedPairKeys = new Set();
      let idxCounter = 0;
      const elIdx = new Map();
      for (const el of rectMap.keys()) elIdx.set(el, idxCounter++);

      for (const siblings of byParent.values()) {
        if (siblings.length < 2) continue;
        for (let i = 0; i < siblings.length; i++) {
          const a = siblings[i];
          const ra = rectMap.get(a);
          for (let j = i + 1; j < siblings.length; j++) {
            const b = siblings[j];
            const rb = rectMap.get(b);
            const area = intersectionArea(ra, rb);
            if (area > minPx2) {
              const ia = elIdx.get(a);
              const ib = elIdx.get(b);
              const pk = ia < ib ? `${ia}:${ib}` : `${ib}:${ia}`;
              checkedPairKeys.add(pk);
              overlaps.push({
                a: describe(a),
                b: describe(b),
                areaPx2: Number(area.toFixed(2)),
                _elA: a,
                _elB: b,
              });
            }
          }
        }
      }

      // 2. Cross-parent check for visible interactive / [data-bench] elements
      //    (catches child overflow into neighboring cards/columns without double-counting)
      const specials = Array.from(rectMap.keys()).filter((el) => el.matches(INTERACTIVE_SEL));
      for (let i = 0; i < specials.length; i++) {
        const a = specials[i];
        const ra = rectMap.get(a);
        for (let j = i + 1; j < specials.length; j++) {
          const b = specials[j];
          if (a.contains(b) || b.contains(a)) continue;
          const ia = elIdx.get(a);
          const ib = elIdx.get(b);
          const pk = ia < ib ? `${ia}:${ib}` : `${ib}:${ia}`;
          if (checkedPairKeys.has(pk)) continue;
          const rb = rectMap.get(b);
          const area = intersectionArea(ra, rb);
          if (area > minPx2 && !hasOverlappingAncestorPair(a, b)) {
            checkedPairKeys.add(pk);
            overlaps.push({
              a: describe(a),
              b: describe(b),
              areaPx2: Number(area.toFixed(2)),
              _elA: a,
              _elB: b,
            });
          }
        }
      }

      window.scrollTo(savedX, savedY);

      const cleanOverlaps = overlaps.map(({ a, b, areaPx2 }) => ({ a, b, areaPx2 }));
      return {
        'layout.overlap_count': cleanOverlaps.length,
        details: {
          checkedElements: rectMap.size,
          overlaps: cleanOverlaps.slice(0, 50),
        },
      };
    }, minArea);
  } finally {
    if (zoom200) {
      await page.evaluate(() => {
        document.getElementById('__bench_zoom200_style')?.remove();
      }).catch(() => {});
    }
  }
}
