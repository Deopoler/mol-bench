// Regression tests for lobby/index.html — run with:  node tests/lobby.test.mjs
//
// Drives the page through the same Playwright harness the grader uses (bench/capture) and
// covers the public smoke tests plus the behaviours the brief lists: collection counts and
// titles at edge lengths, empty collection, coming-soon rooms, responsive overflow, heading
// structure, language semantics, keyboard access, focus indication, themes, reduced motion
// and route behaviour. Exit code is non-zero when any check fails.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const load = (rel) => import(pathToFileURL(path.join(root, rel)).href);
const { launchBrowser } = await load('bench/capture/browser.mjs');
const { startServer } = await load('bench/capture/server.mjs');
const { runProbe } = await load('bench/capture/probes/index.js');
const { runTests } = await load('bench/capture/testrunner.mjs');
const { pngMeanAbsDiff } = await load('bench/capture/probes/shared.js');
const adapter = await load('bench/rooms/lobby.mjs');

const server = await startServer(path.join(root, 'lobby'));
const session = await launchBrowser({ mode: 'swiftshader' });
const results = [];
const only = process.argv[2] || '';

async function open({ seed = 1, variant = 'normal', viewport = '1440x900', scheme = 'light', reduced = false, locale = null, mutate = null } = {}) {
  let params = adapter.generate(seed, { variant });
  if (mutate) params = mutate(params);
  const handle = await session.newPage({
    origin: server.origin, url: server.url, viewport, colorScheme: scheme, seed, params, locale,
    reducedMotion: reduced ? 'reduce' : 'no-preference',
  });
  await handle.setSeed(seed, params);
  await handle.seek(0);
  await handle.renderFrame();
  return { handle, page: handle.page, params };
}

function test(name, fn) {
  results.push({ name, fn });
}

async function run() {
  let failed = 0;
  for (const { name, fn } of results) {
    if (only && !name.includes(only)) continue;
    let opened = [];
    const ctx = { open: async (opts) => { const o = await open(opts); opened.push(o.handle); return o; } };
    try {
      const out = await fn(ctx);
      const pass = out === undefined || out === true || (out && out.pass !== false);
      if (!pass) failed += 1;
      console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${out && out.detail ? `  — ${out.detail}` : ''}`);
    } catch (err) {
      failed += 1;
      console.log(`FAIL  ${name}  — ${String(err && err.stack ? err.stack.split('\n').slice(0, 3).join(' | ') : err)}`);
    } finally {
      for (const h of opened) await h.close().catch(() => {});
    }
  }
  return failed;
}

const expect = (cond, detail) => ({ pass: Boolean(cond), detail: cond ? '' : detail });
const VIEWPORTS = ['320x640', '360x780', '390x844', '768x1024', '1024x768', '1440x900', '1920x1080'];

/* ---------- public smoke tests (same module the grader receives) ---------- */

test('public smoke tests pass', async () => {
  const smoke = await runTests([path.join(root, 'public-tests')], {
    browserSession: session, origin: server.origin, url: server.url, adapter, hidden: false,
  });
  const bad = smoke.filter((t) => !t.pass);
  return expect(smoke.length >= 2 && bad.length === 0, bad.map((t) => `${t.id}: ${t.detail}`).join('; ') || `only ${smoke.length} tests ran`);
});

/* ---------- data: counts, titles, edge lengths ---------- */

for (const seed of [1, 2, 3, 7]) {
  test(`data: every generated room renders as one card (seed ${seed})`, async ({ open }) => {
    const { page, params } = await open({ seed });
    const r = await page.evaluate(() => {
      const cards = [...document.querySelectorAll('[data-bench="room-card"]')];
      return { n: cards.length, titles: cards.map((c) => c.querySelector('h3')?.textContent), links: cards.map((c) => c.querySelector('a')?.getAttribute('href')) };
    });
    const ok = r.n === params.rooms.length
      && params.rooms.every((room, i) => r.titles[i] === room.title_ko && r.links[i] === room.route);
    return expect(ok, JSON.stringify(r).slice(0, 300));
  });
}

test('data: room data is read from __benchHost (no hard-coded titles)', async ({ open }) => {
  const { page } = await open({
    mutate: () => ({ rooms: [{ id: 'x-1', route: '#/room/x-1', title_ko: '시험용 방 가나다', title_en: 'Probe Room', summary_ko: '테스트 요약입니다.', accent_oklch: [0.7, 0.1, 200], status: 'open' }] }),
  });
  const t = await page.evaluate(() => [...document.querySelectorAll('[data-bench="room-card"] h3')].map((h) => h.textContent));
  return expect(t.length === 1 && t[0] === '시험용 방 가나다', JSON.stringify(t));
});

test('data: many rooms (24) all render without overflow', async ({ open }) => {
  const { page } = await open({ variant: 'many_rooms', viewport: '360x780' });
  const r = await page.evaluate(() => ({ n: document.querySelectorAll('[data-bench="room-card"]').length, sw: document.documentElement.scrollWidth, iw: innerWidth }));
  return expect(r.n === 24 && r.sw <= r.iw, JSON.stringify(r));
});

test('data: one room renders', async ({ open }) => {
  const { page } = await open({ variant: 'one_room' });
  return expect(await page.evaluate(() => document.querySelectorAll('[data-bench="room-card"]').length) === 1, 'expected one card');
});

for (const vp of ['320x640', '360x780', '768x1024', '1440x900']) {
  test(`data: long titles stay whole and inside the viewport (${vp})`, async ({ open }) => {
    const { page, params } = await open({ variant: 'long_title', viewport: vp });
    const r = await page.evaluate(() => {
      const h = document.querySelector('[data-bench="room-card"] h3');
      const box = h.getBoundingClientRect();
      const s = getComputedStyle(h);
      return { text: h.textContent, right: box.right, left: box.left, iw: innerWidth, h: box.height, clipped: h.scrollWidth > h.clientWidth + 1, ov: s.overflow, sw: document.documentElement.scrollWidth };
    });
    return expect(r.text === params.rooms[0].title_ko && r.right <= r.iw && r.left >= 0 && r.h > 0 && !r.clipped && r.sw <= r.iw, JSON.stringify(r));
  });
}

test('data: a single very long unbroken title does not overflow at 320px', async ({ open }) => {
  const { page } = await open({
    viewport: '320x640',
    mutate: (p) => { p.rooms[0].title_ko = '아주아주아주아주아주아주아주아주아주아주아주아주아주아주긴제목'; p.rooms[0].title_en = 'Supercalifragilisticexpialidocious'.repeat(2); return p; },
  });
  const r = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: innerWidth }));
  return expect(r.sw <= r.iw, JSON.stringify(r));
});

/* ---------- empty collection ---------- */

test('empty: clear empty state, no cards, no grid', async ({ open }) => {
  const { page } = await open({ variant: 'empty_rooms' });
  const r = await page.evaluate(() => {
    const e = document.querySelector('[data-bench="empty-state"]');
    return { cards: document.querySelectorAll('[data-bench="room-card"]').length, hidden: e.hidden, display: getComputedStyle(e).display, text: e.textContent.trim(), h: e.getBoundingClientRect().height };
  });
  return expect(r.cards === 0 && !r.hidden && r.display !== 'none' && r.text.length > 8 && r.h > 0, JSON.stringify(r));
});

test('empty: state is hidden when rooms exist and returns after setSeed with no rooms', async ({ open }) => {
  const { page, handle } = await open({});
  const before = await page.evaluate(() => document.querySelector('[data-bench="empty-state"]').hidden);
  await handle.setSeed(1, { rooms: [] });
  const after = await page.evaluate(() => ({ hidden: document.querySelector('[data-bench="empty-state"]').hidden, cards: document.querySelectorAll('[data-bench="room-card"]').length }));
  return expect(before === true && after.hidden === false && after.cards === 0, JSON.stringify({ before, after }));
});

/* ---------- coming soon ---------- */

test('coming soon: visibly distinct, not a link, click does not navigate', async ({ open }) => {
  const { page } = await open({ variant: 'coming_soon' });
  const info = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('[data-bench="room-card"]')];
    const soon = cards.find((c) => c.dataset.status === 'coming_soon');
    const open = cards.find((c) => c.dataset.status === 'open');
    const style = (c) => { const x = c.querySelector('.card'); const p = c.querySelector('.card__plate'); return { border: getComputedStyle(p).borderStyle, bg: getComputedStyle(p).backgroundImage, cursor: getComputedStyle(x).cursor, text: c.textContent }; };
    return { soonLinks: soon.querySelectorAll('a[href]').length, soonStyle: style(soon), openStyle: style(open) };
  });
  const first = (await page.$$('[data-bench="room-card"]'))[0];
  const hashBefore = await page.evaluate(() => location.hash);
  await first.click();
  await page.waitForTimeout(120);
  const after = await page.evaluate(() => ({ hash: location.hash, route: __bench.state().route }));
  const distinct = info.soonStyle.border !== info.openStyle.border && info.soonStyle.bg !== info.openStyle.bg && /준비 중|Coming soon/.test(info.soonStyle.text);
  return expect(info.soonLinks === 0 && distinct && after.hash === hashBefore && after.route === 'lobby', JSON.stringify({ info, after }));
});

test('coming soon: deep link to a coming-soon route stays on the lobby', async ({ open }) => {
  const { page, handle } = await open({ variant: 'coming_soon' });
  await page.evaluate(() => { location.hash = '#/room/room-1'; });
  await page.waitForTimeout(150);
  const r = await handle.state();
  return expect(r.route === 'lobby', JSON.stringify(r));
});

/* ---------- responsive overflow ---------- */

for (const vp of VIEWPORTS) {
  for (const scheme of ['light', 'dark']) {
    test(`layout: no horizontal overflow or clipped text (${vp}, ${scheme})`, async ({ open }) => {
      const { page } = await open({ viewport: vp, scheme, seed: 3 });
      const layout = await runProbe('layout', { page }, {});
      const text = await runProbe('text', { page }, {});
      const ov = layout['layout.overflow_count'];
      const cl = text['text.clipped_count'];
      return expect(ov === 0 && cl === 0, `overflow=${ov} clipped=${cl}`);
    });
  }
}

test('layout: no horizontal overflow at every width from 280 to 2560 (both languages)', async ({ open }) => {
  const { page, handle } = await open({ viewport: '1440x900', variant: 'long_title' });
  const bad = [];
  for (const lang of ['ko', 'en']) {
    if (lang === 'en') await page.click('[data-bench="lang-toggle"]');
    for (const w of [280, 300, 320, 360, 390, 414, 480, 560, 639, 640, 641, 720, 768, 820, 900, 1023, 1024, 1099, 1100, 1101, 1180, 1280, 1366, 1440, 1600, 1920, 2560]) {
      await handle.setViewport(`${w}x800`);
      const r = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: innerWidth }));
      if (r.sw > r.iw) bad.push(`${lang}@${w}: ${r.sw}>${r.iw}`);
    }
  }
  return expect(bad.length === 0, bad.join('; '));
});

test('layout: overflow stays 0 in English at 320px with a long title', async ({ open }) => {
  const { page } = await open({ viewport: '320x640', variant: 'long_title' });
  await page.click('[data-bench="lang-toggle"]');
  const r = await runProbe('layout', { page }, {});
  return expect(r['layout.overflow_count'] === 0, String(r['layout.overflow_count']));
});

/* ---------- heading structure ---------- */

test('headings: one h1, no skipped levels, in lobby and in a room', async ({ open }) => {
  const { page } = await open({});
  const lobby = await page.evaluate(() => [...document.querySelectorAll('h1,h2,h3,h4,h5,h6')].filter((h) => h.getClientRects().length).map((h) => Number(h.tagName[1])));
  await page.click('[data-bench="room-card"] a');
  await page.waitForTimeout(100);
  const room = await page.evaluate(() => ({ all: [...document.querySelectorAll('h1')].length, vis: [...document.querySelectorAll('h1,h2,h3')].filter((h) => h.getClientRects().length).map((h) => Number(h.tagName[1])) }));
  const ok = (levels) => levels[0] === 1 && levels.filter((l) => l === 1).length === 1 && levels.every((l, i) => i === 0 || l - levels[i - 1] <= 1);
  return expect(ok(lobby) && ok(room.vis) && room.all === 1, JSON.stringify({ lobby, room }));
});

/* ---------- language semantics ---------- */

test('language: html[lang] is ko by default (even with an English browser locale) and matches state()', async ({ open }) => {
  const { page, handle } = await open({ locale: 'en-US' });
  const r = await page.evaluate(() => ({ lang: document.documentElement.lang, state: __bench.state().lang, nav: navigator.language }));
  return expect(r.lang === 'ko' && r.state === 'ko', JSON.stringify(r));
});

test('language: toggle swaps titles, html lang, state and persists', async ({ open }) => {
  const { page, params } = await open({ seed: 2 });
  await page.click('[data-bench="lang-toggle"]');
  const r = await page.evaluate(() => ({
    lang: document.documentElement.lang, state: __bench.state().lang, saved: localStorage.getItem('mol-lang'),
    titles: [...document.querySelectorAll('[data-bench="room-card"] h3')].map((h) => h.textContent),
    korean: [...document.querySelectorAll('[data-bench="room-card"]')].every((c, i) => c.textContent.includes(window.__benchHost.params.rooms[i].title_ko)),
    sw: document.documentElement.scrollWidth <= innerWidth,
    langAttrs: [...document.querySelectorAll('.card__alt')].every((n) => n.lang === 'ko') && [...document.querySelectorAll('.card__summary')].every((n) => n.lang === 'ko'),
    label: document.querySelector('[data-bench="lang-toggle"]').textContent,
  }));
  const ok = r.lang === 'en' && r.state === 'en' && r.saved === 'en' && params.rooms.every((room, i) => r.titles[i] === room.title_en) && r.korean && r.sw && r.langAttrs;
  await page.click('[data-bench="lang-toggle"]');
  const back = await page.evaluate(() => ({ lang: document.documentElement.lang, state: __bench.state().lang }));
  return expect(ok && back.lang === 'ko' && back.state === 'ko', JSON.stringify({ r, back }).slice(0, 400));
});

test('language: foreign-language fragments carry their own lang attribute', async ({ open }) => {
  const { page } = await open({});
  const r = await page.evaluate(() => ({
    alt: [...document.querySelectorAll('.card__alt')].every((n) => n.lang === 'en'),
    brand: document.querySelector('.brand').lang === 'en',
    toggle: document.querySelector('[data-bench="lang-toggle"]').lang === 'en',
  }));
  return expect(r.alt && r.brand && r.toggle, JSON.stringify(r));
});

test('language: stored English preference is applied on load', async ({ open }) => {
  const { page, handle } = await open({});
  await page.evaluate(() => localStorage.setItem('mol-lang', 'en'));
  await page.reload();
  await handle.waitForBenchReady();
  const r = await page.evaluate(() => ({ lang: document.documentElement.lang, state: __bench.state().lang, h1: document.querySelector('h1').textContent }));
  return expect(r.lang === 'en' && r.state === 'en' && /Welcome/.test(r.h1), JSON.stringify(r));
});

/* ---------- keyboard + focus ---------- */

test('keyboard: every required target is reachable and room links activate with Enter', async ({ open }) => {
  const { page } = await open({ seed: 3 });
  const r = await runProbe('keyboard_reach', { page }, {});
  return expect(r['a11y.keyboard_reach'] === 1, JSON.stringify(r.details));
});

for (const vp of ['360x780', '1440x900']) {
  test(`focus: visible indicator on every required target (${vp})`, async ({ open }) => {
    const { page } = await open({ seed: 3, viewport: vp });
    const r = await runProbe('focus_visible', { page }, {});
    return expect(r['a11y.focus_visible'] === 1, JSON.stringify(r.details.per_target.filter((t) => !t.pass)));
  });
}

test('focus: dark theme focus indicator is visible too', async ({ open }) => {
  const { page } = await open({ seed: 1, scheme: 'dark' });
  const r = await runProbe('focus_visible', { page }, {});
  return expect(r['a11y.focus_visible'] === 1, JSON.stringify(r.details.per_target.filter((t) => !t.pass)));
});

test('keyboard: Tab order starts with the skip link and Space/Enter toggle the buttons', async ({ open }) => {
  const { page } = await open({});
  await page.keyboard.press('Tab');
  const first = await page.evaluate(() => document.activeElement.className);
  await page.focus('[data-bench="theme-toggle"]');
  const t0 = await page.evaluate(() => __bench.state().theme);
  await page.keyboard.press('Enter');
  const t1 = await page.evaluate(() => __bench.state().theme);
  await page.keyboard.press('Space');
  const t2 = await page.evaluate(() => __bench.state().theme);
  return expect(first === 'skip' && t0 !== t1 && t2 === t0, JSON.stringify({ first, t0, t1, t2 }));
});

test('keyboard: controls are at least 44px tall', async ({ open }) => {
  const { page } = await open({ viewport: '360x780' });
  const small = await page.evaluate(() => [...document.querySelectorAll('button, [data-bench="room-card"] a, .btn')].map((n) => n.getBoundingClientRect()).filter((r) => r.width && (r.height < 44 || r.width < 44)).length);
  return expect(small === 0, `${small} small targets`);
});

/* ---------- themes ---------- */

for (const vp of ['360x780', '768x1024', '1440x900']) {
  test(`theme: zero serious/critical axe violations and zero contrast failures in both schemes (${vp})`, async ({ open }) => {
    const bad = [];
    for (const scheme of ['light', 'dark']) {
      for (const variant of ['normal', 'coming_soon', 'empty_rooms']) {
        const { page } = await open({ viewport: vp, scheme, variant, seed: 2 });
        const a = await runProbe('axe', { page }, {});
        if (a['a11y.axe_violations'] !== 0 || a.colorContrastViolations !== 0) bad.push({ scheme, variant, v: a.violations, cc: a.colorContrastViolations });
      }
    }
    return expect(bad.length === 0, JSON.stringify(bad));
  });
}

test('theme: follows prefers-color-scheme and the toggle flips it (light → dark → light)', async ({ open }) => {
  const { page, handle } = await open({ scheme: 'light' });
  const a = await handle.state();
  await page.emulateMedia({ colorScheme: 'dark' });
  const b = await handle.state();
  await page.emulateMedia({ colorScheme: 'light' });
  await page.click('[data-bench="theme-toggle"]');
  const c = await handle.state();
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  await page.click('[data-bench="theme-toggle"]');
  const d = await handle.state();
  return expect(a.theme === 'light' && b.theme === 'dark' && c.theme === 'dark' && d.theme === 'light' && bg !== 'rgb(251, 249, 244)', JSON.stringify({ a, b, c, d, bg }));
});

test('theme: light and dark renders differ', async ({ open }) => {
  const l = await open({ scheme: 'light' });
  const a = await l.handle.screenshot();
  const d = await open({ scheme: 'dark' });
  const b = await d.handle.screenshot();
  return expect(Buffer.compare(a, b) !== 0, 'identical screenshots');
});

/* ---------- reduced motion ---------- */

test('motion: reduced-motion removes animations and transitions', async ({ open }) => {
  const { page } = await open({ reduced: true });
  const r = await page.evaluate(() => {
    const names = ['.btn', '.ctrl', '.card__plate', 'main'].map((s) => document.querySelector(s)).filter(Boolean);
    return names.map((n) => { const s = getComputedStyle(n); return [n.className || n.tagName, s.transitionDuration, s.animationName]; });
  });
  const ok = r.every(([, t, a]) => t.split(',').every((d) => parseFloat(d) === 0) && a === 'none');
  return expect(ok, JSON.stringify(r));
});

test('motion: route change settles within 100 ms under reduced motion', async ({ open }) => {
  const { handle } = await open({ reduced: true, seed: 1 });
  const r = await runProbe('nav_transition', handle, {});
  return expect(r['nav.transition_ms'] <= 100, JSON.stringify(r['nav.transition_ms']));
});

test('motion: route transition is between 150 and 600 ms normally', async ({ open }) => {
  const { handle } = await open({ seed: 1 });
  const r = await runProbe('nav_transition', handle, {});
  const v = r['nav.transition_ms'];
  return expect(v >= 150 && v <= 600, `${v} ms ${JSON.stringify(r.details.sampleDiffs)}`);
});

/* ---------- routes ---------- */

test('route: every open card navigates, shows the room, and Back restores the lobby and scroll', async ({ open }) => {
  const { page } = await open({ seed: 3, viewport: '768x1024' });
  const r = await runProbe('nav_routes', { page }, {});
  return expect(r['nav.routes'] === 1, JSON.stringify(r.details.results.filter((x) => !x.pass)));
});

test('route: room view shows its own title and a way back; hero-title follows the room', async ({ open }) => {
  const { page, params } = await open({ seed: 2 });
  const target = params.rooms[3];
  await page.click(`[data-room="${target.id}"] a`);
  await page.waitForTimeout(100);
  const r = await page.evaluate(() => ({
    route: __bench.state().route, hash: location.hash, h1: document.querySelector('[data-bench="hero-title"]').textContent,
    roomsVisible: document.querySelector('#rooms').getClientRects().length, back: document.querySelector('#cta-back').getClientRects().length,
    focus: document.activeElement.id, title: document.title,
  }));
  await page.click('#cta-back');
  await page.waitForTimeout(100);
  const back = await page.evaluate(() => ({ route: __bench.state().route, rooms: document.querySelector('#rooms').getClientRects().length }));
  return expect(r.route === target.id && r.hash === target.route && r.h1 === target.title_ko && !r.roomsVisible && r.back > 0 && r.focus === 'hero-title' && back.route === 'lobby' && back.rooms > 0, JSON.stringify({ r, back }));
});

test('route: deep link opens the room on load; unknown ids fall back to the lobby', async ({ open }) => {
  const a = await open({ seed: 1 });
  await a.page.evaluate(() => { location.hash = '#/room/room-2'; });
  await a.page.reload();
  await a.handle.waitForBenchReady();
  const deep = await a.handle.state();
  await a.page.evaluate(() => { location.hash = '#/room/does-not-exist'; });
  await a.page.waitForTimeout(100);
  const unknown = await a.handle.state();
  return expect(deep.route === 'room-2' && unknown.route === 'lobby', JSON.stringify({ deep, unknown }));
});

test('route: browser Back/Forward across several rooms keeps state() in sync', async ({ open }) => {
  const { page, handle } = await open({ seed: 1 });
  const seen = [];
  for (const id of ['room-1', 'room-4']) {
    await page.evaluate((h) => { location.hash = h; }, `#/room/${id}`);
    await page.waitForTimeout(80);
    seen.push((await handle.state()).route);
  }
  await page.goBack(); await page.waitForTimeout(80); seen.push((await handle.state()).route);
  await page.goBack(); await page.waitForTimeout(80); seen.push((await handle.state()).route);
  await page.goForward(); await page.waitForTimeout(80); seen.push((await handle.state()).route);
  return expect(JSON.stringify(seen) === JSON.stringify(['room-1', 'room-4', 'room-1', 'lobby', 'room-1']), JSON.stringify(seen));
});

test('route: in-page anchors (#rooms, #info, #top) keep the lobby route', async ({ open }) => {
  const { page, handle } = await open({ viewport: '768x1024' });
  const routes = [];
  for (const h of ['#rooms', '#info', '#top']) {
    await page.evaluate((x) => { location.hash = x; }, h);
    await page.waitForTimeout(60);
    routes.push((await handle.state()).route);
  }
  return expect(routes.every((x) => x === 'lobby'), JSON.stringify(routes));
});

/* ---------- runtime contract + determinism ---------- */

test('contract: __bench v1 shape, state() fields and stats() numbers', async ({ open }) => {
  const { page } = await open({});
  const r = await page.evaluate(async () => {
    const b = window.__bench; await b.ready;
    const s = b.state(); const st = b.stats();
    return { v: b.version, fns: ['setSeed', 'seek', 'resume', 'renderFrame', 'state', 'stats'].every((k) => typeof b[k] === 'function'), route: s.route, lang: s.lang, theme: s.theme, dc: typeof st.drawCalls, tri: typeof st.triangles };
  });
  return expect(r.v === 1 && r.fns && r.route === 'lobby' && ['ko', 'en'].includes(r.lang) && ['light', 'dark'].includes(r.theme) && r.dc === 'number' && r.tri === 'number', JSON.stringify(r));
});

test('determinism: same seed/time/viewport renders identical pixels in fresh pages', async ({ open }) => {
  const a = await open({ seed: 2 });
  const b = await open({ seed: 2 });
  const [x, y] = [await a.handle.screenshot(), await b.handle.screenshot()];
  return expect(Buffer.compare(x, y) === 0, 'pixel mismatch');
});

test('determinism: seek() frame equals a live frame at the same clock (mean abs diff < 0.0005)', async ({ open }) => {
  const { handle, page } = await open({ seed: 1 });
  await handle.resetClock(0);
  await handle.resume();
  await page.waitForTimeout(300);
  const now = await handle.clockNow();
  await page.evaluate((t) => { window.__benchHostControl.freeze(t); window.__bench.seek(t); }, now);
  await handle.renderFrame();
  const live = await handle.screenshot();
  const other = await open({ seed: 1 });
  await other.handle.seek(now);
  await other.handle.renderFrame();
  const seeked = await other.handle.screenshot();
  const mad = pngMeanAbsDiff(live, seeked);
  return expect(mad < 0.0005, `live vs seek mean abs diff ${mad}`);
});

test('console: no errors or external requests during a full interaction pass', async ({ open }) => {
  const o = await open({ seed: 1 });
  await o.page.click('[data-bench="lang-toggle"]');
  await o.page.click('[data-bench="theme-toggle"]');
  await o.page.click('[data-bench="room-card"] a');
  await o.page.waitForTimeout(100);
  await o.page.goBack();
  await o.page.waitForTimeout(100);
  const errs = o.handle.consoleLogs.filter((l) => l.type === 'error' || l.type === 'pageerror');
  const ext = o.handle.networkLogs.filter((n) => !n.allowed);
  return expect(errs.length === 0 && ext.length === 0, JSON.stringify({ errs, ext }));
});

/* ---------- performance budget ---------- */

test('budget: transfer under 400 KB, no raster/font files, LCP/CLS in range', async ({ open }) => {
  const stats = server.getServedStats();
  const files = fs.readdirSync(path.join(root, 'lobby'), { recursive: true }).map(String);
  const bytes = files.reduce((sum, f) => { const p = path.join(root, 'lobby', f); return sum + (fs.statSync(p).isFile() ? fs.statSync(p).size : 0); }, 0);
  const raster = files.filter((f) => /\.(png|jpe?g|webp|gif|avif|bmp|woff2?|ttf|otf)$/i.test(f));
  const { page } = await open({ viewport: '1440x900' });
  const vitals = await page.evaluate(() => new Promise((resolve) => {
    let cls = 0; let lcp = 0;
    new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) cls += e.value; }).observe({ type: 'layout-shift', buffered: true });
    new PerformanceObserver((l) => { for (const e of l.getEntries()) lcp = e.startTime; }).observe({ type: 'largest-contentful-paint', buffered: true });
    setTimeout(() => resolve({ cls, lcp }), 600);
  }));
  return expect(bytes < 400 * 1024 && raster.length === 0 && vitals.cls <= 0.02 && vitals.lcp <= 1200, JSON.stringify({ kb: Math.round(bytes / 1024), raster, vitals, served: stats.requests }));
});

const failed = await run();
await session.close();
await server.close();
console.log(failed === 0 ? `\nAll ${results.filter((r) => !only || r.name.includes(only)).length} checks passed.` : `\n${failed} check(s) failed.`);
process.exit(failed === 0 ? 0 : 1);
