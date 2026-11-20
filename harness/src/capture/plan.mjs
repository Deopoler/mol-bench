import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startServer } from './server.mjs';
import { launchBrowser } from './browser.mjs';
import { runProbe } from './probes/index.js';
import { pixelSha256, pngMeanAbsDiff, median } from './probes/shared.js';
import { runTests } from './testrunner.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CALIBRATION_DIR = path.join(__dirname, 'calibration');
const PERF_REFERENCE_PATH = path.resolve(__dirname, '../../perf/reference.json');

export function measureLiveFlip(imageA, imageB, { noPython = false } = {}) {
  if (noPython) return { flip: null, pass: null, detail: 'FLIP not evaluated because Python is disabled' };
  const pyDir = path.resolve(__dirname, '../../../metrics');
  const py = [path.resolve(__dirname, '../../../.venv/Scripts/python.exe'), path.resolve(__dirname, '../../../.venv/bin/python')].find((p) => existsSync(p)) || 'python';
  try {
    const flip = Number(execFileSync(py, ['-m', 'molmetrics', 'flip', imageA, imageB], {
      cwd: path.resolve(__dirname, '../../..'),
      env: { ...process.env, PYTHONPATH: [pyDir, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter) },
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']
    }).trim());
    if (!Number.isFinite(flip)) throw new Error('molmetrics returned a non-number');
    return { flip, pass: flip <= 0.02, detail: `FLIP=${flip.toFixed(5)} (threshold <= 0.02)` };
  } catch (err) {
    return { flip: null, pass: false, detail: `FLIP unavailable: ${err.message}` };
  }
}

const RASTER_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.avif',
  '.mp4', '.webm', '.mov', '.ogv', '.m4v',
]);

async function scanRasterGate(submissionDir, spec) {
  const maxAssetKb = typeof spec?.max_raster_asset_kb === 'number' ? spec.max_raster_asset_kb : Infinity;
  const maxTotalKb = typeof spec?.max_raster_total_kb === 'number' ? spec.max_raster_total_kb : Infinity;

  let totalBytes = 0;
  let maxBytes = 0;
  let worstFile = null;
  const files = [];

  async function walk(dir) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (RASTER_EXTS.has(ext)) {
          const st = await fs.stat(full);
          totalBytes += st.size;
          if (st.size > maxBytes) {
            maxBytes = st.size;
            worstFile = path.relative(submissionDir, full).replace(/\\/g, '/');
          }
          files.push({ file: path.relative(submissionDir, full).replace(/\\/g, '/'), kb: st.size / 1024 });
        }
      }
    }
  }

  await walk(submissionDir);

  const maxKb = maxBytes / 1024;
  const totalKb = totalBytes / 1024;
  const pass = maxKb <= maxAssetKb && totalKb <= maxTotalKb;
  const detail = pass
    ? `Raster assets within budget (max=${maxKb.toFixed(1)}KB/${maxAssetKb}KB, total=${totalKb.toFixed(1)}KB/${maxTotalKb}KB)`
    : `Raster budget exceeded (max=${maxKb.toFixed(1)}KB [${worstFile}] limit=${maxAssetKb}KB, total=${totalKb.toFixed(1)}KB limit=${maxTotalKb}KB)`;

  return { pass, detail };
}

function variantToPageConfig(variant, base = {}) {
  const cfg = {
    viewport: base.viewport || '1440x900',
    dpr: Number(base.dpr || 1),
    colorScheme: base.scheme || base.colorScheme || 'light',
    reducedMotion: 'no-preference',
    locale: null,
    pointerNormalized: null,
  };

  if (variant === 'reduced_motion') {
    cfg.reducedMotion = 'reduce';
  } else if (variant === 'dpr2') {
    cfg.dpr = 2;
  } else if (variant === 'pointer_left') {
    cfg.pointerNormalized = [0.2, 0.5];
  } else if (variant === 'pointer_right') {
    cfg.pointerNormalized = [0.8, 0.5];
  } else if (variant === 'lang_en') {
    cfg.locale = 'en-US';
  } else if (variant === 'lang_ko') {
    cfg.locale = 'ko-KR';
  }

  return cfg;
}

function wrappedAngleDiffDeg(a, b) {
  const diff = Math.abs((((a - b) % 360) + 540) % 360 - 180);
  return diff;
}

async function measureRafP95(pageHandle, { warmupMs = 2000, measureMs = 10000 } = {}) {
  await pageHandle.resume().catch(() => {});
  const result = await pageHandle.page.evaluate(async ([warm, dur]) => {
    const waitMs = (ms) => new Promise((r) => setTimeout(r, ms));
    await waitMs(warm);

    const deltas = [];
    await new Promise((resolve) => {
      let start = performance.now();
      let prev = start;
      function tick(now) {
        const dt = now - prev;
        prev = now;
        if (dt > 0) deltas.push(dt);
        if (now - start >= dur) {
          resolve();
          return;
        }
        requestAnimationFrame(tick);
      }
      requestAnimationFrame((first) => {
        start = first;
        prev = first;
        requestAnimationFrame(tick);
      });
    });

    deltas.sort((a, b) => a - b);
    const idx = Math.min(deltas.length - 1, Math.floor(deltas.length * 0.95));
    return {
      p95: deltas.length > 0 ? deltas[idx] : 0,
      frames: deltas.length,
    };
  }, [warmupMs, measureMs]);
  return result;
}

async function runPerfMeasurement(planPerf, { submissionUrl, origin, spec, defaultSeed, getParams }) {
  const viewport = planPerf.viewport || '1440x900';
  const runsCount = Number(planPerf.runs || 5);
  const warmupMs = Number(planPerf.warmupMs ?? 2000);
  const measureMs = Number(planPerf.measureMs ?? 10000);

  let cRef = null;
  try {
    const refRaw = await fs.readFile(PERF_REFERENCE_PATH, 'utf8');
    const refJson = JSON.parse(refRaw);
    if (typeof refJson.p95_ms === 'number' && refJson.p95_ms > 0) {
      cRef = refJson.p95_ms;
    }
  } catch {
    // Fallback to Cref = Cnow when reference.json does not yet exist
  }

  let calServer = null;
  let gpuBrowser = null;
  try {
    calServer = await startServer(CALIBRATION_DIR);
    gpuBrowser = await launchBrowser({ mode: 'gpu' });
    const runs = [];
    for (let i = 0; i < runsCount; i++) {
      // 1. Calibration scene
      const calPage = await gpuBrowser.newPage({
        origin: calServer.origin,
        url: calServer.url,
        viewport,
        dpr: 1,
        seed: 1,
        params: {},
      });
      let cNow;
      try {
        const calStats = await measureRafP95(calPage, { warmupMs, measureMs });
        cNow = calStats.p95;
      } finally {
        await calPage.close();
      }

      // 2. Submission scene
      const subPage = await gpuBrowser.newPage({
        origin,
        url: submissionUrl,
        viewport,
        dpr: 1,
        seed: defaultSeed,
        params: getParams(defaultSeed, 'normal'),
        loadTimeoutMs: spec?.load_timeout_ms ?? 15000,
      });
      let pMs;
      try {
        const subStats = await measureRafP95(subPage, { warmupMs, measureMs });
        pMs = subStats.p95;
      } finally {
        await subPage.close();
      }

      const effectiveCref = cRef !== null ? cRef : cNow;
      const normMs = cNow > 0 ? (pMs * effectiveCref) / cNow : pMs;
      runs.push({ run: i + 1, raw_p95_ms: pMs, cal_p95_ms: cNow, norm_p95_ms: normMs });
    }

    const p95NormMs = median(runs.map((r) => r.norm_p95_ms));
    return {
      p95_norm_ms: p95NormMs,
      cref_fallback: cRef === null,
      cref_ms: cRef,
      runs,
    };
  } finally {
    await gpuBrowser?.close().catch(() => {});
    await calServer?.close().catch(() => {});
  }
}

/**
 * Execute a MoL-Bench capture plan (docs/ARCHITECTURE.md).
 *
 * @param {object} plan Capture plan JSON
 * @param {object} opts { submissionDir, workDir, spec, adapter, hidden, planTimeoutMs }
 * @returns {Promise<{ manifestPath, probes, gates, tests, perf, lighthouse, console, network }>}
 */
export async function executePlan(plan, {
  submissionDir,
  workDir,
  spec = {},
  adapter = null,
  hidden = false,
  noPython = false,
  planTimeoutMs = null,
} = {}) {
  if (!submissionDir) throw new Error('executePlan requires submissionDir');
  if (!workDir) throw new Error('executePlan requires workDir');

  const watchdogMs = Number(planTimeoutMs ?? plan?.timeoutMs ?? 180_000);
  const absWorkDir = path.resolve(workDir);
  const framesDir = path.join(absWorkDir, 'frames');
  await fs.mkdir(framesDir, { recursive: true });

  const loadTimeoutMs = spec?.load_timeout_ms ?? 15000;
  const defaultViewport =
    plan?.viewport_default ||
    spec?.capture?.viewports?.[0] ||
    plan?.frames?.[0]?.viewport ||
    '1440x900';
  const defaultSeed =
    plan?.frames?.[0]?.seed ??
    plan?.sequences?.[0]?.seed ??
    plan?.probes?.[0]?.seed ??
    spec?.capture?.public_seeds?.[0] ??
    1;

  const consoleAll = [];
  const networkAll = [];
  const fontResponsesAll = [];

  function collectLogs(handle) {
    if (!handle) return;
    for (const c of handle.consoleLogs) {
      consoleAll.push({ type: c.type, text: c.text });
    }
    for (const n of handle.networkLogs) {
      networkAll.push({ url: n.url, allowed: n.allowed });
    }
    for (const f of handle.fontResponses) {
      fontResponsesAll.push(f);
    }
  }

  const paramsMap = {};
  function getParams(seed, variant = 'normal') {
    let generated = {};
    if (adapter && typeof adapter.generate === 'function') {
      generated = adapter.generate(seed, { hidden, variant }) || {};
    }
    if (variant === 'empty_rooms' && !adapter) {
      generated = { ...generated, rooms: [] };
    }
    if (variant === 'normal' || !(String(seed) in paramsMap)) {
      paramsMap[String(seed)] = generated;
    }
    return generated;
  }

  let server = null;
  let browserSession = null;
  let cleanupDone = false;

  async function cleanupResources() {
    if (cleanupDone) return;
    cleanupDone = true;
    await Promise.allSettled([
      browserSession ? browserSession.close() : Promise.resolve(),
      server ? server.close() : Promise.resolve(),
    ]);
  }

  let watchdogTimer = null;
  const watchdogPromise = new Promise((_, reject) => {
    if (watchdogMs > 0 && Number.isFinite(watchdogMs)) {
      watchdogTimer = setTimeout(async () => {
        await cleanupResources();
        reject(new Error(`executePlan timed out after ${watchdogMs} ms`));
      }, watchdogMs);
      if (typeof watchdogTimer.unref === 'function') {
        watchdogTimer.unref();
      }
    }
  });

  const runBody = (async () => {
    const mode = plan?.mode || spec?.capture?.renderer || 'swiftshader';
    server = await startServer(submissionDir);
    const localResolver = server.loopbackReachable ? null : server.resolveFile;
    browserSession = await launchBrowser({ mode });

    const openPage = (opts) => browserSession.newPage({
      origin: server.origin,
      url: server.url,
      localResolver,
      loadTimeoutMs,
      ...opts,
    });

    const manifest = {
      room: plan?.room || spec?.room || 'unknown',
      viewport_default: defaultViewport,
      samples: [],
      sequences: [],
      params: paramsMap,
    };

    const gates = {};
    const probes = {};
    let tests = [];
    let perf = null;
    let lighthouse = null;
    // ---- Gate: G-raster (filesystem scan) ----
    gates['G-raster'] = await scanRasterGate(submissionDir, spec);

    // ---- Gate: G-load, G-contract, initial G-fonts-local ----
    let fontsReadyResult = { ok: true, count: 0 };
    const initHandle = await openPage({
      viewport: defaultViewport,
      seed: defaultSeed,
      params: getParams(defaultSeed, 'normal'),
    });
    try {
      gates['G-load'] = { ...initHandle.loadResult };
      if (gates['G-load'].pass) {
        gates['G-contract'] = await initHandle.checkContract();
        fontsReadyResult = await initHandle.waitForFontsReady(loadTimeoutMs);
      } else {
        gates['G-contract'] = { pass: false, detail: 'Skipped because G-load failed' };
      }
    } finally {
      collectLogs(initHandle);
      await initHandle.close();
    }

    const canRender = gates['G-load'].pass && gates['G-contract'].pass;

    // ---- Gate: G-determinism (same sample rendered twice in FRESH pages) ----
    if (canRender && noPython) {
      gates['G-live'] = { pass: null, detail: 'FLIP not evaluated because Python is disabled' };
    } else if (canRender) {
      const detSample = plan?.frames?.[0] || {
        seed: defaultSeed,
        t: 1000,
        viewport: defaultViewport,
        scheme: 'light',
        variant: 'normal',
        dpr: 1,
      };
      const detSeed = detSample.seed ?? defaultSeed;
      const detT = detSample.t ?? 1000;
      const detCfg = variantToPageConfig(detSample.variant || 'normal', detSample);
      const detParams = getParams(detSeed, detSample.variant || 'normal');

      async function renderDetOnce() {
        const h = await openPage({
          viewport: detCfg.viewport,
          dpr: detCfg.dpr,
          colorScheme: detCfg.colorScheme,
          reducedMotion: detCfg.reducedMotion,
          locale: detCfg.locale,
          seed: detSeed,
          params: detParams,
        });
        try {
          await h.setSeed(detSeed, detParams);
          await h.seek(detT);
          await h.renderFrame();
          return await h.screenshot();
        } finally {
          collectLogs(h);
          await h.close();
        }
      }

      const buf1 = await renderDetOnce();
      const buf2 = await renderDetOnce();
      const sha1 = pixelSha256(buf1);
      const sha2 = pixelSha256(buf2);
      const detPass = sha1 === sha2;
      gates['G-determinism'] = {
        pass: detPass,
        detail: detPass
          ? `Identical decoded pixel SHA-256 (${sha1.slice(0, 16)}...)`
          : `Pixel SHA-256 mismatch across fresh pages (${sha1.slice(0, 16)} vs ${sha2.slice(0, 16)})`,
      };
    } else {
      gates['G-determinism'] = { pass: false, detail: 'Skipped because G-load/G-contract failed' };
    }

    // ---- Gate: G-live (seek frame vs live frame paused at same clock) ----
    if (canRender) {
      const liveSample = (plan?.frames || []).find((f) => Number(f.t) > 0) || plan?.frames?.[0] || {
        seed: defaultSeed,
        t: 300,
        viewport: defaultViewport,
        scheme: 'light',
        dpr: 1,
      };
      const liveSeed = liveSample.seed ?? defaultSeed;
      const requestedT = Number(plan?.liveCheckMs ?? (Number(liveSample.t) > 0 ? Math.min(Number(liveSample.t), 400) : 250));
      const liveVp = liveSample.viewport || defaultViewport;
      const liveScheme = liveSample.scheme || 'light';
      const liveParams = getParams(liveSeed, 'normal');

      // 1) Live run paused at exact clock >= requestedT
      let liveBuf;
      let tActual = requestedT;
      const liveHandle = await openPage({
        viewport: liveVp,
        dpr: 1,
        colorScheme: liveScheme,
        seed: liveSeed,
        params: liveParams,
      });
      try {
        await liveHandle.setSeed(liveSeed, liveParams);
        await liveHandle.resetClock(0);
        await liveHandle.resume();
        tActual = await liveHandle.page.evaluate((targetMs) => {
          return new Promise((resolve) => {
            let done = false;
            const finish = () => {
              if (done) return;
              done = true;
              const now = window.__benchHost.clock.now();
              window.__benchHostControl.freeze(now);
              window.__bench.seek(now);
              resolve(now);
            };
            const maxWait = setTimeout(finish, Math.max(2000, targetMs + 2000));
            function check() {
              if (done) return;
              const now = window.__benchHost.clock.now();
              if (now >= targetMs) {
                clearTimeout(maxWait);
                finish();
                return;
              }
              requestAnimationFrame(check);
            }
            requestAnimationFrame(check);
          });
        }, requestedT);
        await liveHandle.renderFrame();
        const livePath = path.join(framesDir, '_g_live_live.png');
        liveBuf = await liveHandle.screenshot(livePath);
      } finally {
        collectLogs(liveHandle);
        await liveHandle.close();
      }

      // 2) Seek frame at exact tActual in a fresh page
      let seekBuf;
      const seekHandle = await openPage({
        viewport: liveVp,
        dpr: 1,
        colorScheme: liveScheme,
        seed: liveSeed,
        params: liveParams,
      });
      try {
        await seekHandle.setSeed(liveSeed, liveParams);
        await seekHandle.seek(tActual);
        await seekHandle.renderFrame();
        const seekPath = path.join(framesDir, '_g_live_seek.png');
        seekBuf = await seekHandle.screenshot(seekPath);
      } finally {
        collectLogs(seekHandle);
        await seekHandle.close();
      }

      const flipResult = measureLiveFlip(path.join(framesDir, '_g_live_seek.png'), path.join(framesDir, '_g_live_live.png'));
      const flip = flipResult.flip;
      const mad = pngMeanAbsDiff(seekBuf, liveBuf);
      const livePass = flipResult.pass;
      manifest.live_check = {
        seed: liveSeed,
        t: tActual,
        viewport: liveVp,
        scheme: liveScheme,
        seek_file: 'frames/_g_live_seek.png',
        live_file: 'frames/_g_live_live.png',
        mad_proxy: mad,
        flip,
      };
      gates['G-live'] = {
        pass: livePass,
        detail: `Seek vs live FLIP=${flip === null ? 'unavailable' : flip.toFixed(5)} (threshold <= 0.02); MAD proxy=${mad.toFixed(5)} at t=${tActual.toFixed(2)}ms`,
      };
    } else {
      gates['G-live'] = { pass: false, detail: 'Skipped because G-load/G-contract failed' };
    }

    // ---- Execute plan.frames ----
    if (canRender && Array.isArray(plan?.frames) && plan.frames.length > 0) {
      // Group frames by browser context settings to reuse pages cleanly without cross-context leakage
      const groups = new Map();
      for (const frame of plan.frames) {
        const variant = frame.variant || 'normal';
        const cfg = variantToPageConfig(variant, frame);
        const groupKey = JSON.stringify([cfg.viewport, cfg.dpr, cfg.colorScheme, cfg.reducedMotion, cfg.locale]);
        if (!groups.has(groupKey)) groups.set(groupKey, { cfg, frames: [] });
        groups.get(groupKey).frames.push(frame);
      }

      for (const { cfg, frames } of groups.values()) {
        const first = frames[0];
        const firstSeed = first.seed ?? defaultSeed;
        const handle = await openPage({
          viewport: cfg.viewport,
          dpr: cfg.dpr,
          colorScheme: cfg.colorScheme,
          reducedMotion: cfg.reducedMotion,
          locale: cfg.locale,
          seed: firstSeed,
          params: getParams(firstSeed, first.variant || 'normal'),
        });

        try {
          for (const frame of frames) {
            const seed = frame.seed ?? defaultSeed;
            const variant = frame.variant || 'normal';
            const t = Number(frame.t ?? 0);
            const params = getParams(seed, variant);
            await handle.setSeed(seed, params);

            // Pointer handling
            if (frame.pointer && Array.isArray(frame.pointer) && frame.pointer.length === 2) {
              const [px, py] = frame.pointer;
              if (px <= 1 && py <= 1) {
                await handle.movePointerNormalized(px, py);
              } else {
                await handle.movePointer(px, py);
              }
            } else if (frame.pointer && typeof frame.pointer === 'object' && 'x' in frame.pointer) {
              await handle.movePointer(frame.pointer.x, frame.pointer.y);
            } else if (cfg.pointerNormalized) {
              await handle.movePointerNormalized(cfg.pointerNormalized[0], cfg.pointerNormalized[1]);
            }

            await handle.seek(t);
            await handle.renderFrame();

            const relFile = `frames/${frame.key}.png`;
            const outPath = path.join(absWorkDir, relFile);
            await handle.screenshot(outPath);

            const sampleEntry = {
              key: frame.key,
              seed,
              t,
              viewport: cfg.viewport,
              scheme: cfg.colorScheme,
              variant,
              dpr: cfg.dpr,
              file: relFile,
            };
            if (frame.mask) sampleEntry.mask = frame.mask;
            manifest.samples.push(sampleEntry);
          }
        } finally {
          collectLogs(handle);
          await handle.close();
        }
      }
    }

    // ---- Execute plan.sequences (including variant 'camera_drift') ----
    if (canRender && Array.isArray(plan?.sequences) && plan.sequences.length > 0) {
      const renderedSeqDirs = new Map();
      for (const seq of plan.sequences) {
        const seed = seq.seed ?? defaultSeed;
        const variant = seq.variant || 'normal';
        const cfg = variantToPageConfig(variant, seq);
        const params = getParams(seed, variant);
        const t0 = Number(seq.t0 ?? 0);
        const dt = Number(seq.dt ?? 16.667);
        const count = Number(seq.count ?? 1);
        const seqRelDir = `frames/${seq.key}/`;
        const seqAbsDir = path.join(absWorkDir, seqRelDir);
        await fs.mkdir(seqAbsDir, { recursive: true });

        const cameraPath = variant === 'camera_drift' && Array.isArray(params?.cameraPath)
          ? params.cameraPath
          : null;
        const seedKey = (plan?.room || spec?.room) === 'restoration' ? '*' : seed;
        const seqCacheKey = JSON.stringify([
          seedKey,
          t0,
          dt,
          count,
          cfg.viewport,
          cfg.dpr,
          cfg.colorScheme,
          cfg.reducedMotion,
          cameraPath ? variant : 'normal',
        ]);

        const cachedAbsDir = renderedSeqDirs.get(seqCacheKey);
        if (cachedAbsDir) {
          for (let i = 0; i < count; i++) {
            const fileName = `${String(i).padStart(4, '0')}.png`;
            await fs.copyFile(path.join(cachedAbsDir, fileName), path.join(seqAbsDir, fileName));
          }
          const seqEntry = {
            key: seq.key,
            seed,
            t0,
            dt,
            count,
            viewport: cfg.viewport,
            variant,
            dir: seqRelDir,
          };
          if (seq.mask) seqEntry.mask = seq.mask;
          manifest.sequences.push(seqEntry);
          continue;
        }

        const handle = await openPage({
          viewport: cfg.viewport,
          dpr: cfg.dpr,
          colorScheme: cfg.colorScheme,
          reducedMotion: cfg.reducedMotion,
          locale: cfg.locale,
          seed,
          params,
        });

        try {
          await handle.setSeed(seed, params);

          for (let i = 0; i < count; i++) {
            const t = t0 + i * dt;
            if (cameraPath && cameraPath.length > 0) {
              const pose = cameraPath[Math.min(i, cameraPath.length - 1)];
              await handle.page.evaluate((cam) => {
                if (window.__bench && typeof window.__bench.setCamera === 'function') {
                  window.__bench.setCamera(cam);
                }
              }, pose);
            }
            await handle.seek(t);
            await handle.renderFrame();
            const fileName = `${String(i).padStart(4, '0')}.png`;
            await handle.screenshot(path.join(seqAbsDir, fileName));
          }

          renderedSeqDirs.set(seqCacheKey, seqAbsDir);

          const seqEntry = {
            key: seq.key,
            seed,
            t0,
            dt,
            count,
            viewport: cfg.viewport,
            variant,
            dir: seqRelDir,
          };
          if (seq.mask) seqEntry.mask = seq.mask;
          manifest.sequences.push(seqEntry);
        } finally {
          collectLogs(handle);
          await handle.close();
        }
      }
    }

    // ---- Execute plan.steps ----
    if (canRender && Array.isArray(plan?.steps) && plan.steps.length > 0) {
      for (const step of plan.steps) {
        const seed = step.seed ?? defaultSeed;
        const kind = step.kind;

        if (kind === 'resize_sequence') {
          const viewports = Array.isArray(step.viewports) && step.viewports.length > 0
            ? step.viewports
            : ['1440x900', '768x1024', '1440x900'];
          const dpr = Number(step.dpr || 1);
          const scheme = step.scheme || 'light';
          const params = getParams(seed, step.variant || 'resize_seq');

          const handle = await openPage({
            viewport: viewports[0],
            dpr,
            colorScheme: scheme,
            seed,
            params,
          });
          try {
            await handle.setSeed(seed, params);
            await handle.resizeSequence(viewports.slice(1));
            const t = Number(step.t ?? 0);
            await handle.seek(t);
            await handle.renderFrame();

            if (!step.then || step.then === 'frame') {
              const relFile = `frames/${step.key}.png`;
              await handle.screenshot(path.join(absWorkDir, relFile));
              manifest.samples.push({
                key: step.key,
                seed,
                t,
                viewport: viewports[viewports.length - 1],
                scheme,
                variant: step.variant || 'resize_seq',
                dpr,
                file: relFile,
              });
            }
          } finally {
            collectLogs(handle);
            await handle.close();
          }
        } else if (kind === 'lifecycle_30' || kind === 'lifecycle') {
          const cycles = Number(step.cycles || 30);
          const viewport = step.viewport || defaultViewport;
          const params = getParams(seed, 'lifecycle_30');
          const handle = await openPage({
            viewport,
            dpr: 1,
            seed,
            params,
          });
          try {
            await handle.setSeed(seed, params);
            await handle.seek(0);
            await handle.renderFrame();

            const firstStats = await handle.stats();
            const firstHeap = await handle.collectGarbageAndHeap();
            const firstListeners = await handle.getListenerCount();

            const hasLifecycle = await handle.page.evaluate(
              () => typeof window.__bench?.unmount === 'function' && typeof window.__bench?.mount === 'function',
            );

            if (hasLifecycle) {
              await handle.page.evaluate(async (n) => {
                const container = document.getElementById('app') || document.body;
                for (let i = 0; i < n; i++) {
                  await window.__bench.unmount();
                  await window.__bench.mount(container);
                }
              }, cycles);
              await handle.renderFrame();
            }

            const afterStats = await handle.stats();
            const afterHeap = await handle.collectGarbageAndHeap();
            const afterListeners = await handle.getListenerCount();

            const resourceBaselinePass =
              hasLifecycle &&
              afterStats.geometries === firstStats.geometries &&
              afterStats.textures === firstStats.textures &&
              afterStats.programs === firstStats.programs;
            const heapGrowthMb = afterHeap.usedMB - firstHeap.usedMB;
            const listenerBaselinePass = hasLifecycle && afterListeners === firstListeners;

            // Optional single-step click test for interact.single_step
            let singleStepPass = null;
            if (step.nextControlSelector) {
              const beforeIdx = (await handle.state())?.focusedIndex;
              await handle.page.click(step.nextControlSelector).catch(() => {});
              await handle.renderFrame();
              const afterIdx = (await handle.state())?.focusedIndex;
              singleStepPass = typeof beforeIdx === 'number' && typeof afterIdx === 'number' && afterIdx === beforeIdx + 1;
            }

            probes[step.key] = {
              'mem.resource_baseline': resourceBaselinePass,
              'mem.heap_growth_mb': heapGrowthMb,
              'mem.listener_baseline': listenerBaselinePass,
              ...(singleStepPass !== null ? { 'interact.single_step': singleStepPass } : {}),
              details: {
                cycles,
                hasLifecycle,
                firstStats,
                afterStats,
                firstHeapMB: firstHeap.usedMB,
                afterHeapMB: afterHeap.usedMB,
                firstListeners,
                afterListeners,
              },
            };
          } finally {
            collectLogs(handle);
            await handle.close();
          }
        } else if (kind === 'raf_rate' || kind === 'clock_independence') {
          const durationMs = Number(step.durationMs || 5000);
          const rates = Array.isArray(step.rates) && step.rates.length === 2 ? step.rates : [30, 144];
          const viewport = step.viewport || defaultViewport;
          const params = getParams(seed, 'raf30');

          async function runAtRate(hz) {
            const h = await openPage({
              viewport,
              dpr: 1,
              seed,
              params,
            });
            try {
              await h.setSeed(seed, params);
              await h.seek(0);
              await h.installRafOverride();
              await h.resume();
              const info = await h.stepRafVirtual(durationMs, hz, 0);
              await h.renderFrame();
              const st = await h.state();
              return { hz, info, state: st };
            } finally {
              collectLogs(h);
              await h.close();
            }
          }

          const r1 = await runAtRate(rates[0]);
          const r2 = await runAtRate(rates[1]);
          const a1 = Number(r1.state?.orbitAngleDeg ?? 0);
          const a2 = Number(r2.state?.orbitAngleDeg ?? 0);
          const deltaDeg = wrappedAngleDiffDeg(a1, a2);

          probes[step.key] = {
            'anim.clock_independence': deltaDeg,
            details: {
              durationMs,
              rateA: rates[0],
              angleA: a1,
              stepsA: r1.info.steps,
              rateB: rates[1],
              angleB: a2,
              stepsB: r2.info.steps,
            },
          };
        }
      }
    }

    // ---- Execute plan.probes ----
    if (canRender && Array.isArray(plan?.probes) && plan.probes.length > 0) {
      for (const p of plan.probes) {
        const seed = p.seed ?? defaultSeed;
        const variant = p.variant || 'normal';
        const cfg = variantToPageConfig(variant, p);
        const params = getParams(seed, variant);

        const handle = await openPage({
          viewport: cfg.viewport,
          dpr: cfg.dpr,
          colorScheme: cfg.colorScheme,
          reducedMotion: cfg.reducedMotion,
          locale: cfg.locale,
          seed,
          params,
        });
        try {
          await handle.setSeed(seed, params);
          await handle.seek(Number(p.t ?? 0));
          await handle.renderFrame();
          probes[p.key] = await runProbe(p.probe, handle, p.args || {});
        } finally {
          collectLogs(handle);
          await handle.close();
        }
      }
    }

    // ---- Execute plan.tests ----
    if (Array.isArray(plan?.tests) && plan.tests.length > 0) {
      tests = await runTests(plan.tests, {
        browserSession,
        origin: server.origin,
        url: server.url,
        localResolver,
        spec,
        adapter,
        hidden,
        workDir: absWorkDir,
        defaultViewport,
        defaultSeed,
        onLogs: collectLogs,
      });
    }

    // ---- Optional room adapter extraCapture(ctx) ----
    if (canRender && adapter && typeof adapter.extraCapture === 'function') {
      await adapter.extraCapture({
        browserSession,
        openPage,
        localResolver,
        origin: server.origin,
        url: server.url,
        workDir: absWorkDir,
        manifest,
        probes,
        spec,
        hidden,
        getParams,
        collectLogs,
      });
    }

    // ---- Finalize session-wide gates ----
    const consoleErrors = consoleAll.filter((c) => c.type === 'error' || c.type === 'pageerror');
    gates['G-console'] = {
      pass: consoleErrors.length === 0,
      detail: consoleErrors.length === 0
        ? '0 console errors / uncaught exceptions'
        : `${consoleErrors.length} error(s): ${consoleErrors.slice(0, 3).map((e) => e.text).join(' | ')}`,
    };

    const externalRequests = networkAll.filter((n) => !n.allowed);
    gates['G-offline'] = {
      pass: externalRequests.length === 0,
      detail: externalRequests.length === 0
        ? '0 requests outside local origin'
        : `${externalRequests.length} external request(s): ${externalRequests.slice(0, 3).map((r) => r.url).join(', ')}`,
    };

    const externalFonts = fontResponsesAll.filter((f) => !f.allowed);
    const fontsPass = Boolean(fontsReadyResult.ok) && externalFonts.length === 0;
    gates['G-fonts-local'] = {
      pass: fontsPass,
      detail: fontsPass
        ? `All fonts local (${fontResponsesAll.length} font response(s)), document.fonts.ready resolved`
        : (!fontsReadyResult.ok
          ? `document.fonts.ready failed: ${fontsReadyResult.error}`
          : `${externalFonts.length} non-local font(s): ${externalFonts.map((f) => f.url).join(', ')}`),
    };

    // ---- Optional perf measurement (real GPU headed Chromium) ----
    if (canRender && plan?.perf?.enabled) {
      perf = await runPerfMeasurement(plan.perf, {
        submissionUrl: server.url,
        origin: server.origin,
        spec,
        defaultSeed,
        getParams,
      });
      await fs.writeFile(path.join(absWorkDir, 'perf.json'), JSON.stringify(perf, null, 2));
    }

    // ---- Optional Lighthouse (TODO stub) ----
    if (plan?.lighthouse?.enabled) {
      // TODO: Implement offline Lighthouse runner using pinned node_modules/lighthouse
      // with desktop preset + simulated throttling against local origin (median of 5 runs).
      // Currently stubbed to return null so offline captures do not fail.
      lighthouse = null;
    }

    // ---- Write manifest.json and probes.json ----
    const manifestPath = path.join(absWorkDir, 'manifest.json');
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));
    if (Object.keys(probes).length > 0) {
      await fs.writeFile(path.join(absWorkDir, 'probes.json'), JSON.stringify(probes, null, 2));
    }

    return {
      manifestPath,
      probes,
      gates,
      tests,
      perf,
      lighthouse,
      console: consoleAll,
      network: networkAll,
    };
  })();

  try {
    return await Promise.race([runBody, watchdogPromise]);
  } finally {
    if (watchdogTimer) clearTimeout(watchdogTimer);
    await cleanupResources();
  }
}
