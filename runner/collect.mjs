#!/usr/bin/env node
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { generatePreviewContactSheets } from "../harness/src/cli.mjs";

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
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      if (
        key === "no-capture" ||
        key === "no-python" ||
        key === "lenient" ||
        key === "no-hidden" ||
        key === "timed-out" ||
        key === "perf" ||
        key === "help" ||
        key === "h"
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
  repoRoot = DEFAULT_REPO_ROOT,
  resultsDir = null
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

  const endedAt = new Date().toISOString();
  const createdMs = Date.parse(runMeta.created_at);
  const endedMs = Date.parse(endedAt);
  const wallMin =
    Number.isFinite(createdMs) && Number.isFinite(endedMs)
      ? Number((Math.max(0, endedMs - createdMs) / 60000).toFixed(4))
      : null;

  // 1. Capture git diff from start commit (including untracked files) BEFORE editing .run.json
  const { diffText, changedFiles } = buildGitDiffAndChangedFiles(runDir);
  const submissionsDir = path.join(resolvedResultsDir, "submissions");
  fs.mkdirSync(submissionsDir, { recursive: true });
  const diffPath = path.join(submissionsDir, `${runId}.diff`);
  fs.writeFileSync(diffPath, diffText, "utf8");

  // 2. Record end time in .run.json
  const updatedRunMeta = {
    ...runMeta,
    ended_at: endedAt,
    wall_min: wallMin,
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
    process.stderr.write(`collect: could not export start snapshot (${err.message}); diff metrics will fail closed
`);
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
  const warnings = [...(graded.warnings || [])];
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
      wall_min: wallMin
    },
    leakage,
    diff_file: path.relative(resolvedResultsDir, diffPath).replace(/\\/g, "/"),
    submission_copy: path.relative(resolvedResultsDir, subCopyDir).replace(/\\/g, "/"),
    ...(previewSheets.length > 0 ? { preview_sheets: previewSheets } : {}),
    ...(warnings.length > 0 ? { warnings } : {})
  };

  fs.mkdirSync(resolvedResultsDir, { recursive: true });
  const resultPath = path.join(resolvedResultsDir, `${runId}.json`);
  fs.writeFileSync(resultPath, JSON.stringify(finalResult, null, 2) + "\n", "utf8");

  // 8. Delete heavy folders (node_modules, .venv) from runDir
  fs.rmSync(path.join(runDir, "node_modules"), { recursive: true, force: true });
  fs.rmSync(path.join(runDir, ".venv"), { recursive: true, force: true });

  return {
    resultPath,
    diffPath,
    subCopyDir,
    result: finalResult
  };
}

function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
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
    repoRoot: flags["repo-root"] || DEFAULT_REPO_ROOT,
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
