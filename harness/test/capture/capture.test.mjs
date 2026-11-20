import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { executePlan } from '../../src/capture/plan.mjs';
import { startServer } from '../../src/capture/server.mjs';
import { launchBrowser } from '../../src/capture/browser.mjs';
import { runTests } from '../../src/capture/testrunner.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../..');
const FIXTURES_DIR = path.resolve(__dirname, '../fixtures');
const PREFERRED_WORK_BASE = path.join(REPO_ROOT, 'work', 'test-capture');

let WORK_BASE = PREFERRED_WORK_BASE;
let usingTempDir = false;

before(async () => {
  try {
    await fs.mkdir(PREFERRED_WORK_BASE, { recursive: true });
    WORK_BASE = PREFERRED_WORK_BASE;
  } catch (err) {
    if (err?.code === 'EPERM' || err?.code === 'EACCES') {
      // Fallback when workspace root is mounted read-only inside the sandbox
      WORK_BASE = await fs.mkdtemp(path.join(os.tmpdir(), 'mol-bench-capture-'));
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

function fileSha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

const TEST_TIMEOUT_MS = 90_000;

test('determinism gate passes for canvas-room and fails for canvas-room-nondet', { timeout: TEST_TIMEOUT_MS }, async () => {
  const workDet = path.join(WORK_BASE, 'det-pass');
  const workNonDet = path.join(WORK_BASE, 'det-fail');
  await fs.rm(workDet, { recursive: true, force: true });
  await fs.rm(workNonDet, { recursive: true, force: true });

  const basePlan = {
    room: 'canvas-fixture',
    mode: 'swiftshader',
    frames: [
      { key: 's1_t1000', seed: 1, t: 1000, viewport: '320x240', scheme: 'light', variant: 'normal', dpr: 1 },
    ],
  };

  const resGood = await executePlan(basePlan, {
    submissionDir: path.join(FIXTURES_DIR, 'canvas-room'),
    workDir: workDet,
    spec: { room: 'canvas-fixture', load_timeout_ms: 15000, max_raster_asset_kb: 64, max_raster_total_kb: 128 },
    planTimeoutMs: 60_000,
  });

  assert.equal(resGood.gates['G-load'].pass, true, resGood.gates['G-load'].detail);
  assert.equal(resGood.gates['G-contract'].pass, true, resGood.gates['G-contract'].detail);
  assert.equal(resGood.gates['G-console'].pass, true, resGood.gates['G-console'].detail);
  assert.equal(resGood.gates['G-offline'].pass, true, resGood.gates['G-offline'].detail);
  assert.equal(resGood.gates['G-raster'].pass, true, resGood.gates['G-raster'].detail);
  assert.equal(resGood.gates['G-fonts-local'].pass, true, resGood.gates['G-fonts-local'].detail);
  assert.equal(resGood.gates['G-determinism'].pass, true, resGood.gates['G-determinism'].detail);
  assert.equal(resGood.gates['G-live'].pass, true, resGood.gates['G-live'].detail);

  // Verify G-live saved both PNGs for Python FLIP
  const manifest = JSON.parse(await fs.readFile(resGood.manifestPath, 'utf8'));
  assert.ok(manifest.live_check?.seek_file);
  assert.ok(manifest.live_check?.live_file);
  await fs.access(path.join(workDet, manifest.live_check.seek_file));
  await fs.access(path.join(workDet, manifest.live_check.live_file));

  const resBad = await executePlan(basePlan, {
    submissionDir: path.join(FIXTURES_DIR, 'canvas-room-nondet'),
    workDir: workNonDet,
    spec: { room: 'canvas-nondet', load_timeout_ms: 15000 },
    planTimeoutMs: 60_000,
  });

  assert.equal(resBad.gates['G-load'].pass, true, resBad.gates['G-load'].detail);
  assert.equal(resBad.gates['G-contract'].pass, true, resBad.gates['G-contract'].detail);
  assert.equal(resBad.gates['G-determinism'].pass, false, 'Non-deterministic room must fail G-determinism');
});

test('two full captures of canvas-room produce byte-identical frame hashes + steps & camera_drift work', { timeout: TEST_TIMEOUT_MS }, async () => {
  const workA = path.join(WORK_BASE, 'repeat-a');
  const workB = path.join(WORK_BASE, 'repeat-b');
  await fs.rm(workA, { recursive: true, force: true });
  await fs.rm(workB, { recursive: true, force: true });

  const adapter = {
    generate(seed) {
      return {
        seedTag: `seed-${seed}`,
        cameraPath: [
          { position: [0, 0, 5], target: [0, 0, 0] },
          { position: [1, 0, 5], target: [0, 0, 0] },
          { position: [2, 0, 5], target: [0, 0, 0] },
        ],
      };
    },
  };

  const plan = {
    room: 'canvas-fixture',
    mode: 'swiftshader',
    frames: [
      { key: 's1_t0_normal', seed: 1, t: 0, viewport: '320x240', scheme: 'light', variant: 'normal', dpr: 1 },
      { key: 's1_t1000_ptr_left', seed: 1, t: 1000, viewport: '320x240', scheme: 'light', variant: 'pointer_left', dpr: 1 },
      { key: 's2_t1000_dpr2', seed: 2, t: 1000, viewport: '320x240', scheme: 'light', variant: 'dpr2', dpr: 2 },
    ],
    sequences: [
      { key: 'drift_s1', seed: 1, t0: 0, dt: 16.667, count: 3, viewport: '320x240', variant: 'camera_drift' },
    ],
    steps: [
      { key: 'resize_s1', kind: 'resize_sequence', seed: 1, viewports: ['320x240', '240x320', '320x240'], then: 'frame', dpr: 1, t: 500 },
      { key: 'life_s1', kind: 'lifecycle_30', seed: 1, cycles: 5, viewport: '320x240' },
    ],
    lighthouse: { enabled: true },
  };

  const resA = await executePlan(plan, {
    submissionDir: path.join(FIXTURES_DIR, 'canvas-room'),
    workDir: workA,
    adapter,
    spec: { room: 'canvas-fixture' },
    planTimeoutMs: 60_000,
  });
  const resB = await executePlan(plan, {
    submissionDir: path.join(FIXTURES_DIR, 'canvas-room'),
    workDir: workB,
    adapter,
    spec: { room: 'canvas-fixture' },
    planTimeoutMs: 60_000,
  });

  // Lighthouse stub returns null
  assert.equal(resA.lighthouse, null);

  // Lifecycle checks pass on clean fixture
  assert.equal(resA.probes.life_s1['mem.resource_baseline'], true);
  assert.equal(resA.probes.life_s1['mem.listener_baseline'], true);
  assert.equal(typeof resA.probes.life_s1['mem.heap_growth_mb'], 'number');

  // Compare byte-identical SHA-256 of every captured frame & sequence frame
  const manifestA = JSON.parse(await fs.readFile(resA.manifestPath, 'utf8'));
  const manifestB = JSON.parse(await fs.readFile(resB.manifestPath, 'utf8'));
  assert.equal(manifestA.samples.length, 4); // 3 frames + 1 resize_sequence step
  assert.equal(manifestA.samples.length, manifestB.samples.length);

  for (const sample of manifestA.samples) {
    const bufA = await fs.readFile(path.join(workA, sample.file));
    const bufB = await fs.readFile(path.join(workB, sample.file));
    assert.equal(fileSha256(bufA), fileSha256(bufB), `Frame ${sample.key} must be byte-identical across runs`);
  }

  for (let i = 0; i < 3; i++) {
    const rel = `frames/drift_s1/${String(i).padStart(4, '0')}.png`;
    const bufA = await fs.readFile(path.join(workA, rel));
    const bufB = await fs.readFile(path.join(workB, rel));
    assert.equal(fileSha256(bufA), fileSha256(bufB), `Sequence frame ${rel} must be byte-identical across runs`);
  }
});

test('DOM probes return expected counts and metrics for dom-room', { timeout: TEST_TIMEOUT_MS }, async () => {
  const workDom = path.join(WORK_BASE, 'dom-probes');
  await fs.rm(workDom, { recursive: true, force: true });

  const plan = {
    room: 'dom-fixture',
    mode: 'swiftshader',
    frames: [
      { key: 'dom_light', seed: 1, t: 0, viewport: '800x700', scheme: 'light', variant: 'normal', dpr: 1 },
    ],
    probes: [
      { key: 'all_800x700', probe: 'all', viewport: '800x700', scheme: 'light', variant: 'normal', seed: 1, args: {} },
    ],
  };

  const res = await executePlan(plan, {
    submissionDir: path.join(FIXTURES_DIR, 'dom-room'),
    workDir: workDom,
    spec: { room: 'dom-fixture', load_timeout_ms: 10000 },
    planTimeoutMs: 60_000,
  });

  assert.equal(res.gates['G-load'].pass, true, res.gates['G-load'].detail);
  assert.equal(res.gates['G-console'].pass, true, res.gates['G-console'].detail);
  assert.equal(res.gates['G-contract'].pass, true, res.gates['G-contract'].detail);
  assert.equal(res.gates['G-determinism'].pass, true, res.gates['G-determinism'].detail);

  const p = res.probes.all_800x700;
  // Deliberate overflow element + scrollingElement.scrollWidth > innerWidth => >= 2
  assert.ok(p['layout.overflow_count'] >= 2, `Expected overflow_count >= 2, got ${p['layout.overflow_count']}`);
  assert.equal(p['layout.tap_targets'], 1, `Expected all tap targets >= 44px, got ${p['layout.tap_targets']}`);

  // Deliberate Hangul mid-word break inside narrow break-all div => >= 1
  assert.ok(p['text.hangul_midword_breaks'] >= 1, `Expected hangul_midword_breaks >= 1, got ${p['text.hangul_midword_breaks']}`);
  assert.equal(p['text.clipped_count'], 0, `Expected clipped_count == 0, got ${p['text.clipped_count']}`);

  // Line length & line height on Korean [data-bench="body"]
  assert.equal(p['text.line_length'].script, 'hangul');
  assert.ok(p['text.line_length'].value > 15, `Expected hangul line_length > 15, got ${p['text.line_length'].value}`);
  assert.ok(
    p['text.line_height'].value >= 1.5 && p['text.line_height'].value <= 1.8,
    `Expected line_height ~1.65, got ${p['text.line_height'].value}`,
  );

  // Typography steps (12px, 16px, 24px, 36px -> 4 steps, min ratio = 16/12 = 1.333)
  assert.ok(p['type.size_steps'] >= 3, `Expected size_steps >= 3, got ${p['type.size_steps']}`);
  assert.ok(p['type.scale_ratio_min'] > 1.1, `Expected scale_ratio_min > 1.1, got ${p['type.scale_ratio_min']}`);

  // Spacing & alignment
  assert.ok(p['space.grid4_frac'] >= 0.8, `Expected grid4_frac >= 0.8, got ${p['space.grid4_frac']}`);
  assert.ok(p['align.column_count'] >= 1 && p['align.column_count'] <= 8, `Unexpected column_count ${p['align.column_count']}`);

  // Accessibility
  assert.equal(p['a11y.axe_violations'], 0, `Expected 0 axe violations, got ${JSON.stringify(p.details.axe)}`);
  assert.equal(p['a11y.keyboard_reach'], 1, `Expected keyboard_reach == 1, got ${p['a11y.keyboard_reach']}`);
  assert.equal(p['a11y.focus_visible'], 1, `Expected focus_visible == 1, got ${JSON.stringify(p.details.focus_visible)}`);

  // Navigation & Theme
  assert.equal(p['nav.routes'], 1, `Expected nav.routes == 1, got ${JSON.stringify(p.details.nav_routes)}`);
  assert.ok(
    p['nav.transition_ms'] >= 64 && p['nav.transition_ms'] <= 500,
    `Expected nav.transition_ms ~160ms, got ${p['nav.transition_ms']}`,
  );
  assert.equal(p['theme.both_valid'], true, `Expected theme.both_valid == true, got ${JSON.stringify(p.details.theme)}`);
});

test('rAF 30 Hz vs 144 Hz override advances clock-driven fixture identically', { timeout: TEST_TIMEOUT_MS }, async () => {
  const workRaf = path.join(WORK_BASE, 'raf-rate');
  await fs.rm(workRaf, { recursive: true, force: true });

  const plan = {
    room: 'canvas-fixture',
    mode: 'swiftshader',
    frames: [
      { key: 's1_t0', seed: 1, t: 0, viewport: '320x240', scheme: 'light', variant: 'normal', dpr: 1 },
    ],
    steps: [
      { key: 'clock_indep', kind: 'clock_independence', seed: 1, durationMs: 5000, rates: [30, 144], viewport: '320x240' },
    ],
  };

  const res = await executePlan(plan, {
    submissionDir: path.join(FIXTURES_DIR, 'canvas-room'),
    workDir: workRaf,
    spec: { room: 'canvas-fixture' },
    planTimeoutMs: 60_000,
  });

  const ci = res.probes.clock_indep;
  assert.ok(ci, 'clock_indep probe result missing');
  assert.equal(ci.details.stepsA, 150, '30 Hz over 5000 ms should run 150 steps');
  assert.equal(ci.details.stepsB, 720, '144 Hz over 5000 ms should run 720 steps');
  // 5000 ms * 0.036 deg/ms = 180 deg at both 30 Hz and 144 Hz
  assert.ok(Math.abs(ci.details.angleA - 180) < 0.1, `Expected angleA ~180, got ${ci.details.angleA}`);
  assert.ok(Math.abs(ci.details.angleB - 180) < 0.1, `Expected angleB ~180, got ${ci.details.angleB}`);
  assert.ok(ci['anim.clock_independence'] < 0.01, `Expected delta < 0.01 deg, got ${ci['anim.clock_independence']}`);
});

test('testrunner executes passing tests, catches crashes, and enforces per-test timeout', { timeout: TEST_TIMEOUT_MS }, async () => {
  let server = null;
  let browser = null;
  try {
    server = await startServer(path.join(FIXTURES_DIR, 'canvas-room'));
    browser = await launchBrowser({ mode: 'swiftshader' });

    const timeoutTestPath = path.join(WORK_BASE, 'timeout-test.mjs');
    await fs.mkdir(WORK_BASE, { recursive: true });
    await fs.writeFile(timeoutTestPath, `
      export default [
        {
          id: 'hang-test',
          title: 'hangs forever',
          async run() {
            await new Promise(() => {});
            return { pass: true, detail: '' };
          },
        },
      ];
    `);

    const results = await runTests(
      [path.join(FIXTURES_DIR, 'sample-tests'), timeoutTestPath],
      {
        browserSession: browser,
        origin: server.origin,
        url: server.url,
        localResolver: server.loopbackReachable ? null : server.resolveFile,
        defaultViewport: '320x240',
        timeoutMs: 1200,
      },
    );

    assert.equal(results.length, 3);
    const passRes = results.find((r) => r.id === 'pass-state');
    const crashRes = results.find((r) => r.id === 'crash-test');
    const hangRes = results.find((r) => r.id === 'hang-test');

    assert.equal(passRes?.pass, true, passRes?.detail);
    assert.equal(crashRes?.pass, false);
    assert.match(crashRes?.detail || '', /intentional boom/);
    assert.equal(hangRes?.pass, false);
    assert.match(hangRes?.detail || '', /timed out/);
  } finally {
    await browser?.close().catch(() => {});
    await server?.close().catch(() => {});
  }
});

test('host.js rng mulberry32 + fork(label) is deterministic and order-independent', { timeout: TEST_TIMEOUT_MS }, async () => {
  let server = null;
  let browser = null;
  try {
    server = await startServer(path.join(FIXTURES_DIR, 'canvas-room'));
    browser = await launchBrowser({ mode: 'swiftshader' });
    const h = await browser.newPage({
      origin: server.origin,
      url: server.url,
      localResolver: server.loopbackReachable ? null : server.resolveFile,
      viewport: '320x240',
      seed: 42,
      params: { custom: 'ok' },
    });
    try {
      const res = await h.page.evaluate(() => {
        const host = window.__benchHost;
        const a1 = [host.rng.fork('stars').next(), host.rng.fork('stars').int(100)];
        const a2 = [host.rng.fork('stars').next(), host.rng.fork('stars').int(100)];
        const b1 = host.rng.fork('aurora').next();
        const frozen = Object.isFrozen(host) && Object.isFrozen(host.params);
        return { contractVersion: host.contractVersion, seed: host.seed, params: host.params, a1, a2, b1, frozen };
      });
      assert.equal(res.contractVersion, 1);
      assert.equal(res.seed, 42);
      assert.deepEqual(res.params, { custom: 'ok' });
      assert.equal(res.frozen, true);
      assert.deepEqual(res.a1, res.a2, 'fork(label) must be deterministic');
      assert.notEqual(res.a1[0], res.b1, 'different labels must produce independent streams');
    } finally {
      await h.close();
    }
  } finally {
    await browser?.close().catch(() => {});
    await server?.close().catch(() => {});
  }
});
