import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { executePlan } from '../../src/capture/plan.mjs';
import { startServer } from '../../src/capture/server.mjs';
import { launchBrowser } from '../../src/capture/browser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../..');
const PREFERRED_WORK_BASE = path.join(REPO_ROOT, 'work', 'test-capture-v2');

let WORK_BASE = PREFERRED_WORK_BASE;
let usingTempDir = false;

before(async () => {
  try {
    await fs.mkdir(PREFERRED_WORK_BASE, { recursive: true });
    WORK_BASE = PREFERRED_WORK_BASE;
  } catch (err) {
    if (err?.code === 'EPERM' || err?.code === 'EACCES') {
      WORK_BASE = await fs.mkdtemp(path.join(os.tmpdir(), 'mol-bench-capv2-'));
      usingTempDir = true;
    } else {
      throw err;
    }
  }
});

after(async () => {
  if (usingTempDir && WORK_BASE) {
    await fs.rm(WORK_BASE, { recursive: true, force: true }).catch(() => {});
  }
});

const TEST_TIMEOUT_MS = 90_000;

test('host.js WebGL2 interceptors capture drawCalls, vertices, FBO renderPasses, shader sources, and texture/buffer uploads', { timeout: TEST_TIMEOUT_MS }, async () => {
  const fixtureDir = path.join(WORK_BASE, 'webgl2-fixture');
  const workDir = path.join(WORK_BASE, 'webgl2-work');
  await fs.rm(fixtureDir, { recursive: true, force: true });
  await fs.rm(workDir, { recursive: true, force: true });
  await fs.mkdir(fixtureDir, { recursive: true });

  await fs.writeFile(
    path.join(fixtureDir, 'index.html'),
    `<!doctype html>
<html><head><meta charset="utf-8"><title>WebGL2 Interceptors</title></head>
<body style="margin:0;overflow:hidden"><canvas id="c" width="320" height="240"></canvas>
<script>
(function () {
  const c = document.getElementById('c');
  const gl = c.getContext('webgl2', { preserveDrawingBuffer: true });
  const vs = '#version 300 es\\nin vec2 a_pos; void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }';
  const fsSrc = '#version 300 es\\nprecision highp float; out vec4 o; void main() { o = vec4(0.1, 0.6, 0.9, 1.0); }';
  function comp(t, s) { const sh = gl.createShader(t); gl.shaderSource(sh, s); gl.compileShader(sh); return sh; }
  const prog = gl.createProgram();
  gl.attachShader(prog, comp(gl.VERTEX_SHADER, vs));
  gl.attachShader(prog, comp(gl.FRAGMENT_SHADER, fsSrc));
  gl.linkProgram(prog);

  // Upload 4096 bytes of VBO + 4096 bytes of LUT texture = 8 KB
  const vbo = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(1024), gl.STATIC_DRAW);

  const lutTex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, lutTex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 32, 32, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(32 * 32 * 4));

  // Offscreen FBO (640x480 = 4x viewport area) with null backing (0 CPU upload bytes)
  const fbo = gl.createFramebuffer();
  const fboTex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, fboTex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 640, 480, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, fboTex, 0);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);

  function renderOneFrame() {
    gl.useProgram(prog);
    const loc = gl.getAttribLocation(prog, 'a_pos');
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

    // Pass 1: offscreen 640x480 FBO (4x fill) + 6 vertices instanced (3 * 2)
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.viewport(0, 0, 640, 480);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 3, 2);

    // Pass 2: default screen 320x240 (1x fill) + 3 vertices
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, 320, 240);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.finish();
  }

  renderOneFrame();
  window.__bench = {
    version: 1,
    ready: Promise.resolve(),
    setSeed() {},
    seek() {},
    resume() {},
    async renderFrame() { renderOneFrame(); },
    state() { return { ok: true }; },
    stats() { return { drawCalls: 99, triangles: 99 }; } // fake self-report; host.js must override
  };
})();
</script></body></html>`
  );

  const plan = {
    room: 'aurora',
    mode: 'swiftshader',
    captureBudgets: true,
    frames: [
      { key: 'f1', seed: 1, t: 0, viewport: '320x240', scheme: 'light', variant: 'normal', dpr: 1 },
    ],
  };

  const spec = {
    room: 'aurora',
    spec_version: '0.2.0',
    load_timeout_ms: 15000,
    metrics: [
      { id: 'budget.draw_calls', axis: 'craft', weight: 1, score: { type: 'lower', full: 2, zero: 10 } },
      { id: 'budget.render_passes', axis: 'craft', weight: 1, score: { type: 'lower', full: 2, zero: 8 } },
      { id: 'budget.transfer_kb', axis: 'craft', weight: 1, score: { type: 'lower', full: 120, zero: 500 } },
    ],
  };

  const res = await executePlan(plan, {
    submissionDir: fixtureDir,
    workDir,
    spec,
    noPython: true,
    planTimeoutMs: 60_000,
  });

  // Intercepted drawCalls must be 2 (not fake self-reported 99)
  assert.ok(res.drawCalls.length > 0);
  assert.equal(res.drawCalls[res.drawCalls.length - 1], 2);

  assert.ok(res.webglBudget, 'webglBudget summary must be returned');
  assert.equal(res.webglBudget.draw_calls, 2);
  assert.equal(res.webglBudget.vertices_drawn, 9); // 3*2 + 3
  assert.ok(res.webglBudget.gl_calls_per_frame >= 10);
  // 2 FBO switches (null->fbo, fbo->null) + (4.0 + 1.0) pixel fill = 7.0
  assert.ok(Math.abs(res.webglBudget.render_passes - 7.0) < 0.01, `expected render_passes ~7.0, got ${res.webglBudget.render_passes}`);
  // 4096 + 4096 = 8192 bytes = 8 KB (null FBO backing counts as 0)
  assert.ok(Math.abs(res.webglBudget.tex_upload_kb - 8.0) < 0.01, `expected tex_upload_kb 8.0, got ${res.webglBudget.tex_upload_kb}`);
  assert.equal(res.webglBudget.active_shaders.length, 1);
  assert.match(res.webglBudget.active_shaders[0].vertexSource, /gl_Position/);
  assert.match(res.webglBudget.active_shaders[0].fragmentSource, /0\.6/);

  // CDP transfer bytes recorded
  assert.ok(res.transferKb > 0 && res.transferKb < 50, `unexpected transferKb: ${res.transferKb}`);
  assert.ok(res.probes._budget_transfer?.metrics?.['budget.transfer_kb'] > 0);
  assert.ok(res.probes._budget_render_passes_f1?.metrics?.['budget.render_passes'] >= 7.0);
  assert.ok(res.toolchain && res.toolchain.chromium_version);

  const manifest = JSON.parse(await fs.readFile(res.manifestPath, 'utf8'));
  assert.equal(manifest.webgl_budget.draw_calls, 2);
  assert.equal(manifest.webgl_budget.vertices_drawn, 9);
  assert.ok(manifest.transfer_kb > 0);
});

test('host.js DOM interceptors, 200% root font zoom, prefers-contrast: more, and lang_ja work accurately', { timeout: TEST_TIMEOUT_MS }, async () => {
  const fixtureDir = path.join(WORK_BASE, 'dom-v2-fixture');
  await fs.rm(fixtureDir, { recursive: true, force: true });
  await fs.mkdir(fixtureDir, { recursive: true });

  await fs.writeFile(
    path.join(fixtureDir, 'index.html'),
    `<!doctype html>
<html><head><meta charset="utf-8"><style>
  html { font-size: 16px; }
  body { margin: 0; font-size: 1rem; }
  .box { width: 100px; height: 2rem; background: #eee; color: #111; }
  @media (prefers-contrast: more) {
    .box { background: #000; color: #fff; border: 2px solid #fff; }
  }
</style></head>
<body>
  <div id="list"><div class="box" id="target">Item</div></div>
  <button id="step-btn" type="button">Filter</button>
<script>
  document.getElementById('step-btn').addEventListener('click', () => {
    const list = document.getElementById('list');
    // 2 forced layout reads
    void list.offsetWidth;
    void document.getElementById('target').getBoundingClientRect();
    void window.getComputedStyle(list).width;
    // 2 DOM mutations (add 2 nodes)
    const d1 = document.createElement('div'); d1.textContent = 'A';
    const d2 = document.createElement('div'); d2.textContent = 'B';
    list.appendChild(d1);
    list.appendChild(d2);
  });
  window.__bench = {
    version: 1,
    ready: Promise.resolve(),
    setSeed() {}, seek() {}, resume() {},
    async renderFrame() {},
    state() {
      return {
        rootFontPx: getComputedStyle(document.documentElement).fontSize,
        highContrast: window.matchMedia('(prefers-contrast: more)').matches,
        lang: navigator.language,
      };
    },
    stats() { return { drawCalls: 0, triangles: 0 }; }
  };
</script></body></html>`
  );

  let server = null;
  let browser = null;
  try {
    server = await startServer(fixtureDir);
    browser = await launchBrowser({ mode: 'swiftshader' });
    const localResolver = server.loopbackReachable ? null : server.resolveFile;

    // 1. Test 1440x900@zoom200 + prefers-contrast: more + ja-JP
    const h = await browser.newPage({
      origin: server.origin,
      url: server.url,
      localResolver,
      viewport: '1440x900@zoom200',
      colorScheme: 'high_contrast',
      locale: 'ja-JP',
    });
    try {
      const st = await h.state();
      assert.equal(st.rootFontPx, '32px', '1440x900@zoom200 must set html font-size to 32px');
      assert.equal(st.highContrast, true, 'high_contrast must enable prefers-contrast: more');
      assert.equal(st.lang, 'ja-JP', 'locale ja-JP must override navigator.language');

      // Verify rem box doubled in height (2rem * 32px = 64px) + 2px top/bottom border from prefers-contrast: more = 68px
      await h.setDomBypass(true);
      const boxHeight = await h.page.evaluate(() => document.getElementById('target').getBoundingClientRect().height);
      await h.setDomBypass(false);
      assert.equal(boxHeight, 68);

      // Reset DOM metrics, trigger step, check layoutReads & domMutations
      await h.resetDomMetrics();
      await h.page.click('#step-btn');
      const domMetrics = await h.getDomMetrics();
      assert.equal(domMetrics.domMutations, 2, `expected 2 mutations, got ${domMetrics.domMutations}`);
      assert.equal(domMetrics.addedNodes, 2);
      assert.equal(domMetrics.layoutReads, 3, `expected 3 layout reads, got ${domMetrics.layoutReads}`);
      assert.ok(domMetrics.domNodes >= 8);

      // Verify setDomBypass prevents probe reads from incrementing layoutReads
      await h.setDomBypass(true);
      await h.page.evaluate(() => {
        void document.body.offsetWidth;
        void document.body.getBoundingClientRect();
      });
      await h.setDomBypass(false);
      const afterBypass = await h.getDomMetrics();
      assert.equal(afterBypass.layoutReads, 3, 'bypassed probe reads must not increment layoutReads');
    } finally {
      await h.close();
    }
  } finally {
    await browser?.close().catch(() => {});
    await server?.close().catch(() => {});
  }
});

test('plan.mjs executes nav_transition steps for both normal and reduced_motion variants', { timeout: TEST_TIMEOUT_MS }, async () => {
  const fixtureDir = path.join(WORK_BASE, 'nav-transition-fixture');
  const workDir = path.join(WORK_BASE, 'nav-transition-work');
  await fs.rm(fixtureDir, { recursive: true, force: true });
  await fs.rm(workDir, { recursive: true, force: true });
  await fs.mkdir(fixtureDir, { recursive: true });

  await fs.writeFile(
    path.join(fixtureDir, 'index.html'),
    `<!doctype html>
<html><head><meta charset="utf-8"><style>
  body { margin: 0; font-family: sans-serif; }
  #panel { width: 320px; height: 180px; background: #1e293b; color: #fff; opacity: 1; transition: opacity 240ms linear; }
  body.navigating #panel { background: #dc2626; opacity: 0.25; }
  @media (prefers-reduced-motion: reduce) {
    #panel { transition-duration: 0ms; }
  }
</style></head>
<body>
  <div data-bench="room-card"><a id="go" href="#/room/aurora">Aurora</a></div>
  <div id="panel">Lobby</div>
<script>
  document.getElementById('go').addEventListener('click', () => {
    document.body.classList.add('navigating');
  });
  window.__bench = {
    version: 1,
    ready: Promise.resolve(),
    setSeed() {}, seek() {}, resume() {},
    async renderFrame() {},
    state() { return { route: location.hash || 'lobby' }; },
    stats() { return { drawCalls: 0, triangles: 0 }; }
  };
</script></body></html>`
  );

  const plan = {
    room: 'lobby',
    mode: 'swiftshader',
    frames: [],
    steps: [
      { kind: 'step', key: 'nav_transition_s1_normal', stepKind: 'nav_transition', seed: 1, variant: 'normal', stepMs: 32, maxMs: 600 },
      { kind: 'step', key: 'nav_transition_s1_reduced_motion', stepKind: 'nav_transition', seed: 1, variant: 'reduced_motion', stepMs: 32, maxMs: 600 },
    ],
  };

  const res = await executePlan(plan, {
    submissionDir: fixtureDir,
    workDir,
    spec: { room: 'lobby', spec_version: '0.2.0', load_timeout_ms: 15000, metrics: [] },
    noPython: true,
    planTimeoutMs: 60_000,
  });

  const norm = res.probes.nav_transition_s1_normal;
  const red = res.probes.nav_transition_s1_reduced_motion;
  assert.ok(norm && norm.details.triggered, 'normal nav_transition must trigger card navigation');
  assert.equal(typeof norm['nav.transition_ms'], 'number');
  assert.equal(norm.metrics['nav.transition_ms'], norm['nav.transition_ms']);
  assert.equal(norm.details.clickDiag.reducedMotion, false);
  assert.ok(norm['nav.transition_ms'] >= 150, `expected normal transition >=150ms, got ${norm['nav.transition_ms']}`);

  assert.ok(red && red.details.triggered, 'reduced_motion nav_transition must trigger card navigation');
  assert.equal(typeof red['a11y.reduced_motion_transition_ms'], 'number');
  assert.equal(red.metrics['a11y.reduced_motion_transition_ms'], red['a11y.reduced_motion_transition_ms']);
  assert.equal(red['nav.transition_ms'], undefined, 'reduced_motion step must not emit nav.transition_ms key');
  assert.equal(red.details.clickDiag.reducedMotion, true);
  assert.ok(red['a11y.reduced_motion_transition_ms'] < norm['nav.transition_ms'], `expected reduced_motion (${red['a11y.reduced_motion_transition_ms']}) < normal (${norm['nav.transition_ms']})`);
});
