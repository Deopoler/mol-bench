import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startServer } from '../bench/capture/server.mjs';
import { launchBrowser } from '../bench/capture/browser.mjs';
import { runProbe } from '../bench/capture/probes/index.js';
import { generate } from '../bench/rooms/lobby.mjs';
import smokeTests from '../public-tests/smoke.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function measureTransferKb() {
  const lobbyDir = path.join(REPO_ROOT, 'lobby');
  const entries = await fs.readdir(lobbyDir, { withFileTypes: true });
  let rawBytes = 0;
  let gzBytes = 0;
  for (const e of entries) {
    if (!e.isFile()) continue;
    const buf = await fs.readFile(path.join(lobbyDir, e.name));
    const gz = zlib.gzipSync(buf, { level: 6 });
    rawBytes += buf.length;
    gzBytes += gz.length;
  }
  return { rawKb: rawBytes / 1024, gzKb: gzBytes / 1024 };
}

function computeCongestion(imgPath) {
  const py = path.join(REPO_ROOT, '.venv', 'Scripts', 'python.exe');
  const out = execFileSync(
    py,
    ['-c', 'import sys; from molmetrics.io import load_image; from molmetrics.visual import congestion; print(congestion(load_image(sys.argv[1])))', imgPath],
    {
      cwd: REPO_ROOT,
      env: { ...process.env, PYTHONPATH: path.join(REPO_ROOT, 'metrics') },
      encoding: 'utf8',
    },
  ).trim();
  return Number(out);
}

async function run() {
  const results = [];
  const server = await startServer(REPO_ROOT);
  const browser = await launchBrowser({ mode: 'swiftshader' });

  const openPage = (opts) => browser.newPage({
    origin: server.origin,
    url: server.url,
    localResolver: server.loopbackReachable ? null : server.resolveFile,
    loadTimeoutMs: 8000,
    ...opts,
  });

  async function test(id, fn) {
    try {
      const detail = await fn();
      results.push({ id, pass: true, detail });
      console.log(`PASS  ${id}  ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
    } catch (err) {
      results.push({ id, pass: false, detail: err.message });
      console.error(`FAIL  ${id}  ${err.message}`);
    }
  }

  try {
    // 1. Public smoke tests
    for (const st of smokeTests) {
      await test(`public:${st.id}`, async () => {
        const h = await openPage({ viewport: '1440x900', seed: 1, params: generate(1) });
        try {
          const r = await st.run({ page: h.page });
          assert(r.pass, r.detail || 'smoke test failed');
          return r.detail || 'ok';
        } finally {
          await h.close();
        }
      });
    }

    // 2. Theme both valid
    await test('theme.both_valid', async () => {
      const h = await openPage({ viewport: '1440x900', seed: 1, params: generate(1) });
      try {
        const res = await runProbe('theme.both_valid', h);
        assert(res['theme.both_valid'] === true, JSON.stringify(res.details));
        return {
          differs: res.details.differs,
          lightContrastViolations: res.details.lightContrastViolations,
          darkContrastViolations: res.details.darkContrastViolations,
        };
      } finally {
        await h.close();
      }
    });

    // 3. Navigation transition duration (normal motion: ideal 150-600 ms)
    await test('nav.transition_ms', async () => {
      const h = await openPage({ viewport: '1440x900', seed: 1, params: generate(1) });
      try {
        const res = await runProbe('nav.transition_ms', h);
        const ms = res['nav.transition_ms'];
        assert(ms >= 150 && ms <= 600, `Expected 150-600ms, got ${ms}ms (${JSON.stringify(res.details)})`);
        return { ms, settled: res.details.settled, animsAfterClick: res.details.clickDiag?.animsAfterClick };
      } finally {
        await h.close();
      }
    });

    // 4. Reduced-motion navigation transition duration (<= 100 ms)
    await test('a11y.reduced_motion_transition_ms', async () => {
      const h = await openPage({
        viewport: '1440x900',
        reducedMotion: 'reduce',
        seed: 1,
        params: generate(1),
      });
      try {
        const res = await runProbe('a11y.reduced_motion_transition_ms', h);
        const ms = res['nav.transition_ms'];
        assert(ms <= 100, `Expected <= 100ms, got ${ms}ms (${JSON.stringify(res.details)})`);
        return { ms, settled: res.details.settled };
      } finally {
        await h.close();
      }
    });

    // 5. Language toggle probe (320x640 and 1440x900)
    for (const vp of ['320x640', '1440x900']) {
      await test(`lang.toggle:${vp}`, async () => {
        const h = await openPage({ viewport: vp, seed: 1, params: generate(1) });
        try {
          const res = await runProbe('lang_toggle', h);
          const { passed, total } = res.metrics['lang.toggle'];
          assert(passed === total, `Expected ${total}/${total}, got ${passed}/${total}`);
          await h.page.click('[data-bench="lang-toggle"]');
          const back = await h.page.evaluate(() => ({
            docLang: document.documentElement.lang,
            stateLang: window.__bench.state().lang,
            stored: localStorage.getItem('mol-lang'),
          }));
          assert(back.docLang === 'ko' && back.stateLang === 'ko' && back.stored === 'ko', JSON.stringify(back));
          return { passed, total, toggledBack: back.stateLang };
        } finally {
          await h.close();
        }
      });
    }

    // 6. Default Korean & runtime languagechange event
    await test('locale.korean_default_and_change', async () => {
      const h = await openPage({ viewport: '1440x900', seed: 1, params: generate(1, { variant: 'one_room' }) });
      try {
        const init = await h.page.evaluate(() => ({
          docLang: document.documentElement.lang,
          state: window.__bench.state(),
          firstTitle: document.querySelector('[data-bench="room-card"] h3')?.textContent,
        }));
        assert(init.docLang === 'ko' && init.state.lang === 'ko', `Expected Korean default: ${JSON.stringify(init)}`);

        await h.emulate({ locale: 'en-US' });
        const switched = await h.page.evaluate(() => ({
          docLang: document.documentElement.lang,
          state: window.__bench.state(),
          firstTitle: document.querySelector('[data-bench="room-card"] h3')?.textContent,
        }));
        assert(switched.docLang === 'en' && switched.state.lang === 'en', `Expected EN after languagechange: ${JSON.stringify(switched)}`);
        return { init: init.firstTitle, switched: switched.firstTitle };
      } finally {
        await h.close();
      }
    });

    // 7. Coming-soon visual distinction & non-navigation
    await test('coming_soon.non_navigable', async () => {
      const params = generate(1, { variant: 'coming_soon' });
      const h = await openPage({ viewport: '1440x900', seed: 1, params });
      try {
        const info = await h.page.evaluate(() => {
          const soonCard = document.querySelector('[data-bench="room-card"][data-status="coming_soon"]');
          const openCard = document.querySelector('[data-bench="room-card"][data-status="open"]');
          const soonLink = soonCard?.querySelector('a[href]');
          const soonStyle = soonCard ? getComputedStyle(soonCard) : null;
          const openStyle = openCard ? getComputedStyle(openCard) : null;
          const beforeHash = location.hash;
          soonCard?.click();
          const afterClickHash = location.hash;
          const afterClickRoute = window.__bench.state().route;
          return {
            hasSoonCard: Boolean(soonCard),
            hasLinkInsideSoon: Boolean(soonLink),
            borderStyleDiffers: soonStyle?.borderTopStyle !== openStyle?.borderTopStyle,
            bgDiffers: soonStyle?.backgroundColor !== openStyle?.backgroundColor,
            beforeHash,
            afterClickHash,
            afterClickRoute,
          };
        });
        assert(info.hasSoonCard, 'coming_soon card missing');
        assert(!info.hasLinkInsideSoon, 'coming_soon card must not contain a[href]');
        assert(info.borderStyleDiffers && info.bgDiffers, `coming_soon not visually distinct: ${JSON.stringify(info)}`);
        assert(info.afterClickRoute === 'lobby' && info.afterClickHash === info.beforeHash, `coming_soon navigated: ${JSON.stringify(info)}`);

        await h.page.evaluate((route) => { location.hash = route; }, params.rooms[0].route);
        await h.page.waitForTimeout(50);
        const directState = await h.state();
        assert(directState.route === 'lobby', `Direct hash to coming_soon opened room: ${JSON.stringify(directState)}`);
        return info;
      } finally {
        await h.close();
      }
    });

    // 8. Variants stress test across viewports
    const variantCases = [
      { variant: 'empty_rooms', viewport: '360x780' },
      { variant: 'empty_rooms', viewport: '1440x900' },
      { variant: 'one_room', viewport: '360x780' },
      { variant: 'one_room', viewport: '1440x900' },
      { variant: 'many_rooms', viewport: '360x780' },
      { variant: 'many_rooms', viewport: '1440x900' },
      { variant: 'long_title', viewport: '360x780' },
      { variant: 'long_title', viewport: '768x1024' },
      { variant: 'long_title', viewport: '1440x900' },
    ];
    for (const vc of variantCases) {
      await test(`variant:${vc.variant}@${vc.viewport}`, async () => {
        const params = generate(2, { variant: vc.variant });
        const h = await openPage({ viewport: vc.viewport, seed: 2, params });
        try {
          const data = await runProbe('data', h);
          const layout = await runProbe('layout', h);
          const text = await runProbe('text', h);
          const axe = await runProbe('axe', h);
          assert(data.metrics['data.rooms_rendered'].passed === 1, 'rooms_rendered failed');
          assert(data.metrics['data.long_title'] === true, 'long_title failed');
          assert(data.metrics['data.empty_state'] === true, 'empty_state failed');
          assert(layout['layout.overflow_count'] === 0, `overflow=${layout['layout.overflow_count']}`);
          assert(text['text.clipped_count'] === 0, `clipped=${text['text.clipped_count']}`);
          assert(text['text.hangul_midword_breaks'] === 0, `hangul_breaks=${text['text.hangul_midword_breaks']}`);
          assert(axe['a11y.axe_violations'] === 0, `axe=${JSON.stringify(axe.violations)}`);
          return {
            rooms: params.rooms.length,
            tapTargets: Number(layout['layout.tap_targets'].toFixed(3)),
            lineLength: text['text.line_length'].value,
            lineHeight: text['text.line_height'].value,
          };
        } finally {
          await h.close();
        }
      });
    }

    // 9. Full probes at 1440x900 (headings, type, space, align, kb, focus, nav.routes)
    await test('full_probes@1440x900', async () => {
      const h = await openPage({ viewport: '1440x900', seed: 1, params: generate(1) });
      try {
        const headings = await h.page.evaluate(() => {
          const hs = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6')]
            .filter((el) => !el.closest('[hidden]'))
            .map((el) => Number(el.tagName[1]));
          let skipped = false;
          for (let i = 1; i < hs.length; i++) {
            if (hs[i] > hs[i - 1] + 1) skipped = true;
          }
          return { h1Count: hs.filter((n) => n === 1).length, skipped, levels: [...new Set(hs)] };
        });
        assert(headings.h1Count === 1 && !headings.skipped, `Bad heading hierarchy: ${JSON.stringify(headings)}`);

        const text = await runProbe('text', h);
        const type = await runProbe('type.hero_serif', h);
        const space = await runProbe('space', h);
        const kb = await runProbe('keyboard_reach', h);
        const fv = await runProbe('focus_visible', h);
        const navRoutes = await runProbe('nav_routes', h);

        assert(text['text.line_length'].script === 'hangul', `Expected hangul script, got ${text['text.line_length'].script}`);
        assert(text['text.line_length'].value >= 22 && text['text.line_length'].value <= 45, `line_length=${text['text.line_length'].value}`);
        assert(text['text.line_height'].value >= 1.5 && text['text.line_height'].value <= 1.9, `line_height=${text['text.line_height'].value}`);
        assert(type['type.size_steps'] >= 3 && type['type.size_steps'] <= 6, `size_steps=${type['type.size_steps']} (${JSON.stringify(type.details)})`);
        assert(type['type.scale_ratio_min'] >= 1.125, `scale_ratio_min=${type['type.scale_ratio_min']} (${JSON.stringify(type.details)})`);
        assert(type['type.hero_serif'] === true, `hero_serif=${type['type.hero_serif']} (${JSON.stringify(type.details)})`);
        assert(space['space.grid4_frac'] >= 0.9, `grid4_frac=${space['space.grid4_frac']}`);
        assert(space['align.column_count'] <= 8, `column_count=${space['align.column_count']} (${JSON.stringify(space.details)})`);
        assert(kb['a11y.keyboard_reach'] === 1, `keyboard_reach=${kb['a11y.keyboard_reach']} (${JSON.stringify(kb.details)})`);
        assert(fv['a11y.focus_visible'] === 1, `focus_visible=${fv['a11y.focus_visible']} (${JSON.stringify(fv.details)})`);
        assert(navRoutes['nav.routes'] === 1, `nav.routes=${navRoutes['nav.routes']} (${JSON.stringify(navRoutes.details)})`);

        return {
          headings: headings.levels,
          lineLength: text['text.line_length'].value,
          lineHeight: text['text.line_height'].value,
          sizesPx: type.details.sizes_px,
          scaleRatioMin: Number(type['type.scale_ratio_min'].toFixed(3)),
          heroSerif: type['type.hero_serif'],
          grid4Frac: Number(space['space.grid4_frac'].toFixed(4)),
          columnCount: space['align.column_count'],
          columnEdges: space.details.column_edges_px,
          kbReached: `${kb.details.validated}/${kb.details.total}`,
          focusVisible: `${fv.details.passed}/${fv.details.total}`,
          navRoutes: `${navRoutes.details.passed}/${navRoutes.details.total}`,
        };
      } finally {
        await h.close();
      }
    });

    // 10. Visual congestion across seeds 1..10 at 1440x900 light
    await test('visual.congestion@1440x900', async () => {
      const vals = [];
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mol-lobby-cong-'));
      try {
        for (const seed of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
          const h = await openPage({ viewport: '1440x900', seed, params: generate(seed) });
          try {
            await h.setSeed(seed, generate(seed));
            await h.seek(0);
            await h.renderFrame();
            const shot = path.join(tmpDir, `s${seed}.png`);
            await h.screenshot(shot);
            vals.push(Number(computeCongestion(shot).toFixed(4)));
          } finally {
            await h.close();
          }
        }
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
      const pubSorted = [...vals.slice(0, 3)].sort((a, b) => a - b);
      const med = pubSorted[1];
      const minVal = Math.min(...vals);
      const maxVal = Math.max(...vals);
      assert(minVal >= 0.10 && maxVal <= 0.12, `Expected all seeds in [0.10, 0.12], got min=${minVal} max=${maxVal} (${JSON.stringify(vals)})`);
      return { publicMedian: med, min: minVal, max: maxVal };
    });

    // 10b. Dark-mode & responsive focus/keyboard/a11y + English typography + adversarial edge data
    await test('dark_and_responsive_a11y', async () => {
      const summary = {};
      for (const [vp, scheme] of [['1440x900', 'dark'], ['768x1024', 'dark'], ['360x780', 'dark'], ['768x1024', 'light']]) {
        const h = await openPage({ viewport: vp, colorScheme: scheme, seed: 1, params: generate(1) });
        try {
          const layout = await runProbe('layout', h);
          const text = await runProbe('text', h);
          const space = await runProbe('space', h);
          const a11y = await runProbe('a11y', h);
          assert(layout['layout.overflow_count'] === 0, `${vp}/${scheme} overflow=${layout['layout.overflow_count']}`);
          assert(text['text.clipped_count'] === 0, `${vp}/${scheme} clipped=${text['text.clipped_count']}`);
          assert(text['text.hangul_midword_breaks'] === 0, `${vp}/${scheme} breaks=${text['text.hangul_midword_breaks']}`);
          assert(space['space.grid4_frac'] >= 0.9, `${vp}/${scheme} grid4=${space['space.grid4_frac']}`);
          assert(a11y['a11y.axe_violations'] === 0, `${vp}/${scheme} axe=${JSON.stringify(a11y.details.axe)}`);
          assert(a11y['a11y.keyboard_reach'] === 1, `${vp}/${scheme} kb=${a11y['a11y.keyboard_reach']}`);
          assert(a11y['a11y.focus_visible'] === 1, `${vp}/${scheme} fv=${a11y['a11y.focus_visible']}`);
          summary[`${vp}_${scheme}`] = { grid4: Number(space['space.grid4_frac'].toFixed(3)), fv: a11y['a11y.focus_visible'] };
        } finally {
          await h.close();
        }
      }
      return summary;
    });

    await test('adversarial.edge_titles_and_en_typography', async () => {
      const customParams = {
        rooms: [
          {
            id: 'edge-1',
            route: '#/room/edge-1',
            title_ko: '빛',
            title_en: 'SupercalifragilisticexpialidociousPhotoluminescenceExhibitionHall',
            summary_ko: '<img src=x onerror=alert(1)> & 특수문자 테스트입니다.',
            accent_oklch: [0.99, 0.4, -45],
            status: 'open',
          },
          {
            id: 'edge-2',
            route: '#/room/edge-2',
            title_ko: '준비 중인 아주 긴 이름의 전시 공간에서 기다리는 시간의 조각들을 모아 봅니다',
            title_en: 'A Very Long Coming Soon Room Title That Wraps Gracefully Across Mobile Lines',
            summary_ko: '곧 열릴 전시를 준비하고 있습니다.',
            accent_oklch: null,
            status: 'coming_soon',
          },
        ],
      };
      const h = await openPage({ viewport: '360x780', seed: 9, params: customParams });
      try {
        const layoutKo = await runProbe('layout', h);
        const textKo = await runProbe('text', h);
        const axeKo = await runProbe('axe', h);
        const hasInjectedImg = await h.page.evaluate(() => Boolean(document.querySelector('#rooms img')));
        assert(!hasInjectedImg, 'XSS injection rendered HTML!');
        assert(layoutKo['layout.overflow_count'] === 0, `KO edge overflow=${layoutKo['layout.overflow_count']}`);
        assert(textKo['text.clipped_count'] === 0, `KO edge clipped=${textKo['text.clipped_count']}`);
        assert(axeKo['a11y.axe_violations'] === 0, `KO edge axe=${JSON.stringify(axeKo.violations)}`);

        // Switch to English and check typography & zero overflow at 360x780 and 1440x900
        await h.page.click('[data-bench="lang-toggle"]');
        const layoutEn360 = await runProbe('layout', h);
        assert(layoutEn360['layout.overflow_count'] === 0, `EN 360 edge overflow=${layoutEn360['layout.overflow_count']}`);
        await h.setViewport('1440x900');
        const textEn1440 = await runProbe('text', h);
        assert(textEn1440['text.line_length'].script === 'latin', `Expected latin script in EN`);
        assert(textEn1440['text.line_length'].value >= 45 && textEn1440['text.line_length'].value <= 90, `EN line_length=${textEn1440['text.line_length'].value}`);
        assert(textEn1440['text.line_height'].value >= 1.4 && textEn1440['text.line_height'].value <= 1.8, `EN line_height=${textEn1440['text.line_height'].value}`);
        return {
          enLineLength: textEn1440['text.line_length'].value,
          enLineHeight: textEn1440['text.line_height'].value,
        };
      } finally {
        await h.close();
      }
    });

    // 11. Transfer size
    await test('budget.transfer_kb', async () => {
      const budget = await measureTransferKb();
      assert(budget.rawKb <= 400, `Raw transfer ${budget.rawKb.toFixed(1)}KB > 400KB`);
      return { rawKb: Number(budget.rawKb.toFixed(2)), gzKb: Number(budget.gzKb.toFixed(2)) };
    });

    // 12. G-live FLIP check via local venv python (uses os.tmpdir so works in sandbox too)
    await test('gate.G-live.flip', async () => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mol-lobby-flip-'));
      const livePath = path.join(tmpDir, 'live.png');
      const seekPath = path.join(tmpDir, 'seek.png');
      try {
        const h1 = await openPage({ viewport: '1440x900', seed: 1, params: generate(1) });
        let tActual = 250;
        try {
          await h1.setSeed(1, generate(1));
          await h1.resetClock(0);
          await h1.resume();
          tActual = await h1.page.evaluate(() => new Promise((resolve) => {
            function check() {
              const now = window.__benchHost.clock.now();
              if (now >= 250) {
                window.__benchHostControl.freeze(now);
                window.__bench.seek(now);
                resolve(now);
                return;
              }
              requestAnimationFrame(check);
            }
            requestAnimationFrame(check);
          }));
          await h1.renderFrame();
          await h1.screenshot(livePath);
        } finally {
          await h1.close();
        }

        const h2 = await openPage({ viewport: '1440x900', seed: 1, params: generate(1) });
        try {
          await h2.setSeed(1, generate(1));
          await h2.seek(tActual);
          await h2.renderFrame();
          await h2.screenshot(seekPath);
        } finally {
          await h2.close();
        }

        const py = path.join(REPO_ROOT, '.venv', 'Scripts', 'python.exe');
        const out = execFileSync(py, ['-m', 'molmetrics', 'flip', seekPath, livePath], {
          cwd: REPO_ROOT,
          env: { ...process.env, PYTHONPATH: path.join(REPO_ROOT, 'metrics') },
          encoding: 'utf8',
        }).trim();
        const flip = Number(out);
        assert(Number.isFinite(flip) && flip <= 0.02, `FLIP=${flip} > 0.02`);
        return { flip, tActualMs: Number(tActual.toFixed(1)) };
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
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

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
