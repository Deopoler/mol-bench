/**
 * Regression test suite for Museum of Light — Lobby.
 * Run directly with: node tests/lobby.test.mjs
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../bench/capture/server.mjs';
import { launchBrowser } from '../bench/capture/browser.mjs';
import { generate } from '../bench/rooms/lobby.mjs';
import {
  probeA11y,
  probeLayout,
  probeNavRoutes,
  probeNavTransitionMs,
  probeSpaceAndAlign,
  probeText,
  probeThemeBothValid,
  probeType,
} from '../bench/capture/probes/index.js';
import { probeLobbyData, probeLobbyLanguage } from '../bench/capture/probes/lobby.js';
import { pixelSha256 } from '../bench/capture/probes/shared.js';
import smokeTests from '../public-tests/smoke.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

async function main() {
  const server = await startServer(REPO_ROOT);
  const localResolver = server.loopbackReachable ? null : server.resolveFile;
  const browser = await launchBrowser({ mode: 'swiftshader' });

  const openPage = (opts = {}) =>
    browser.newPage({
      origin: server.origin,
      url: server.url,
      localResolver,
      viewport: '1440x900',
      seed: 1,
      params: generate(1),
      loadTimeoutMs: 8000,
      ...opts,
    });

  const results = [];
  async function runCase(name, fn) {
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
    for (const t of smokeTests) {
      await runCase(`public:${t.id}`, async () => {
        const h = await openPage();
        try {
          const out = await t.run({ page: h.page });
          assert.equal(out.pass, true, out.detail || 'smoke test failed');
          return out.detail;
        } finally {
          await h.close();
        }
      });
    }

    // 2. Data variants: empty, one_room, many_rooms, long_title
    await runCase('data:empty_rooms', async () => {
      const h = await openPage({ params: generate(1, { variant: 'empty_rooms' }), viewport: '360x780' });
      try {
        const res = await probeLobbyData(h.page);
        assert.equal(res.metrics['data.empty_state'], true);
        assert.equal(res.metrics['data.rooms_rendered'].passed, 1);
        const layout = await probeLayout(h.page);
        assert.equal(layout['layout.overflow_count'], 0);
        return 'empty state visible, 0 overflow';
      } finally {
        await h.close();
      }
    });

    await runCase('data:long_title_mobile', async () => {
      const h = await openPage({ params: generate(1, { variant: 'long_title' }), viewport: '360x780' });
      try {
        const data = await probeLobbyData(h.page);
        const layout = await probeLayout(h.page);
        const text = await probeText(h.page);
        assert.equal(data.metrics['data.long_title'], true);
        assert.equal(layout['layout.overflow_count'], 0);
        assert.equal(text['text.clipped_count'], 0);
        assert.equal(text['text.hangul_midword_breaks'], 0);
        return 'long title intact, 0 overflow, 0 clipping';
      } finally {
        await h.close();
      }
    });

    await runCase('data:many_rooms_24', async () => {
      const h = await openPage({ params: generate(2, { variant: 'many_rooms' }), viewport: '1440x900' });
      try {
        const data = await probeLobbyData(h.page);
        const layout = await probeLayout(h.page);
        assert.equal(data.metrics['data.rooms_rendered'].passed, 1);
        assert.equal(layout['layout.overflow_count'], 0);
        return '24 rooms rendered cleanly';
      } finally {
        await h.close();
      }
    });

    // 3. Coming-soon room must be distinct and non-navigable
    await runCase('data:coming_soon_non_navigable', async () => {
      const h = await openPage({ params: generate(1, { variant: 'coming_soon' }) });
      try {
        const info = await h.page.evaluate(() => {
          const card = document.querySelector('[data-bench="room-card"][data-status="coming_soon"]');
          if (!card) return { found: false };
          const hasLink = Boolean(card.querySelector('a[href]'));
          const beforeHash = location.hash;
          const beforeRoute = window.__bench.state().route;
          card.click();
          return {
            found: true,
            hasLink,
            beforeHash,
            afterHash: location.hash,
            beforeRoute,
            afterRoute: window.__bench.state().route,
          };
        });
        assert.equal(info.found, true, 'coming_soon card missing');
        assert.equal(info.hasLink, false, 'coming_soon card should not contain a link');
        assert.equal(info.afterHash, info.beforeHash, 'coming_soon click changed hash');
        assert.equal(info.afterRoute, 'lobby', 'coming_soon click changed route');
        return 'non-navigable and distinct';
      } finally {
        await h.close();
      }
    });

    // 4. Language toggle probe (ko -> en, persistence, no overflow at 320px & 1440px)
    for (const vp of ['320x640', '1440x900']) {
      await runCase(`lang:toggle_${vp}`, async () => {
        const h = await openPage({ viewport: vp, params: generate(1) });
        try {
          const res = await probeLobbyLanguage(h.page);
          const { passed, total } = res.metrics['lang.toggle'];
          assert.equal(passed, total, `lang.toggle ${passed}/${total}`);
          return `${passed}/${total}`;
        } finally {
          await h.close();
        }
      });
    }

    // 5. Theme both_valid (light vs dark pixel diff + 0 axe contrast violations)
    await runCase('theme:both_valid', async () => {
      const h = await openPage({ viewport: '1440x900', params: generate(1) });
      try {
        const res = await probeThemeBothValid(h);
        assert.equal(res['theme.both_valid'], true, JSON.stringify(res.details));
        return `differs=${res.details.differs}, contrastViolations=0/0`;
      } finally {
        await h.close();
      }
    });

    // 6. Navigation transition timing (normal: 150-600ms, reduced motion: <= 100ms)
    await runCase('nav:transition_normal', async () => {
      const h = await openPage({ viewport: '1440x900', params: generate(1) });
      try {
        const res = await probeNavTransitionMs(h);
        const ms = res['nav.transition_ms'];
        assert.ok(ms >= 150 && ms <= 600, `expected 150..600ms, got ${ms}ms (${JSON.stringify(res.details)})`);
        return `${ms} ms`;
      } finally {
        await h.close();
      }
    });

    await runCase('a11y:reduced_motion_transition', async () => {
      const h = await openPage({ viewport: '1440x900', reducedMotion: 'reduce', params: generate(1) });
      try {
        const res = await probeNavTransitionMs(h);
        const ms = res['nav.transition_ms'];
        assert.ok(ms <= 100, `expected <= 100ms, got ${ms}ms (${JSON.stringify(res.details)})`);
        return `${ms} ms`;
      } finally {
        await h.close();
      }
    });

    // 7. Full DOM probes: typography, spacing, alignment, a11y, nav routes
    await runCase('probes:desktop_summary', async () => {
      const h = await openPage({ viewport: '1440x900', params: generate(1) });
      try {
        const type = await probeType(h.page);
        const space = await probeSpaceAndAlign(h.page);
        const text = await probeText(h.page);
        const a11y = await probeA11y(h.page);
        const nav = await probeNavRoutes(h.page);

        assert.ok(type['type.size_steps'] >= 3 && type['type.size_steps'] <= 6, `size_steps=${type['type.size_steps']}`);
        assert.ok(type['type.scale_ratio_min'] >= 1.125, `scale_ratio_min=${type['type.scale_ratio_min']}`);
        assert.ok(space['space.grid4_frac'] >= 0.9, `grid4_frac=${space['space.grid4_frac']}`);
        assert.ok(space['align.column_count'] <= 8, `column_count=${space['align.column_count']}`);
        assert.equal(text['text.clipped_count'], 0);
        assert.equal(text['text.hangul_midword_breaks'], 0);
        assert.ok(text['text.line_length'].value >= 22 && text['text.line_length'].value <= 45, `line_len=${text['text.line_length'].value}`);
        assert.ok(text['text.line_height'].value >= 1.5 && text['text.line_height'].value <= 1.9, `line_h=${text['text.line_height'].value}`);
        assert.equal(a11y['a11y.axe_violations'], 0);
        assert.equal(a11y['a11y.keyboard_reach'], 1);
        assert.equal(a11y['a11y.focus_visible'], 1);
        assert.equal(nav['nav.routes'], 1);

        return `cols=${space['align.column_count']}, grid4=${space['space.grid4_frac']}, lineLen=${text['text.line_length'].value}, lineH=${text['text.line_height'].value}`;
      } finally {
        await h.close();
      }
    });

    // 8. Determinism across fresh pages
    await runCase('determinism:pixel_sha256', async () => {
      async function snap() {
        const h = await openPage({ viewport: '1440x900', seed: 2, params: generate(2) });
        try {
          await h.setSeed(2, generate(2));
          await h.seek(500);
          await h.renderFrame();
          return pixelSha256(await h.screenshot());
        } finally {
          await h.close();
        }
      }
      const s1 = await snap();
      const s2 = await snap();
      assert.equal(s1, s2, `hash mismatch ${s1} vs ${s2}`);
      return s1.slice(0, 16);
    });

    // 9. Heading hierarchy check (single h1, no skipped levels)
    await runCase('a11y:heading_hierarchy', async () => {
      const h = await openPage({ viewport: '1440x900', params: generate(1) });
      try {
        const levels = await h.page.evaluate(() =>
          [...document.querySelectorAll('h1, h2, h3, h4, h5, h6')]
            .filter((el) => !el.closest('[hidden]') && getComputedStyle(el).display !== 'none')
            .map((el) => Number(el.tagName.slice(1))),
        );
        const h1Count = levels.filter((l) => l === 1).length;
        assert.equal(h1Count, 1, `expected 1 visible h1, got ${h1Count}`);
        for (let i = 1; i < levels.length; i++) {
          assert.ok(levels[i] <= levels[i - 1] + 1, `heading jump ${levels[i - 1]} -> ${levels[i]}`);
        }
        return `levels=[${levels.slice(0, 6).join(',')}...]`;
      } finally {
        await h.close();
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

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
