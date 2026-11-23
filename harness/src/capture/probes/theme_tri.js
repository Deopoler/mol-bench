/**
 * Tri-theme validation probe (v0.2):
 * - theme.tri_valid: Freezes animations/clock, verifies matchMedia actually flips
 *   per scheme (`light`, `dark`, `prefers-contrast: more`), requires a minimum
 *   pixel + OKLab ΔE difference across all 3 pairs (preventing 1-pixel swatches
 *   or identical schemes), AND requires 0 contrast failures (axe + composited APCA).
 */

import { decodePng, pixelSha256 } from './shared.js';
import { probeAxe } from './a11y.js';
import { runProbe as runApcaProbe } from './contrast_apca.js';

export const probeName = 'theme_tri';
export const aliases = ['theme.tri_valid'];

// Precomputed 8-bit sRGB -> OKLab LUT (3x256 floats? Compute per-channel linear LUT)
const SRGB_LIN_LUT = Float64Array.from({ length: 256 }, (_, i) => {
  const c = i / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
});

function rgb8ToOklab(r8, g8, b8) {
  const r = SRGB_LIN_LUT[r8];
  const g = SRGB_LIN_LUT[g8];
  const b = SRGB_LIN_LUT[b8];
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
  ];
}

function comparePngOklab(pngA, pngB, { pixelDeThresh = 0.012 } = {}) {
  const a = decodePng(pngA);
  const b = decodePng(pngB);
  if (a.width !== b.width || a.height !== b.height || a.width === 0 || a.height === 0) {
    return {
      changedPixelFrac: 1.0,
      meanDeltaE: 1.0,
      meanChangedDeltaE: 1.0,
      pixelCount: 0,
    };
  }
  const n = a.width * a.height;
  let totalDe = 0;
  let changedDeSum = 0;
  let changedCount = 0;
  const da = a.data;
  const db = b.data;

  for (let i = 0; i < da.length; i += 4) {
    const r1 = da[i], g1 = da[i + 1], b1 = da[i + 2];
    const r2 = db[i], g2 = db[i + 1], b2 = db[i + 2];
    if (r1 === r2 && g1 === g2 && b1 === b2) continue;

    const lab1 = rgb8ToOklab(r1, g1, b1);
    const lab2 = rgb8ToOklab(r2, g2, b2);
    const dl = lab1[0] - lab2[0];
    const daC = lab1[1] - lab2[1];
    const dbC = lab1[2] - lab2[2];
    const de = Math.sqrt(dl * dl + daC * daC + dbC * dbC);
    totalDe += de;
    if (de >= pixelDeThresh) {
      changedCount += 1;
      changedDeSum += de;
    }
  }

  return {
    changedPixelFrac: Number((changedCount / n).toFixed(6)),
    meanDeltaE: Number((totalDe / n).toFixed(6)),
    meanChangedDeltaE: changedCount > 0 ? Number((changedDeSum / changedCount).toFixed(6)) : 0,
    pixelCount: n,
  };
}

export async function runProbe(pageHandle, args = {}) {
  const { page, cdp } = pageHandle;
  const frozenTimeMs = Number(args.t ?? 0);
  const minChangedPixelFrac = typeof args.minChangedPixelFrac === 'number' ? args.minChangedPixelFrac : 0.01;
  const minMeanDeltaE = typeof args.minMeanDeltaE === 'number' ? args.minMeanDeltaE : 0.003;
  const minChangedDeltaE = typeof args.minChangedDeltaE === 'number' ? args.minChangedDeltaE : 0.012;

  async function freezeAnimationsAndClock() {
    if (typeof pageHandle.seek === 'function') {
      await pageHandle.seek(frozenTimeMs).catch(() => {});
    }
    if (cdp) {
      await cdp.send('Animation.enable').catch(() => {});
      await cdp.send('Animation.setPlaybackRate', { playbackRate: 0 }).catch(() => {});
    }
    await page.evaluate(() => {
      if (!document.getElementById('__bench_theme_freeze_style')) {
        const st = document.createElement('style');
        st.id = '__bench_theme_freeze_style';
        st.textContent = [
          '*, *::before, *::after {',
          '  animation-play-state: paused !important;',
          '  transition-duration: 0s !important;',
          '  transition-delay: 0s !important;',
          '  caret-color: transparent !important;',
          '}',
        ].join('\n');
        (document.head || document.documentElement).appendChild(st);
      }
      if (typeof document.getAnimations === 'function') {
        for (const anim of document.getAnimations()) {
          try { anim.pause(); } catch { /* ignore */ }
        }
      }
    }).catch(() => {});
  }

  async function measureScheme(scheme, prefersContrast) {
    await pageHandle.emulate({ colorScheme: scheme, contrast: prefersContrast });
    if (cdp) {
      await cdp.send('Emulation.setEmulatedMedia', {
        media: 'screen',
        features: [
          { name: 'prefers-color-scheme', value: scheme },
          { name: 'prefers-contrast', value: prefersContrast },
        ],
      }).catch(() => {});
    }
    await pageHandle.renderFrame().catch(() => {});
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

    const mediaState = await page.evaluate(([expectedScheme, expectedContrast]) => {
      const darkMatches = window.matchMedia('(prefers-color-scheme: dark)').matches;
      const lightMatches = window.matchMedia('(prefers-color-scheme: light)').matches;
      const moreMatches = window.matchMedia('(prefers-contrast: more)').matches;
      const schemeOk = expectedScheme === 'dark' ? (darkMatches && !lightMatches) : (lightMatches && !darkMatches);
      const contrastOk = expectedContrast === 'more' ? moreMatches : !moreMatches;
      return {
        lightMatches,
        darkMatches,
        moreMatches,
        flippedOk: schemeOk && contrastOk,
      };
    }, [scheme, prefersContrast]);

    const png = await pageHandle.screenshot();
    const hash = pixelSha256(png);
    const axe = await probeAxe(page);
    const apca = await runApcaProbe(pageHandle, {
      highContrast: prefersContrast === 'more',
    });
    return {
      png,
      report: {
        hash,
        mediaState,
        axeContrastViolations: axe.colorContrastViolations,
        apcaPassFrac: apca['a11y.apca_contrast'],
        apcaFailures: apca.details?.failures || [],
      },
    };
  }

  function pairValid(pairDiff, hashA, hashB) {
    return (
      hashA !== hashB &&
      pairDiff.changedPixelFrac >= minChangedPixelFrac &&
      pairDiff.meanDeltaE >= minMeanDeltaE &&
      pairDiff.meanChangedDeltaE >= minChangedDeltaE
    );
  }

  try {
    await freezeAnimationsAndClock();

    const light = await measureScheme('light', 'no-preference');
    const dark = await measureScheme('dark', 'no-preference');
    const highContrast = await measureScheme('light', 'more');

    const diffLightDark = comparePngOklab(light.png, dark.png);
    const diffLightHc = comparePngOklab(light.png, highContrast.png);
    const diffDarkHc = comparePngOklab(dark.png, highContrast.png);

    const mediaAllFlipped =
      light.report.mediaState.flippedOk &&
      dark.report.mediaState.flippedOk &&
      highContrast.report.mediaState.flippedOk;

    const distinctAllThree =
      pairValid(diffLightDark, light.report.hash, dark.report.hash) &&
      pairValid(diffLightHc, light.report.hash, highContrast.report.hash) &&
      pairValid(diffDarkHc, dark.report.hash, highContrast.report.hash);

    const noContrastFailures =
      light.report.axeContrastViolations === 0 &&
      dark.report.axeContrastViolations === 0 &&
      highContrast.report.axeContrastViolations === 0 &&
      light.report.apcaPassFrac === 1 &&
      dark.report.apcaPassFrac === 1 &&
      highContrast.report.apcaPassFrac === 1;

    const pass = Boolean(mediaAllFlipped && distinctAllThree && noContrastFailures);

    return {
      'theme.tri_valid': pass,
      details: {
        mediaAllFlipped,
        distinctAllThree,
        noContrastFailures,
        pairDiffs: {
          light_dark: diffLightDark,
          light_highContrast: diffLightHc,
          dark_highContrast: diffDarkHc,
        },
        light: light.report,
        dark: dark.report,
        highContrast: highContrast.report,
      },
    };
  } finally {
    await page.evaluate(() => {
      document.getElementById('__bench_theme_freeze_style')?.remove();
      if (typeof document.getAnimations === 'function') {
        for (const anim of document.getAnimations()) {
          try { anim.play(); } catch { /* ignore */ }
        }
      }
    }).catch(() => {});
    if (cdp) {
      await cdp.send('Animation.setPlaybackRate', { playbackRate: 1 }).catch(() => {});
    }
    await pageHandle.emulate({ colorScheme: 'light', contrast: 'no-preference' }).catch(() => {});
    if (cdp) {
      await cdp.send('Emulation.setEmulatedMedia', {
        media: 'screen',
        features: [
          { name: 'prefers-color-scheme', value: 'light' },
          { name: 'prefers-contrast', value: 'no-preference' },
        ],
      }).catch(() => {});
    }
  }
}
