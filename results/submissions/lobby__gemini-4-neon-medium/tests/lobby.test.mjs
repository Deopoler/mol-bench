/**
 * Regression test suite for Museum of Light — Lobby.
 * Covers generated room counts (0, 1, 24), long titles, coming-soon cards,
 * language toggle + localStorage persistence, theme toggle + both schemes,
 * navigation routes + back-scroll restoration, nav transition timing (normal & reduced motion),
 * and public smoke tests.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../bench/capture/server.mjs';
import { launchBrowser } from '../bench/capture/browser.mjs';
import { generate } from '../bench/rooms/lobby.mjs';
import {
  probeLobbyData,
  probeLobbyLanguage,
} from '../bench/capture/probes/lobby.js';
import {
  probeNavRoutes,
  probeNavTransitionMs,
  probeThemeBothValid,
} from '../bench/capture/probes/nav.js';
import { probeLayout } from '../bench/capture/probes/layout.js';
import { probeA11y } from '../bench/capture/probes/a11y.js';
import smokeTests from '../public-tests/smoke.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function assert(cond, msg) {
  if (!cond) {
    throw new Error(`Assertion failed: ${msg}`);
  }
}

async function runTests() {
  const server = await startServer(ROOT);
  const browser = await launchBrowser({ mode: 'swiftshader' });
  const results = [];

  async function openLobby({ seed = 1, params, viewport = '1440x900', colorScheme = 'light', reducedMotion = 'no-preference' }) {
    return browser.newPage({
      origin: server.origin,
      url: `${server.origin}/lobby/`,
      localResolver: server.loopbackReachable ? null : server.resolveFile,
      seed,
      params,
      viewport,
      colorScheme,
      reducedMotion,
    });
  }

  async function test(name, fn) {
    try {
      const detail = await fn();
      results.push({ name, pass: true, detail: detail || 'ok' });
      console.log(`PASS  ${name}${detail ? ` — ${detail}` : ''}`);
    } catch (err) {
      results.push({ name, pass: false, detail: err.message });
      console.error(`FAIL  ${name} — ${err.message}`);
    }
  }

  try {
    // 1. Public smoke tests
    await test('public-tests/smoke.mjs', async () => {
      const params = generate(1, { variant: 'normal' });
      const handle = await openLobby({
        seed: 1,
        params,
        viewport: { width: 1440, height: 900 },
        colorScheme: 'light',
      });
      try {
        for (const t of smokeTests) {
          const res = await t.run({ page: handle.page });
          assert(res.pass, `${t.id}: ${res.detail}`);
        }
        return `${smokeTests.length}/${smokeTests.length} smoke checks passed`;
      } finally {
        await handle.close();
      }
    });

    // 2. Empty collection state
    await test('variant: empty_rooms', async () => {
      const params = generate(1, { variant: 'empty_rooms' });
      const handle = await openLobby({
        seed: 1,
        params,
        viewport: { width: 1440, height: 900 },
        colorScheme: 'light',
      });
      try {
        const res = await probeLobbyData(handle.page);
        assert(res.metrics['data.rooms_rendered'].passed === 1, 'rooms_rendered failed');
        assert(res.metrics['data.empty_state'] === true, 'empty_state not visible');
        const layout = await probeLayout(handle.page);
        assert(layout['layout.overflow_count'] === 0, `overflow=${layout['layout.overflow_count']}`);
        return 'empty state visible, 0 cards, 0 overflow';
      } finally {
        await handle.close();
      }
    });

    // 3. Long title variant on mobile & desktop
    await test('variant: long_title (360x780 & 1440x900)', async () => {
      const params = generate(2, { variant: 'long_title' });
      for (const vp of [
        { width: 360, height: 780 },
        { width: 1440, height: 900 },
      ]) {
        const handle = await openLobby({
          seed: 2,
          params,
          viewport: vp,
          colorScheme: 'light',
        });
        try {
          const data = await probeLobbyData(handle.page);
          assert(data.metrics['data.long_title'] === true, `long_title failed at ${vp.width}x${vp.height}`);
          const layout = await probeLayout(handle.page);
          assert(layout['layout.overflow_count'] === 0, `overflow at ${vp.width}x${vp.height}`);
        } finally {
          await handle.close();
        }
      }
      return 'no overflow or clipping at 360px and 1440px';
    });

    // 4. Many rooms (24) variant
    await test('variant: many_rooms (24 rooms)', async () => {
      const params = generate(3, { variant: 'many_rooms' });
      const handle = await openLobby({
        seed: 3,
        params,
        viewport: { width: 1440, height: 900 },
        colorScheme: 'light',
      });
      try {
        const data = await probeLobbyData(handle.page);
        assert(data.metrics['data.rooms_rendered'].passed === 1, 'not all 24 rooms rendered');
        const layout = await probeLayout(handle.page);
        assert(layout['layout.overflow_count'] === 0, 'overflow with 24 rooms');
        return '24 rooms rendered cleanly, 0 overflow';
      } finally {
        await handle.close();
      }
    });

    // 5. Coming-soon room is visibly distinct and non-navigable
    await test('variant: coming_soon non-navigable', async () => {
      const params = generate(1, { variant: 'coming_soon' });
      const handle = await openLobby({
        seed: 1,
        params,
        viewport: { width: 1440, height: 900 },
        colorScheme: 'light',
      });
      try {
        const check = await handle.page.evaluate(() => {
          const soon = document.querySelector('[data-bench="room-card"][data-status="coming_soon"]');
          const open = document.querySelector('[data-bench="room-card"][data-status="open"]');
          if (!soon || !open) return { ok: false, reason: 'missing cards' };
          const hasLink = Boolean(soon.querySelector('a[href]'));
          const soonBg = getComputedStyle(soon).backgroundColor;
          const openBg = getComputedStyle(open).backgroundColor;
          const soonBorder = getComputedStyle(soon).borderTopStyle;
          soon.click();
          return {
            ok: !hasLink && (soonBg !== openBg || soonBorder === 'dashed') && location.hash === '' && window.__bench.state().route === 'lobby',
            hasLink,
            soonBg,
            openBg,
            soonBorder,
            hash: location.hash,
            route: window.__bench.state().route,
          };
        });
        assert(check.ok, JSON.stringify(check));
        return 'visibly distinct (dashed + recessed) and does not navigate';
      } finally {
        await handle.close();
      }
    });

    // 6. Language toggle + persistence
    await test('language toggle (ko -> en + localStorage)', async () => {
      const params = generate(1, { variant: 'normal' });
      const handle = await openLobby({
        seed: 1,
        params,
        viewport: { width: 1440, height: 900 },
        colorScheme: 'light',
      });
      try {
        const res = await probeLobbyLanguage(handle.page);
        const m = res.metrics['lang.toggle'];
        assert(m.passed === m.total, `lang.toggle ${m.passed}/${m.total}`);
        return `${m.passed}/${m.total} checks passed`;
      } finally {
        await handle.close();
      }
    });

    // 7. Theme both valid (light & dark differ + 0 axe contrast violations)
    await test('theme.both_valid (light & dark)', async () => {
      const params = generate(1, { variant: 'normal' });
      const handle = await openLobby({
        seed: 1,
        params,
        viewport: { width: 1440, height: 900 },
        colorScheme: 'light',
      });
      try {
        const res = await probeThemeBothValid(handle);
        assert(res['theme.both_valid'] === true, JSON.stringify(res.details));
        return `differs=${res.details.differs}, contrastViolations=${res.details.lightContrastViolations}/${res.details.darkContrastViolations}`;
      } finally {
        await handle.close();
      }
    });

    // 8. Navigation transition timing (normal 150-600ms)
    await test('nav.transition_ms (normal: 150-600ms)', async () => {
      const params = generate(1, { variant: 'normal' });
      const handle = await openLobby({
        seed: 1,
        params,
        viewport: { width: 1440, height: 900 },
        colorScheme: 'light',
      });
      try {
        const res = await probeNavTransitionMs(handle);
        const ms = res['nav.transition_ms'];
        assert(ms >= 150 && ms <= 600, `nav.transition_ms=${ms} (expected 150-600)`);
        return `${ms} ms`;
      } finally {
        await handle.close();
      }
    });

    // 9. Reduced motion transition timing (<= 100ms)
    await test('a11y.reduced_motion_transition_ms (<= 100ms)', async () => {
      const params = generate(1, { variant: 'normal' });
      const handle = await openLobby({
        seed: 1,
        params,
        viewport: { width: 1440, height: 900 },
        colorScheme: 'light',
        reducedMotion: 'reduce',
      });
      try {
        const res = await probeNavTransitionMs(handle);
        const ms = res['nav.transition_ms'];
        assert(ms <= 100, `reduced_motion_transition_ms=${ms} (expected <= 100)`);
        return `${ms} ms`;
      } finally {
        await handle.close();
      }
    });

    // 10. Full a11y + nav.routes on dark desktop
    await test('a11y + nav.routes (1440x900 dark)', async () => {
      const params = generate(2, { variant: 'normal' });
      const handle = await openLobby({
        seed: 2,
        params,
        viewport: { width: 1440, height: 900 },
        colorScheme: 'dark',
      });
      try {
        const a11y = await probeA11y(handle.page);
        assert(a11y['a11y.axe_violations'] === 0, `axe=${a11y['a11y.axe_violations']}`);
        assert(a11y['a11y.keyboard_reach'] === 1, `kb=${a11y['a11y.keyboard_reach']}`);
        assert(a11y['a11y.focus_visible'] === 1, `fv=${a11y['a11y.focus_visible']}`);
        const nav = await probeNavRoutes(handle.page);
        assert(nav['nav.routes'] === 1, `nav.routes=${nav['nav.routes']}`);
        return `axe=0, kb=1, fv=1, routes=${nav.details.passed}/${nav.details.total}`;
      } finally {
        await handle.close();
      }
    });
  } finally {
    await browser.close();
    await server.close();
  }

  const failed = results.filter((r) => !r.pass);
  console.log(`\nSummary: ${results.length - failed.length}/${results.length} passed`);
  if (failed.length > 0) {
    process.exitCode = 1;
  }
}

runTests().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
