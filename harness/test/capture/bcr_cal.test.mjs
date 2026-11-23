import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeBcrStats, runBcrCalibration } from '../../src/capture/plan.mjs';
import { startServer } from '../../src/capture/server.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../..');
const PREFERRED_WORK_BASE = path.join(REPO_ROOT, 'work', 'test-bcr-cal');

let WORK_BASE = PREFERRED_WORK_BASE;
let usingTempDir = false;

before(async () => {
  try {
    await fs.mkdir(PREFERRED_WORK_BASE, { recursive: true });
    WORK_BASE = PREFERRED_WORK_BASE;
  } catch (err) {
    if (err?.code === 'EPERM' || err?.code === 'EACCES') {
      WORK_BASE = await fs.mkdtemp(path.join(os.tmpdir(), 'mol-bench-bcr-'));
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

test('computeBcrStats handles stable rounds, single-round spike tolerance, multi-round drift, IQR instability, and slow flag', () => {
  // 1. Clean stable 5 rounds -> median ratio ~ 1.5, not slow
  const stable = computeBcrStats([
    { c_pre: 10.0, s: 15.0, c_post: 10.2 },
    { c_pre: 10.1, s: 15.1, c_post: 10.0 },
    { c_pre: 9.9, s: 14.9, c_post: 10.1 },
    { c_pre: 10.0, s: 16.0, c_post: 10.0 },
    { c_pre: 10.2, s: 15.3, c_post: 10.0 },
  ]);
  assert.equal(stable.perf_cal_unstable, false);
  assert.equal(stable.perf_bcr_slow, false);
  assert.equal(stable.unstable_rounds, 0);
  assert.ok(Math.abs(stable.ratio - 1.5) < 0.02);

  // 2. One unstable round (> 12% drift) is tolerated
  const oneSpike = computeBcrStats([
    { c_pre: 10.0, s: 15.0, c_post: 10.0 },
    { c_pre: 10.0, s: 15.0, c_post: 12.0 }, // |2| / 11 = 0.182 > 0.12
    { c_pre: 10.0, s: 15.0, c_post: 10.0 },
    { c_pre: 10.0, s: 15.0, c_post: 10.0 },
    { c_pre: 10.0, s: 15.0, c_post: 10.0 },
  ]);
  assert.equal(oneSpike.unstable_rounds, 1);
  assert.equal(oneSpike.perf_cal_unstable, false);
  assert.ok(Math.abs(oneSpike.ratio - 1.5) < 0.01);

  // 3. >= 2 unstable rounds -> perf_cal_unstable: true, ratio: null
  const twoSpikes = computeBcrStats([
    { c_pre: 10.0, s: 15.0, c_post: 12.0 },
    { c_pre: 10.0, s: 15.0, c_post: 12.5 },
    { c_pre: 10.0, s: 15.0, c_post: 10.0 },
    { c_pre: 10.0, s: 15.0, c_post: 10.0 },
    { c_pre: 10.0, s: 15.0, c_post: 10.0 },
  ]);
  assert.equal(twoSpikes.unstable_rounds, 2);
  assert.equal(twoSpikes.perf_cal_unstable, true);
  assert.equal(twoSpikes.ratio, null);

  // 4. IQR(C_bar) / median(C_bar) > 0.15 -> perf_cal_unstable: true
  const highIqr = computeBcrStats([
    { c_pre: 5.0, s: 10.0, c_post: 5.0 },
    { c_pre: 7.0, s: 10.0, c_post: 7.0 },
    { c_pre: 10.0, s: 10.0, c_post: 10.0 },
    { c_pre: 13.0, s: 10.0, c_post: 13.0 },
    { c_pre: 15.0, s: 10.0, c_post: 15.0 },
  ]);
  assert.equal(highIqr.unstable_rounds, 0);
  assert.equal(highIqr.perf_cal_unstable, true);
  assert.equal(highIqr.ratio, null);

  // 5. Ratio > 2.5 flags perf_bcr_slow
  const slow = computeBcrStats([
    { c_pre: 10.0, s: 28.0, c_post: 10.0 },
    { c_pre: 10.0, s: 27.0, c_post: 10.0 },
    { c_pre: 10.0, s: 26.0, c_post: 10.0 },
    { c_pre: 10.0, s: 29.0, c_post: 10.0 },
    { c_pre: 10.0, s: 30.0, c_post: 10.0 },
  ]);
  assert.equal(slow.perf_cal_unstable, false);
  assert.equal(slow.perf_bcr_slow, true);
  assert.ok(slow.ratio > 2.5);
});

test('runBcrCalibration retries once on instability, stays non-blocking by default, and throws exitCode 75 in strictPerf', async () => {
  let calls = 0;
  // Unstable on attempt 1, recovers on attempt 2
  const recovered = await runBcrCalibration({
    kind: 'webgl',
    rounds: 5,
    cooldownMs: 5,
    measurePairFn: async () => {
      calls += 1;
      if (calls <= 5) {
        return { c_pre: 10.0, s: 12.0, c_post: 15.0 }; // 40% drift -> unstable
      }
      return { c_pre: 10.0, s: 15.0, c_post: 10.1 }; // stable
    },
  });
  assert.equal(calls, 10);
  assert.equal(recovered.retried, true);
  assert.equal(recovered.perf_cal_unstable, false);
  assert.ok(Math.abs(recovered.ratio - 1.49) < 0.05);

  // Persistently unstable -> non-blocking null ratio in default mode
  let failCalls = 0;
  const nonBlocking = await runBcrCalibration({
    kind: 'dom',
    rounds: 5,
    cooldownMs: 5,
    strictPerf: false,
    measurePairFn: async () => {
      failCalls += 1;
      return { c_pre: 10.0, s: 20.0, c_post: 18.0 };
    },
  });
  assert.equal(failCalls, 10, 'must retry at most once');
  assert.equal(nonBlocking.metric_id, 'perf.interaction_ratio');
  assert.equal(nonBlocking.perf_cal_unstable, true);
  assert.equal(nonBlocking.ratio, null);

  // Persistently unstable with strictPerf: true -> throws with exitCode 75
  await assert.rejects(
    () =>
      runBcrCalibration({
        kind: 'webgl',
        rounds: 5,
        cooldownMs: 5,
        strictPerf: true,
        measurePairFn: async () => ({ c_pre: 10.0, s: 20.0, c_post: 18.0 }),
      }),
    (err) => err && err.exitCode === 75,
  );
});

test('webgl_cal.html and dom_cal.html run interleaved BCR sessions cleanly in Chromium', { timeout: 120_000 }, async () => {
  const webglSub = path.join(REPO_ROOT, 'harness', 'test', 'fixtures', 'canvas-room');
  const domSub = path.join(REPO_ROOT, 'harness', 'src', 'capture', 'calibration');

  let webglSrv = null;
  let domSrv = null;
  try {
    webglSrv = await startServer(webglSub);
    const webglRes = await runBcrCalibration({
      kind: 'webgl',
      submissionUrl: webglSrv.url,
      origin: webglSrv.origin,
      localResolver: webglSrv.loopbackReachable ? null : webglSrv.resolveFile,
      viewport: '320x240',
      rounds: 3,
      warmupMs: 50,
      measureMs: 120,
      cooldownMs: 5,
      mode: 'swiftshader',
    });
    assert.equal(webglRes.metric_id, 'perf.frame_ratio');
    assert.equal(webglRes.rounds.length, 3);
    assert.ok(webglRes.rounds.every((r) => r.c_pre > 0 && r.c_post > 0 && r.s > 0));

    domSrv = await startServer(domSub);
    const domRes = await runBcrCalibration({
      kind: 'dom',
      submissionUrl: `${domSrv.origin}/dom_cal.html`,
      origin: domSrv.origin,
      localResolver: domSrv.loopbackReachable ? null : domSrv.resolveFile,
      viewport: '800x600',
      rounds: 3,
      domSteps: 4,
      cooldownMs: 5,
      mode: 'swiftshader',
    });
    assert.equal(domRes.metric_id, 'perf.interaction_ratio');
    assert.equal(domRes.rounds.length, 3);
    assert.ok(domRes.rounds.every((r) => r.c_pre > 0 && r.c_post > 0 && r.s > 0));
  } finally {
    await webglSrv?.close().catch(() => {});
    await domSrv?.close().catch(() => {});
  }
});
