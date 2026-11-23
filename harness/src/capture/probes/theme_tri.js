/**
 * Tri-theme validation probe (v0.2):
 * - theme.tri_valid: Distinct pixel SHA-256 across `light`, `dark`, and
 *   `prefers-contrast: more` AND 0 contrast failures (both axe color-contrast
 *   and composited APCA contrast).
 */

import { pixelSha256 } from './shared.js';
import { probeAxe } from './a11y.js';
import { runProbe as runApcaProbe } from './contrast_apca.js';

export const probeName = 'theme_tri';
export const aliases = ['theme.tri_valid'];

export async function runProbe(pageHandle, args = {}) {
  const { page, cdp } = pageHandle;

  async function measureScheme(scheme, prefersContrast) {
    await pageHandle.emulate({ colorScheme: scheme });
    if (cdp) {
      await cdp.send('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-contrast', value: prefersContrast }],
      }).catch(() => {});
    }
    await pageHandle.renderFrame().catch(() => {});
    const png = await pageHandle.screenshot();
    const hash = pixelSha256(png);
    const axe = await probeAxe(page);
    const apca = await runApcaProbe(pageHandle, {
      highContrast: prefersContrast === 'more',
    });
    return {
      hash,
      axeContrastViolations: axe.colorContrastViolations,
      apcaPassFrac: apca['a11y.apca_contrast'],
      apcaFailures: apca.details?.failures || [],
    };
  }

  try {
    const light = await measureScheme('light', 'no-preference');
    const dark = await measureScheme('dark', 'no-preference');
    const highContrast = await measureScheme('light', 'more');

    const distinctAllThree =
      light.hash !== dark.hash &&
      light.hash !== highContrast.hash &&
      dark.hash !== highContrast.hash;

    const noContrastFailures =
      light.axeContrastViolations === 0 &&
      dark.axeContrastViolations === 0 &&
      highContrast.axeContrastViolations === 0 &&
      light.apcaPassFrac === 1 &&
      dark.apcaPassFrac === 1 &&
      highContrast.apcaPassFrac === 1;

    const pass = Boolean(distinctAllThree && noContrastFailures);

    return {
      'theme.tri_valid': pass,
      details: {
        distinctAllThree,
        noContrastFailures,
        light,
        dark,
        highContrast,
      },
    };
  } finally {
    await pageHandle.emulate({ colorScheme: 'light' }).catch(() => {});
    if (cdp) {
      await cdp.send('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-contrast', value: 'no-preference' }],
      }).catch(() => {});
    }
  }
}
