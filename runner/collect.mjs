#!/usr/bin/env node
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { generatePreviewContactSheets } from "../harness/src/cli.mjs";
import { collectTokens, collectActiveTime } from "./tokens.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = path.resolve(__dirname, "..");
const DEFAULT_RUNS_ROOT = path.join(os.homedir(), "molbench-runs");
const EXCLUDED_SUBMISSION_DIRS = new Set([
  "node_modules",
  ".venv",
  "bench",
  "metrics",
  ".git",
  "__pycache__",
  ".pytest_cache",
  "work",        // bench tool scratch output (selfcheck/preview), not part of the submission
  "preview"
]);
const BINARY_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".gif",
  ".ico",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".glb",
  ".gltf",
  ".blend",
  ".zip",
  ".gz",
  ".mp4",
  ".webm",
  ".wasm",
  ".pyc"
]);

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  const booleanFlags = new Set([
    "no-capture",
    "no-python",
    "lenient",
    "no-hidden",
    "timed-out",
    "perf",
    "help",
    "h",
    "awake-tick",
    "awake-heartbeat",
    "status-rows",
    "print-since-launch"
  ]);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      if (booleanFlags.has(key)) {
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

function copySubmissionFiltered(srcDir, dstDir) {
  fs.mkdirSync(dstDir, { recursive: true });
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    if (EXCLUDED_SUBMISSION_DIRS.has(entry.name) || entry.name.endsWith(".pyc") || entry.name === "selfcheck.json") continue;
    const srcPath = path.join(srcDir, entry.name);
    const dstPath = path.join(dstDir, entry.name);
    if (entry.isDirectory()) {
      copySubmissionFiltered(srcPath, dstPath);
    } else if (entry.isSymbolicLink()) {
      const real = fs.realpathSync(srcPath);
      const st = fs.statSync(real);
      if (st.isDirectory()) {
        copySubmissionFiltered(real, dstPath);
      } else {
        fs.copyFileSync(real, dstPath);
      }
    } else {
      fs.copyFileSync(srcPath, dstPath);
    }
  }
}

function listUntrackedFiles(runDir) {
  const out = execFileSync("git", ["ls-files", "--others", "--exclude-standard", "-z"], {
    cwd: runDir,
    encoding: "buffer",
    stdio: ["ignore", "pipe", "pipe"]
  });
  return out
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
}

function buildGitDiffAndChangedFiles(runDir) {
  const startCommit = execFileSync("git", ["rev-list", "--max-parents=0", "HEAD"], {
    cwd: runDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  })
    .trim()
    .split(/\r?\n/)
    .pop();

  const untracked = listUntrackedFiles(runDir);
  if (untracked.length > 0) {
    const chunkSize = 100;
    for (let i = 0; i < untracked.length; i += chunkSize) {
      execFileSync("git", ["add", "-N", "--", ...untracked.slice(i, i + chunkSize)], {
        cwd: runDir,
        stdio: ["ignore", "pipe", "pipe"]
      });
    }
  }

  let diffText = "";
  let changedFiles = [];
  try {
    diffText = execFileSync("git", ["diff", "--binary", startCommit], {
      cwd: runDir,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const namesRaw = execFileSync("git", ["diff", "--name-only", startCommit], {
      cwd: runDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    });
    changedFiles = namesRaw.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  } finally {
    if (untracked.length > 0) {
      execFileSync("git", ["reset", "--mixed", "HEAD"], {
        cwd: runDir,
        stdio: ["ignore", "pipe", "pipe"]
      });
    }
  }

  return { diffText, changedFiles };
}

function isInsideDir(targetPath, parentDir) {
  const rel = path.relative(path.resolve(parentDir), path.resolve(targetPath));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

export function scanForLeakage({ runDir, subCopyDir, diffText, changedFiles, repoRoot }) {
  const matches = [];
  const normRepoSlash = path.resolve(repoRoot).replace(/\\/g, "/");
  const normRepoBack = path.resolve(repoRoot).replace(/\//g, "\\");
  const repoLowerSlash = normRepoSlash.toLowerCase();
  const repoLowerBack = normRepoBack.toLowerCase();
  const hiddenPattern = /(?:^|[\s"'`(\[/\\=:])hidden[\/\\]/i;

  // 1. Check symlinks in runDir escaping runDir
  function checkSymlinks(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === ".venv" || entry.name === ".git") continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        const resolved = fs.realpathSync(fullPath);
        if (!isInsideDir(resolved, runDir)) {
          matches.push({
            file: path.relative(runDir, fullPath).replace(/\\/g, "/"),
            pattern: "symlink_escape",
            detail: `Symlink points outside run directory: ${resolved}`
          });
        }
      } else if (entry.isDirectory()) {
        checkSymlinks(fullPath);
      }
    }
  }
  if (fs.existsSync(runDir)) checkSymlinks(runDir);

  // 2. Check diff headers and added lines
  let currentDiffFile = "(diff)";
  for (const line of (diffText || "").split(/\r?\n/)) {
    if (line.startsWith("diff --git ")) {
      currentDiffFile = line.slice("diff --git ".length);
      if (hiddenPattern.test(currentDiffFile)) {
        matches.push({
          file: currentDiffFile,
          pattern: "hidden/",
          detail: `Diff path references hidden/: ${currentDiffFile}`
        });
      }
      continue;
    }
    if (!line.startsWith("+") || line.startsWith("+++")) continue;
    const content = line.slice(1);
    const lower = content.toLowerCase();
    if (hiddenPattern.test(content)) {
      matches.push({
        file: currentDiffFile,
        pattern: "hidden/",
        detail: `Added diff line references hidden/`
      });
    }
    if (lower.includes(repoLowerSlash) || lower.includes(repoLowerBack)) {
      matches.push({
        file: currentDiffFile,
        pattern: "repo_path",
        detail: `Added diff line references repository path (${normRepoSlash})`
      });
    }
  }

  // 3. Scan changed/added files in submission copy (fallback to all non-harmless files if changedFiles empty)
  const filesToScan = new Set(changedFiles || []);
  for (const rel of filesToScan) {
    const normRel = rel.replace(/\\/g, "/");
    if (hiddenPattern.test(normRel)) {
      matches.push({ file: normRel, pattern: "hidden/", detail: `Submission path references hidden/: ${normRel}` });
    }
    const full = path.join(subCopyDir, normRel);
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) continue;
    const ext = path.extname(full).toLowerCase();
    if (BINARY_EXTENSIONS.has(ext)) continue;
    const buf = fs.readFileSync(full);
    if (buf.includes(0)) continue;
    const text = buf.toString("utf8");
    const lower = text.toLowerCase();
    if (hiddenPattern.test(text)) {
      matches.push({ file: normRel, pattern: "hidden/", detail: `File content references hidden/` });
    }
    if (lower.includes(repoLowerSlash) || lower.includes(repoLowerBack)) {
      matches.push({
        file: normRel,
        pattern: "repo_path",
        detail: `File content references repository path (${normRepoSlash})`
      });
    }
  }

  // Deduplicate identical (file, pattern) matches
  const deduped = [];
  const seen = new Set();
  for (const m of matches) {
    const key = `${m.file}::${m.pattern}`;
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(m);
    }
  }

  return {
    flagged: deduped.length > 0,
    matches: deduped
  };
}

function collectPreviewSheets({ runDir, workDir, subCopyDir, resultsDir }) {
  const previewOutDir = path.join(subCopyDir, "preview");
  const sheets = [];

  // 1. Generate contact sheets if capture produced a manifest.json in workDir
  if (workDir && fs.existsSync(workDir)) {
    const manifestPath = path.join(workDir, "manifest.json");
    if (fs.existsSync(manifestPath)) {
      try {
        const generated = generatePreviewContactSheets(manifestPath, previewOutDir);
        for (const p of generated) sheets.push(p);
      } catch {
        // Ignore if manifest has 0 samples
      }
    }
  }

  // 2. Also include any preview PNGs already inside runDir/preview/
  const runPreviewDir = path.join(runDir, "preview");
  if (fs.existsSync(runPreviewDir)) {
    fs.mkdirSync(previewOutDir, { recursive: true });
    for (const name of fs.readdirSync(runPreviewDir)) {
      if (!name.toLowerCase().endsWith(".png")) continue;
      const dst = path.join(previewOutDir, name);
      if (!fs.existsSync(dst)) {
        fs.copyFileSync(path.join(runPreviewDir, name), dst);
        sheets.push(dst);
      }
    }
  }

  return sheets.map((p) => path.relative(resultsDir, p).replace(/\\/g, "/"));
}

const SCRATCH_CHANGE_FILES = new Set(["selfcheck.json", ".run.json"]);
const SCRATCH_CHANGE_PREFIXES = ["work/", "preview/", "bench/", "metrics/", "node_modules/", ".venv/", ".git/"];

function isSubmissionChange(relPath) {
  const norm = String(relPath || "").replace(/\\/g, "/");
  if (!norm || SCRATCH_CHANGE_FILES.has(norm)) return false;
  return !SCRATCH_CHANGE_PREFIXES.some((prefix) => norm.startsWith(prefix));
}

function writeAtomicFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp.${process.pid}`;
  fs.writeFileSync(tmpPath, content, "utf8");
  fs.renameSync(tmpPath, filePath);
}

function cleanupHeavyRunDirs(runDir) {
  fs.rmSync(path.join(runDir, "node_modules"), { recursive: true, force: true });
  fs.rmSync(path.join(runDir, ".venv"), { recursive: true, force: true });
}

function inferRoomFromRunId(runId) {
  const prefix = String(runId || "").split("__")[0];
  return prefix.replace(/-r\d+$/, "") || "unknown";
}

function buildFailedResultPayload({
  runId,
  model,
  room,
  renovation = null,
  track = null,
  seed = null,
  createdAt = null,
  endedAt = null,
  status,
  reason,
  wallMin = null,
  activeMin = null,
  tokens = null,
  leakage = null,
  diffFile = null,
  submissionCopy = null,
  warnings = []
}) {
  return {
    run_id: runId,
    model: model || "unknown",
    room: room || inferRoomFromRunId(runId),
    ...(renovation ? { renovation } : {}),
    track: track || (renovation ? "renovation" : "build"),
    seed: seed ?? null,
    created_at: createdAt,
    ended_at: endedAt,
    status,
    reason,
    gates: {},
    axes: {},
    composite: null,
    taste: null,
    efficiency: {
      wall_min: wallMin,
      active_min: activeMin,
      tokens
    },
    ...(leakage ? { leakage } : {}),
    ...(diffFile ? { diff_file: diffFile } : {}),
    ...(submissionCopy ? { submission_copy: submissionCopy } : {}),
    ...(warnings.length > 0 ? { warnings } : {})
  };
}

export const TERMINAL_RUN_STATES = new Set([
  "collected",
  "timed-out",
  "no-submission",
  "collect-error",
  "terminal",
  "done"
]);

export function parseRunsTsv(runsTsvPath) {
  if (!runsTsvPath || !fs.existsSync(runsTsvPath)) return [];
  const raw = fs.readFileSync(runsTsvPath, "utf8");
  const rows = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const cols = line.split("\t");
    rows.push({
      rid: cols[0] || "",
      label: cols[1] || "",
      agent: cols[2] || "",
      term: cols[3] || "",
      dir: cols[4] || "",
      start: Number(cols[5] || 0),
      limit: Number(cols[6] || 60),
      status: (cols[7] || "").trim(),
      cols
    });
  }
  return rows;
}

export function markRunTerminalInTsv(runsTsvPath, runId, state = "collected") {
  if (!runsTsvPath || !fs.existsSync(runsTsvPath) || !runId) return false;
  const raw = fs.readFileSync(runsTsvPath, "utf8");
  const outLines = [];
  let updated = false;
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const cols = line.split("\t");
    if (cols[0] === runId) {
      while (cols.length < 7) cols.push("");
      cols[7] = state;
      updated = true;
    }
    outLines.push(cols.join("\t"));
  }
  if (updated) {
    writeAtomicFile(runsTsvPath, outLines.join("\n") + (outLines.length > 0 ? "\n" : ""));
  }
  return updated;
}

function getLatestRunMtimeMs(runDir) {
  if (!runDir || !fs.existsSync(runDir)) return 0;
  let latest = 0;
  const skip = new Set(["node_modules", ".venv", "bench", "metrics", ".git", "work", "preview", "__pycache__"]);
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (skip.has(e.name) || e.name === "selfcheck.json" || e.name === ".run.json") continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else latest = Math.max(latest, fs.statSync(p).mtimeMs);
    }
  };
  try {
    walk(runDir);
  } catch {
    /* ignore */
  }
  return Math.floor(latest);
}

export function loadAwakeState(awakePath) {
  const runs = new Map();
  const streaks = new Map();
  const retries = new Map();
  let lastTick = null;
  let sinceLaunch = 0;
  if (!awakePath || !fs.existsSync(awakePath)) {
    return { lastTick, sinceLaunch, runs, streaks, retries };
  }
  const raw = fs.readFileSync(awakePath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [key, valStr = ""] = line.split("\t");
    if (!key) continue;
    if (key.startsWith("_streak_")) {
      const rid = key.slice("_streak_".length);
      const [st, countStr, mtimeStr] = valStr.split(":");
      const count = Number(countStr);
      const mtimeMs = Number(mtimeStr || 0);
      if (rid && st && Number.isFinite(count)) {
        streaks.set(rid, {
          state: st,
          count: Math.max(0, Math.floor(count)),
          mtimeMs: Number.isFinite(mtimeMs) ? mtimeMs : 0
        });
      }
      continue;
    }
    if (key.startsWith("_retries_")) {
      const rid = key.slice("_retries_".length);
      const count = Number(valStr);
      if (rid && Number.isFinite(count) && count > 0) {
        retries.set(rid, Math.floor(count));
      }
      continue;
    }
    const val = Number(valStr);
    if (!Number.isFinite(val)) continue;
    if (key === "_last_tick") lastTick = val;
    else if (key === "_since_launch") sinceLaunch = Math.max(0, val);
    else runs.set(key, Math.max(0, val));
  }
  return { lastTick, sinceLaunch, runs, streaks, retries };
}

export function saveAwakeState(awakePath, { lastTick, sinceLaunch, runs, streaks = new Map(), retries = new Map() }) {
  const lines = [];
  if (lastTick !== null && Number.isFinite(lastTick)) {
    lines.push(`_last_tick\t${Math.floor(lastTick)}`);
  }
  lines.push(`_since_launch\t${Math.max(0, Math.floor(sinceLaunch || 0))}`);
  for (const rid of [...runs.keys()].sort()) {
    lines.push(`${rid}\t${Math.max(0, Math.floor(runs.get(rid) || 0))}`);
  }
  for (const rid of [...streaks.keys()].sort()) {
    const s = streaks.get(rid);
    if (s && s.count > 0) {
      lines.push(`_streak_${rid}\t${s.state}:${Math.floor(s.count)}:${Math.floor(s.mtimeMs || 0)}`);
    }
  }
  for (const rid of [...retries.keys()].sort()) {
    const c = retries.get(rid);
    if (c > 0) {
      lines.push(`_retries_${rid}\t${Math.floor(c)}`);
    }
  }
  writeAtomicFile(awakePath, lines.join("\n") + "\n");
}

function advanceActiveRunsAwake(state, { runsTsvPath, resultsDir, nowSec, add, sleepThreshold, prevTick }) {
  const rows = parseRunsTsv(runsTsvPath);
  for (const row of rows) {
    if (!row.rid) continue;
    if (TERMINAL_RUN_STATES.has(row.status)) continue;
    if (resultsDir && fs.existsSync(path.join(resultsDir, `${row.rid}.json`))) continue;

    if (state.runs.has(row.rid)) {
      state.runs.set(row.rid, state.runs.get(row.rid) + add);
    } else {
      const sinceStart = Number.isFinite(row.start) && row.start > 0 ? Math.max(0, nowSec - row.start) : 0;
      if (prevTick !== null && Number.isFinite(row.start) && row.start > prevTick) {
        state.runs.set(row.rid, Math.min(add, sinceStart));
      } else {
        // Migrated or pre-existing active run: seed bounded by sleepThreshold and own start time.
        state.runs.set(row.rid, Math.min(sleepThreshold, sinceStart));
      }
    }
  }
}

/**
 * Advance per-run and since-launch awake seconds on a loop tick (after sleep).
 * If delta > 2*intervalSec + 60, treat the gap as machine sleep and add only intervalSec.
 */
export function updateAwakeState({
  runsTsvPath,
  awakePath,
  resultsDir = path.join(DEFAULT_REPO_ROOT, "results"),
  nowSec = Math.floor(Date.now() / 1000),
  intervalSec = 300
}) {
  const state = loadAwakeState(awakePath);
  const prevTick = state.lastTick;
  const delta = prevTick === null ? 0 : Math.max(0, nowSec - prevTick);
  const sleepThreshold = 2 * intervalSec + 60;
  const add = delta > sleepThreshold ? intervalSec : delta;
  const sinceLaunch = state.sinceLaunch + add;

  advanceActiveRunsAwake(state, { runsTsvPath, resultsDir, nowSec, add, sleepThreshold, prevTick });
  saveAwakeState(awakePath, { ...state, lastTick: nowSec, sinceLaunch });
  return {
    now_sec: nowSec,
    delta,
    add,
    slept: delta > sleepThreshold,
    since_launch: sinceLaunch,
    runs: Object.fromEntries(state.runs)
  };
}

/**
 * Record an end-of-iteration heartbeat (before sleep) so long active loop iterations
 * (e.g. multi-run collect or Blender grading) are counted in full as awake time.
 */
export function heartbeatAwakeState({
  runsTsvPath,
  awakePath,
  resultsDir = path.join(DEFAULT_REPO_ROOT, "results"),
  nowSec = Math.floor(Date.now() / 1000),
  intervalSec = 300
}) {
  const state = loadAwakeState(awakePath);
  const prevTick = state.lastTick;
  const delta = prevTick === null ? 0 : Math.max(0, nowSec - prevTick);
  const sleepThreshold = 2 * intervalSec + 60;
  const sinceLaunch = state.sinceLaunch + delta;

  advanceActiveRunsAwake(state, { runsTsvPath, resultsDir, nowSec, add: delta, sleepThreshold, prevTick });
  saveAwakeState(awakePath, { ...state, lastTick: nowSec, sinceLaunch });
  return {
    now_sec: nowSec,
    delta,
    add: delta,
    since_launch: sinceLaunch,
    runs: Object.fromEntries(state.runs)
  };
}

export function registerAwakeLaunch({
  awakePath,
  runId = null,
  nowSec = Math.floor(Date.now() / 1000)
}) {
  const state = loadAwakeState(awakePath);
  const lastTick = state.lastTick ?? nowSec;
  if (runId && !state.runs.has(runId)) {
    state.runs.set(runId, 0);
  }
  saveAwakeState(awakePath, { ...state, lastTick, sinceLaunch: 0 });
  return { lastTick, sinceLaunch: 0 };
}

/**
 * Gate collection for transient states:
 * - `idle` requires `idleTicks` (default 2) consecutive ticks with unchanged run-dir mtime.
 * - `gone` requires `goneTicks` (default 3) consecutive ticks unless a prior collection retry is pending.
 */
export function evaluateCollectReadiness({
  runId,
  state,
  over = "",
  runDir = null,
  awakePath,
  idleTicks = 2,
  goneTicks = 3
}) {
  const awake = loadAwakeState(awakePath);
  const prev = awake.streaks.get(runId);
  const retryCount = awake.retries.get(runId) || 0;
  const isOver = over === "OVER";

  const save = (nextStreak) => {
    if (nextStreak) awake.streaks.set(runId, nextStreak);
    else awake.streaks.delete(runId);
    if (awakePath) saveAwakeState(awakePath, awake);
  };

  if (state === "done" || state === "error") {
    save(null);
    return { collect: true, mode: "normal", reason: state };
  }

  if (state === "idle") {
    const mtimeMs = getLatestRunMtimeMs(runDir);
    const count = prev?.state === "idle" && prev.mtimeMs === mtimeMs ? prev.count + 1 : 1;
    if (count >= idleTicks) {
      save(null);
      return { collect: true, mode: "normal", reason: `idle (${count}/${idleTicks})` };
    }
    if (isOver) {
      save(null);
      return { collect: true, mode: "timeout", reason: "OVER" };
    }
    save({ state: "idle", count, mtimeMs });
    return { collect: false, mode: "wait", count, reason: `idle (${count}/${idleTicks})` };
  }

  if (state === "gone") {
    if (retryCount > 0) {
      save(null);
      return { collect: true, mode: "normal", reason: `gone (retry ${retryCount})` };
    }
    const count = prev?.state === "gone" ? prev.count + 1 : 1;
    if (count >= goneTicks) {
      save(null);
      return { collect: true, mode: "normal", reason: `gone (${count}/${goneTicks})` };
    }
    if (isOver) {
      save(null);
      return { collect: true, mode: "timeout", reason: "OVER" };
    }
    save({ state: "gone", count, mtimeMs: 0 });
    return { collect: false, mode: "wait", count, reason: `gone (${count}/${goneTicks})` };
  }

  save(null);
  if (isOver) {
    return { collect: true, mode: "timeout", reason: "OVER" };
  }
  return { collect: false, mode: "skip", reason: state };
}

export function getRunStatusRows({
  runsTsvPath,
  awakePath,
  resultsDir = path.join(DEFAULT_REPO_ROOT, "results"),
  nowSec = Math.floor(Date.now() / 1000)
}) {
  const rows = parseRunsTsv(runsTsvPath);
  const awake = loadAwakeState(awakePath);
  const active = [];

  for (const row of rows) {
    if (!row.rid) continue;
    if (TERMINAL_RUN_STATES.has(row.status)) continue;
    if (resultsDir && fs.existsSync(path.join(resultsDir, `${row.rid}.json`))) continue;

    const elapsedSec = awake.runs.has(row.rid)
      ? awake.runs.get(row.rid)
      : Math.max(0, nowSec - (Number.isFinite(row.start) ? row.start : nowSec));
    const elapsedMin = Math.floor(elapsedSec / 60);
    const limit = Number.isFinite(row.limit) && row.limit > 0 ? row.limit : 60;
    const over = elapsedMin >= limit ? "OVER" : "";
    active.push({
      rid: row.rid,
      label: row.label,
      agent: row.agent,
      term: row.term,
      dir: row.dir,
      start: row.start,
      limit,
      elapsedMin,
      over
    });
  }
  return active;
}

export function ensureTerminalResult({
  runId,
  label = null,
  runsTsvPath = null,
  awakePath = null,
  resultsDir = path.join(DEFAULT_REPO_ROOT, "results"),
  state = "collected",
  maxRetries = 3,
  reason = "Collection yielded no result"
}) {
  if (!runId) throw new Error("Missing required runId for ensureTerminalResult.");
  const resolvedResultsDir = path.resolve(resultsDir);
  const resultPath = path.join(resolvedResultsDir, `${runId}.json`);
  let finalState = state;
  let attempts = 0;

  if (fs.existsSync(resultPath)) {
    try {
      const existing = JSON.parse(fs.readFileSync(resultPath, "utf8"));
      if (existing?.status === "no-submission" || existing?.status === "collect-error") {
        finalState = existing.status;
      }
    } catch {
      // keep provided state
    }
  } else {
    if (awakePath && maxRetries > 1) {
      const awake = loadAwakeState(awakePath);
      attempts = (awake.retries.get(runId) || 0) + 1;
      if (attempts < maxRetries) {
        awake.retries.set(runId, attempts);
        saveAwakeState(awakePath, awake);
        return { resultPath: null, state: "retry", finalized: false, attempts, maxRetries };
      }
    }

    let resolvedLabel = label;
    if (!resolvedLabel && runsTsvPath) {
      const match = parseRunsTsv(runsTsvPath).find((r) => r.rid === runId);
      if (match?.label) resolvedLabel = match.label;
    }
    const payload = buildFailedResultPayload({
      runId,
      model: resolvedLabel || "unknown",
      room: inferRoomFromRunId(runId),
      endedAt: new Date().toISOString(),
      status: "collect-error",
      reason
    });
    fs.mkdirSync(resolvedResultsDir, { recursive: true });
    fs.writeFileSync(resultPath, JSON.stringify(payload, null, 2) + "\n", "utf8");
    finalState = "collect-error";
  }

  if (runsTsvPath) {
    markRunTerminalInTsv(runsTsvPath, runId, finalState);
  }
  if (awakePath) {
    const awake = loadAwakeState(awakePath);
    awake.runs.delete(runId);
    awake.retries.delete(runId);
    awake.streaks.delete(runId);
    if (runsTsvPath) {
      const remaining = getRunStatusRows({ runsTsvPath, awakePath, resultsDir: resolvedResultsDir });
      if (remaining.length === 0) {
        awake.sinceLaunch = 0;
      }
    }
    saveAwakeState(awakePath, awake);
  }
  return { resultPath, state: finalState, finalized: true, attempts, maxRetries };
}

export function collectRun({
  runId,
  model,
  root = process.env.MOLBENCH_RUNS || DEFAULT_RUNS_ROOT,
  renovation = null,
  hidden = true,
  noCapture = false,
  noPython = false,
  perf = false,
  lenient = false,
  timedOut = false,
  interventions = 0,
  repoRoot = DEFAULT_REPO_ROOT,
  resultsDir = null,
  claudeDir = undefined,
  codexDir = undefined,
  geminiDir = undefined
}) {
  if (!runId) throw new Error("Missing required <id> argument.");
  if (!model) throw new Error("Missing required --model \"<label>\" argument.");

  const resolvedRepoRoot = path.resolve(repoRoot);
  const resolvedResultsDir = resultsDir ? path.resolve(resultsDir) : path.join(resolvedRepoRoot, "results");
  const runDir = path.resolve(root, runId);
  if (!fs.existsSync(runDir)) {
    throw new Error(`Run directory does not exist: ${runDir}`);
  }

  const runJsonPath = path.join(runDir, ".run.json");
  if (!fs.existsSync(runJsonPath)) {
    throw new Error(`Missing .run.json in run directory: ${runDir}`);
  }
  const runMeta = JSON.parse(fs.readFileSync(runJsonPath, "utf8"));
  const room = runMeta.room;
  const effectiveRenovation = renovation ?? runMeta.renovation ?? null;

  // End time = last modification of a submission file (the agent's last write), not the moment we collect.
  const lastWrite = getLatestRunMtimeMs(runDir);
  const endedAt = new Date(lastWrite > 0 ? Math.min(lastWrite, Date.now()) : Date.now()).toISOString();
  const createdMs = Date.parse(runMeta.created_at);
  const endedMs = Date.parse(endedAt);
  const wallMin =
    Number.isFinite(createdMs) && Number.isFinite(endedMs)
      ? Number((Math.max(0, endedMs - createdMs) / 60000).toFixed(4))
      : null;

  const tokenOpts = {
    runDir,
    agent: runMeta.agent ?? null,
    startedAt: runMeta.created_at,
    endedAt,
    runsRoot: root,
    repoRoot: resolvedRepoRoot,
    ...(claudeDir !== undefined ? { claudeDir } : {}),
    ...(codexDir !== undefined ? { codexDir } : {}),
    ...(geminiDir !== undefined ? { geminiDir } : {})
  };

  // Compute active_min BEFORE mutating .run.json or removing folders
  const extraWarnings = [];
  let activeMin = null;
  try {
    activeMin = collectActiveTime(tokenOpts);
  } catch (err) {
    extraWarnings.push(`Active time collection error: ${err.message}`);
  }

  let tokens = null;
  try {
    tokens = collectTokens(tokenOpts);
  } catch (err) {
    extraWarnings.push(`Token collection error: ${err.message}`);
  }

  // 1. Capture git diff from start commit (including untracked files) BEFORE editing .run.json
  const { diffText, changedFiles } = buildGitDiffAndChangedFiles(runDir);
  const submissionChanges = changedFiles.filter(isSubmissionChange);
  const resultPath = path.join(resolvedResultsDir, `${runId}.json`);
  fs.mkdirSync(resolvedResultsDir, { recursive: true });

  if (submissionChanges.length === 0) {
    const reason = "No files changed vs start commit";
    const updatedRunMeta = {
      ...runMeta,
      ended_at: endedAt,
      wall_min: wallMin,
      active_min: activeMin,
      model,
      status: "no-submission"
    };
    fs.writeFileSync(runJsonPath, JSON.stringify(updatedRunMeta, null, 2) + "\n", "utf8");

    const finalResult = buildFailedResultPayload({
      runId,
      model,
      room,
      renovation: effectiveRenovation,
      track: runMeta.track || (effectiveRenovation ? "renovation" : "build"),
      seed: runMeta.seed ?? null,
      createdAt: runMeta.created_at,
      endedAt,
      status: "no-submission",
      reason,
      wallMin,
      activeMin,
      tokens,
      warnings: extraWarnings
    });
    fs.writeFileSync(resultPath, JSON.stringify(finalResult, null, 2) + "\n", "utf8");
    cleanupHeavyRunDirs(runDir);

    return {
      resultPath,
      diffPath: null,
      subCopyDir: null,
      result: finalResult
    };
  }

  const submissionsDir = path.join(resolvedResultsDir, "submissions");
  fs.mkdirSync(submissionsDir, { recursive: true });
  const diffPath = path.join(submissionsDir, `${runId}.diff`);
  fs.writeFileSync(diffPath, diffText, "utf8");

  // 2. Record end time in .run.json
  const updatedRunMeta = {
    ...runMeta,
    ended_at: endedAt,
    wall_min: wallMin,
    active_min: activeMin,
    model
  };
  fs.writeFileSync(runJsonPath, JSON.stringify(updatedRunMeta, null, 2) + "\n", "utf8");

  // 3. Copy submission (excluding node_modules, .venv, bench, metrics, .git)
  const subCopyDir = path.join(submissionsDir, runId);
  fs.rmSync(subCopyDir, { recursive: true, force: true });
  copySubmissionFiltered(runDir, subCopyDir);

  // 4. Leakage scan
  const leakage = scanForLeakage({
    runDir,
    subCopyDir,
    diffText,
    changedFiles,
    repoRoot: resolvedRepoRoot
  });

  // 5. Run `bench grade <room> <copy> --hidden [--renovation r1]`
  const cliPath = path.join(resolvedRepoRoot, "harness", "src", "cli.mjs");
  const workDir = path.join(resolvedRepoRoot, "work", "collect", runId, room);
  const gradeArgs = [cliPath, "grade", room, subCopyDir];
  if (hidden) gradeArgs.push("--hidden");
  if (effectiveRenovation) gradeArgs.push("--renovation", effectiveRenovation);
  if (noCapture) gradeArgs.push("--no-capture");
  if (noPython) gradeArgs.push("--no-python");
  if (perf) gradeArgs.push("--perf");
  if (lenient) gradeArgs.push("--lenient");
  if (timedOut) gradeArgs.push("--timed-out");
  if (interventions > 0) gradeArgs.push("--interventions", String(interventions));
  gradeArgs.push("--work-dir", workDir);

  // 5a. Export the start snapshot (first commit of the run repo) so diff metrics compare against it.
  const startDir = path.join(resolvedRepoRoot, "work", "collect", runId, "start");
  try {
    fs.rmSync(startDir, { recursive: true, force: true });
    fs.mkdirSync(startDir, { recursive: true });
    const startCommit = execFileSync("git", ["-C", runDir, "rev-list", "--max-parents=0", "HEAD"], { encoding: "utf8" })
      .trim().split(/\s+/)[0];
    execFileSync("git", ["-C", runDir, "--work-tree", startDir, "checkout", startCommit, "--", "."], { stdio: "ignore" });
    for (const heavy of ["bench", "metrics"]) fs.rmSync(path.join(startDir, heavy), { recursive: true, force: true });
    gradeArgs.push("--start", startDir);
  } catch (err) {
    process.stderr.write(`collect: could not export start snapshot (${err.message}); diff metrics will fail closed\n`);
  }

  const stdout = execFileSync(process.execPath, gradeArgs, {
    cwd: resolvedRepoRoot,
    env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: "0" },
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"]
  });
  const graded = JSON.parse(stdout);

  // 6. Collect or generate preview contact sheets if available
  const previewSheets = collectPreviewSheets({
    runDir,
    workDir,
    subCopyDir,
    resultsDir: resolvedResultsDir
  });

  // 7. Merge efficiency, model label, leakage, and metadata into results/<id>.json
  const warnings = [...(graded.warnings || []), ...extraWarnings];
  if (leakage.flagged) {
    warnings.push(`Possible leakage detected (${leakage.matches.length} match(es))`);
  }

  const finalResult = {
    run_id: runId,
    model,
    seed: runMeta.seed ?? null,
    created_at: runMeta.created_at,
    ended_at: endedAt,
    ...graded,
    efficiency: {
      ...(graded.efficiency || {}),
      wall_min: wallMin,
      active_min: activeMin,
      tokens
    },
    leakage,
    diff_file: path.relative(resolvedResultsDir, diffPath).replace(/\\/g, "/"),
    submission_copy: path.relative(resolvedResultsDir, subCopyDir).replace(/\\/g, "/"),
    ...(previewSheets.length > 0 ? { preview_sheets: previewSheets } : {}),
    ...(warnings.length > 0 ? { warnings } : {})
  };

  fs.writeFileSync(resultPath, JSON.stringify(finalResult, null, 2) + "\n", "utf8");

  // 8. Delete heavy folders (node_modules, .venv) from runDir
  cleanupHeavyRunDirs(runDir);

  return {
    resultPath,
    diffPath,
    subCopyDir,
    result: finalResult
  };
}

function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const repoRoot = flags["repo-root"] || DEFAULT_REPO_ROOT;
  const resultsDir = flags["results-dir"] || path.join(repoRoot, "results");
  const runsTsvPath = flags["runs-tsv"] || path.join(repoRoot, ".orchestra", "runs.tsv");
  const awakePath = flags["awake-file"] || path.join(repoRoot, ".orchestra", "awake.tsv");
  const nowSec = flags.now !== undefined ? Number(flags.now) : Math.floor(Date.now() / 1000);

  if (flags["awake-tick"] || flags["awake-heartbeat"]) {
    const fn = flags["awake-heartbeat"] ? heartbeatAwakeState : updateAwakeState;
    const out = fn({
      runsTsvPath,
      awakePath,
      resultsDir,
      nowSec,
      intervalSec: flags.interval !== undefined ? Number(flags.interval) : 300
    });
    if (flags["print-since-launch"]) {
      console.log(out.since_launch);
    } else {
      console.log(JSON.stringify(out));
    }
    return;
  }

  if (flags["check-collect"]) {
    const runId = flags["check-collect"] === true ? positional[0] : flags["check-collect"];
    const out = evaluateCollectReadiness({
      runId,
      state: flags.state || "",
      over: flags.over || "",
      runDir: flags["run-dir"] || null,
      awakePath,
      idleTicks: flags["idle-ticks"] !== undefined ? Number(flags["idle-ticks"]) : 2,
      goneTicks: flags["gone-ticks"] !== undefined ? Number(flags["gone-ticks"]) : 3
    });
    console.log(out.mode);
    return;
  }

  if (flags["awake-launch"]) {
    const runId = flags["awake-launch"] === true ? positional[0] : flags["awake-launch"];
    const out = registerAwakeLaunch({ awakePath, runId: runId || null, nowSec });
    console.log(JSON.stringify(out));
    return;
  }

  if (flags["status-rows"]) {
    const rows = getRunStatusRows({ runsTsvPath, awakePath, resultsDir, nowSec });
    for (const r of rows) {
      console.log(`${r.rid}\t${r.term || "-"}\t${r.elapsedMin}\t${r.limit}\t${r.over}`);
    }
    return;
  }

  if (flags["mark-terminal"]) {
    const runId = flags["mark-terminal"] === true ? positional[0] : flags["mark-terminal"];
    const ok = markRunTerminalInTsv(runsTsvPath, runId, flags.state || "collected");
    console.log(JSON.stringify({ updated: ok }));
    return;
  }

  if (flags["ensure-terminal-result"]) {
    const runId = flags["ensure-terminal-result"] === true ? positional[0] : flags["ensure-terminal-result"];
    const out = ensureTerminalResult({
      runId,
      label: flags.label || null,
      runsTsvPath,
      awakePath: flags["awake-file"] ? awakePath : null,
      resultsDir,
      state: flags.state || "collected",
      maxRetries: flags["max-retries"] !== undefined ? Number(flags["max-retries"]) : 3,
      reason: flags.reason || "Collection yielded no result"
    });
    console.log(JSON.stringify(out));
    return;
  }

  if (flags.help || flags.h || positional.length === 0) {
    console.log(
      'Usage: node runner/collect.mjs <id> --model "<label>" [--root <dir>] [--renovation r1] [--no-capture] [--no-python] [--lenient] [--no-hidden]'
    );
    return;
  }
  const runId = positional[0];
  const out = collectRun({
    runId,
    model: flags.model,
    root: flags.root || process.env.MOLBENCH_RUNS || DEFAULT_RUNS_ROOT,
    renovation: flags.renovation ?? null,
    hidden: !flags["no-hidden"],
    noCapture: Boolean(flags["no-capture"]),
    noPython: Boolean(flags["no-python"]),
    perf: Boolean(flags.perf),
    lenient: Boolean(flags.lenient),
    timedOut: Boolean(flags["timed-out"]),
    interventions: Number(flags.interventions || 0),
    repoRoot,
    resultsDir: flags["results-dir"] || null
  });
  console.log(JSON.stringify({ result: out.resultPath, diff: out.diffPath, submission: out.subCopyDir }, null, 2));
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    main();
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}
