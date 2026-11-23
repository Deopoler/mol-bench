import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { launchBrowser } from '../../src/capture/browser.mjs';
import { startServer } from '../../src/capture/server.mjs';
import { discoverProbes, listProbes, runProbe, getProbeLoadErrors } from '../../src/capture/probes/index.js';
import { apcaContrast, sampleHaloMaskedBackground } from '../../src/capture/probes/contrast_apca.js';
import { computeDomWorkProfile } from '../../src/capture/probes/perf_dom.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../..');
const PREFERRED_WORK_BASE = path.join(REPO_ROOT, 'work', 'test-probes-v2');

let WORK_BASE = PREFERRED_WORK_BASE;
let usingTempDir = false;
let browserSession = null;

function scoreLower(val, full, zero) {
  if (val <= full) return 10;
  if (val >= zero) return 0;
  return (10 * (zero - val)) / (zero - full);
}

function scoreHigher(val, full, zero) {
  if (val >= full) return 10;
  if (val <= zero) return 0;
  return (10 * (val - zero)) / (full - zero);
}

before(async () => {
  try {
    await fs.mkdir(PREFERRED_WORK_BASE, { recursive: true });
    WORK_BASE = PREFERRED_WORK_BASE;
  } catch (err) {
    if (err?.code === 'EPERM' || err?.code === 'EACCES') {
      WORK_BASE = await fs.mkdtemp(path.join(os.tmpdir(), 'mol-probes-v2-'));
      usingTempDir = true;
    } else {
      throw err;
    }
  }
  browserSession = await launchBrowser({ mode: 'swiftshader' });
});

after(async () => {
  await browserSession?.close().catch(() => {});
  if (usingTempDir && WORK_BASE) {
    await fs.rm(WORK_BASE, { recursive: true, force: true }).catch(() => {});
  }
});

async function withFixturePage(name, html, opts, fn) {
  const dir = path.join(WORK_BASE, `${name}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'index.html'), html, 'utf8');

  const server = await startServer(dir);
  const localResolver = server.loopbackReachable ? null : server.resolveFile;
  const handle = await browserSession.newPage({
    origin: server.origin,
    url: server.url,
    localResolver,
    viewport: opts.viewport || '1440x900',
    colorScheme: opts.colorScheme || 'light',
    seed: opts.seed ?? 1,
    params: opts.params || {},
    loadTimeoutMs: 15000,
  });

  try {
    return await fn(handle);
  } finally {
    await handle.close().catch(() => {});
    await server.close().catch(() => {});
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

const TEST_TIMEOUT_MS = 60_000;

test('WP-1 probes auto-discover cleanly without editing probes/index.js', async () => {
  const reg = await discoverProbes({ forceReload: true });
  assert.equal(getProbeLoadErrors().length, 0, `Unexpected probe load errors: ${JSON.stringify(getProbeLoadErrors())}`);
  const names = await listProbes();
  for (const expected of [
    'overlap',
    'layout.overlap_count',
    'contrast_apca',
    'a11y.apca_contrast',
    'flow',
    'interact.scripted_flow',
    'perf_dom',
    'budget.dom_work_profile',
    'perf.cls',
    'theme_tri',
    'theme.tri_valid',
  ]) {
    assert.ok(names.includes(expected), `Missing probe registration: ${expected}`);
  }
  assert.equal(reg.has('overlap'), true);
});

test('overlap probe separates clean, partial-overlap, and zoom200-attack layouts by >= 4 pts and is repeatable', { timeout: TEST_TIMEOUT_MS }, async () => {
  const makeHtml = (mode) => `<!doctype html><html><head><meta charset="utf-8"><style>
    body { margin: 0; font: 16px/1.5 sans-serif; }
    .grid { display: flex; gap: 16px; padding: 16px; }
    .card { width: 180px; height: 80px; background: #eee; position: relative; }
    ${mode === 'bad' ? '.card-b { margin-left: -40px; } .card-c { margin-left: -40px; }' : ''}
    ${mode === 'attack' ? '.grid { gap: 0; } .card { width: 6rem; margin-left: -3.5rem; } .card:first-child { margin-left: 0; }' : ''}
    [data-bench="detail-drawer"] { position: fixed; inset: 0; background: rgba(0,0,0,0.6); }
  </style></head><body>
    <div class="grid">
      <div class="card card-a" data-bench="room-card">Card 1</div>
      <div class="card card-b" data-bench="room-card">Card 2</div>
      <div class="card card-c" data-bench="room-card">Card 3</div>
      <div class="card card-d" data-bench="room-card">Card 4</div>
      <div class="card card-e" data-bench="room-card">Card 5</div>
    </div>
    <div data-bench="detail-drawer" hidden aria-hidden="true">Closed overlay</div>
    <script>window.__bench={version:1,ready:Promise.resolve(),setSeed(){},seek(){},resume(){},renderFrame:async()=>{},state:()=>({}),stats:()=>({drawCalls:0,triangles:0})};</script>
  </body></html>`;

  const goodRes1 = await withFixturePage('ov_good1', makeHtml('good'), {}, (h) => runProbe('overlap', h));
  const goodRes2 = await withFixturePage('ov_good2', makeHtml('good'), {}, (h) => runProbe('overlap', h));
  assert.equal(goodRes1['layout.overlap_count'], 0);
  assert.deepEqual(goodRes1, goodRes2);

  const badRes = await withFixturePage('ov_bad', makeHtml('bad'), {}, (h) => runProbe('layout.overlap_count', h));
  assert.equal(badRes['layout.overlap_count'], 2);

  const atkRes = await withFixturePage('ov_atk', makeHtml('attack'), {}, (h) => runProbe('overlap', h, { zoom200: true }));
  assert.ok(atkRes['layout.overlap_count'] >= 4, `Expected >= 4 overlaps at zoom200, got ${atkRes['layout.overlap_count']}`);

  const sGood = scoreLower(goodRes1['layout.overlap_count'], 0, 4);
  const sBad = scoreLower(badRes['layout.overlap_count'], 0, 4);
  const sAtk = scoreLower(atkRes['layout.overlap_count'], 0, 4);
  assert.ok(sGood - sBad >= 4.0);
  assert.ok(sBad - sAtk >= 4.0);
});

test('contrast_apca masks 2px glyph AA halo and separates good/bad/attack fixtures by >= 4 pts', { timeout: TEST_TIMEOUT_MS }, async () => {
  // 1. Unit test: 2px AA halo around dark glyph on light background must not bias sampled bg
  const png = new PNG({ width: 40, height: 30 });
  for (let y = 0; y < 30; y++) {
    for (let x = 0; x < 40; x++) {
      const idx = (y * 40 + x) * 4;
      // Background is pure white (255,255,255)
      let r = 255, g = 255, b = 255;
      // Glyph stroke at x=16..20, y=10..18 in black (10,10,10)
      if (x >= 16 && x <= 20 && y >= 10 && y <= 18) {
        r = 10; g = 10; b = 10;
      } else if (x >= 14 && x <= 22 && y >= 8 && y <= 20) {
        // 2px anti-aliased gray halo around the glyph
        r = 140; g = 140; b = 140;
      }
      png.data[idx] = r; png.data[idx + 1] = g; png.data[idx + 2] = b; png.data[idx + 3] = 255;
    }
  }
  const sampled = sampleHaloMaskedBackground(png, { x: 15, y: 9, width: 7, height: 11 }, [10, 10, 10]);
  assert.deepEqual(sampled, [255, 255, 255]);
  assert.ok(apcaContrast([10, 10, 10], sampled) > 100);

  // 2. Browser tests: good vs bad vs attack
  const makePage = (colors) => `<!doctype html><html><head><meta charset="utf-8"><style>
    body { margin: 24px; background: #ffffff; font: 16px/1.5 sans-serif; }
    h1 { font-size: 28px; color: ${colors.h1}; }
    ${colors.items.map((c, i) => `.t${i} { color: ${c}; margin: 8px 0; }`).join('\n')}
  </style></head><body>
    <h1>Heading Contrast</h1>
    ${colors.items.map((_, i) => `<p class="t${i}">Readable sample paragraph ${i}</p>`).join('\n')}
    <script>window.__bench={version:1,ready:Promise.resolve(),setSeed(){},seek(){},resume(){},renderFrame:async()=>{},state:()=>({}),stats:()=>({drawCalls:0,triangles:0})};</script>
  </body></html>`;

  const goodHtml = makePage({ h1: '#4b5563', items: ['#111111', '#111111', '#111111', '#111111', '#111111', '#111111'] });
  const badHtml = makePage({ h1: '#333333', items: ['#111111', '#111111', '#111111', '#111111', '#111111', '#a3a3a3'] });
  const atkHtml = makePage({ h1: '#bbbbbb', items: ['#aaaaaa', '#aaaaaa', '#aaaaaa', '#aaaaaa', '#aaaaaa', '#111111'] });

  const good1 = await withFixturePage('apca_good1', goodHtml, {}, (h) => runProbe('contrast_apca', h));
  const good2 = await withFixturePage('apca_good2', goodHtml, {}, (h) => runProbe('contrast_apca', h));
  assert.equal(good1['a11y.apca_contrast'], 1);
  assert.deepEqual(good1, good2);

  const badRes = await withFixturePage('apca_bad', badHtml, {}, (h) => runProbe('a11y.apca_contrast', h));
  assert.ok(badRes['a11y.apca_contrast'] > 0.78 && badRes['a11y.apca_contrast'] < 0.92, `got ${badRes['a11y.apca_contrast']}`);

  const atkRes = await withFixturePage('apca_atk', atkHtml, {}, (h) => runProbe('contrast_apca', h));
  assert.ok(atkRes['a11y.apca_contrast'] <= 0.30, `got ${atkRes['a11y.apca_contrast']}`);

  const sGood = scoreHigher(good1['a11y.apca_contrast'], 1.0, 0.70);
  const sBad = scoreHigher(badRes['a11y.apca_contrast'], 1.0, 0.70);
  const sAtk = scoreHigher(atkRes['a11y.apca_contrast'], 1.0, 0.70);
  assert.ok(sGood - sBad >= 4.0);
  assert.ok(sBad - sAtk >= 4.0);
});

test('flow probe scores 10/10 on interactive lobby v0.2 fixture, ~5/10 on partial, <=1/10 on static attack', { timeout: TEST_TIMEOUT_MS }, async () => {
  const rooms = Array.from({ length: 6 }, (_, i) => ({
    id: `room-${i + 1}`,
    route: `#/room/room-${i + 1}`,
    title_ko: `전시실 ${i + 1} ${i === 0 ? '오로라빛' : '기억'}`,
    title_en: `Room ${i + 1}`,
    category: i < 4 ? 'light' : 'sound',
    duration_min: 30 - i * 4,
    status: 'open',
  }));

  const makeLobbyHtml = (mode) => `<!doctype html><html lang="ko"><head><meta charset="utf-8"><style>
    body { margin: 0; padding: 24px; font: 16px/1.5 sans-serif; min-height: 1600px; }
    .grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 16px; margin-top: 24px; }
    .card { border: 1px solid #ccc; padding: 16px; border-radius: 8px; }
    .card[hidden] { display: none; }
    [data-bench="detail-drawer"] { position: fixed; right: 0; top: 0; width: 320px; height: 100%; background: #fff; border-left: 2px solid #111; padding: 20px; }
    [data-bench="detail-drawer"][hidden] { display: none; }
  </style></head><body>
    <header data-bench="header"><h1 data-bench="hero-title">Museum</h1></header>
    ${mode === 'attack' ? '' : `
      <input data-bench="search-input" type="search" placeholder="Search" />
      <div data-bench="filter-bar">
        <button type="button" data-category="all" aria-pressed="true">All</button>
        <button type="button" data-category="light" aria-pressed="false">Light</button>
        <button type="button" data-category="sound" aria-pressed="false">Sound</button>
      </div>
      <select data-bench="sort-select">
        <option value="default">Default</option>
        <option value="duration">Duration</option>
      </select>
    `}
    <main id="cards" class="grid"></main>
    ${mode === 'attack' ? '' : `
      <aside data-bench="detail-drawer" role="dialog" aria-modal="true" hidden aria-hidden="true">
        <h2 id="drawer-title"></h2>
        <button type="button" id="drawer-close">Close</button>
        <a id="drawer-enter" data-bench="enter-room" href="#/room/room-1">Enter Room</a>
      </aside>
    `}
    <script>
      const rooms = ${JSON.stringify(rooms)};
      const state = { q: '', cat: 'all', sort: 'default', route: 'lobby', lang: 'ko' };
      const grid = document.getElementById('cards');
      const searchEl = document.querySelector('[data-bench="search-input"]');
      const sortEl = document.querySelector('[data-bench="sort-select"]');
      const drawer = document.querySelector('[data-bench="detail-drawer"]');
      const drawerTitle = document.getElementById('drawer-title');
      const drawerEnter = document.getElementById('drawer-enter');
      const drawerClose = document.getElementById('drawer-close');
      let lastTrigger = null;

      function parseHashState() {
        const h = location.hash || '';
        const rm = /^#\\/room\\/([^?]+)/.exec(h);
        if (rm) {
          state.route = rm[1];
          return;
        }
        state.route = 'lobby';
        if (${mode === 'good' ? 'true' : 'false'}) {
          const qi = h.indexOf('?');
          if (qi >= 0) {
            const sp = new URLSearchParams(h.slice(qi + 1));
            state.q = sp.get('q') || '';
            state.cat = sp.get('cat') || 'all';
            state.sort = sp.get('sort') || 'default';
          }
        }
      }

      function syncUrl() {
        if (${mode === 'good' ? 'true' : 'false'} && state.route === 'lobby') {
          const sp = new URLSearchParams();
          if (state.q) sp.set('q', state.q);
          if (state.cat !== 'all') sp.set('cat', state.cat);
          if (state.sort !== 'default') sp.set('sort', state.sort);
          const qs = sp.toString();
          history.replaceState(null, '', '#/' + (qs ? '?' + qs : ''));
        }
      }

      function render() {
        if (searchEl) searchEl.value = state.q;
        if (sortEl) sortEl.value = state.sort;
        document.querySelectorAll('[data-bench="filter-bar"] button').forEach((b) => {
          b.setAttribute('aria-pressed', b.dataset.category === state.cat ? 'true' : 'false');
        });
        let list = rooms.filter((r) => {
          if (state.cat !== 'all' && r.category !== state.cat) return false;
          if (state.q && !r.title_ko.includes(state.q) && !r.title_en.includes(state.q)) return false;
          return true;
        });
        if (state.sort === 'duration' && ${mode === 'good' ? 'true' : 'false'}) {
          list = [...list].sort((a, b) => a.duration_min - b.duration_min);
        }
        grid.innerHTML = '';
        for (const r of list) {
          const card = document.createElement('article');
          card.className = 'card';
          card.setAttribute('data-bench', 'room-card');
          card.setAttribute('data-room-id', r.id);
          card.setAttribute('data-duration', String(r.duration_min));
          const trigger = document.createElement('button');
          trigger.type = 'button';
          trigger.textContent = r.title_ko;
          trigger.addEventListener('click', () => {
            if (${mode === 'attack' ? 'true' : 'false'}) return;
            lastTrigger = trigger;
            if (drawer) {
              drawerTitle.textContent = r.title_ko;
              drawerEnter.setAttribute('href', r.route);
              drawer.hidden = false;
              drawer.setAttribute('aria-hidden', 'false');
              if (${mode === 'good' ? 'true' : 'false'}) drawerClose.focus();
            }
          });
          card.appendChild(trigger);
          grid.appendChild(card);
        }
      }

      if (searchEl) searchEl.addEventListener('input', () => { state.q = searchEl.value; syncUrl(); render(); });
      if (sortEl) sortEl.addEventListener('change', () => { state.sort = sortEl.value; syncUrl(); render(); });
      document.querySelectorAll('[data-bench="filter-bar"] button').forEach((b) => {
        b.addEventListener('click', () => { state.cat = b.dataset.category; syncUrl(); render(); });
      });

      if (drawer && ${mode === 'good' ? 'true' : 'false'}) {
        drawer.addEventListener('keydown', (e) => {
          if (e.key === 'Escape') {
            drawer.hidden = true;
            drawer.setAttribute('aria-hidden', 'true');
            lastTrigger?.focus();
          } else if (e.key === 'Tab') {
            const focusables = [drawerClose, drawerEnter];
            const idx = focusables.indexOf(document.activeElement);
            e.preventDefault();
            focusables[(idx + (e.shiftKey ? focusables.length - 1 : 1)) % focusables.length].focus();
          }
        });
        drawerClose.addEventListener('click', () => {
          drawer.hidden = true;
          drawer.setAttribute('aria-hidden', 'true');
          lastTrigger?.focus();
        });
      } else if (drawer) {
        // Partial/bad mode: fails focus trap (Tab escapes drawer to body/next element) and lacks Escape close
        const outsideBtn = document.createElement('button');
        outsideBtn.textContent = 'Outside';
        document.body.appendChild(outsideBtn);
      }

      window.addEventListener('hashchange', () => { parseHashState(); render(); });
      parseHashState();
      render();
      window.__bench = {
        version: 1, ready: Promise.resolve(), setSeed(){}, seek(){}, resume(){},
        renderFrame: async () => {},
        state: () => ({ route: state.route, lang: state.lang }),
        stats: () => ({ drawCalls: 0, triangles: 0 }),
      };
    </script>
  </body></html>`;

  const good1 = await withFixturePage('flow_good1', makeLobbyHtml('good'), { params: { rooms } }, (h) => runProbe('flow', h));
  const good2 = await withFixturePage('flow_good2', makeLobbyHtml('good'), { params: { rooms } }, (h) => runProbe('flow', h));
  assert.equal(good1['interact.scripted_flow'], 1.0, `Checkpoints: ${JSON.stringify(good1.details.checkpoints)}`);
  assert.deepEqual(good1, good2);

  const bad = await withFixturePage('flow_bad', makeLobbyHtml('bad'), { params: { rooms } }, (h) => runProbe('interact.scripted_flow', h));
  assert.ok(bad['interact.scripted_flow'] >= 0.4 && bad['interact.scripted_flow'] <= 0.6, `got ${bad['interact.scripted_flow']}`);

  const atk = await withFixturePage('flow_atk', makeLobbyHtml('attack'), { params: { rooms } }, (h) => runProbe('flow', h));
  assert.ok(atk['interact.scripted_flow'] <= 0.1, `got ${atk['interact.scripted_flow']}`);

  assert.ok((good1['interact.scripted_flow'] - bad['interact.scripted_flow']) * 10 >= 4.0);
  assert.ok((bad['interact.scripted_flow'] - atk['interact.scripted_flow']) * 10 >= 4.0);
});

test('perf_dom measures DOM mutations, layout reads, node count, CLS, and synthetic WP-0b payloads cleanly', { timeout: TEST_TIMEOUT_MS }, async () => {
  // 1. Pure synthetic WP-0b interceptor payload check
  const synthGood = await runProbe('perf_dom', { page: null }, {
    domStats: { steps: 10, dom_mutations: 80, layout_reads: 10, dom_nodes: 450, cls: 0.0 },
  });
  const synthBad = await runProbe('perf_dom', { page: null }, {
    domStats: { steps: 10, dom_mutations: 1800, layout_reads: 10, dom_nodes: 450, cls: 0.08 },
  });
  const synthAtk = await runProbe('perf_dom', { page: null }, {
    domStats: { steps: 10, dom_mutations: 4000, layout_reads: 300, dom_nodes: 2100, cls: 0.25 },
  });
  assert.equal(synthGood['budget.dom_work_profile'], 1.0);
  assert.ok(synthBad['budget.dom_work_profile'] > 0.4 && synthBad['budget.dom_work_profile'] < 0.6);
  assert.equal(synthAtk['budget.dom_work_profile'], 0.0);
  assert.equal(computeDomWorkProfile({ dom_mutations_per_step: 55, layout_reads_per_step: 4, dom_nodes: 650 }).value, 1.0);

  // 2. Live browser self-instrumented good / bad / attack fixtures
  const makePerfHtml = (mode) => `<!doctype html><html><head><meta charset="utf-8"><style>
    body { margin: 0; font: 16px/1.5 sans-serif; }
    .banner { height: 20px; background: #eee; }
    .card { padding: 8px; margin: 4px; border: 1px solid #ddd; }
    .hidden { display: none; }
  </style></head><body>
    <div id="banner" class="banner">Banner</div>
    <input data-bench="search-input" />
    <div id="list">${Array.from({ length: 48 }, (_, i) => `<div class="card" data-bench="room-card">Room ${i}</div>`).join('')}</div>
    <script>
      const input = document.querySelector('[data-bench="search-input"]');
      const list = document.getElementById('list');
      const cards = Array.from(list.children);
      if (${mode === 'attack' ? 'true' : 'false'}) {
        setTimeout(() => { document.getElementById('banner').style.height = '240px'; }, 10);
      }
      input.addEventListener('input', () => {
        const q = input.value;
        if (${mode === 'good' ? 'true' : 'false'}) {
          cards.forEach((c, idx) => c.classList.toggle('hidden', q && idx % 2 === 1));
        } else if (${mode === 'bad' ? 'true' : 'false'}) {
          // ~14 forced layout reads per step
          let sum = 0;
          for (let i = 0; i < 14; i++) sum += cards[i % cards.length].offsetWidth;
          list.dataset.w = String(sum);
        } else {
          // Attack: tear down & rebuild 350 nodes + 30 forced layout reads per step
          list.innerHTML = '';
          for (let i = 0; i < 350; i++) {
            const d = document.createElement('div');
            d.textContent = 'Rebuilt ' + i + ' ' + q;
            list.appendChild(d);
            if (i < 30) void d.offsetWidth;
          }
        }
      });
      window.__bench={version:1,ready:Promise.resolve(),setSeed(){},seek(){},resume(){},renderFrame:async()=>{},state:()=>({}),stats:()=>({drawCalls:0,triangles:0})};
    </script>
  </body></html>`;

  const good1 = await withFixturePage('pd_good1', makePerfHtml('good'), {}, (h) => runProbe('perf_dom', h));
  const good2 = await withFixturePage('pd_good2', makePerfHtml('good'), {}, (h) => runProbe('perf_dom', h));
  assert.equal(good1['budget.dom_work_profile'], 1.0);
  assert.ok(good1['perf.cls'] <= 0.01);
  assert.deepEqual(good1, good2);

  const bad = await withFixturePage('pd_bad', makePerfHtml('bad'), {}, (h) => runProbe('budget.dom_work_profile', h));
  assert.ok(bad['budget.dom_work_profile'] >= 0.4 && bad['budget.dom_work_profile'] <= 0.65, `got ${bad['budget.dom_work_profile']}`);

  const atk = await withFixturePage('pd_atk', makePerfHtml('attack'), {}, (h) => runProbe('perf_dom', h));
  assert.equal(atk['budget.dom_work_profile'], 0.0);
  assert.ok(atk['perf.cls'] >= 0.10, `Expected CLS >= 0.10 on shifted banner, got ${atk['perf.cls']}`);

  assert.ok((good1['budget.dom_work_profile'] - bad['budget.dom_work_profile']) * 10 >= 4.0);
  assert.ok((bad['budget.dom_work_profile'] - atk['budget.dom_work_profile']) * 10 >= 4.0);
});

test('theme_tri validates distinct light, dark, and prefers-contrast: more renders with 0 contrast failures', { timeout: TEST_TIMEOUT_MS }, async () => {
  const makeThemeHtml = (mode) => `<!doctype html><html><head><meta charset="utf-8"><style>
    :root { --bg: #ffffff; --fg: #111111; --border: #cccccc; }
    @media (prefers-color-scheme: dark) {
      :root { --bg: #111318; --fg: #f4f6fa; --border: #3a4152; }
    }
    ${mode === 'good' ? `
      @media (prefers-contrast: more) {
        :root { --bg: #fffef5; --fg: #000000; --border: #000000; }
        .card { border-width: 3px; }
      }
    ` : mode === 'bad_contrast' ? `
      @media (prefers-contrast: more) {
        :root { --bg: #ffffff; --fg: #6b7280; --border: #000000; }
        .card { border-width: 3px; }
      }
    ` : ''}
    body { margin: 0; padding: 24px; background: var(--bg); color: var(--fg); font: 16px/1.5 sans-serif; }
    .card { padding: 16px; border: 1px solid var(--border); }
  </style></head><body>
    <div class="card"><p>Tri-theme accessibility check</p></div>
    <script>window.__bench={version:1,ready:Promise.resolve(),setSeed(){},seek(){},resume(){},renderFrame:async()=>{},state:()=>({}),stats:()=>({drawCalls:0,triangles:0})};</script>
  </body></html>`;

  const good1 = await withFixturePage('tri_good1', makeThemeHtml('good'), {}, (h) => runProbe('theme_tri', h));
  const good2 = await withFixturePage('tri_good2', makeThemeHtml('good'), {}, (h) => runProbe('theme.tri_valid', h));
  assert.equal(good1['theme.tri_valid'], true, JSON.stringify(good1.details));
  assert.deepEqual(good1, good2);

  const atkMissingHc = await withFixturePage('tri_missing_hc', makeThemeHtml('missing_hc'), {}, (h) => runProbe('theme_tri', h));
  assert.equal(atkMissingHc['theme.tri_valid'], false);

  const atkBadHc = await withFixturePage('tri_bad_hc', makeThemeHtml('bad_contrast'), {}, (h) => runProbe('theme_tri', h));
  assert.equal(atkBadHc['theme.tri_valid'], false);
});
