#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PNG } from "pngjs";
import { loadSpec, buildPlan, parseVersion, resolveVersionPaths } from "./spec.mjs";
import { scoreSubmission, scoreMetric, round1, isV2Spec } from "./score.mjs";
import { registerMetrics } from "./registry.mjs";
import { evaluateStaticGates, combineGates, getGitChangedFiles, evaluateAliveGate } from "./gates.mjs";
import { evaluateHonesty, evaluateAutonomy, evaluateDecisionCorrect } from "./report.mjs";
import { compareSourceTrees, compareAllFiles, countPatchLines, computeDiffMetrics } from "./diffmetrics.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const IS_ISOLATED_BENCH =
  fs.existsSync(path.join(__dirname, "..", "schemas")) &&
  !fs.existsSync(path.join(__dirname, "..", "..", "harness"));
const REPO_ROOT = IS_ISOLATED_BENCH ? path.resolve(__dirname, "..") : path.resolve(__dirname, "..", "..");
const BENCH_VERSION = "0.1.0";

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      if (
        key === "hidden" ||
        key === "no-capture" ||
        key === "no-python" ||
        key === "perf" ||
        key === "lenient" ||
        key === "timed-out"
      ) {
        flags[key] = true;
      } else {
        flags[key] = argv[++i];
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

function findPythonExecutable(repoRoot = REPO_ROOT) {
  const winVenv = path.join(repoRoot, ".venv", "Scripts", "python.exe");
  if (fs.existsSync(winVenv)) return winVenv;
  const unixVenv = path.join(repoRoot, ".venv", "bin", "python");
  if (fs.existsSync(unixVenv)) return unixVenv;
  return "python";
}

export async function loadRoomAdapter(room, { version = 1, repoRoot = REPO_ROOT, adapterDir = null } = {}) {
  const v = parseVersion(version);
  const envDirs = (process.env.MOL_ADAPTER_DIRS || "")
    .split(path.delimiter)
    .map((s) => s.trim())
    .filter(Boolean);
  const defaultDirs =
    v === 2
      ? [path.join(__dirname, "rooms-v2"), path.join(repoRoot, "harness", "src", "rooms-v2")]
      : [path.join(__dirname, "rooms"), path.join(repoRoot, "harness", "src", "rooms")];
  const candidateDirs = [
    ...(adapterDir ? [path.resolve(adapterDir)] : []),
    ...envDirs.map((d) => path.resolve(d)),
    ...defaultDirs.map((d) => path.resolve(d))
  ];

  let loaded = null;
  for (const dir of [...new Set(candidateDirs)]) {
    const adapterPath = path.join(dir, `${room}.mjs`);
    if (fs.existsSync(adapterPath)) {
      loaded = await import(pathToFileURL(adapterPath).href);
      break;
    }
  }
  if (!loaded) {
    const tplPath = path.join(__dirname, "rooms", "_template.mjs");
    if (fs.existsSync(tplPath)) {
      loaded = await import(pathToFileURL(tplPath).href);
    }
  }
  if (loaded && typeof loaded.registerMetrics === "function") {
    const defs = loaded.registerMetrics();
    if (defs && typeof defs === "object") {
      registerMetrics(defs, { replace: true });
    }
  }
  return loaded;
}

const _toolchainCache = new Map();

function readPlaywrightChromiumInfo(repoRoot) {
  const cacheKey = `pw:${repoRoot}`;
  if (_toolchainCache.has(cacheKey)) return _toolchainCache.get(cacheKey);
  let info = null;
  try {
    const pwCoreDir = path.join(repoRoot, "node_modules", "playwright-core");
    const pkgPath = path.join(pwCoreDir, "package.json");
    const browsersPath = path.join(pwCoreDir, "browsers.json");
    const pkgVer = fs.existsSync(pkgPath) ? JSON.parse(fs.readFileSync(pkgPath, "utf8")).version : null;
    let rev = null;
    if (fs.existsSync(browsersPath)) {
      const browsers = JSON.parse(fs.readFileSync(browsersPath, "utf8")).browsers || [];
      const chromium = browsers.find((b) => b.name === "chromium");
      if (chromium?.revision) rev = chromium.revision;
    }
    if (pkgVer && rev) info = `playwright-core@${pkgVer} (chromium rev ${rev})`;
    else if (pkgVer) info = `playwright-core@${pkgVer}`;
  } catch {
    info = null;
  }
  _toolchainCache.set(cacheKey, info);
  return info;
}

function readPythonVersion(repoRoot) {
  const cacheKey = `py:${repoRoot}`;
  if (_toolchainCache.has(cacheKey)) return _toolchainCache.get(cacheKey);
  let ver = null;
  try {
    const py = findPythonExecutable(repoRoot);
    ver = execFileSync(py, ["--version"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    }).trim().replace(/^Python\s+/i, "");
  } catch {
    ver = null;
  }
  _toolchainCache.set(cacheKey, ver);
  return ver;
}

export function collectToolchainInfo({ repoRoot = REPO_ROOT, captureRes = null, noCapture = false, noPython = false } = {}) {
  const capTc = captureRes?.toolchain || {};
  return {
    chromium_version: capTc.chromium_version ?? readPlaywrightChromiumInfo(repoRoot),
    swiftshader_renderer: capTc.swiftshader_renderer ?? (noCapture ? null : "Google SwiftShader (ANGLE)"),
    blender_version: capTc.blender_version ?? null,
    node_version: process.version,
    python_version: noPython ? null : readPythonVersion(repoRoot),
    os_platform: `${process.platform}-${process.arch}`
  };
}

function runPythonMetrics(manifestPath, specPath, outPath, repoRoot = REPO_ROOT, renovationStartPath = null) {
  const py = findPythonExecutable(repoRoot);
  const metricsPkgDir = path.join(repoRoot, "metrics");
  const pythonPath = [metricsPkgDir, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter);
  try {
    execFileSync(py, ["-m", "molmetrics", "compute", "--manifest", manifestPath, "--spec", specPath, "--out", outPath, ...(renovationStartPath ? ["--renovation-start", renovationStartPath] : [])], {
      cwd: repoRoot,
      env: { ...process.env, PYTHONPATH: pythonPath },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    });
  } catch (err) {
    const stderr = err.stderr ? String(err.stderr).trim() : err.message;
    throw new Error(
      `Python metric computation failed (${py} -m molmetrics compute). Ensure metrics/molmetrics is installed or pass --no-python. Detail: ${stderr}`
    );
  }
  if (!fs.existsSync(outPath)) {
    throw new Error(`Python molmetrics did not produce output file: ${outPath}`);
  }
  return JSON.parse(fs.readFileSync(outPath, "utf8"));
}

function normalizeProbeValue(val) {
  if (val && typeof val === "object" && "value" in val) return val.value;
  return val;
}

const BUNDLE_EXTS = new Set([".html", ".htm", ".js", ".mjs", ".cjs", ".css", ".glsl", ".vert", ".frag"]);
const BUNDLE_IGNORE_DIRS = new Set(["node_modules", ".git", "preview", "bench", "contract", "tests", "public-tests"]);
const BUNDLE_IGNORE_FILES = new Set(["report.json", "decisions.json", "selfcheck.json", ".bench-room", "package.json", "package-lock.json"]);

function computeBundleGzKb(submissionDir) {
  let totalGz = 0;
  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (BUNDLE_IGNORE_DIRS.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(full);
      } else if (e.isFile()) {
        if (BUNDLE_IGNORE_FILES.has(e.name)) continue;
        if (!BUNDLE_EXTS.has(path.extname(full).toLowerCase())) continue;
        totalGz += zlib.gzipSync(fs.readFileSync(full), { level: 9 }).length;
      }
    }
  }
  walk(submissionDir);
  return totalGz / 1024;
}

function medianValue(nums) {
  if (!Array.isArray(nums) || nums.length === 0) return null;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function probeMatchesParsedAt(probeMeta, parsedAt) {
  if (!probeMeta || !parsedAt) return true;
  if (Array.isArray(parsedAt.viewports) && parsedAt.viewports.length > 0 && !parsedAt.viewports.includes(probeMeta.viewport)) {
    return false;
  }
  if (parsedAt.raw && /\bboth schemes\b/i.test(parsedAt.raw) && Array.isArray(parsedAt.schemes) && !parsedAt.schemes.includes(probeMeta.scheme)) {
    return false;
  }
  if (parsedAt.raw && /\bvariants=/i.test(parsedAt.raw) && Array.isArray(parsedAt.variants) && !parsedAt.variants.includes(probeMeta.variant)) {
    return false;
  }
  return true;
}

function collectProbeMetrics(probes, plan, spec, rawMetrics) {
  if (!probes) return;
  const probeMetaByKey = new Map((plan?.probes || []).map((p) => [p.key, p]));
  const metricConfigsById = new Map();
  const addCfg = (m) => {
    if (!m?.id) return;
    if (!metricConfigsById.has(m.id)) metricConfigsById.set(m.id, []);
    metricConfigsById.get(m.id).push(m);
  };
  for (const m of spec?.metrics || []) addCfg(m);
  for (const req of spec?.requests || []) {
    for (const sm of req.metrics || []) addCfg(sm);
  }
  const matchesMetric = (mId, key) => {
    const cfgs = metricConfigsById.get(mId);
    if (!cfgs || cfgs.length === 0) return false;
    const meta = probeMetaByKey.get(key);
    if (!meta) return true;
    return cfgs.some((c) => probeMatchesParsedAt(meta, c.parsedAt));
  };

  for (const [key, val] of Object.entries(probes)) {
    if (!val || typeof val !== "object") continue;
    if (val.metricId) {
      if (!Array.isArray(rawMetrics[val.metricId])) rawMetrics[val.metricId] = [];
      rawMetrics[val.metricId].push({ key, ...val });
    } else if (val.metrics) {
      for (const [mId, mVal] of Object.entries(val.metrics)) {
        if (!Array.isArray(rawMetrics[mId])) rawMetrics[mId] = [];
        rawMetrics[mId].push({ key, value: normalizeProbeValue(mVal), ...(typeof mVal === "object" ? mVal : {}) });
      }
    } else {
      for (const [mId, mVal] of Object.entries(val)) {
        if (!matchesMetric(mId, key)) continue;
        if (!Array.isArray(rawMetrics[mId])) rawMetrics[mId] = [];
        rawMetrics[mId].push({ key, value: normalizeProbeValue(mVal), ...(typeof mVal === "object" ? mVal : {}) });
      }
    }
  }
}

function computeLayoutShiftSamples(spec, plan, startProbes, subProbes) {
  if (!startProbes || !subProbes) return [];
  const shiftCfg = (spec?.metrics || []).find((m) => m.id === "layout.shift_px");
  if (!shiftCfg) return [];
  const probeMetaByKey = new Map((plan?.probes || []).map((p) => [p.key, p]));
  const out = [];
  for (const [key, subProbe] of Object.entries(subProbes)) {
    const startProbe = startProbes[key];
    const startBoxes = startProbe?.details?.bboxes;
    const subBoxes = subProbe?.details?.bboxes;
    if (!startBoxes || !subBoxes) continue;
    const meta = probeMetaByKey.get(key);
    if (meta && meta.probe !== "layout") continue;
    if (meta && !probeMatchesParsedAt(meta, shiftCfg.parsedAt)) continue;
    const displacements = [];
    for (const sel of Object.keys(startBoxes)) {
      const list0 = startBoxes[sel] || [];
      const list1 = subBoxes[sel] || [];
      const count = Math.min(list0.length, list1.length);
      for (let i = 0; i < count; i++) {
        const b0 = list0[i];
        const b1 = list1[i];
        if (!b0 || !b1) continue;
        displacements.push(Math.hypot(Number(b1.x) - Number(b0.x), Number(b1.y) - Number(b0.y)));
      }
    }
    if (displacements.length > 0) {
      out.push({ key, value: medianValue(displacements) });
    }
  }
  return out;
}

function extractRawScalarValue(entry) {
  if (entry === null || entry === undefined) return undefined;
  if (typeof entry === "number" || typeof entry === "boolean") return entry;
  if (typeof entry === "object") {
    if (entry.raw !== undefined) return entry.raw;
    if (entry.value !== undefined) return entry.value;
  }
  return undefined;
}

export async function gradeSubmission({
  room,
  submissionDir,
  renovation = null,
  version = null,
  adapterDir = null,
  hidden = false,
  noCapture = false,
  noPython = false,
  perf = false,
  lenient = false,
  timedOut = false,
  interventions = 0,
  repoRoot = REPO_ROOT,
  workDir = null,
  start = null
}) {
  const resolvedSub = path.resolve(submissionDir);
  if (!fs.existsSync(resolvedSub)) {
    throw new Error(`Submission directory does not exist: ${resolvedSub}`);
  }

  let adapterRoomName = room;
  let inferredVersion = version !== null && version !== undefined ? parseVersion(version) : 1;
  if (typeof room === "string" && room.endsWith(".json")) {
    const directPath = fs.existsSync(room) ? path.resolve(room) : path.resolve(repoRoot, room);
    if (fs.existsSync(directPath)) {
      try {
        const peek = JSON.parse(fs.readFileSync(directPath, "utf8"));
        if (typeof peek.room === "string" && peek.room.length > 0) adapterRoomName = peek.room;
        if ((version === null || version === undefined) && isV2Spec(peek)) inferredVersion = 2;
      } catch {
        // loadSpec will report the parse error
      }
    }
  }

  // Load room adapter before loadSpec so adapter.registerMetrics() populates registry.mjs.
  const adapter = await loadRoomAdapter(adapterRoomName, { version: inferredVersion, repoRoot, adapterDir });
  const spec = loadSpec(room, { renovation, lenient, version: inferredVersion, repoRoot });
  const effectiveVersion = spec._version ?? inferredVersion;
  const versionPaths = resolveVersionPaths(effectiveVersion, repoRoot);
  const isV2 = effectiveVersion === 2 || isV2Spec(spec);

  const runId = `${spec.room}${spec.renovation ? `_${spec.renovation}` : ""}_${Date.now()}`;
  let resolvedWorkDir = workDir ? path.resolve(workDir) : path.join(repoRoot, "work", runId, spec.room);
  // Sandboxed agents (e.g. agy) may be unable to create folders in their workspace; fall back to the OS temp dir.
  try { fs.mkdirSync(resolvedWorkDir, { recursive: true }); }
  catch (err) {
    if (workDir || !["EPERM", "EACCES"].includes(err?.code)) throw err;
    resolvedWorkDir = path.join(os.tmpdir(), "mol-bench-work", runId, spec.room);
    fs.mkdirSync(resolvedWorkDir, { recursive: true });
  }

  // Load hidden seeds/timestamps if --hidden and <hiddenDir>/<room>/grade.json exists
  let seeds = spec.capture?.public_seeds ?? [1];
  let timestamps = spec.capture?.public_timestamps_ms ?? spec.capture?.timestamps_ms ?? [0];
  if (hidden) {
    const hiddenGradePath = path.join(versionPaths.hiddenDir, spec.room, "grade.json");
    if (fs.existsSync(hiddenGradePath)) {
      const hg = JSON.parse(fs.readFileSync(hiddenGradePath, "utf8"));
      if (Array.isArray(hg.seeds)) seeds = hg.seeds;
      if (Array.isArray(hg.timestamps_ms)) timestamps = hg.timestamps_ms;
    }
  }

  const plan = buildPlan(spec, { seeds, timestamps, hidden, renovation, version: effectiveVersion });
  plan.perf.enabled = Boolean(perf);

  // Static gates
  const defaultStart = spec.track === "renovation" ? path.join(versionPaths.roomsDir, spec.room, "anchors", "a5") : null;
  const startDir = start ? path.resolve(start) : defaultStart;
  let sourceComparison = null;
  let comparisonError = null;
  if (startDir) {
    try { sourceComparison = compareSourceTrees(startDir, resolvedSub, { excludeWorkspaceArtifacts: isV2 }); }
    catch (err) { comparisonError = err.message; }
  }
  const gitChanged = spec.track === "renovation" ? getGitChangedFiles(resolvedSub) : null;
  let changedFiles = gitChanged;
  if (!Array.isArray(changedFiles) && startDir) {
    try { changedFiles = compareAllFiles(startDir, resolvedSub, { excludeWorkspaceArtifacts: isV2 }); } catch (err) { comparisonError ||= err.message; }
  }
  const staticRes = evaluateStaticGates(resolvedSub, spec, { repoRoot, changedFiles });

  const rawMetrics = {};
  if (staticRes.scopeCheck) {
    rawMetrics["diff.out_of_scope_files"] = staticRes.scopeCheck.outOfScopeCount;
  } else if (spec.metrics.some((m) => m.id === "diff.out_of_scope_files")) {
    rawMetrics["diff.out_of_scope_files"] = 3;
    rawMetrics._diffError = comparisonError || "changed file comparison unavailable";
  }
  if (!noCapture && spec.metrics.some((m) => m.id === "budget.bundle_gz_kb")) {
    rawMetrics["budget.bundle_gz_kb"] = computeBundleGzKb(resolvedSub);
  }
  const hasDiffMetrics = spec.metrics.some((m) => m.id === "diff.change_ratio" || m.id === "diff.rewrite");
  if (hasDiffMetrics) {
    try {
      if (!startDir) throw new Error("no start directory; pass --start <dir>");
      let denominator;
      if (spec.track === "renovation") {
        let patchPath = path.join(versionPaths.roomsDir, spec.room, "renovation", `${spec.renovation}.min-diff.patch`);
        if (!fs.existsSync(patchPath) && isV2) {
          patchPath = path.join(versionPaths.roomsDir, spec.room, "renovation", "chain", `${spec.renovation}.min-diff.patch`);
        }
        if (!fs.existsSync(patchPath)) throw new Error(`minimal diff patch unavailable: ${patchPath}`);
        denominator = countPatchLines(patchPath);
      } else {
        if (typeof adapter?.diffDenominator !== "function") throw new Error("room adapter does not provide diffDenominator(ctx)");
        denominator = await adapter.diffDenominator({ spec, submissionDir: resolvedSub, startDir, repoRoot, version: effectiveVersion });
      }
      const diff = computeDiffMetrics({ startDir, submissionDir: resolvedSub, denominator, excludeWorkspaceArtifacts: isV2 });
      if (spec.metrics.some((m) => m.id === "diff.change_ratio")) rawMetrics["diff.change_ratio"] = diff.change_ratio;
      if (spec.metrics.some((m) => m.id === "diff.rewrite")) rawMetrics["diff.rewrite"] = diff.rewrite;
    } catch (err) {
      const ratioMetric = spec.metrics.find((m) => m.id === "diff.change_ratio");
      const rewriteMetric = spec.metrics.find((m) => m.id === "diff.rewrite");
      if (ratioMetric) rawMetrics[ratioMetric.id] = ratioMetric.score?.zero ?? 1e9;
      if (rewriteMetric) rawMetrics[rewriteMetric.id] = false;
      rawMetrics._diffError = err.message;
    }
  }

  let captureGates = {};
  let captureRes = null;

  if (!noCapture) {
    const isBlenderRoom = String(spec.contract || spec._baseSpec?.contract || "").includes("blender");
    if (isBlenderRoom && typeof adapter?.captureBlender === "function") {
      fs.mkdirSync(resolvedWorkDir, { recursive: true });
      captureRes = await adapter.captureBlender({
        submissionDir: resolvedSub,
        workDir: resolvedWorkDir,
        spec,
        hidden,
        noPython,
        repoRoot
      });
      captureGates = captureRes.gates || {};
      if (captureRes.rawMetrics) {
        Object.assign(rawMetrics, captureRes.rawMetrics);
      }
    } else {
      const capturePlanPath = path.join(__dirname, "capture", "plan.mjs");
      if (!fs.existsSync(capturePlanPath)) {
        throw new Error(
          `Capture layer missing at ${capturePlanPath}. Wait for capture/plan.mjs or pass --no-capture for offline testing.`
        );
      }
      const { executePlan } = await import(pathToFileURL(capturePlanPath).href);
      try {
        fs.mkdirSync(resolvedWorkDir, { recursive: true });
      } catch (err) {
        if (!workDir && (err?.code === "EPERM" || err?.code === "EACCES")) {
          resolvedWorkDir = path.join(os.tmpdir(), "mol-bench-work", runId, spec.room);
          fs.mkdirSync(resolvedWorkDir, { recursive: true });
        } else {
          throw err;
        }
      }
      captureRes = await executePlan(plan, {
        submissionDir: resolvedSub,
        workDir: resolvedWorkDir,
        spec,
        adapter,
        hidden,
        noPython
      });
      captureGates = captureRes.gates || {};

      collectProbeMetrics(captureRes.probes, plan, spec, rawMetrics);

      if (Array.isArray(captureRes.tests)) {
        const total = captureRes.tests.length;
        const passed = captureRes.tests.filter((t) => t.pass).length;
        if (spec.metrics.some((m) => m.id === "tests.hidden")) {
          rawMetrics["tests.hidden"] = { passed, total };
        }
        if (spec.metrics.some((m) => m.id === "tests.preservation")) {
          rawMetrics["tests.preservation"] = { passed, total };
        }
      }

      if (captureRes.perf && typeof captureRes.perf.p95_norm_ms === "number") {
        rawMetrics["perf.frame_p95_norm_ms"] = captureRes.perf.p95_norm_ms;
      }
      if (captureRes.lighthouse) {
        if (typeof captureRes.lighthouse.lcp_ms === "number") rawMetrics["lh.lcp_ms"] = captureRes.lighthouse.lcp_ms;
        if (typeof captureRes.lighthouse.cls === "number") rawMetrics["lh.cls"] = captureRes.lighthouse.cls;
      }
      if (Array.isArray(captureRes.drawCalls) && captureRes.drawCalls.length > 0 && spec.metrics.some((m) => m.id === "budget.draw_calls")) {
        rawMetrics["budget.draw_calls"] = captureRes.drawCalls;
      }

      let startManifestPath = captureRes.startManifestPath ?? null;
      let startCapture = null;
      let startRawMetrics = null;
      if (spec.track === "renovation" && !startManifestPath && startDir && fs.existsSync(startDir)) {
        const startWorkDir = path.join(resolvedWorkDir, "_start");
        fs.mkdirSync(startWorkDir, { recursive: true });
        const startPlan = {
          ...plan,
          sequences: [],
          tests: [],
          perf: { enabled: false },
          lighthouse: { enabled: false }
        };
        startCapture = await executePlan(startPlan, {
          submissionDir: startDir,
          workDir: startWorkDir,
          spec,
          adapter,
          hidden,
          noPython
        });
        startManifestPath = startCapture.manifestPath ?? null;
        startRawMetrics = {};
        collectProbeMetrics(startCapture.probes, startPlan, spec, startRawMetrics);
        if (!noPython && startManifestPath) {
          const startPyOut = path.join(startWorkDir, "metrics.json");
          const startPyMetrics = runPythonMetrics(startManifestPath, spec._specPath, startPyOut, repoRoot);
          Object.assign(startRawMetrics, startPyMetrics);
        }
        if (adapter && typeof adapter.extraMetrics === "function") {
          await adapter.extraMetrics(
            {
              room: spec.room,
              submissionDir: startDir,
              workDir: startWorkDir,
              repoRoot,
              spec,
              plan: startPlan,
              seeds,
              timestamps,
              hidden,
              noCapture,
              noPython,
              staticRes: null,
              captureRes: startCapture,
              manifestPath: startManifestPath
            },
            startRawMetrics
          );
        }
      }

      if (!noPython && captureRes.manifestPath) {
        const pyOut = path.join(resolvedWorkDir, "metrics.json");
        const pyMetrics = runPythonMetrics(captureRes.manifestPath, spec._specPath, pyOut, repoRoot, startManifestPath);
        Object.assign(rawMetrics, pyMetrics);
      }

      if (spec.track === "renovation" && startCapture?.probes && captureRes.probes && spec.metrics.some((m) => m.id === "layout.shift_px")) {
        const shiftSamples = computeLayoutShiftSamples(spec, plan, startCapture.probes, captureRes.probes);
        if (shiftSamples.length > 0) {
          rawMetrics["layout.shift_px"] = shiftSamples;
        }
      }

      if (spec.track === "renovation" && startRawMetrics && Array.isArray(spec.requests)) {
        for (const req of spec.requests) {
          for (const sub of req.metrics || []) {
            if (sub.score?.type !== "relative") continue;
            const beforeVal = extractRawScalarValue(startRawMetrics[sub.id]);
            const afterVal = extractRawScalarValue(rawMetrics[sub.id]);
            if (beforeVal !== undefined && afterVal !== undefined) {
              rawMetrics[`request.${req.id}.${sub.id}`] = {
                before: beforeVal,
                after: afterVal
              };
            }
          }
        }
      }
    }
  }

  if (adapter && typeof adapter.extraMetrics === "function") {
    await adapter.extraMetrics(
      {
        room: spec.room,
        version: effectiveVersion,
        submissionDir: resolvedSub,
        workDir: resolvedWorkDir,
        repoRoot,
        spec,
        plan,
        seeds,
        timestamps,
        hidden,
        noCapture,
        noPython,
        staticRes,
        captureRes,
        manifestPath: captureRes?.manifestPath ?? null
      },
      rawMetrics
    );
  }

  if ((spec.gates || []).includes("G-alive")) {
    captureGates = { ...captureGates, "G-alive": evaluateAliveGate(rawMetrics, { skipped: noCapture || noPython }) };
  }
  const gates = combineGates(spec.gates, staticRes.gates, captureGates, { captureSkipped: noCapture });

  // Evaluate decision.correct for renovation before scoring request.<id> and honesty
  if (spec.track === "renovation") {
    const decEval = evaluateDecisionCorrect({ decisions: staticRes.decisions, spec, rawMetrics });
    for (const [reqId, res] of Object.entries(decEval.perRequest)) {
      if (res.pass !== null) {
        rawMetrics[`request.${reqId}.decision.correct`] = res.pass;
      }
    }
    if (decEval.value !== null && !("decision.correct" in rawMetrics)) {
      rawMetrics["decision.correct"] = decEval.value;
    }
  }

  // First pass score to get public-seed metric scores & request scores for honesty evaluation
  const preScored = scoreSubmission(spec, rawMetrics, { gates, failClosed: false });
  const publicMetricScores = {};
  const publicMetricValues = {};
  for (const [id, m] of Object.entries(preScored.metrics)) {
    publicMetricScores[id] = m.score;
    publicMetricValues[id] = m.raw;
  }
  const requestScores = {};
  if (preScored.requests) {
    for (const [reqId, reqObj] of Object.entries(preScored.requests)) {
      requestScores[reqId] = reqObj.score;
      publicMetricScores[`request.${reqId}`] = reqObj.score;
      publicMetricValues[`request.${reqId}`] = reqObj.score;
    }
  }

  // Evaluate report.honesty and report.autonomy
  const honestyRes = evaluateHonesty({
    report: staticRes.report,
    decisions: staticRes.decisions,
    spec,
    publicMetricScores,
    publicMetricValues,
    gates,
    requestScores
  });
  const autonomyRes = evaluateAutonomy({
    report: staticRes.report,
    spec,
    submissionDir: resolvedSub,
    changedSourceFiles: sourceComparison?.changedFiles.length ?? 0,
    timedOut
  });

  if (autonomyRes.score !== null && interventions > 0) {
    autonomyRes.score = Math.max(0, autonomyRes.score - interventions); // SCORING.md: each harness intervention costs 1 point
    autonomyRes.interventions = interventions;
  }
  rawMetrics["report.honesty"] = honestyRes.score;
  if (autonomyRes.score !== null) {
    rawMetrics["report.autonomy"] = autonomyRes.score;
  }

  // partialEval is strictly derived from harness CLI flags (--no-capture / --no-python), never submission files.
  const finalScored = scoreSubmission(spec, rawMetrics, { gates, partialEval: Boolean(noCapture || noPython) });
  const allWarnings = [...(spec.warnings || []), ...(finalScored.warnings || []), ...(rawMetrics._diffError ? [`Diff scoring error: ${rawMetrics._diffError}`] : [])];

  const result = {
    room: spec.room,
    ...(spec.renovation ? { renovation: spec.renovation } : {}),
    track: spec.track,
    spec_version: spec.spec_version,
    bench_version: isV2 ? "0.2.0" : BENCH_VERSION,
    submission: resolvedSub,
    seeds: hidden ? "hidden" : "public",
    gates: finalScored.gates,
    metrics: finalScored.metrics,
    ...(finalScored.requests ? { requests: finalScored.requests } : {}),
    axes: finalScored.axes,
    composite: finalScored.composite,
    completeness: finalScored.completeness,
    completeness_multiplier: finalScored.completeness_multiplier,
    taste: null,
    efficiency: { wall_min: null },
    ...(isV2 ? { toolchain: collectToolchainInfo({ repoRoot, captureRes, noCapture, noPython }) } : {}),
    ...(autonomyRes.invalid ? { invalid: true, invalid_reason: autonomyRes.outcome } : {}),
    ...(allWarnings.length > 0 ? { warnings: allWarnings } : {})
  };

  return result;
}

function readBenchRoomFile(dir) {
  const file = path.join(dir, ".bench-room");
  const runJsonFile = path.join(dir, ".run.json");
  let runMeta = null;
  if (fs.existsSync(runJsonFile)) {
    try {
      runMeta = JSON.parse(fs.readFileSync(runJsonFile, "utf8"));
    } catch {
      runMeta = null;
    }
  }
  const runVersion = runMeta?.version ?? (runMeta?.bench_version ? parseVersion(runMeta.bench_version) : null);
  if (!fs.existsSync(file)) {
    if (runMeta?.room) {
      return { room: runMeta.room, renovation: runMeta.renovation ?? null, version: runVersion };
    }
    throw new Error(`Missing .bench-room file in ${dir}. Create .bench-room containing the room name (e.g. "aurora").`);
  }
  const raw = fs.readFileSync(file, "utf8").trim();
  if (raw.startsWith("{")) {
    const parsed = JSON.parse(raw);
    const parsedVersion = parsed.version !== undefined ? parseVersion(parsed.version) : (parsed.bench_version ? parseVersion(parsed.bench_version) : runVersion);
    return { room: parsed.room, renovation: parsed.renovation ?? runMeta?.renovation ?? null, version: parsedVersion };
  }
  const parts = raw.split(/\s+/);
  return { room: parts[0], renovation: parts[1] ?? runMeta?.renovation ?? null, version: runVersion };
}

function formatSelfcheckTable(result) {
  const lines = [];
  lines.push(`MoL-Bench selfcheck: ${result.room}${result.renovation ? ` (${result.renovation})` : ""} [public seeds]`);
  lines.push("Gates:");
  for (const [id, g] of Object.entries(result.gates)) {
    const status = g.pass === true ? "PASS" : g.pass === false ? "FAIL" : "SKIP";
    lines.push(`  ${id.padEnd(18)} ${status.padEnd(6)} ${g.detail || ""}`);
  }
  lines.push("Metrics:");
  for (const [id, m] of Object.entries(result.metrics)) {
    const rawStr = m.raw === null || m.raw === undefined ? "null" : String(typeof m.raw === "number" ? Number(m.raw.toFixed(4)) : m.raw);
    const scStr = m.score === null || m.score === undefined ? "null" : String(round1(m.score));
    lines.push(`  ${id.padEnd(32)} raw=${rawStr.padEnd(10)} score=${scStr}`);
  }
  lines.push("Axes:");
  for (const [axis, val] of Object.entries(result.axes)) {
    lines.push(`  ${axis.padEnd(18)} ${val === null ? "null" : round1(val)}`);
  }
  lines.push(`Composite: ${result.composite === null ? "null" : round1(result.composite)}`);
  return lines.join("\n");
}

function resizeRgbaNearest(srcData, srcW, srcH, dstW, dstH) {
  const out = Buffer.alloc(dstW * dstH * 4);
  for (let y = 0; y < dstH; y++) {
    const sy = Math.min(srcH - 1, Math.floor((y * srcH) / dstH));
    for (let x = 0; x < dstW; x++) {
      const sx = Math.min(srcW - 1, Math.floor((x * srcW) / dstW));
      const si = (sy * srcW + sx) * 4;
      const di = (y * dstW + x) * 4;
      out[di] = srcData[si];
      out[di + 1] = srcData[si + 1];
      out[di + 2] = srcData[si + 2];
      out[di + 3] = srcData[si + 3];
    }
  }
  return out;
}

export function generatePreviewContactSheets(manifestPath, outDir, opts = {}) {
  const resolvedManifest = path.resolve(manifestPath);
  if (!fs.existsSync(resolvedManifest)) {
    throw new Error(`Manifest file not found: ${resolvedManifest}`);
  }
  const manifestDir = path.dirname(resolvedManifest);
  const manifest = JSON.parse(fs.readFileSync(resolvedManifest, "utf8"));
  const samples = manifest.samples || [];
  if (samples.length === 0) {
    throw new Error(`No samples found in manifest: ${resolvedManifest}`);
  }

  const cols = opts.cols ?? 3;
  const thumbW = opts.thumbW ?? 320;
  const thumbH = opts.thumbH ?? 200;
  const pad = opts.pad ?? 8;
  const perSheet = opts.perSheet ?? 12;

  fs.mkdirSync(outDir, { recursive: true });
  const written = [];

  for (let offset = 0, sheetIdx = 1; offset < samples.length; offset += perSheet, sheetIdx++) {
    const chunk = samples.slice(offset, offset + perSheet);
    const rows = Math.ceil(chunk.length / cols);
    const width = cols * thumbW + (cols + 1) * pad;
    const height = rows * thumbH + (rows + 1) * pad;
    const sheet = new PNG({ width, height });
    // Dark neutral background (#18181b)
    for (let i = 0; i < sheet.data.length; i += 4) {
      sheet.data[i] = 24;
      sheet.data[i + 1] = 24;
      sheet.data[i + 2] = 27;
      sheet.data[i + 3] = 255;
    }

    chunk.forEach((sample, idx) => {
      const imgPath = path.resolve(manifestDir, sample.file);
      if (!fs.existsSync(imgPath)) return;
      const srcPng = PNG.sync.read(fs.readFileSync(imgPath));
      const resized = resizeRgbaNearest(srcPng.data, srcPng.width, srcPng.height, thumbW, thumbH);
      const col = idx % cols;
      const row = Math.floor(idx / cols);
      const destX = pad + col * (thumbW + pad);
      const destY = pad + row * (thumbH + pad);
      for (let y = 0; y < thumbH; y++) {
        for (let x = 0; x < thumbW; x++) {
          const si = (y * thumbW + x) * 4;
          const di = ((destY + y) * width + (destX + x)) * 4;
          sheet.data[di] = resized[si];
          sheet.data[di + 1] = resized[si + 1];
          sheet.data[di + 2] = resized[si + 2];
          sheet.data[di + 3] = resized[si + 3];
        }
      }
    });

    const outPath = path.join(outDir, `${manifest.room || "preview"}_sheet_${sheetIdx}.png`);
    fs.writeFileSync(outPath, PNG.sync.write(sheet));
    written.push(outPath);
  }

  return written;
}

function parseAttackThreshold(attackEntry, defaultThreshold = 4) {
  const m = String(attackEntry).match(/composite\s*<=?\s*(\d+(?:\.\d+)?)/i);
  return m ? Number(m[1]) : defaultThreshold;
}

async function runCalibrate(room, flags) {
  const renovation = flags.renovation ?? null;
  const version = flags.version !== undefined ? parseVersion(flags.version) : 1;
  const versionPaths = resolveVersionPaths(version, REPO_ROOT);
  const lenient = Boolean(flags.lenient);
  const noCapture = Boolean(flags["no-capture"]);
  const noPython = Boolean(flags["no-python"]);
  await loadRoomAdapter(room, { version, repoRoot: REPO_ROOT });
  const spec = loadSpec(room, { renovation, lenient, version, repoRoot: REPO_ROOT });

  const roomBase = path.join(versionPaths.roomsDir, room);
  const candidates = [
    { label: "null", dir: path.join(roomBase, "seed") },
    { label: "a5", dir: path.join(roomBase, "anchors", "a5") },
    { label: "a8", dir: path.join(roomBase, "anchors", "a8") }
  ];

  const attacksDir = path.join(roomBase, "attacks");
  const attackSpecs = spec.attacks || [];
  const defaultAttackThresh = version === 2 ? 3.0 : 4;
  if (fs.existsSync(attacksDir)) {
    for (const entry of fs.readdirSync(attacksDir)) {
      const full = path.join(attacksDir, entry);
      if (fs.statSync(full).isDirectory()) {
        const specLine = attackSpecs.find((a) => a.startsWith(entry));
        candidates.push({
          label: `attack:${entry}`,
          dir: full,
          threshold: parseAttackThreshold(specLine, defaultAttackThresh)
        });
      }
    }
  }

  const graded = {};
  const missing = [];
  for (const c of candidates) {
    if (!fs.existsSync(c.dir)) {
      missing.push({ label: c.label, dir: c.dir });
      continue;
    }
    graded[c.label] = await gradeSubmission({
      room,
      submissionDir: c.dir,
      renovation,
      version,
      hidden: Boolean(flags.hidden),
      noCapture,
      noPython,
      lenient,
      repoRoot: REPO_ROOT
    });
  }

  const checks = [];
  if (graded.null && graded.a5 && graded.a8) {
    for (const m of spec.metrics) {
      const sNull = graded.null.metrics[m.id]?.score;
      const sA5 = graded.a5.metrics[m.id]?.score;
      const sA8 = graded.a8.metrics[m.id]?.score;
      if (sNull !== null && sA5 !== null && sA8 !== null) {
        checks.push({
          check: `metric_order:${m.id}`,
          pass: sA8 >= sA5 && sA5 >= sNull,
          detail: `a8=${round1(sA8)} >= a5=${round1(sA5)} >= null=${round1(sNull)}`
        });
      }
    }
    const cA8 = graded.a8.composite;
    const cA5 = graded.a5.composite;
    if (cA8 !== null) {
      checks.push({
        check: "composite_band:a8",
        pass: cA8 >= 7.5 && cA8 <= 8.5,
        detail: `a8=${round1(cA8)} in [7.5, 8.5]`
      });
    }
    if (cA5 !== null) {
      checks.push({
        check: "composite_band:a5",
        pass: cA5 >= 4.5 && cA5 <= 5.5,
        detail: `a5=${round1(cA5)} in [4.5, 5.5]`
      });
    }
  }

  for (const c of candidates.filter((x) => x.label.startsWith("attack:"))) {
    const res = graded[c.label];
    if (res && res.composite !== null) {
      checks.push({
        check: `attack:${c.label}`,
        pass: res.composite <= c.threshold,
        detail: `composite=${round1(res.composite)} <= ${c.threshold}`
      });
    }
  }

  console.log(JSON.stringify({ room, renovation, missing, checks, graded }, null, 2));
}

function findDefaultManifest(repoRoot, roomFilter = null) {
  const workDir = path.join(repoRoot, "work");
  if (!fs.existsSync(workDir)) return null;
  for (const run of fs.readdirSync(workDir)) {
    const runPath = path.join(workDir, run);
    if (!fs.statSync(runPath).isDirectory()) continue;
    for (const r of fs.readdirSync(runPath)) {
      if (roomFilter && r !== roomFilter) continue;
      const cand = path.join(runPath, r, "manifest.json");
      if (fs.existsSync(cand)) return cand;
    }
  }
  return null;
}

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const cmd = positional[0];

  if (!cmd || cmd === "--help" || cmd === "-h") {
    console.log(
      "Usage:\n" +
        "  bench grade <room> <dir> [--version 1|2] [--renovation r1] [--start <dir>] [--hidden] [--out f] [--no-capture] [--no-python] [--perf] [--lenient]\n" +
        "  bench selfcheck [--dir <dir>] [--version 1|2] [--renovation r1] [--no-capture] [--no-python] [--lenient]\n" +
        "  bench preview [--manifest <path>] [--out <dir>] [--room <room>]\n" +
        "  bench calibrate <room> [--version 1|2] [--renovation r1] [--hidden] [--no-capture] [--no-python] [--lenient]"
    );
    return;
  }

  if (cmd === "grade") {
    const [, room, dir] = positional;
    if (!room || !dir) {
      throw new Error("Usage: bench grade <room> <dir> [options]");
    }
    const result = await gradeSubmission({
      room,
      submissionDir: dir,
      renovation: flags.renovation ?? null,
      version: flags.version ?? null,
      hidden: Boolean(flags.hidden),
      noCapture: Boolean(flags["no-capture"]),
      noPython: Boolean(flags["no-python"]),
      perf: Boolean(flags.perf),
      lenient: Boolean(flags.lenient),
      timedOut: Boolean(flags["timed-out"]),
      interventions: Number(flags.interventions || 0),
      workDir: flags["work-dir"] ?? null,
      start: flags.start ?? null,
      repoRoot: REPO_ROOT
    });

    const json = JSON.stringify(result, null, 2);
    if (flags.out) {
      const outPath = path.resolve(flags.out);
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, json + "\n");
    }
    console.log(json);
    return;
  }

  if (cmd === "selfcheck") {
    const dir = path.resolve(flags.dir || process.cwd());
    const { room, renovation, version: benchRoomVersion } = readBenchRoomFile(dir);
    const result = await gradeSubmission({
      room,
      submissionDir: dir,
      renovation: flags.renovation ?? renovation,
      version: flags.version ?? benchRoomVersion ?? null,
      hidden: false, // selfcheck never touches hidden/
      noCapture: Boolean(flags["no-capture"]),
      noPython: Boolean(flags["no-python"]),
      perf: Boolean(flags.perf),
      lenient: Boolean(flags.lenient),
      timedOut: Boolean(flags["timed-out"]),
      interventions: Number(flags.interventions || 0),
      repoRoot: REPO_ROOT
    });
    fs.writeFileSync(path.join(dir, "selfcheck.json"), JSON.stringify(result, null, 2) + "\n");
    console.log(formatSelfcheckTable(result));
    return;
  }

  if (cmd === "preview") {
    const manifestPath = flags.manifest || findDefaultManifest(REPO_ROOT, flags.room);
    if (!manifestPath) {
      throw new Error("No manifest.json found. Pass --manifest <path>.");
    }
    const outDir = path.resolve(flags.out || path.join(process.cwd(), "preview"));
    const sheets = generatePreviewContactSheets(manifestPath, outDir);
    console.log(JSON.stringify({ manifest: manifestPath, sheets }, null, 2));
    return;
  }

  if (cmd === "calibrate") {
    const [, room] = positional;
    if (!room) {
      throw new Error("Usage: bench calibrate <room> [--renovation r1]");
    }
    await runCalibrate(room, flags);
    return;
  }

  if (cmd === "blender-run") {
    const dir = path.resolve(flags.dir || process.cwd());
    const blenderBin =
      process.env.BLENDER_BIN && fs.existsSync(process.env.BLENDER_BIN)
        ? process.env.BLENDER_BIN
        : fs.existsSync("C:/Program Files/Blender Foundation/Blender 5.3/blender.exe")
          ? "C:/Program Files/Blender Foundation/Blender 5.3/blender.exe"
          : "blender";
    const bp = flags.blueprint || "blueprint/";
    const out = flags.out || "out/";
    execFileSync(
      blenderBin,
      ["-b", "--factory-startup", "--threads", "4", "--python", "build.py", "--", "--blueprint", bp, "--out", out],
      { cwd: dir, stdio: "inherit" }
    );
    return;
  }

  throw new Error(`Unknown command: "${cmd}"`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  });
}
