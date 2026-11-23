/**
 * Composited APCA contrast probe (v0.2):
 * - a11y.apca_contrast: APCA |Lc| per visible text node against composited
 *   screenshot background (3x3 median sampled outside a 2 px anti-aliased glyph halo).
 *   Thresholds: |Lc| >= 60 body (>= 75 high-contrast), >= 45 large headings.
 */

import { decodePng, median } from './shared.js';

export const probeName = 'contrast_apca';
export const aliases = ['a11y.apca_contrast'];

// APCA-W3 (0.0.98G-4g / 0.1.9) constants
const APCA_NORM_BG = 0.56;
const APCA_NORM_TXT = 0.57;
const APCA_REV_TXT = 0.62;
const APCA_REV_BG = 0.65;
const APCA_BLK_THRS = 0.022;
const APCA_BLK_CLMP = 1.414;
const APCA_SCALE_BOW = 1.14;
const APCA_SCALE_WOB = 1.14;
const APCA_LO_BOW_OFFSET = 0.027;
const APCA_LO_WOB_OFFSET = 0.027;
const APCA_LO_CLIP = 0.1;
const APCA_DELTA_Y_MIN = 0.0005;

export function apcaLuminance(r8, g8, b8) {
  const r = Math.pow(Math.max(0, Math.min(255, r8)) / 255, 2.4);
  const g = Math.pow(Math.max(0, Math.min(255, g8)) / 255, 2.4);
  const b = Math.pow(Math.max(0, Math.min(255, b8)) / 255, 2.4);
  let y = 0.2126729 * r + 0.7151522 * g + 0.0721750 * b;
  if (y < APCA_BLK_THRS) {
    y += Math.pow(APCA_BLK_THRS - y, APCA_BLK_CLMP);
  }
  return y;
}

export function apcaContrast(fgRgb, bgRgb) {
  const txtY = apcaLuminance(fgRgb[0], fgRgb[1], fgRgb[2]);
  const bgY = apcaLuminance(bgRgb[0], bgRgb[1], bgRgb[2]);
  if (Math.abs(bgY - txtY) < APCA_DELTA_Y_MIN) return 0;

  let lc = 0;
  if (bgY > txtY) {
    const sapc = (Math.pow(bgY, APCA_NORM_BG) - Math.pow(txtY, APCA_NORM_TXT)) * APCA_SCALE_BOW;
    lc = sapc < APCA_LO_CLIP ? 0 : (sapc - APCA_LO_BOW_OFFSET) * 100;
  } else {
    const sapc = (Math.pow(bgY, APCA_REV_BG) - Math.pow(txtY, APCA_REV_TXT)) * APCA_SCALE_WOB;
    lc = sapc > -APCA_LO_CLIP ? 0 : (sapc + APCA_LO_WOB_OFFSET) * 100;
  }
  return Math.abs(lc);
}

function parseCssColor(cssColor) {
  if (!cssColor || typeof cssColor !== 'string') return null;
  const m = cssColor.match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?\s*\)/i);
  if (!m) return null;
  return {
    r: Math.round(Number(m[1])),
    g: Math.round(Number(m[2])),
    b: Math.round(Number(m[3])),
    a: m[4] !== undefined ? Number(m[4]) : 1,
  };
}

/**
 * Sample background RGB around/within a text box from a decoded RGBA PNG,
 * masking out foreground-like pixels dilated by a 2 px anti-aliased glyph halo
 * and taking a 3x3 spatial median.
 */
export function sampleHaloMaskedBackground(png, textBox, fgRgb, parentBox = null) {
  const { width, height, data } = png;
  const pad = 4;

  let x0 = Math.max(0, Math.floor(textBox.x) - pad);
  let y0 = Math.max(0, Math.floor(textBox.y) - pad);
  let x1 = Math.min(width - 1, Math.ceil(textBox.x + textBox.width) + pad);
  let y1 = Math.min(height - 1, Math.ceil(textBox.y + textBox.height) + pad);

  if (parentBox && parentBox.width >= textBox.width && parentBox.height >= textBox.height) {
    const px0 = Math.max(0, Math.floor(parentBox.x) + 1);
    const py0 = Math.max(0, Math.floor(parentBox.y) + 1);
    const px1 = Math.min(width - 1, Math.ceil(parentBox.x + parentBox.width) - 1);
    const py1 = Math.min(height - 1, Math.ceil(parentBox.y + parentBox.height) - 1);
    if (px1 > px0 && py1 > py0) {
      x0 = Math.max(x0, px0);
      y0 = Math.max(y0, py0);
      x1 = Math.min(x1, px1);
      y1 = Math.min(y1, py1);
    }
  }

  const bw = x1 - x0 + 1;
  const bh = y1 - y0 + 1;
  if (bw <= 0 || bh <= 0) return [fgRgb[0], fgRgb[1], fgRgb[2]];

  // Mark pixels close to fgRgb as glyph strokes
  const glyphMask = new Uint8Array(bw * bh);
  const fgThreshSq = 35 * 35 * 3;
  for (let dy = 0; dy < bh; dy++) {
    const py = y0 + dy;
    for (let dx = 0; dx < bw; dx++) {
      const px = x0 + dx;
      const idx = (py * width + px) * 4;
      const dr = data[idx] - fgRgb[0];
      const dg = data[idx + 1] - fgRgb[1];
      const db = data[idx + 2] - fgRgb[2];
      if (dr * dr + dg * dg + db * db <= fgThreshSq) {
        glyphMask[dy * bw + dx] = 1;
      }
    }
  }

  // Dilate glyphMask by 2 px radius to exclude the 2 px anti-aliased halo
  const haloMask = new Uint8Array(bw * bh);
  for (let dy = 0; dy < bh; dy++) {
    for (let dx = 0; dx < bw; dx++) {
      if (!glyphMask[dy * bw + dx]) continue;
      for (let ky = Math.max(0, dy - 2); ky <= Math.min(bh - 1, dy + 2); ky++) {
        for (let kx = Math.max(0, dx - 2); kx <= Math.min(bw - 1, dx + 2); kx++) {
          haloMask[ky * bw + kx] = 1;
        }
      }
    }
  }

  // Collect 3x3 median samples at unmasked background pixels
  const rs = [];
  const gs = [];
  const bs = [];

  for (let dy = 0; dy < bh; dy++) {
    for (let dx = 0; dx < bw; dx++) {
      if (haloMask[dy * bw + dx]) continue;
      const py = y0 + dy;
      const px = x0 + dx;
      const nr = [];
      const ng = [];
      const nb = [];
      for (let ky = Math.max(0, py - 1); ky <= Math.min(height - 1, py + 1); ky++) {
        for (let kx = Math.max(0, px - 1); kx <= Math.min(width - 1, px + 1); kx++) {
          const idx = (ky * width + kx) * 4;
          nr.push(data[idx]);
          ng.push(data[idx + 1]);
          nb.push(data[idx + 2]);
        }
      }
      rs.push(median(nr));
      gs.push(median(ng));
      bs.push(median(nb));
    }
  }

  // Fallback if every pixel was within fgThresh (low-contrast text where fg ≈ bg)
  if (rs.length === 0) {
    for (let dy = 0; dy < bh; dy++) {
      const py = y0 + dy;
      for (let dx = 0; dx < bw; dx++) {
        const px = x0 + dx;
        const idx = (py * width + px) * 4;
        rs.push(data[idx]);
        gs.push(data[idx + 1]);
        bs.push(data[idx + 2]);
      }
    }
  }

  return [Math.round(median(rs)), Math.round(median(gs)), Math.round(median(bs))];
}

/**
 * Pure evaluator over decoded PNG + extracted text items (also usable in unit tests).
 */
export function evaluateApcaItems(png, items, { highContrast = false, dprX = 1, dprY = 1 } = {}) {
  let passed = 0;
  let minLc = Infinity;
  const failures = [];

  for (const item of items) {
    const fg = typeof item.color === 'string' ? parseCssColor(item.color) : item.fg;
    if (!fg) continue;
    const textBox = {
      x: item.rect.x * dprX,
      y: item.rect.y * dprY,
      width: item.rect.width * dprX,
      height: item.rect.height * dprY,
    };
    const parentBox = item.parentRect
      ? {
          x: item.parentRect.x * dprX,
          y: item.parentRect.y * dprY,
          width: item.parentRect.width * dprX,
          height: item.parentRect.height * dprY,
        }
      : null;

    const bgRgb = sampleHaloMaskedBackground(png, textBox, [fg.r, fg.g, fg.b], parentBox);
    const effectiveFg =
      fg.a < 1
        ? [
            Math.round(fg.r * fg.a + bgRgb[0] * (1 - fg.a)),
            Math.round(fg.g * fg.a + bgRgb[1] * (1 - fg.a)),
            Math.round(fg.b * fg.a + bgRgb[2] * (1 - fg.a)),
          ]
        : [fg.r, fg.g, fg.b];

    const lc = apcaContrast(effectiveFg, bgRgb);
    if (lc < minLc) minLc = lc;

    const threshold = item.isLargeHeading ? 45 : (highContrast ? 75 : 60);
    if (lc >= threshold) {
      passed += 1;
    } else {
      failures.push({
        text: item.text,
        lc: Number(lc.toFixed(2)),
        threshold,
        fg: effectiveFg,
        bg: bgRgb,
      });
    }
  }

  const total = items.length;
  return {
    passFrac: total > 0 ? passed / total : 1,
    passed,
    total,
    minLc: Number.isFinite(minLc) ? Number(minLc.toFixed(2)) : null,
    failures: failures.slice(0, 30),
  };
}

export async function runProbe(pageHandle, args = {}) {
  const { page, cdp } = pageHandle;
  const forceHighContrast = args.highContrast === true || args.scheme === 'high_contrast';
  let emulatedHc = false;

  if (forceHighContrast && cdp) {
    await cdp.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-contrast', value: 'more' }],
    }).catch(() => {});
    emulatedHc = true;
  }

  try {
    const extracted = await page.evaluate(() => {
      const savedX = window.scrollX;
      const savedY = window.scrollY;
      window.scrollTo(0, 0);

      const innerW = window.innerWidth;
      const innerH = window.innerHeight;
      const highContrast = window.matchMedia('(prefers-contrast: more)').matches;

      function isVisible(el) {
        let cur = el;
        while (cur && cur.nodeType === 1) {
          if (cur.hasAttribute('hidden') || cur.getAttribute('aria-hidden') === 'true') return false;
          const st = getComputedStyle(cur);
          if (st.display === 'none' || st.visibility === 'hidden' || st.visibility === 'collapse') return false;
          if (parseFloat(st.opacity) <= 0) return false;
          if (cur === document.body) break;
          cur = cur.parentElement;
        }
        return true;
      }

      const items = [];
      if (document.body) {
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        const range = document.createRange();
        let node;
        while ((node = walker.nextNode())) {
          const text = (node.nodeValue || '').trim();
          if (!text) continue;
          const parent = node.parentElement;
          if (!parent || !isVisible(parent)) continue;
          const tag = parent.tagName;
          if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') continue;

          range.selectNodeContents(node);
          const rect = range.getBoundingClientRect();
          if (
            rect.width <= 1 ||
            rect.height <= 1 ||
            rect.right <= 0 ||
            rect.left >= innerW ||
            rect.bottom <= 0 ||
            rect.top >= innerH
          ) {
            continue;
          }

          const st = getComputedStyle(parent);
          const fontSize = parseFloat(st.fontSize) || 16;
          const fontWeight = parseInt(st.fontWeight, 10) || 400;
          const isHeadingTag = /^H[1-6]$/.test(tag);
          const isLargeHeading =
            fontSize >= 24 ||
            (fontSize >= 18.66 && fontWeight >= 700) ||
            (isHeadingTag && fontSize >= 20);

          const pRect = parent.getBoundingClientRect();
          items.push({
            text: text.slice(0, 48),
            color: st.color,
            isLargeHeading,
            rect: {
              x: Math.max(0, rect.left),
              y: Math.max(0, rect.top),
              width: Math.min(innerW - Math.max(0, rect.left), rect.width),
              height: Math.min(innerH - Math.max(0, rect.top), rect.height),
            },
            parentRect: {
              x: Math.max(0, pRect.left),
              y: Math.max(0, pRect.top),
              width: Math.min(innerW - Math.max(0, pRect.left), pRect.width),
              height: Math.min(innerH - Math.max(0, pRect.top), pRect.height),
            },
          });
        }
      }

      window.scrollTo(savedX, savedY);
      return { innerW, innerH, highContrast, items };
    });

    const shot = await pageHandle.screenshot();
    const png = decodePng(shot);
    const dprX = extracted.innerW > 0 ? png.width / extracted.innerW : 1;
    const dprY = extracted.innerH > 0 ? png.height / extracted.innerH : 1;
    const highContrast = forceHighContrast || extracted.highContrast;

    const evalRes = evaluateApcaItems(png, extracted.items, { highContrast, dprX, dprY });

    return {
      'a11y.apca_contrast': evalRes.passFrac,
      details: {
        passed: evalRes.passed,
        total: evalRes.total,
        minLc: evalRes.minLc,
        highContrast,
        failures: evalRes.failures,
      },
    };
  } finally {
    if (emulatedHc && cdp) {
      await cdp.send('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-contrast', value: 'no-preference' }],
      }).catch(() => {});
    }
  }
}
