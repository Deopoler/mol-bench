import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startServer } from './server.mjs';
import { launchBrowser, parseViewportSpec } from './browser.mjs';
import { runProbe } from './probes/index.js';
import { pixelSha256, pngMeanAbsDiff, median } from './probes/shared.js';
import { runTests } from './testrunner.mjs';
import { isV2Spec } from '../score.mjs';

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
      // Bench tooling dirs and scratch output are never part of the submission's assets.
      if (['node_modules', '.git', '.venv', 'bench', 'metrics', 'work', 'preview', '__pycache__'].includes(entry.name)) continue;
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
  const rawViewport = base.viewport || '1440x900';
  const vpSpec = parseViewportSpec(rawViewport);
  const rawScheme = base.scheme || base.colorScheme || 'light';
  const isHighContrast =
    rawScheme === 'high_contrast' ||
    variant === 'high_contrast' ||
    variant === 'prefers_contrast_more';

  const cfg = {
    viewport: rawViewport,
    viewportSize: `${vpSpec.width}x${vpSpec.height}`,
    dpr: Number(base.dpr || 1),
    scheme: rawScheme,
    colorScheme: rawScheme === 'dark' ? 'dark' : 'light',
    contrast: isHighContrast ? 'more' : 'no-preference',
    reducedMotion: 'no-preference',
    locale: null,
    rootFontZoom: vpSpec.zoomPercent ?? (variant === 'zoom200' ? 200 : null),
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
  } else if (variant === 'lang_ja') {
    cfg.locale = 'ja-JP';
  }

  return cfg;
}

function sortedQuantile(sorted, q) {
  if (!sorted || sorted.length === 0) return null;
  if (sorted.length === 1) return sorted[0];
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/**
 * Compute interleaved Bracketed Calibration Ratio (BCR) statistics (V02-DESIGN §3.1B).
 * @param {Array<{ round?: number, c_pre: number, s: number, c_post: number }>} rawRounds
 */
export function computeBcrStats(rawRounds = []) {
  const rounds = rawRounds.map((entry, idx) => {
    const cPre = Number(entry?.c_pre);
    const s = Number(entry?.s);
    const cPost = Number(entry?.c_post);
    const validC = Number.isFinite(cPre) && Number.isFinite(cPost) && cPre > 0 && cPost > 0;
    const cBar = validC ? (cPre + cPost) / 2 : null;
    const drift = cBar !== null && cBar > 0 ? Math.abs(cPost - cPre) / cBar : Infinity;
    const unstable = !validC || drift > 0.12;
    const r = cBar !== null && cBar > 0 && Number.isFinite(s) && s >= 0 ? s / cBar : null;
    return {
      round: entry?.round ?? idx + 1,
      c_pre: Number.isFinite(cPre) ? cPre : null,
      s: Number.isFinite(s) ? s : null,
      c_post: Number.isFinite(cPost) ? cPost : null,
      c_bar: cBar,
      drift: Number.isFinite(drift) ? drift : null,
      unstable,
      r,
    };
  });

  const unstableRounds = rounds.filter((x) => x.unstable).length;
  const validCBars = rounds.map((x) => x.c_bar).filter((v) => typeof v === 'number' && Number.isFinite(v)).sort((a, b) => a - b);
  const medianC = median(validCBars);
  const q1 = sortedQuantile(validCBars, 0.25);
  const q3 = sortedQuantile(validCBars, 0.75);
  const iqrC = q1 !== null && q3 !== null ? q3 - q1 : null;
  const iqrRatio = medianC !== null && medianC > 0 && iqrC !== null ? iqrC / medianC : Infinity;

  const perfCalUnstable = validCBars.length === 0 || unstableRounds >= 2 || iqrRatio > 0.15;
  const validRatios = rounds.map((x) => x.r).filter((v) => typeof v === 'number' && Number.isFinite(v));
  const ratio = perfCalUnstable ? null : median(validRatios);
  const perfBcrSlow = !perfCalUnstable && ratio !== null && ratio > 2.5;

  return {
    ratio,
    perf_cal_unstable: perfCalUnstable,
    perf_bcr_slow: perfBcrSlow,
    unstable_rounds: unstableRounds,
    median_c_bar: medianC,
    iqr_ratio: Number.isFinite(iqrRatio) ? iqrRatio : null,
    rounds,
  };
}

async function measureDomCalDuration(pageHandle, { steps = 12 } = {}) {
  return pageHandle.page.evaluate(async (nSteps) => {
    const waitFrame = () => new Promise((r) => requestAnimationFrame(r));
    const durations = [];
    for (let i = 0; i < nSteps; i++) {
      const t0 = performance.now();
      if (window.__benchCal && typeof window.__benchCal.runStep === 'function') {
        window.__benchCal.runStep(i);
      } else {
        const chips = Array.from(document.querySelectorAll('[data-bench="filter-bar"] button, [data-bench="filter-bar"] [role="button"]'));
        if (chips.length > 0) {
          chips[i % chips.length].click();
        }
        const sel = document.querySelector('[data-bench="sort-select"]');
        if (sel && sel.options && sel.options.length > 0) {
          sel.selectedIndex = i % sel.options.length;
          sel.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }
      await waitFrame();
      durations.push(performance.now() - t0);
    }
    durations.sort((a, b) => a - b);
    const idx = Math.min(durations.length - 1, Math.floor(durations.length * 0.95));
    return {
      p95: durations.length > 0 ? durations[idx] : 0,
      median: durations.length > 0 ? durations[Math.floor(durations.length / 2)] : 0,
      steps: durations.length,
    };
  }, steps);
}

/**
 * Informational Bracketed Calibration Ratio (BCR) runner (V02-DESIGN §3.1B).
 * Supports `kind: 'webgl'` (`webgl_cal.html`) and `kind: 'dom'` (`dom_cal.html` under 4x CPU throttling).
 */
export async function runBcrCalibration({
  kind = 'webgl',
  submissionUrl = null,
  origin = null,
  localResolver = null,
  spec = {},
  defaultSeed = 1,
  getParams = () => ({}),
  viewport = '1440x900',
  rounds = 5,
  warmupMs = 250,
  measureMs = 800,
  domSteps = 12,
  cooldownMs = 10_000,
  strictPerf = false,
  mode = null,
  measurePairFn = null,
} = {}) {
  async function runSingleAttempt() {
    if (typeof measurePairFn === 'function') {
      const rawRounds = [];
      for (let i = 0; i < rounds; i++) {
        const m = await measurePairFn(i);
        rawRounds.push({ round: i + 1, ...m });
      }
      return computeBcrStats(rawRounds);
    }

    const calFile = kind === 'dom' ? 'dom_cal.html' : 'webgl_cal.html';
    const browserMode = mode || (kind === 'webgl' ? 'gpu' : 'swiftshader');
    let calServer = null;
    let browserSess = null;
    try {
      calServer = await startServer(CALIBRATION_DIR);
      const calResolver = calServer.loopbackReachable ? null : calServer.resolveFile;
      browserSess = await launchBrowser({ mode: browserMode });

      const calPage = await browserSess.newPage({
        origin: calServer.origin,
        url: `${calServer.origin}/${calFile}`,
        localResolver: calResolver,
        viewport,
        dpr: 1,
        seed: 1,
        params: {},
      });
      const subPage = await browserSess.newPage({
        origin,
        url: submissionUrl,
        localResolver,
        viewport,
        dpr: 1,
        seed: defaultSeed,
        params: getParams(defaultSeed, 'normal'),
        loadTimeoutMs: spec?.load_timeout_ms ?? 15000,
      });

      if (kind === 'dom') {
        await calPage.setCpuThrottling(4);
        await subPage.setCpuThrottling(4);
        // Warmup
        await measureDomCalDuration(calPage, { steps: 3 });
        await measureDomCalDuration(subPage, { steps: 3 });
      }

      const rawRounds = [];
      for (let i = 0; i < rounds; i++) {
        if (kind === 'dom') {
          const pre = await measureDomCalDuration(calPage, { steps: domSteps });
          const sub = await measureDomCalDuration(subPage, { steps: domSteps });
          const post = await measureDomCalDuration(calPage, { steps: domSteps });
          rawRounds.push({ round: i + 1, c_pre: pre.p95, s: sub.p95, c_post: post.p95 });
        } else {
          await subPage.seek(0).catch(() => {});
          const pre = await measureRafP95(calPage, { warmupMs, measureMs });
          await calPage.seek(0).catch(() => {});
          const sub = await measureRafP95(subPage, { warmupMs, measureMs });
          await subPage.seek(0).catch(() => {});
          const post = await measureRafP95(calPage, { warmupMs, measureMs });
          rawRounds.push({ round: i + 1, c_pre: pre.p95, s: sub.p95, c_post: post.p95 });
        }
      }
      return computeBcrStats(rawRounds);
    } finally {
      await browserSess?.close().catch(() => {});
      await calServer?.close().catch(() => {});
    }
  }

  let stats = await runSingleAttempt();
  let retried = false;
  if (stats.perf_cal_unstable) {
    retried = true;
    if (cooldownMs > 0) {
      await new Promise((r) => setTimeout(r, cooldownMs));
    }
    stats = await runSingleAttempt();
  }

  if (stats.perf_cal_unstable && strictPerf) {
    const err = new Error(`BCR calibration (${kind}) remained unstable after retry`);
    err.exitCode = 75;
    throw err;
  }

  return {
    kind,
    metric_id: kind === 'dom' ? 'perf.interaction_ratio' : 'perf.frame_ratio',
    retried,
    ...stats,
  };
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
  strictPerf = false,
} = {}) {
  if (!submissionDir) throw new Error('executePlan requires submissionDir');
  if (!workDir) throw new Error('executePlan requires workDir');

  const isV2 = isV2Spec(spec) || Number(spec?._version) === 2 || Boolean(plan?.captureBudgets);
  const specMetricIds = new Set([
    ...(Array.isArray(spec?.metrics) ? spec.metrics.map((m) => m?.id).filter(Boolean) : []),
    ...((spec?.requests || []).flatMap((r) => (r?.metrics || []).map((m) => m?.id)).filter(Boolean)),
  ]);

  // Restoration's functional suite drives multiple seeded mounts and resize,
  // lifecycle, and animation captures. Allow that full plan to finish on
  // software WebGL while retaining a finite watchdog for hung submissions.
  const watchdogMs = Number(planTimeoutMs ?? plan?.timeoutMs ?? 600_000);
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

  // Renovation specs may pin the language protected elements are compared in
  // (spec.protected.language). Default ("normal") captures then use that locale so the
  // start and the submission both render in it instead of Playwright's en-US default.
  const protectedLocale = { ko: 'ko-KR', en: 'en-US' }[spec?.protected?.language] ?? null;
  function pageConfig(variant, base = {}) {
    const cfg = variantToPageConfig(variant, base);
    if (protectedLocale && variant === 'normal' && !cfg.locale) cfg.locale = protectedLocale;
    return cfg;
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

    let entryUrl = server.url;
    if (!existsSync(path.join(submissionDir, 'index.html'))) {
      const delivs = [
        ...(Array.isArray(spec?.deliverables) ? spec.deliverables : []),
        ...(Array.isArray(spec?._baseSpec?.deliverables) ? spec._baseSpec.deliverables : []),
      ];
      const htmlDeliv = delivs.find((d) => typeof d === 'string' && d.endsWith('.html') && existsSync(path.join(submissionDir, d)));
      const fallbackRoomHtml = existsSync(path.join(submissionDir, 'room', 'index.html')) ? 'room/index.html' : null;
      const chosen = htmlDeliv || fallbackRoomHtml;
      if (chosen) {
        entryUrl = `${server.origin}/${chosen.replace(/^\/+/, '')}`;
      }
    }

    const openPage = (opts) => browserSession.newPage({
      origin: server.origin,
      url: entryUrl,
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
    const drawCalls = [];
    const renderPassesSamples = [];
    const webglFrameBudgets = [];
    let transferBytes = 0;
    let initDomMetrics = null;
    let initWebGLMetrics = null;
    let toolchainInfo = null;
    let tests = [];
    let perf = null;
    let bcr = null;
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
      transferBytes = initHandle.getTransferBytes();
      toolchainInfo = await initHandle.getToolchainInfo().catch(() => null);
      if (gates['G-load'].pass) {
        gates['G-contract'] = await initHandle.checkContract();
        fontsReadyResult = await initHandle.waitForFontsReady(loadTimeoutMs);
        if (gates['G-contract'].pass) {
          initDomMetrics = await initHandle.getDomMetrics().catch(() => null);
          initWebGLMetrics = await initHandle.getWebGLMetrics().catch(() => null);
          if (isV2 && initWebGLMetrics && initWebGLMetrics.drawCalls > 0) {
            drawCalls.push(initWebGLMetrics.drawCalls);
          } else {
            const st = await initHandle.stats().catch(() => null);
            if (st && typeof st.drawCalls === 'number') {
              drawCalls.push(st.drawCalls);
            }
          }
        }
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
      const detCfg = pageConfig(detSample.variant || 'normal', detSample);
      const detParams = getParams(detSeed, detSample.variant || 'normal');

      async function renderDetOnce() {
        const h = await openPage({
          viewport: detCfg.viewport,
          dpr: detCfg.dpr,
          colorScheme: detCfg.colorScheme,
          contrast: detCfg.contrast,
          reducedMotion: detCfg.reducedMotion,
          locale: detCfg.locale,
          rootFontZoom: detCfg.rootFontZoom,
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
        const cfg = pageConfig(variant, frame);
        const groupKey = JSON.stringify([
          cfg.viewportSize,
          cfg.dpr,
          cfg.colorScheme,
          cfg.contrast,
          cfg.reducedMotion,
          cfg.locale,
          cfg.rootFontZoom,
        ]);
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
          contrast: cfg.contrast,
          reducedMotion: cfg.reducedMotion,
          locale: cfg.locale,
          rootFontZoom: cfg.rootFontZoom,
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
            if (isV2) {
              await handle.resetWebGLFrameMetrics().catch(() => {});
            }
            await handle.renderFrame();

            if (isV2) {
              const glMetrics = await handle.getWebGLMetrics().catch(() => null);
              if (glMetrics) {
                webglFrameBudgets.push({ key: frame.key, seed, viewport: cfg.viewport, variant, ...glMetrics });
                if (specMetricIds.has('budget.draw_calls') && glMetrics.drawCalls > 0) {
                  drawCalls.push(glMetrics.drawCalls);
                }
                if (glMetrics.drawCalls > 0) {
                  renderPassesSamples.push({ key: frame.key, value: glMetrics.renderPasses });
                }
              }
            } else if (Array.isArray(spec?.metrics) && spec.metrics.some((m) => m.id === 'budget.draw_calls')) {
              const st = await handle.stats().catch(() => null);
              if (st && typeof st.drawCalls === 'number') {
                drawCalls.push(st.drawCalls);
              }
            }

            const relFile = `frames/${frame.key}.png`;
            const outPath = path.join(absWorkDir, relFile);
            await handle.screenshot(outPath);

            const sampleEntry = {
              key: frame.key,
              seed,
              t,
              viewport: cfg.viewport,
              scheme: cfg.scheme,
              variant,
              dpr: cfg.dpr,
              file: relFile,
            };
            if (frame.mask) sampleEntry.mask = frame.mask;

            const protectedSelectors = Array.isArray(spec?.protected?.elements) ? spec.protected.elements : [];
            const compareVps = Array.isArray(spec?.protected?.compare_at) ? spec.protected.compare_at : null;
            const compareSchemes = Array.isArray(spec?.protected?.color_schemes) ? spec.protected.color_schemes : null;
            if (
              protectedSelectors.length > 0 &&
              variant === 'normal' &&
              (!compareVps || compareVps.includes(cfg.viewport)) &&
              (!compareSchemes || compareSchemes.includes(cfg.scheme))
            ) {
              const fullRelFile = `frames/_full_${frame.key}.png`;
              await handle.screenshot(path.join(absWorkDir, fullRelFile), { fullPage: true });
              await handle.setDomBypass(true).catch(() => {});
              const rawBoxes = await handle.page.evaluate((selectors) => {
                const out = [];
                for (const sel of selectors) {
                  const els = Array.from(document.querySelectorAll(sel));
                  els.forEach((el, idx) => {
                    const r = el.getBoundingClientRect();
                    if (r.width <= 0 || r.height <= 0) return;
                    out.push({
                      selector: `${sel}#${idx}`,
                      bbox: {
                        x: r.left + window.scrollX,
                        y: r.top + window.scrollY,
                        width: r.width,
                        height: r.height,
                      },
                    });
                  });
                }
                return out;
              }, protectedSelectors).finally(() => handle.setDomBypass(false).catch(() => {}));
              sampleEntry.full_file = fullRelFile;
              sampleEntry.element_bboxes = rawBoxes.map((item) => ({
                selector: item.selector,
                bbox: cfg.dpr === 1 ? item.bbox : {
                  x: item.bbox.x * cfg.dpr,
                  y: item.bbox.y * cfg.dpr,
                  width: item.bbox.width * cfg.dpr,
                  height: item.bbox.height * cfg.dpr,
                },
              }));
            }

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
        const cfg = pageConfig(variant, seq);
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
          contrast: cfg.contrast,
          reducedMotion: cfg.reducedMotion,
          locale: cfg.locale,
          rootFontZoom: cfg.rootFontZoom,
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
        const kind = step.stepKind || step.kind;

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
        } else if (kind === 'nav_transition') {
          const variant = step.variant || 'normal';
          const cfg = pageConfig(variant, step);
          const params = getParams(seed, variant);
          const handle = await openPage({
            viewport: cfg.viewport,
            dpr: cfg.dpr,
            colorScheme: cfg.colorScheme,
            contrast: cfg.contrast,
            reducedMotion: cfg.reducedMotion,
            locale: cfg.locale,
            rootFontZoom: cfg.rootFontZoom,
            seed,
            params,
          });
          try {
            await handle.setSeed(seed, params);
            await handle.seek(Number(step.t ?? 0));
            await handle.renderFrame();
            const probeArgs = { ...(step.args || {}) };
            for (const optKey of ['stepMs', 'maxMs', 'threshold', 'stableFrames', 'triggerSelector']) {
              if (step[optKey] !== undefined && probeArgs[optKey] === undefined) {
                probeArgs[optKey] = step[optKey];
              }
            }
            const transRes = await runProbe('nav_transition', handle, probeArgs);
            const rawMs = transRes?.['nav.transition_ms'] ?? null;
            const isReducedMotion = variant === 'reduced_motion' || String(step.key || '').includes('reduced_motion');
            const metricKey = isReducedMotion ? 'a11y.reduced_motion_transition_ms' : 'nav.transition_ms';
            probes[step.key] = {
              [metricKey]: rawMs,
              metrics: { [metricKey]: rawMs },
              details: {
                ...(transRes?.details || {}),
                variant,
              },
            };
          } finally {
            collectLogs(handle);
            await handle.close();
          }
        }
      }
    }

    // ---- Execute plan.probes ----
    if (canRender && Array.isArray(plan?.probes) && plan.probes.length > 0) {
      for (const p of plan.probes) {
        const seed = p.seed ?? defaultSeed;
        const variant = p.variant || 'normal';
        const cfg = pageConfig(variant, p);
        const params = getParams(seed, variant);

        const handle = await openPage({
          viewport: cfg.viewport,
          dpr: cfg.dpr,
          colorScheme: cfg.colorScheme,
          contrast: cfg.contrast,
          reducedMotion: cfg.reducedMotion,
          locale: cfg.locale,
          rootFontZoom: cfg.rootFontZoom,
          seed,
          params,
        });
        try {
          await handle.setSeed(seed, params);
          await handle.seek(Number(p.t ?? 0));
          await handle.renderFrame();
          await handle.setDomBypass(true).catch(() => {});
          try {
            probes[p.key] = await runProbe(p.probe, handle, p.args || {});
          } finally {
            await handle.setDomBypass(false).catch(() => {});
          }
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
        url: entryUrl,
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
        url: entryUrl,
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
        submissionUrl: entryUrl,
        origin: server.origin,
        spec,
        defaultSeed,
        getParams,
      });
      await fs.writeFile(path.join(absWorkDir, 'perf.json'), JSON.stringify(perf, null, 2));
    }

    // ---- Optional informational BCR measurement (V02-DESIGN §3.1B) ----
    const wantsFrameBcr = plan?.bcr?.kind === 'webgl' || (isV2 && specMetricIds.has('perf.frame_ratio'));
    const wantsDomBcr = plan?.bcr?.kind === 'dom' || (isV2 && specMetricIds.has('perf.interaction_ratio'));
    if (canRender && (plan?.bcr?.enabled || wantsFrameBcr || wantsDomBcr)) {
      const bcrKind = plan?.bcr?.kind || (wantsDomBcr && !wantsFrameBcr ? 'dom' : 'webgl');
      try {
        bcr = await runBcrCalibration({
          kind: bcrKind,
          submissionUrl: entryUrl,
          origin: server.origin,
          localResolver,
          spec,
          defaultSeed,
          getParams,
          viewport: plan?.bcr?.viewport || defaultViewport,
          rounds: plan?.bcr?.rounds ?? 5,
          warmupMs: plan?.bcr?.warmupMs ?? 250,
          measureMs: plan?.bcr?.measureMs ?? 800,
          domSteps: plan?.bcr?.domSteps ?? 12,
          cooldownMs: plan?.bcr?.cooldownMs ?? 10_000,
          strictPerf: Boolean(strictPerf || plan?.bcr?.strictPerf),
          mode: plan?.bcr?.mode || null,
        });
      } catch (err) {
        if (err?.exitCode === 75) throw err;
        bcr = {
          kind: bcrKind,
          metric_id: bcrKind === 'dom' ? 'perf.interaction_ratio' : 'perf.frame_ratio',
          ratio: null,
          perf_cal_unstable: true,
          perf_bcr_slow: false,
          retried: false,
          error: String(err?.message || err),
        };
      }
      manifest.bcr = bcr;
      await fs.writeFile(path.join(absWorkDir, 'bcr.json'), JSON.stringify(bcr, null, 2));
      if (isV2 && specMetricIds.has(bcr.metric_id)) {
        probes._bcr = {
          metrics: { [bcr.metric_id]: bcr.ratio },
          details: bcr,
        };
      }
    }

    // ---- v0.2 WebGL & DOM budget summaries ----
    const transferKb = Number((transferBytes / 1024).toFixed(4));
    const webglBudgetSummary = (webglFrameBudgets.length > 0 || initWebGLMetrics)
      ? {
          frames: webglFrameBudgets,
          init: initWebGLMetrics,
          draw_calls: webglFrameBudgets.length > 0 ? median(webglFrameBudgets.map((x) => x.drawCalls)) : (initWebGLMetrics?.drawCalls ?? 0),
          render_passes: webglFrameBudgets.length > 0 ? median(webglFrameBudgets.map((x) => x.renderPasses)) : (initWebGLMetrics?.renderPasses ?? 0),
          vertices_drawn: webglFrameBudgets.length > 0 ? Math.max(...webglFrameBudgets.map((x) => x.verticesDrawn)) : (initWebGLMetrics?.verticesDrawn ?? 0),
          gl_calls_per_frame: webglFrameBudgets.length > 0 ? Math.max(...webglFrameBudgets.map((x) => x.glCalls)) : (initWebGLMetrics?.glCalls ?? 0),
          tex_upload_kb: Math.max(
            initWebGLMetrics?.texUploadKb ?? 0,
            ...webglFrameBudgets.map((x) => x.texUploadKb ?? 0),
          ),
          active_shaders: webglFrameBudgets[0]?.activeShaders?.length
            ? webglFrameBudgets[0].activeShaders
            : (initWebGLMetrics?.activeShaders ?? []),
          linked_programs: webglFrameBudgets[0]?.linkedPrograms?.length
            ? webglFrameBudgets[0].linkedPrograms
            : (initWebGLMetrics?.linkedPrograms ?? []),
        }
      : null;

    if (isV2) {
      manifest.transfer_kb = transferKb;
      if (webglBudgetSummary) {
        manifest.webgl_budget = webglBudgetSummary;
      }
      if (initDomMetrics) {
        manifest.dom_budget = initDomMetrics;
      }
      if (specMetricIds.has('budget.transfer_kb')) {
        probes._budget_transfer = { metrics: { 'budget.transfer_kb': transferKb } };
      }
      if (specMetricIds.has('budget.render_passes') && renderPassesSamples.length > 0) {
        for (const rps of renderPassesSamples) {
          probes[`_budget_render_passes_${rps.key}`] = { metrics: { 'budget.render_passes': rps.value } };
        }
      }
      const hasProbeMetric = (mid) => Object.values(probes).some((p) => p && (mid in p || (p.metrics && mid in p.metrics)));
      if (specMetricIds.has('perf.cls') && initDomMetrics && !hasProbeMetric('perf.cls')) {
        probes._perf_cls = { metrics: { 'perf.cls': initDomMetrics.cls } };
      }
      if (specMetricIds.has('budget.dom_nodes') && initDomMetrics && !hasProbeMetric('budget.dom_nodes')) {
        probes._budget_dom_nodes = { metrics: { 'budget.dom_nodes': initDomMetrics.domNodes } };
      }
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
      drawCalls,
      perf,
      bcr,
      transferKb,
      webglBudget: webglBudgetSummary,
      domMetrics: initDomMetrics,
      toolchain: toolchainInfo,
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
