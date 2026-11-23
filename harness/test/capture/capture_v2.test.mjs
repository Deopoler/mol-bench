import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { executePlan } from '../../src/capture/plan.mjs';
import { startServer } from '../../src/capture/server.mjs';
import { launchBrowser } from '../../src/capture/browser.mjs';
import { extraCapture as restorationExtraCapture } from '../../src/rooms/restoration.mjs';
import { createDomHostAdapter } from '../../src/capture/probes/perf_dom.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../..');
const PREFERRED_WORK_BASE = path.join(REPO_ROOT, 'work', 'test-capture-v2');

let WORK_BASE = PREFERRED_WORK_BASE;
let usingTempDir = false;

before(async () => {
  try {
    await fs.mkdir(PREFERRED_WORK_BASE, { recursive: true });
    const probe = await fs.mkdtemp(path.join(PREFERRED_WORK_BASE, '.probe-'));
    await fs.rm(probe, { recursive: true, force: true });
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
      { key: 'f2', seed: 1, t: 500, viewport: '320x240', scheme: 'light', variant: 'normal', dpr: 1 },
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

  // Intercepted drawCalls must be 2 per frame (not fake self-reported 99)
  assert.ok(res.drawCalls.length >= 2);
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

  // Validate exact WP-1 budget_glsl.py manifest.webgl & samples[i].webgl snake_case schema (.metrics-v2-from-wp1.md §1.3)
  assert.equal(typeof manifest.bundle_gz_kb, 'number');
  assert.ok(manifest.bundle_gz_kb > 0);
  const wgl = manifest.webgl;
  assert.ok(wgl && typeof wgl === 'object', 'manifest.webgl must exist for WebGL submissions');
  assert.equal(Array.isArray(wgl.programs), true);
  assert.equal(wgl.programs.length, 1, 'identical linked program must be deduped across multi-frame capture');
  assert.equal(typeof wgl.programs[0].vertex, 'string');
  assert.equal(typeof wgl.programs[0].fragment, 'string');
  assert.match(wgl.programs[0].vertex, /gl_Position/);
  assert.match(wgl.programs[0].fragment, /0\.6/);
  assert.equal(wgl.programs[0].draw_calls, 2, 'per-frame program draw_calls must equal 2');
  assert.equal(wgl.programs[0].vertices_drawn, 9, 'per-frame program vertices_drawn must equal 9');
  assert.equal(wgl.draw_calls_per_frame, 2);
  assert.equal(wgl.fbo_switches, 2);
  assert.ok(Math.abs(wgl.pixel_fill_ratio - 5.0) < 0.01, `expected pixel_fill_ratio ~5.0, got ${wgl.pixel_fill_ratio}`);
  assert.equal(wgl.vertices_drawn_per_frame, 9);
  assert.equal(wgl.triangles_per_frame, 3);
  assert.ok(Math.abs(wgl.tex_upload_kb - 8.0) < 0.01);
  assert.ok(typeof wgl.gl_calls_per_frame === 'number' && wgl.gl_calls_per_frame >= 10);
  assert.equal(wgl.bundle_gz_kb, manifest.bundle_gz_kb);

  assert.equal(manifest.samples.length, 2);
  for (const s of manifest.samples) {
    assert.ok(s.webgl && typeof s.webgl === 'object');
    assert.equal(s.webgl.programs.length, 1);
    assert.equal(s.webgl.draw_calls_per_frame, 2);
    assert.equal(s.webgl.vertices_drawn_per_frame, 9);
    assert.equal(s.webgl.triangles_per_frame, 3);
    assert.equal(s.webgl.bundle_gz_kb, manifest.bundle_gz_kb);
  }
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

      // Verify WP-1 perf_dom.js snake_case shape via getDomBudgetStats() (.metrics-v2-from-wp1.md §2.1)
      const domStats = await h.getDomBudgetStats();
      assert.deepEqual(Object.keys(domStats).sort(), ['cls', 'dom_mutations', 'dom_nodes', 'layout_reads', 'ready', 'steps']);
      assert.equal(domStats.ready, true);
      assert.equal(typeof domStats.steps, 'number');
      assert.equal(domStats.dom_mutations, 2);
      assert.equal(domStats.layout_reads, 3);
      assert.ok(domStats.dom_nodes >= 8);
      assert.equal(typeof domStats.cls, 'number');

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

test('host.js blocks unauthorized __benchHostControl mutations, fails G-tamper, stubs navigator.gpu, counts 3D/copy uploads, and flags unhooked rendering', { timeout: TEST_TIMEOUT_MS }, async () => {
  const tamperDir = path.join(WORK_BASE, 'tamper-fixture');
  const tamperWork = path.join(WORK_BASE, 'tamper-work');
  const glExtDir = path.join(WORK_BASE, 'gl-ext-fixture');
  const glExtWork = path.join(WORK_BASE, 'gl-ext-work');
  for (const d of [tamperDir, tamperWork, glExtDir, glExtWork]) {
    await fs.rm(d, { recursive: true, force: true });
  }
  await fs.mkdir(tamperDir, { recursive: true });
  await fs.mkdir(glExtDir, { recursive: true });

  // 1. Page JS attempts to tamper with __benchHostControl mutators and create a worker/webgpu context
  await fs.writeFile(
    path.join(tamperDir, 'index.html'),
    `<!doctype html>
<html><head><meta charset="utf-8"></head>
<body>
  <canvas id="c" width="160" height="120"></canvas>
  <script>
    window.__initWasPresent = '__BENCH_HOST_INIT__' in window;
    window.__gpuValue = typeof navigator.gpu === 'undefined' ? 'undefined' : 'defined';
    const c = document.getElementById('c');
    window.__webgpuCtx = c.getContext('webgpu');
    const gl = c.getContext('webgl2', { preserveDrawingBuffer: true });
    // Attempt unauthorized mutator calls
    window.__benchHostControl.markDomStep(1e9);
    window.__benchHostControl.setInternalBypass(true);
    window.__benchHostControl.resetDomMetrics({ resetCls: true });
    window.__benchHostControl.resetWebGLFrameMetrics();
    window.__benchHostControl.freeze(999999);
    // Genuine DOM mutation should still be recorded because setInternalBypass(true) was blocked
    const div = document.createElement('div');
    div.textContent = 'legit';
    document.body.appendChild(div);
    // Genuine GL draw should still work
    const vs = '#version 300 es\\nin vec2 p; void main(){ gl_Position=vec4(p,0.0,1.0); }';
    const fsS = '#version 300 es\\nprecision mediump float; out vec4 o; void main(){ o=vec4(1.0); }';
    function sh(t,s){ const x=gl.createShader(t); gl.shaderSource(x,s); gl.compileShader(x); return x; }
    const pr = gl.createProgram(); gl.attachShader(pr, sh(gl.VERTEX_SHADER, vs)); gl.attachShader(pr, sh(gl.FRAGMENT_SHADER, fsS)); gl.linkProgram(pr);
    const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1,3,-1,-1,3]), gl.STATIC_DRAW);
    function draw() {
      gl.useProgram(pr);
      const loc = gl.getAttribLocation(pr, 'p');
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    draw();
    window.__bench = {
      version: 1,
      ready: Promise.resolve(),
      setSeed() {}, seek() {}, resume() {},
      async renderFrame() {
        draw();
        // Also try resetting at end of renderFrame to hide draw calls
        window.__benchHostControl.resetWebGLFrameMetrics();
      },
      state() { return { initPresent: window.__initWasPresent, gpu: window.__gpuValue, webgpuCtx: window.__webgpuCtx === null }; },
      stats() { return { drawCalls: 1, triangles: 1 }; }
    };
  </script>
</body></html>`
  );

  const tamperRes = await executePlan(
    { room: 'aurora', mode: 'swiftshader', frames: [{ key: 'f1', seed: 1, t: 0, viewport: '320x240', scheme: 'light', variant: 'normal', dpr: 1 }] },
    {
      submissionDir: tamperDir,
      workDir: tamperWork,
      spec: { room: 'aurora', spec_version: '0.2.0', load_timeout_ms: 15000, metrics: [{ id: 'budget.draw_calls', axis: 'craft', weight: 1, score: { type: 'lower', full: 2, zero: 10 } }] },
      noPython: true,
      planTimeoutMs: 60_000,
    },
  );
  const tamperManifest = JSON.parse(await fs.readFile(tamperRes.manifestPath, 'utf8'));
  assert.equal(tamperRes.gates['G-tamper'].pass, false, 'G-tamper must fail when page JS invokes mutators');
  assert.equal(tamperManifest.tamper.detected, true);
  assert.ok(tamperManifest.tamper.count >= 5);
  assert.equal(tamperManifest.webgl.draw_calls_per_frame, 1, 'blocked resetWebGLFrameMetrics() must not erase draw calls');
  assert.ok(tamperManifest.dom_budget.domMutations >= 1, 'blocked setInternalBypass(true) must not suppress DOM mutation counting');
  assert.equal(tamperRes.gates['G-webgl-hook'].pass, false, 'webgpu getContext must fail G-webgl-hook');
  assert.equal(tamperManifest.unhooked_rendering.detected, true);
  assert.ok(tamperManifest.unhooked_rendering.reasons.includes('webgpu_context'));

  // 2. Test navigator.gpu stub, 3D/compressed/copyBufferSubData uploads, and clean DOM/WebGL2 passes G-tamper & G-webgl-hook
  await fs.writeFile(
    path.join(glExtDir, 'index.html'),
    `<!doctype html>
<html><head><meta charset="utf-8"></head>
<body>
  <canvas id="c" width="160" height="120"></canvas>
  <script>
    const c = document.getElementById('c');
    const gl = c.getContext('webgl2', { preserveDrawingBuffer: true });
    // Upload 4096B via copyBufferSubData + 2048B via texImage3D
    const b1 = gl.createBuffer(); gl.bindBuffer(gl.COPY_READ_BUFFER, b1);
    gl.bufferData(gl.COPY_READ_BUFFER, new Uint8Array(4096), gl.STATIC_DRAW);
    const b2 = gl.createBuffer(); gl.bindBuffer(gl.COPY_WRITE_BUFFER, b2);
    gl.bufferData(gl.COPY_WRITE_BUFFER, 4096, gl.STATIC_DRAW);
    gl.copyBufferSubData(gl.COPY_READ_BUFFER, gl.COPY_WRITE_BUFFER, 0, 0, 4096);
    const t3 = gl.createTexture(); gl.bindTexture(gl.TEXTURE_3D, t3);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA8, 8, 8, 8, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(2048));
    // Trigger extension hooks cleanly if available
    const vaoExt = gl.getExtension('OES_vertex_array_object');
    const multiExt = gl.getExtension('WEBGL_multi_draw');
    const vs = '#version 300 es\\nin vec2 p; void main(){ gl_Position=vec4(p,0.0,1.0); }';
    const fsS = '#version 300 es\\nprecision mediump float; out vec4 o; void main(){ o=vec4(0.2,0.8,0.4,1.0); }';
    function sh(t,s){ const x=gl.createShader(t); gl.shaderSource(x,s); gl.compileShader(x); return x; }
    const pr = gl.createProgram(); gl.attachShader(pr, sh(gl.VERTEX_SHADER, vs)); gl.attachShader(pr, sh(gl.FRAGMENT_SHADER, fsS)); gl.linkProgram(pr);
    const vb = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, vb); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1,3,-1,-1,3]), gl.STATIC_DRAW);
    function draw() {
      gl.useProgram(pr);
      const loc = gl.getAttribLocation(pr, 'p');
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    draw();
    window.__bench = {
      version: 1,
      ready: Promise.resolve(),
      setSeed() {}, seek() {}, resume() {},
      async renderFrame() { draw(); },
      state() { return { gpuStubbed: typeof navigator.gpu === 'undefined', hasMulti: Boolean(multiExt), hasVao: Boolean(vaoExt) }; },
      stats() { return { drawCalls: 1, triangles: 1 }; }
    };
  </script>
</body></html>`
  );

  const extRes = await executePlan(
    { room: 'aurora', mode: 'swiftshader', frames: [{ key: 'f1', seed: 1, t: 0, viewport: '320x240', scheme: 'light', variant: 'normal', dpr: 1 }] },
    {
      submissionDir: glExtDir,
      workDir: glExtWork,
      spec: { room: 'aurora', spec_version: '0.2.0', load_timeout_ms: 15000, metrics: [{ id: 'budget.draw_calls', axis: 'craft', weight: 1, score: { type: 'lower', full: 2, zero: 10 } }] },
      noPython: true,
      planTimeoutMs: 60_000,
    },
  );
  const extManifest = JSON.parse(await fs.readFile(extRes.manifestPath, 'utf8'));
  assert.equal(extRes.gates['G-tamper'].pass, true);
  assert.equal(extRes.gates['G-webgl-hook'].pass, true);
  // 4096 (copy_read) + 4096 (copy_write) + 4096 (copyBufferSubData) + 2048 (texImage3D) + 24 (vb) = 14360 bytes ~ 14.02 KB
  assert.ok(extManifest.webgl.tex_upload_kb >= 14.0, `expected >=14.0 KB uploads, got ${extManifest.webgl.tex_upload_kb}`);
});

test('restoration.mjs extraCapture remains behavior-neutral with controlSecret protection for v0.1 compatibility', { timeout: TEST_TIMEOUT_MS }, async () => {
  const restDir = path.join(WORK_BASE, 'restoration-neutral-fixture');
  const restWork = path.join(WORK_BASE, 'restoration-neutral-work');
  await fs.rm(restDir, { recursive: true, force: true });
  await fs.rm(restWork, { recursive: true, force: true });
  await fs.mkdir(restDir, { recursive: true });
  await fs.mkdir(path.join(restWork, 'frames'), { recursive: true });

  await fs.writeFile(
    path.join(restDir, 'index.html'),
    `<!doctype html>
<html><head><meta charset="utf-8"><style>html,body{margin:0;width:100%;height:100%}</style></head>
<body>
  <div id="orrery-stage"><canvas id="c" width="200" height="150"></canvas></div>
  <button data-bench="next-planet" type="button">Next</button>
<script>
  let seed = 1, focused = 0, tNow = 0, rafs = [], running = false;
  document.querySelector('[data-bench="next-planet"]').addEventListener('click', () => { focused = (focused + 1) % 7; });
  function loop() {
    if (!running) return;
    tNow = window.__benchHost.clock.now();
    requestAnimationFrame(loop);
  }
  window.__bench = {
    version: 1,
    ready: Promise.resolve(),
    setSeed(s) { seed = s; },
    seek(t) { running = false; tNow = t; },
    resume() { running = true; requestAnimationFrame(loop); },
    async renderFrame() { tNow = window.__benchHost.clock.now(); },
    mount(el) { if (el && !el.querySelector('canvas')) { const c = document.createElement('canvas'); c.width = 200; c.height = 150; el.appendChild(c); } },
    unmount() { const c = document.querySelector('#orrery-stage canvas'); if (c) c.remove(); },
    state() { return { seed, tNow, focusedIndex: focused, orbitAngleDeg: (tNow / 5000) * 180 }; },
    stats() { return { drawCalls: 0, triangles: 0, geometries: 1, textures: 0, programs: 1, listeners: 0 }; }
  };
</script></body></html>`
  );

  let server = null;
  let browserSession = null;
  try {
    server = await startServer(restDir);
    browserSession = await launchBrowser({ mode: 'swiftshader' });
    const localResolver = server.loopbackReachable ? null : server.resolveFile;
    const h = await browserSession.newPage({
      origin: server.origin,
      url: server.url,
      localResolver,
      viewport: '1440x900',
      seed: 1,
      params: {},
    });
    const manifest = { samples: [{ key: 's1', seed: 1, t: 1000, viewport: '1440x900', dpr: 1 }], sequences: [] };
    const probes = {};
    try {
      await restorationExtraCapture({
        page: h.page,
        controlSecret: h.controlSecret,
        workDir: restWork,
        manifest,
        probes,
        spec: { room: 'restoration', capture: { public_seeds: [1] } },
        seeds: [1],
      });
      const tamper = await h.getTamperStatus();
      assert.equal(tamper.tampered, false, 'restoration.mjs must pass controlSecret and never trigger G-tamper');
      assert.equal(manifest.samples[0].state.tNow, 1000, 'freeze(1000) via controlSecret must set clock accurately');
      assert.ok(manifest.samples.some((s) => s.variant === 'resize_seq'));
      const clockEntry = Object.values(probes).find((p) => p?.metrics?.['anim.clock_independence'] !== undefined);
      assert.ok(clockEntry && clockEntry.metrics['anim.clock_independence'] < 0.1, 'setVirtualClock must drive 30Hz vs 144Hz deterministically');
    } finally {
      await h.close();
    }
  } finally {
    await browserSession?.close().catch(() => {});
    await server?.close().catch(() => {});
  }
});

test('host.js DOM interceptors track attributes, characterData, open ShadowRoot, deep iframe nodes, extra layout reads, and perf_dom createDomHostAdapter', { timeout: TEST_TIMEOUT_MS }, async () => {
  const dir = path.join(WORK_BASE, 'dom-extended-fixture');
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });

  await fs.writeFile(
    path.join(dir, 'index.html'),
    `<!doctype html>
<html><head><meta charset="utf-8"><style>
  html, body { margin: 0; padding: 0; }
  #text-target { width: 120px; height: 24px; }
</style></head>
<body>
  <div id="text-target" data-state="init">hello</div>
  <div id="shadow-host"></div>
  <svg width="100" height="40"><rect id="svg-rect" x="0" y="0" width="50" height="20"></rect></svg>
  <iframe id="child" srcdoc="<!doctype html><html><body><p>in-iframe</p><span>x</span></body></html>"></iframe>
<script>
  const hostEl = document.getElementById('shadow-host');
  const sr = hostEl.attachShadow({ mode: 'open' });
  const srChild = document.createElement('div');
  srChild.textContent = 'shadow-item';
  sr.appendChild(srChild);

  window.__triggerDomWork = () => {
    const t = document.getElementById('text-target');
    // 1. Attribute mutation (+1)
    t.setAttribute('data-state', 'updated');
    // 2. characterData mutation (+1)
    t.firstChild.nodeValue = 'world';
    // 3. Open ShadowRoot childList + attribute mutation (+2)
    const span = document.createElement('span');
    sr.appendChild(span);
    srChild.setAttribute('data-active', '1');

    // Extended layout reads (5 total):
    void t.innerText;
    void document.elementFromPoint(10, 10);
    void sr.elementFromPoint(10, 10);
    const range = document.createRange();
    range.selectNodeContents(t);
    void range.getBoundingClientRect();
    void document.getElementById('svg-rect').getBBox();
  };

  window.__bench = {
    version: 1,
    ready: new Promise((resolve) => {
      document.getElementById('child').addEventListener('load', () => resolve(), { once: true });
      setTimeout(resolve, 300);
    }),
    setSeed() {}, seek() {}, resume() {},
    async renderFrame() {},
    state() { return { ok: true }; },
    stats() { return { drawCalls: 0, triangles: 0 }; }
  };
</script></body></html>`
  );

  let server = null;
  let browserSession = null;
  try {
    server = await startServer(dir);
    browserSession = await launchBrowser({ mode: 'swiftshader' });
    const localResolver = server.loopbackReachable ? null : server.resolveFile;
    const h = await browserSession.newPage({
      origin: server.origin,
      url: server.url,
      localResolver,
      viewport: '800x600',
      seed: 1,
      params: {},
    });
    try {
      const adapter = createDomHostAdapter(h);
      assert.equal(await adapter.isAvailable(), true, 'createDomHostAdapter must detect host.js readiness');
      await adapter.beginMeasurement();
      await h.page.evaluate(() => window.__triggerDomWork());
      await adapter.markStep(2);

      const stats = await adapter.readStats();
      assert.equal(stats.ready, true);
      assert.equal(stats.steps, 2, 'markDomStep via pageHandle.markDomStep must update secret-gated steps');
      assert.equal(stats.dom_mutations, 4, `expected 4 mutations (attr + charData + shadow childList + shadow attr), got ${stats.dom_mutations}`);
      assert.equal(stats.layout_reads, 5, `expected 5 layout reads (innerText + doc/sr elementFromPoint + Range.getBoundingClientRect + SVG.getBBox), got ${stats.layout_reads}`);

      // Deep node count must include shadowRoot children (div + span = 2) AND same-origin iframe nodes (html,head,body,p,span = 5)
      const shallowCount = await h.page.evaluate(() => document.getElementsByTagName('*').length);
      assert.ok(stats.dom_nodes >= shallowCount + 7, `expected deep dom_nodes (${stats.dom_nodes}) >= shallow (${shallowCount}) + 7`);

      const tamper = await h.getTamperStatus();
      assert.equal(tamper.tampered, false, 'createDomHostAdapter through browser.mjs handle must not trigger G-tamper');
    } finally {
      await h.close();
    }
  } finally {
    await browserSession?.close().catch(() => {});
    await server?.close().catch(() => {});
  }
});

test('review-2 hardening: primitive evaluate packets resist Array/String/JSON tampering, Worker/transient-iframe/CSP bypasses, missing init fail-closed, steps=0, and uncapped tamperCount', { timeout: TEST_TIMEOUT_MS }, async () => {
  const secDir = path.join(WORK_BASE, 'sec-hardening-fixture');
  const secWork = path.join(WORK_BASE, 'sec-hardening-work');
  const domWork = path.join(WORK_BASE, 'sec-dom-ok-work');
  for (const d of [secDir, secWork, domWork]) {
    await fs.rm(d, { recursive: true, force: true });
  }
  await fs.mkdir(secDir, { recursive: true });

  // 1. Page attempts Array.prototype.push/map/String.prototype.slice/JSON.parse interception,
  //    calls Worker.prototype.constructor, creates & removes transient iframe, floods >100 bad mutator calls,
  //    and leaves domSteps === 0.
  await fs.writeFile(
    path.join(secDir, 'index.html'),
    `<!doctype html>
<html><head><meta charset="utf-8"></head>
<body>
  <canvas id="c" width="80" height="80"></canvas>
  <script>
    window.__stolen = [];
    const origPush = Array.prototype.push;
    Array.prototype.push = function(...args) {
      for (const a of args) if (typeof a === 'string' && a.length >= 24) origPush.call(window.__stolen, 'push:' + a);
      return origPush.apply(this, args);
    };
    const origMap = Array.prototype.map;
    Array.prototype.map = function(fn, thisArg) {
      return origMap.call(this, function(x, i, arr) {
        if (typeof x === 'string' && x.length >= 24) origPush.call(window.__stolen, 'map:' + x);
        return fn.call(thisArg, x, i, arr);
      });
    };
    const origSlice = String.prototype.slice;
    String.prototype.slice = function(...args) {
      if (this.length >= 40) origPush.call(window.__stolen, 'slice:' + String(this));
      return origSlice.apply(this, args);
    };
    const origParse = JSON.parse;
    JSON.parse = function(text, ...rest) {
      if (typeof text === 'string' && text.includes('"')) origPush.call(window.__stolen, 'json:' + text);
      return origParse.call(this, text, ...rest);
    };

    // Bypass attempt 1: Worker.prototype.constructor (with CSP worker-src 'none' active on GL plan)
    window.__workerMsgs = [];
    window.__workerBlockedErr = '';
    window.addEventListener('securitypolicyviolation', (ev) => {
      if (ev.violatedDirective === 'worker-src') {
        window.__workerBlockedErr = 'csp:' + ev.violatedDirective;
      }
    });
    try {
      const Ctor = Worker.prototype.constructor;
      const w = new Ctor('data:application/javascript,postMessage("RAN")');
      w.onmessage = (m) => origPush.call(window.__workerMsgs, m.data);
      w.onerror = () => { if (!window.__workerBlockedErr) window.__workerBlockedErr = 'worker-error'; };
    } catch (e) {
      window.__workerBlockedErr = String(e?.message || e);
    }
    // Bypass attempt 2: transient iframe removed immediately
    const ifr = document.createElement('iframe');
    ifr.srcdoc = '<!doctype html><canvas></canvas>';
    document.body.appendChild(ifr);
    ifr.remove();

    // Flood > 105 unauthorized mutator calls to verify tamperCount is uncapped
    for (let i = 0; i < 105; i++) {
      window.__benchHostControl.markDomStep(100);
    }

    const c = document.getElementById('c');
    const gl = c.getContext('webgl2', { preserveDrawingBuffer: true });
    window.__bench = {
      version: 1,
      ready: Promise.resolve(),
      setSeed() {}, seek() {}, resume() {},
      async renderFrame() {},
      state() {
        Array.prototype.push = origPush;
        Array.prototype.map = origMap;
        String.prototype.slice = origSlice;
        JSON.parse = origParse;
        return {
          stolen: [...window.__stolen],
          workerBlocked: Boolean(window.__workerBlockedErr),
          workerBlockedErr: window.__workerBlockedErr,
          workerMsgs: [...window.__workerMsgs],
        };
      },
      stats() { return { drawCalls: 0, triangles: 0 }; }
    };
  </script>
</body></html>`
  );

  // Run against a WebGL spec (expectsWebGL=true) -> CSP worker-src 'none' + G-webgl-hook fail + G-tamper fail
  const glRes = await executePlan(
    { room: 'aurora', mode: 'swiftshader', frames: [{ key: 'f1', seed: 1, t: 0, viewport: '320x240', scheme: 'light', variant: 'normal', dpr: 1 }] },
    {
      submissionDir: secDir,
      workDir: secWork,
      spec: { room: 'aurora', spec_version: '0.2.0', load_timeout_ms: 15000, metrics: [{ id: 'budget.draw_calls', axis: 'craft', weight: 1, score: { type: 'lower', full: 2, zero: 10 } }] },
      noPython: true,
      planTimeoutMs: 60_000,
    },
  );

  // Verify DOM room (expectsWebGL=false) does NOT fail G-webgl-hook due to iframe or worker
  const domRes = await executePlan(
    { room: 'lobby', mode: 'swiftshader', frames: [{ key: 'f1', seed: 1, t: 0, viewport: '320x240', scheme: 'light', variant: 'normal', dpr: 1 }] },
    {
      submissionDir: secDir,
      workDir: domWork,
      spec: { room: 'lobby', spec_version: '0.2.0', load_timeout_ms: 15000, metrics: [{ id: 'report.honesty', axis: 'reliability', weight: 1, score: { type: 'higher', full: 10, zero: 0 } }] },
      noPython: true,
      planTimeoutMs: 60_000,
    },
  );

  const glManifest = JSON.parse(await fs.readFile(glRes.manifestPath, 'utf8'));
  assert.equal(glRes.gates['G-tamper'].pass, false);
  assert.ok(glManifest.tamper.count >= 105, `expected uncapped tamper.count >= 105, got ${glManifest.tamper.count}`);
  assert.ok(glManifest.tamper.first_event && glManifest.tamper.first_event.method === 'markDomStep');
  assert.equal(glRes.gates['G-webgl-hook'].pass, false, 'GL room must fail G-webgl-hook on Worker.prototype.constructor & transient iframe');
  assert.ok(glManifest.unhooked_rendering.reasons.includes('worker_created'));
  assert.ok(glManifest.unhooked_rendering.reasons.includes('iframe_detected'));
  assert.ok(glManifest.unhooked_rendering.iframe_count >= 1);
  assert.equal(domRes.gates['G-webgl-hook'].pass, true, 'DOM room without GL requirements must NOT fail G-webgl-hook on iframe/worker');

  // Verify direct browser session with Array.prototype overridden leaks 0 secrets, steps defaults to 0, and missing __BENCH_HOST_INIT__ fails closed
  let srv = null;
  let browserSession = null;
  try {
    srv = await startServer(secDir);
    browserSession = await launchBrowser({ mode: 'swiftshader' });
    const h = await browserSession.newPage({
      origin: srv.origin,
      url: srv.url,
      localResolver: srv.loopbackReachable ? null : srv.resolveFile,
      viewport: '320x240',
      seed: 1,
      params: {},
      blockWorkers: true,
    });
    try {
      await h.resetDomMetrics({ steps: 0 });
      await h.setDomBypass(true);
      await h.setDomBypass(false);
      await h.setSeed(7, { a: 1 });
      await h.seek(123);
      const stats0 = await h.getDomBudgetStats();
      assert.equal(stats0.steps, 0, 'getDomBudgetStats().steps must return 0 when no steps ran');
      const st = await h.state();
      assert.equal(st.stolen.some((s) => s.includes(h.controlSecret)), false, `secret must never leak: ${JSON.stringify(st.stolen)}`);
      assert.equal(st.stolen.some((s) => s.startsWith('map:') || s.startsWith('slice:') || s.startsWith('json:')), false, `unexpected serializer intercept: ${JSON.stringify(st.stolen)}`);
      assert.equal(st.workerBlocked, true, `CSP worker-src none must block Worker instantiation (err=${st.workerBlockedErr})`);
      assert.equal(st.workerMsgs.length, 0, 'blocked worker must never execute postMessage');
      assert.ok(h.consoleLogs.some((c) => c.text.includes("worker-src 'none'")), 'CSP console violation must be emitted');
    } finally {
      await h.close();
    }

    // Missing __BENCH_HOST_INIT__ (injected without init config) must fail closed on verifySecret
    const ctx = await browserSession.browser.newContext();
    const rawPage = await ctx.newPage();
    const hostCode = await fs.readFile(path.join(REPO_ROOT, 'harness', 'src', 'capture', 'host.js'), 'utf8');
    await rawPage.addInitScript({ content: hostCode });
    if (!srv.loopbackReachable) {
      await rawPage.route('**/*', async (route) => {
        const r = await srv.resolveFile(route.request().url());
        await route.fulfill({ status: r.status, contentType: r.contentType, body: r.body });
      });
    }
    await rawPage.goto(srv.url);
    await rawPage.evaluate(() => {
      window.__benchHostControl.setSeed(99, {});
      window.__benchHostControl.markDomStep(50);
    });
    const rawTamper = await rawPage.evaluate(() => window.__benchHostControl.getTamperStatus());
    const rawSeed = await rawPage.evaluate(() => window.__benchHost.seed);
    assert.equal(rawTamper.tampered, true, 'missing __BENCH_HOST_INIT__ must fail closed and record tamper');
    assert.equal(rawTamper.firstEvent.reason, 'missing_host_init');
    assert.equal(rawSeed, 1, 'unauthorized setSeed when __BENCH_HOST_INIT__ is missing must not mutate seed');
    await ctx.close();
  } finally {
    await browserSession?.close().catch(() => {});
    await srv?.close().catch(() => {});
  }
});

test('G-webgl-hook allows offscreen/detached 2D CanvasTexture while failing visible DOM-attached painted 2D canvas bypass', { timeout: TEST_TIMEOUT_MS }, async () => {
  const legitDir = path.join(WORK_BASE, 'c2d-legit-fixture');
  const legitWork = path.join(WORK_BASE, 'c2d-legit-work');
  const bypassDir = path.join(WORK_BASE, 'c2d-bypass-fixture');
  const bypassWork = path.join(WORK_BASE, 'c2d-bypass-work');
  for (const d of [legitDir, legitWork, bypassDir, bypassWork]) {
    await fs.rm(d, { recursive: true, force: true });
  }
  await fs.mkdir(legitDir, { recursive: true });
  await fs.mkdir(bypassDir, { recursive: true });

  const makePageHtml = (mode) => `<!doctype html>
<html><head><meta charset="utf-8"></head>
<body>
  <canvas id="gl" width="160" height="120"></canvas>
  ${mode === 'legit' ? '<canvas id="hidden2d" width="64" height="64" style="display:none"></canvas>' : ''}
  ${mode === 'bypass' ? '<canvas id="bypass2d" width="160" height="120"></canvas>' : ''}
  <script>
    const glCanvas = document.getElementById('gl');
    const gl = glCanvas.getContext('webgl2', { preserveDrawingBuffer: true });
    // Legitimate OffscreenCanvas 2D probe (as used by Three.js WebGLTextures)
    if (typeof OffscreenCanvas !== 'undefined') {
      void new OffscreenCanvas(1, 1).getContext('2d');
    }
    // Legitimate detached 2D canvas for texture generation (CanvasTexture)
    const texCanvas = document.createElement('canvas');
    texCanvas.width = 64; texCanvas.height = 64;
    const texCtx = texCanvas.getContext('2d');
    texCtx.fillStyle = '#34d4c4';
    texCtx.fillRect(0, 0, 64, 64);

    ${mode === 'legit' ? `
    const hidCtx = document.getElementById('hidden2d').getContext('2d');
    hidCtx.fillRect(0, 0, 64, 64);
    ` : ''}

    ${mode === 'bypass' ? `
    const b2d = document.getElementById('bypass2d').getContext('2d');
    b2d.fillStyle = '#ff0044';
    b2d.fillRect(0, 0, 160, 120);
    ` : ''}

    const vs = '#version 300 es\\nin vec2 p; void main(){ gl_Position=vec4(p,0.0,1.0); }';
    const fsS = '#version 300 es\\nprecision mediump float; out vec4 o; void main(){ o=vec4(0.2,0.5,0.8,1.0); }';
    function sh(t,s){ const x=gl.createShader(t); gl.shaderSource(x,s); gl.compileShader(x); return x; }
    const pr = gl.createProgram(); gl.attachShader(pr, sh(gl.VERTEX_SHADER, vs)); gl.attachShader(pr, sh(gl.FRAGMENT_SHADER, fsS)); gl.linkProgram(pr);
    const vb = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, vb); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1,3,-1,-1,3]), gl.STATIC_DRAW);
    function draw() {
      gl.useProgram(pr);
      const loc = gl.getAttribLocation(pr, 'p');
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    draw();
    window.__bench = {
      version: 1,
      ready: Promise.resolve(),
      setSeed() {}, seek() {}, resume() {},
      async renderFrame() { draw(); },
      state() { return { ok: true }; },
      stats() { return { drawCalls: 1, triangles: 1 }; }
    };
  </script>
</body></html>`;

  await fs.writeFile(path.join(legitDir, 'index.html'), makePageHtml('legit'));
  await fs.writeFile(path.join(bypassDir, 'index.html'), makePageHtml('bypass'));

  const spec = {
    room: 'restoration',
    spec_version: '0.2.0',
    load_timeout_ms: 15000,
    metrics: [{ id: 'budget.render_work', axis: 'visual_quality', weight: 1, score: { type: 'higher', full: 1, zero: 0 } }],
  };
  const plan = { room: 'restoration', mode: 'swiftshader', frames: [{ key: 'f1', seed: 1, t: 0, viewport: '320x240', scheme: 'light', variant: 'normal', dpr: 1 }] };

  const legitRes = await executePlan(plan, { submissionDir: legitDir, workDir: legitWork, spec, noPython: true, planTimeoutMs: 60_000 });
  assert.equal(legitRes.gates['G-webgl-hook'].pass, true, `offscreen/detached/hidden 2d canvases must not fail G-webgl-hook: ${legitRes.gates['G-webgl-hook'].detail}`);

  const bypassRes = await executePlan(plan, { submissionDir: bypassDir, workDir: bypassWork, spec, noPython: true, planTimeoutMs: 60_000 });
  const bypassManifest = JSON.parse(await fs.readFile(bypassRes.manifestPath, 'utf8'));
  assert.equal(bypassRes.gates['G-webgl-hook'].pass, false, 'visible DOM-attached painted 2D canvas must fail G-webgl-hook');
  assert.ok(bypassManifest.unhooked_rendering.reasons.includes('canvas_2d'));
  assert.ok(bypassManifest.unhooked_rendering.canvas_2d_count >= 1);
});
