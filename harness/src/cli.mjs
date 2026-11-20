#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PNG } from "pngjs";
import { loadSpec, buildPlan } from "./spec.mjs";
import { scoreSubmission, scoreMetric, round1 } from "./score.mjs";
import { evaluateStaticGates, combineGates, getGitChangedFiles } from "./gates.mjs";
import { evaluateHonesty, evaluateAutonomy, evaluateDecisionCorrect } from "./report.mjs";

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
        key === "lenient"
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

async function loadRoomAdapter(room) {
  const adapterPath = path.join(__dirname, "rooms", `${room}.mjs`);
  if (fs.existsSync(adapterPath)) {
    return import(pathToFileURL(adapterPath).href);
  }
  const tplPath = path.join(__dirname, "rooms", "_template.mjs");
  if (fs.existsSync(tplPath)) {
    return import(pathToFileURL(tplPath).href);
  }
  return null;
}

function runPythonMetrics(manifestPath, specPath, outPath, repoRoot = REPO_ROOT) {
  const py = findPythonExecutable(repoRoot);
  const metricsPkgDir = path.join(repoRoot, "metrics");
  const pythonPath = [metricsPkgDir, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter);
  try {
    execFileSync(py, ["-m", "molmetrics", "compute", "--manifest", manifestPath, "--spec", specPath, "--out", outPath], {
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

export async function gradeSubmission({
  room,
  submissionDir,
  renovation = null,
  hidden = false,
  noCapture = false,
  noPython = false,
  perf = false,
  lenient = false,
  repoRoot = REPO_ROOT,
  workDir = null
}) {
  const resolvedSub = path.resolve(submissionDir);
  if (!fs.existsSync(resolvedSub)) {
    throw new Error(`Submission directory does not exist: ${resolvedSub}`);
  }

  const spec = loadSpec(room, { renovation, lenient, repoRoot });
  const runId = `${spec.room}${spec.renovation ? `_${spec.renovation}` : ""}_${Date.now()}`;
  const resolvedWorkDir = workDir ? path.resolve(workDir) : path.join(repoRoot, "work", runId, spec.room);

  // Load hidden seeds/timestamps if --hidden and hidden/<room>/grade.json exists
  let seeds = spec.capture?.public_seeds ?? [1];
  let timestamps = spec.capture?.public_timestamps_ms ?? spec.capture?.timestamps_ms ?? [0];
  if (hidden) {
    const hiddenGradePath = path.join(repoRoot, "hidden", spec.room, "grade.json");
    if (fs.existsSync(hiddenGradePath)) {
      const hg = JSON.parse(fs.readFileSync(hiddenGradePath, "utf8"));
      if (Array.isArray(hg.seeds)) seeds = hg.seeds;
      if (Array.isArray(hg.timestamps_ms)) timestamps = hg.timestamps_ms;
    }
  }

  const plan = buildPlan(spec, { seeds, timestamps, hidden, renovation });
  if (perf) plan.perf.enabled = true;

  // Static gates
  const changedFiles = spec.track === "renovation" ? getGitChangedFiles(resolvedSub) : null;
  const staticRes = evaluateStaticGates(resolvedSub, spec, { repoRoot, changedFiles });

  const rawMetrics = {};
  if (staticRes.scopeCheck) {
    rawMetrics["diff.out_of_scope_files"] = staticRes.scopeCheck.outOfScopeCount;
  }

  let captureGates = {};
  let captureRes = null;

  if (!noCapture) {
    const capturePlanPath = path.join(__dirname, "capture", "plan.mjs");
    if (!fs.existsSync(capturePlanPath)) {
      throw new Error(
        `Capture layer missing at ${capturePlanPath}. Wait for capture/plan.mjs or pass --no-capture for offline testing.`
      );
    }
    const { executePlan } = await import(pathToFileURL(capturePlanPath).href);
    const adapter = await loadRoomAdapter(spec.room);
    fs.mkdirSync(resolvedWorkDir, { recursive: true });
    captureRes = await executePlan(plan, {
      submissionDir: resolvedSub,
      workDir: resolvedWorkDir,
      spec,
      adapter,
      hidden
    });
    captureGates = captureRes.gates || {};

    if (captureRes.probes) {
      for (const [key, val] of Object.entries(captureRes.probes)) {
        if (val && typeof val === "object" && val.metricId) {
          if (!Array.isArray(rawMetrics[val.metricId])) rawMetrics[val.metricId] = [];
          rawMetrics[val.metricId].push({ key, ...val });
        } else if (val && typeof val === "object" && val.metrics) {
          for (const [mId, mVal] of Object.entries(val.metrics)) {
            if (!Array.isArray(rawMetrics[mId])) rawMetrics[mId] = [];
            rawMetrics[mId].push({ key, value: normalizeProbeValue(mVal), ...(typeof mVal === "object" ? mVal : {}) });
          }
        }
      }
    }

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

    if (!noPython && captureRes.manifestPath) {
      const pyOut = path.join(resolvedWorkDir, "metrics.json");
      const pyMetrics = runPythonMetrics(captureRes.manifestPath, spec._specPath, pyOut, repoRoot);
      Object.assign(rawMetrics, pyMetrics);
    }
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
  const preScored = scoreSubmission(spec, rawMetrics, { gates });
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
    submissionDir: resolvedSub
  });

  rawMetrics["report.honesty"] = honestyRes.score;
  if (autonomyRes.score !== null) {
    rawMetrics["report.autonomy"] = autonomyRes.score;
  }

  const finalScored = scoreSubmission(spec, rawMetrics, { gates });
  const allWarnings = [...(spec.warnings || []), ...(finalScored.warnings || [])];

  const result = {
    room: spec.room,
    ...(spec.renovation ? { renovation: spec.renovation } : {}),
    track: spec.track,
    spec_version: spec.spec_version,
    bench_version: BENCH_VERSION,
    submission: resolvedSub,
    seeds: hidden ? "hidden" : "public",
    gates: finalScored.gates,
    metrics: finalScored.metrics,
    ...(finalScored.requests ? { requests: finalScored.requests } : {}),
    axes: finalScored.axes,
    composite: finalScored.composite,
    taste: null,
    efficiency: { wall_min: null },
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
  if (!fs.existsSync(file)) {
    if (runMeta?.room) {
      return { room: runMeta.room, renovation: runMeta.renovation ?? null };
    }
    throw new Error(`Missing .bench-room file in ${dir}. Create .bench-room containing the room name (e.g. "aurora").`);
  }
  const raw = fs.readFileSync(file, "utf8").trim();
  if (raw.startsWith("{")) {
    const parsed = JSON.parse(raw);
    return { room: parsed.room, renovation: parsed.renovation ?? runMeta?.renovation ?? null };
  }
  const parts = raw.split(/\s+/);
  return { room: parts[0], renovation: parts[1] ?? runMeta?.renovation ?? null };
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

function parseAttackThreshold(attackEntry) {
  const m = String(attackEntry).match(/composite\s*<=\s*(\d+(?:\.\d+)?)/i);
  return m ? Number(m[1]) : 4;
}

async function runCalibrate(room, flags) {
  const renovation = flags.renovation ?? null;
  const lenient = Boolean(flags.lenient);
  const noCapture = Boolean(flags["no-capture"]);
  const noPython = Boolean(flags["no-python"]);
  const spec = loadSpec(room, { renovation, lenient, repoRoot: REPO_ROOT });

  const candidates = [
    { label: "null", dir: path.join(REPO_ROOT, "rooms", room, "seed") },
    { label: "a5", dir: path.join(REPO_ROOT, "rooms", room, "anchors", "a5") },
    { label: "a8", dir: path.join(REPO_ROOT, "rooms", room, "anchors", "a8") }
  ];

  const attacksDir = path.join(REPO_ROOT, "rooms", room, "attacks");
  const attackSpecs = spec.attacks || [];
  if (fs.existsSync(attacksDir)) {
    for (const entry of fs.readdirSync(attacksDir)) {
      const full = path.join(attacksDir, entry);
      if (fs.statSync(full).isDirectory()) {
        const specLine = attackSpecs.find((a) => a.startsWith(entry));
        candidates.push({
          label: `attack:${entry}`,
          dir: full,
          threshold: parseAttackThreshold(specLine)
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
        "  bench grade <room> <dir> [--renovation r1] [--hidden] [--out f] [--no-capture] [--no-python] [--perf] [--lenient]\n" +
        "  bench selfcheck [--dir <dir>] [--renovation r1] [--no-capture] [--no-python] [--lenient]\n" +
        "  bench preview [--manifest <path>] [--out <dir>] [--room <room>]\n" +
        "  bench calibrate <room> [--renovation r1] [--no-capture] [--no-python] [--lenient]"
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
      hidden: Boolean(flags.hidden),
      noCapture: Boolean(flags["no-capture"]),
      noPython: Boolean(flags["no-python"]),
      perf: Boolean(flags.perf),
      lenient: Boolean(flags.lenient),
      workDir: flags["work-dir"] ?? null,
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
    const { room, renovation } = readBenchRoomFile(dir);
    const result = await gradeSubmission({
      room,
      submissionDir: dir,
      renovation: flags.renovation ?? renovation,
      hidden: false, // selfcheck never touches hidden/
      noCapture: Boolean(flags["no-capture"]),
      noPython: Boolean(flags["no-python"]),
      perf: Boolean(flags.perf),
      lenient: Boolean(flags.lenient),
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

  throw new Error(`Unknown command: "${cmd}"`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  });
}
