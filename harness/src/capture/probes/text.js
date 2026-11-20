/**
 * DOM text probes:
 * - text.clipped_count
 * - text.hangul_midword_breaks
 * - text.line_length (per-script median)
 * - text.line_height (median)
 */

export async function probeText(page, args = {}) {
  return page.evaluate(() => {
    const innerW = window.innerWidth;
    const innerH = window.innerHeight;
    const scrollingEl = document.scrollingElement || document.documentElement;
    const scrollH = Math.max(scrollingEl.scrollHeight, innerH);
    const savedScrollX = window.scrollX;
    const savedScrollY = window.scrollY;

    const HANGUL_RE = /[\uAC00-\uD7A3]/;
    const LETTER_RE = /\p{L}/u;

    function isStyleVisible(el) {
      if (!el || el.nodeType !== 1) return false;
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

    function hasDirectNonWhitespaceText(el) {
      for (let n = el.firstChild; n; n = n.nextSibling) {
        if (n.nodeType === 3 && n.nodeValue && n.nodeValue.trim().length > 0) {
          return true;
        }
      }
      return false;
    }

    function computeMedian(arr) {
      if (!arr.length) return null;
      const s = [...arr].sort((a, b) => a - b);
      const m = Math.floor(s.length / 2);
      return s.length % 2 === 0 ? (s[m - 1] + s[m]) / 2 : s[m];
    }

    const clippedSet = new Set();
    const visibleTextNodes = new Set();
    const visibleBodyBlocks = new Set();

    const markedBodies = Array.from(document.querySelectorAll('[data-bench="body"]'));
    const bodyCandidates = markedBodies.length > 0
      ? markedBodies
      : Array.from(document.querySelectorAll('p'));
    const bodyCandidateSet = new Set(bodyCandidates);

    const steps = [];
    for (let y = 0; y < scrollH; y += Math.max(1, innerH)) {
      steps.push(y);
    }
    if (steps.length === 0) steps.push(0);

    for (const y of steps) {
      window.scrollTo(0, y);

      // 1. Check clipped text elements
      const allEls = document.body ? document.body.querySelectorAll('*') : [];
      for (let i = 0; i < allEls.length; i++) {
        const el = allEls[i];
        if (!isStyleVisible(el)) continue;
        const rect = el.getBoundingClientRect();
        if (!intersectsViewport(rect)) continue;

        if (bodyCandidateSet.has(el)) {
          visibleBodyBlocks.add(el);
        }

        // Only evaluate elements that contain text
        const text = (el.textContent || '').trim();
        if (!text) continue;
        // Prefer leaf text containers or elements with direct text so parent wrappers don't duplicate
        if (!hasDirectNonWhitespaceText(el) && el.children.length > 0) {
          // Still check if it explicitly clips its children with overflow != visible and single-line/fixed height
          const st = getComputedStyle(el);
          if (st.overflowX === 'visible' && st.overflowY === 'visible') continue;
          // Skip giant layout containers if a descendant is already clipped
          if (el.tagName === 'BODY' || el.tagName === 'HTML' || el.tagName === 'MAIN' || el.tagName === 'SECTION') {
            continue;
          }
        }

        const style = getComputedStyle(el);
        const ovX = style.overflowX;
        const ovY = style.overflowY;
        const clippedX = ovX !== 'visible' && el.scrollWidth > el.clientWidth + 1;
        const clippedY = ovY !== 'visible' && el.scrollHeight > el.clientHeight + 1;
        if (!clippedX && !clippedY) continue;

        // Exception: single-line ellipsis element carrying full text in title or aria-label
        const isSingleLineEllipsis =
          style.textOverflow === 'ellipsis' &&
          (style.whiteSpace === 'nowrap' || style.whiteSpace === 'pre') &&
          !clippedY;
        if (isSingleLineEllipsis) {
          const title = (el.getAttribute('title') || '').trim();
          const ariaLabel = (el.getAttribute('aria-label') || '').trim();
          if (title === text || ariaLabel === text) {
            continue;
          }
        }

        clippedSet.add(el);
      }

      // 2. Collect visible text nodes for hangul_midword_breaks
      if (document.body) {
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        let node;
        while ((node = walker.nextNode())) {
          if (!node.nodeValue || !node.nodeValue.trim()) continue;
          const parent = node.parentElement;
          if (!parent || !isStyleVisible(parent)) continue;
          const tag = parent.tagName;
          if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') continue;
          const range = document.createRange();
          range.selectNodeContents(node);
          const rect = range.getBoundingClientRect();
          if (intersectsViewport(rect)) {
            visibleTextNodes.add(node);
          }
        }
      }
    }

    // Remove ancestor elements from clippedSet if a descendant is already in clippedSet
    const finalClipped = [];
    for (const el of clippedSet) {
      let hasClippedChild = false;
      for (const other of clippedSet) {
        if (other !== el && el.contains(other)) {
          hasClippedChild = true;
          break;
        }
      }
      if (!hasClippedChild) {
        finalClipped.push(el);
      }
    }

    // 3. Measure text.hangul_midword_breaks
    window.scrollTo(0, 0);
    let hangulMidwordBreaks = 0;
    const range1 = document.createRange();
    const range2 = document.createRange();

    for (const node of visibleTextNodes) {
      const str = node.nodeValue || '';
      if (str.length < 2) continue;
      for (let i = 0; i < str.length - 1; i++) {
        const c1 = str[i];
        const c2 = str[i + 1];
        if (!HANGUL_RE.test(c1) || !HANGUL_RE.test(c2)) continue;
        range1.setStart(node, i);
        range1.setEnd(node, i + 1);
        range2.setStart(node, i + 1);
        range2.setEnd(node, i + 2);
        const r1 = range1.getBoundingClientRect();
        const r2 = range2.getBoundingClientRect();
        if (r1.width <= 0 || r1.height <= 0 || r2.width <= 0 || r2.height <= 0) continue;
        const minH = Math.min(r1.height, r2.height);
        if (Math.abs(r1.top - r2.top) > minH * 0.5) {
          hangulMidwordBreaks += 1;
        }
      }
    }

    // 4. Measure text.line_length and text.line_height on body blocks
    const allLineLengths = [];
    const byScriptLineLengths = { hangul: [], latin: [] };
    const allLineHeights = [];
    const byScriptLineHeights = { hangul: [], latin: [] };
    let totalHangulLetters = 0;
    let totalLetters = 0;

    function measureBlockLines(blockEl) {
      const walker = document.createTreeWalker(blockEl, NodeFilter.SHOW_TEXT);
      const lines = []; // { top, height, chars: string[] }
      const r = document.createRange();
      let tn;
      while ((tn = walker.nextNode())) {
        const parent = tn.parentElement;
        if (!parent || !isStyleVisible(parent)) continue;
        const val = tn.nodeValue || '';
        for (let i = 0; i < val.length; i++) {
          const ch = val[i];
          if (ch === '\n' || ch === '\r' || ch === '\t') continue;
          r.setStart(tn, i);
          r.setEnd(tn, i + 1);
          const rect = r.getBoundingClientRect();
          if (rect.width <= 0 && rect.height <= 0) continue;
          let placed = false;
          if (lines.length > 0) {
            const last = lines[lines.length - 1];
            const tol = Math.max(rect.height, last.height, 4) * 0.5;
            if (Math.abs(rect.top - last.top) <= tol) {
              last.chars.push(ch);
              placed = true;
            }
          }
          if (!placed) {
            lines.push({ top: rect.top, height: rect.height, chars: [ch] });
          }
        }
      }
      return lines
        .map((l) => l.chars.join('').trim())
        .filter((s) => s.length > 0);
    }

    function classifyScript(text) {
      let hangul = 0;
      let letters = 0;
      for (const ch of text) {
        if (HANGUL_RE.test(ch)) {
          hangul += 1;
          letters += 1;
        } else if (LETTER_RE.test(ch)) {
          letters += 1;
        }
      }
      return {
        script: letters > 0 && hangul / letters > 0.5 ? 'hangul' : 'latin',
        hangul,
        letters,
      };
    }

    for (const block of visibleBodyBlocks) {
      const lines = measureBlockLines(block);
      if (lines.length < 2) continue;

      const fullText = lines.join(' ');
      const { script, hangul, letters } = classifyScript(fullText);
      totalHangulLetters += hangul;
      totalLetters += letters;

      // Exclude the last line per docs/METRICS.md
      for (let i = 0; i < lines.length - 1; i++) {
        const len = lines[i].length;
        allLineLengths.push(len);
        byScriptLineLengths[script].push(len);
      }

      const style = getComputedStyle(block);
      const fontSize = parseFloat(style.fontSize);
      let lineHeightPx = parseFloat(style.lineHeight);
      if (!Number.isFinite(lineHeightPx)) {
        // 'normal' line-height: estimate from rendered line step or 1.2 * fontSize
        lineHeightPx = fontSize * 1.2;
      }
      if (fontSize > 0 && lineHeightPx > 0) {
        const ratio = lineHeightPx / fontSize;
        allLineHeights.push(ratio);
        byScriptLineHeights[script].push(ratio);
      }
    }

    window.scrollTo(savedScrollX, savedScrollY);

    const dominantScript = totalLetters > 0 && totalHangulLetters / totalLetters > 0.5 ? 'hangul' : 'latin';
    const lineLengthMedian = computeMedian(allLineLengths);
    const lineHeightMedian = computeMedian(allLineHeights);

    return {
      'text.clipped_count': finalClipped.length,
      'text.hangul_midword_breaks': hangulMidwordBreaks,
      'text.line_length': {
        value: lineLengthMedian,
        script: dominantScript,
        by_script: {
          hangul: computeMedian(byScriptLineLengths.hangul),
          latin: computeMedian(byScriptLineLengths.latin),
        },
      },
      'text.line_height': {
        value: lineHeightMedian,
        script: dominantScript,
        by_script: {
          hangul: computeMedian(byScriptLineHeights.hangul),
          latin: computeMedian(byScriptLineHeights.latin),
        },
      },
      details: {
        body_blocks_measured: visibleBodyBlocks.size,
        lines_measured: allLineLengths.length,
      },
    };
  }, args);
}
