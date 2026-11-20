/**
 * DOM typography probes:
 * - type.size_steps
 * - type.scale_ratio_min
 * - type.hero_serif (optional helper using CDP CSS.getPlatformFontsForNode)
 */

export async function probeType(page, args = {}, cdp = null) {
  const base = await page.evaluate(() => {
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

    const distinctSizes = new Set();
    const steps = [];
    for (let y = 0; y < scrollH; y += Math.max(1, innerH)) {
      steps.push(y);
    }
    if (steps.length === 0) steps.push(0);

    for (const y of steps) {
      window.scrollTo(0, y);
      if (!document.body) continue;
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
        if (!intersectsViewport(rect)) continue;

        const fs = parseFloat(getComputedStyle(parent).fontSize);
        if (Number.isFinite(fs) && fs > 0) {
          // Rounded to 0.5 px per docs/METRICS.md
          const rounded = Math.round(fs * 2) / 2;
          distinctSizes.add(rounded);
        }
      }
    }

    window.scrollTo(savedScrollX, savedScrollY);

    const sortedSizes = Array.from(distinctSizes).sort((a, b) => a - b);
    let minRatio = 1.0;
    if (sortedSizes.length >= 2) {
      minRatio = Infinity;
      for (let i = 0; i < sortedSizes.length - 1; i++) {
        const r = sortedSizes[i + 1] / sortedSizes[i];
        if (r < minRatio) minRatio = r;
      }
    }

    const heroEl = document.querySelector('[data-bench="hero-title"]');
    const heroFontFamily = heroEl ? getComputedStyle(heroEl).fontFamily : null;

    return {
      'type.size_steps': sortedSizes.length,
      'type.scale_ratio_min': minRatio,
      details: {
        sizes_px: sortedSizes,
        hero_font_family: heroFontFamily,
      },
    };
  });

  // Optional type.hero_serif inspection when hero element is present and CDP is available
  if (args.checkHeroSerif && cdp) {
    let heroSerif = false;
    try {
      await cdp.send('DOM.enable');
      await cdp.send('CSS.enable');
      const { root } = await cdp.send('DOM.getDocument', { depth: -1 });
      const { nodeId } = await cdp.send('DOM.querySelector', {
        nodeId: root.nodeId,
        selector: '[data-bench="hero-title"]',
      });
      if (nodeId) {
        const { fonts } = await cdp.send('CSS.getPlatformFontsForNode', { nodeId });
        const famStr = String(base.details.hero_font_family || '').toLowerCase();
        const usedNames = (fonts || []).map((f) => String(f.familyName || '').toLowerCase());
        const serifPattern = /\b(serif|georgia|times|garamond|palatino|baskerville|batang|myeongjo|gungsuh|nanummyeongjo|noto serif|playfair|merriweather|lora)\b/i;
        const isGenericSerif = /(^|,\s*)serif(\s*,|$)/i.test(famStr);
        const matchesSerifName = usedNames.some((n) => serifPattern.test(n) && !/sans/i.test(n));
        heroSerif = matchesSerifName || isGenericSerif;
        base.details.hero_platform_fonts = fonts || [];
      }
    } catch {
      // Ignore CDP errors
    }
    base['type.hero_serif'] = heroSerif;
  }

  return base;
}
