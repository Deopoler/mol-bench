/**
 * Room adapter for `atelier` (Blender 3D Build & Renovation r1).
 * Note on leak prevention: this file is copied into contestant containers and
 * MUST NOT contain any hardcoded hidden parameters, reference values, or answers.
 * All hidden reference data is loaded dynamically from `hidden/atelier/` at grade
 * time and degraded gracefully when `hidden/` is absent (e.g. during selfcheck).
 */

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export const room = "atelier";

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function generate(seed, { hidden = false } = {}) {
  const rng = mulberry32(seed);
  return {
    seed,
    hidden,
    token: Math.floor(rng() * 1e9)
  };
}

export function findBlenderExecutable() {
  if (process.env.BLENDER_BIN && fs.existsSync(process.env.BLENDER_BIN)) {
    return process.env.BLENDER_BIN;
  }
  const winBlender = "C:/Program Files/Blender Foundation/Blender 5.3/blender.exe";
  if (fs.existsSync(winBlender)) return winBlender;
  return "blender";
}

function findPythonExecutable(repoRoot) {
  const winVenv = path.join(repoRoot, ".venv", "Scripts", "python.exe");
  if (fs.existsSync(winVenv)) return winVenv;
  const unixVenv = path.join(repoRoot, ".venv", "bin", "python");
  if (fs.existsSync(unixVenv)) return unixVenv;
  return "python";
}

function resolveBlueprintDir(submissionDir, repoRoot) {
  const subBp = path.join(submissionDir, "blueprint");
  if (fs.existsSync(path.join(subBp, "dimensions.json"))) return subBp;
  const seedBp = path.join(repoRoot, "rooms", "atelier", "seed", "blueprint");
  if (fs.existsSync(path.join(seedBp, "dimensions.json"))) return seedBp;
  return subBp;
}

/**
 * Compute line-level diff stats between start `build.py` and submission `build.py`
 * for Renovation metrics `diff.change_ratio` and `diff.rewrite`.
 */
function computeLineDiffStats(startText, subText, minDiffPatchPath) {
  const startLines = startText.split(/\r?\n/);
  const subLines = subText.split(/\r?\n/);

  // Multiset / LCS line comparison
  const n = startLines.length;
  const m = subLines.length;
  // Fast line matching via frequency map + positional window
  const startCounts = new Map();
  for (const line of startLines) {
    startCounts.set(line, (startCounts.get(line) || 0) + 1);
  }
  let unchanged = 0;
  for (const line of subLines) {
    const c = startCounts.get(line) || 0;
    if (c > 0) {
      unchanged++;
      startCounts.set(line, c - 1);
    }
  }
  const removed = Math.max(0, n - unchanged);
  const added = Math.max(0, m - unchanged);
  const changedLines = added + removed;

  let minFixLines = 45;
  if (minDiffPatchPath && fs.existsSync(minDiffPatchPath)) {
    const patchLines = fs.readFileSync(minDiffPatchPath, "utf8").split(/\r?\n/);
    const diffCount = patchLines.filter(
      (l) => (l.startsWith("+") && !l.startsWith("+++")) || (l.startsWith("-") && !l.startsWith("---"))
    ).length;
    if (diffCount > 0) minFixLines = diffCount;
  }

  const changeRatio = changedLines / Math.max(1, minFixLines);
  const removedFrac = n > 0 ? removed / n : 1;
  const rewritePass = removedFrac < 0.6 && m > 10;

  return {
    changeRatio: Number(changeRatio.toFixed(4)),
    rewritePass
  };
}

/**
 * Execute functional test files (`hidden/atelier/tests/*.mjs` or `public-tests/*.mjs`).
 */
async function runBlenderTests(testDirs, ctx) {
  const results = [];
  for (const dir of testDirs) {
    if (!fs.existsSync(dir)) continue;
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".mjs")).sort();
    for (const file of files) {
      const fullPath = path.join(dir, file);
      const mod = await import(pathToFileURL(fullPath).href);
      const tests = Array.isArray(mod.default) ? mod.default : [];
      for (const t of tests) {
        try {
          const res = await t.run(ctx);
          results.push({
            id: t.id,
            title: t.title,
            pass: Boolean(res?.pass),
            detail: res?.detail || "",
            file
          });
        } catch (err) {
          results.push({
            id: t.id,
            title: t.title,
            pass: false,
            detail: err.message,
            file
          });
        }
      }
    }
  }
  return results;
}

/**
 * Ensure the Renovation start model (`rooms/atelier/anchors/a5`) has cached studio renders
 * so `render.flip_vs_start`, `color.chroma_mean`, and `color.hue_shift` can compare against it.
 */
function ensureRenovationStartCapture({ blenderBin, pyBin, renderScript, postScript, bpDir, hiddenRefsDir, repoRoot }) {
  const startDir = path.join(repoRoot, "rooms", "atelier", "anchors", "a5");
  if (!fs.existsSync(path.join(startDir, "out", "lantern.blend"))) return null;

  const cacheDir = path.join(repoRoot, "work", "_cache_atelier_a5_start");
  if (fs.existsSync(path.join(cacheDir, "metrics3d.json")) && fs.existsSync(path.join(cacheDir, "manifest.json"))) {
    return cacheDir;
  }

  fs.mkdirSync(cacheDir, { recursive: true });
  const args = [
    "-b",
    "--factory-startup",
    "--threads",
    "4",
    "--python",
    renderScript,
    "--",
    "--submission",
    startDir,
    "--blueprint",
    bpDir,
    "--work-dir",
    cacheDir,
    "--skip-build-rerun"
  ];
  if (hiddenRefsDir) {
    args.push("--hidden-refs", hiddenRefsDir);
  }
  execFileSync(blenderBin, args, { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] });
  execFileSync(
    pyBin,
    [postScript, "--work-dir", cacheDir, "--blueprint", bpDir, ...(hiddenRefsDir ? ["--hidden-refs", hiddenRefsDir] : [])],
    { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] }
  );
  return cacheDir;
}

/**
 * Main Blender capture + 3D metric pipeline invoked by `bench grade` / `bench selfcheck`.
 */
export async function captureBlender({
  submissionDir,
  workDir,
  spec,
  hidden = false,
  noPython = false,
  repoRoot
}) {
  const blenderBin = findBlenderExecutable();
  const pyBin = findPythonExecutable(repoRoot);
  const bpDir = resolveBlueprintDir(submissionDir, repoRoot);

  // Check if hidden/atelier/refs exists (never copied into contestant containers)
  const hiddenDir = path.join(repoRoot, "hidden", "atelier");
  const candidateRefs = path.join(hiddenDir, "refs");
  const hasHiddenDir = fs.existsSync(candidateRefs);
  const hiddenRefsDir = hasHiddenDir ? candidateRefs : null;

  const renderScript = path.join(repoRoot, "harness", "blender", "render_submission.py");
  const postScript = path.join(repoRoot, "metrics3d", "post_render.py");

  const startDir = path.join(repoRoot, "rooms", "atelier", "anchors", "a5");
  const startBlendPath =
    spec.track === "renovation" && fs.existsSync(path.join(startDir, "out", "lantern.blend"))
      ? path.join(startDir, "out", "lantern.blend")
      : null;

  let startWorkDir = null;
  if (spec.track === "renovation" && startBlendPath) {
    startWorkDir = ensureRenovationStartCapture({
      blenderBin,
      pyBin,
      renderScript,
      postScript,
      bpDir,
      hiddenRefsDir,
      repoRoot
    });
  }

  const blenderArgs = [
    "-b",
    "--factory-startup",
    "--threads",
    "4",
    "--python-exit-code",
    "1",
    "--python",
    renderScript,
    "--",
    "--submission",
    submissionDir,
    "--blueprint",
    bpDir,
    "--work-dir",
    workDir
  ];
  if (hiddenRefsDir) {
    blenderArgs.push("--hidden-refs", hiddenRefsDir);
  }
  if (startBlendPath) {
    blenderArgs.push("--start-blend", startBlendPath);
  }

  execFileSync(blenderBin, blenderArgs, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });

  if (!noPython) {
    const postArgs = [
      postScript,
      "--work-dir",
      workDir,
      "--blueprint",
      bpDir
    ];
    if (hiddenRefsDir) {
      postArgs.push("--hidden-refs", hiddenRefsDir);
      postArgs.push("--r1-start-hidden-refs", hiddenRefsDir);
    }
    if (startWorkDir) {
      postArgs.push("--start-work-dir", startWorkDir);
    }
    execFileSync(pyBin, postArgs, {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    });
  }

  const evalPath = fs.existsSync(path.join(workDir, "metrics3d.json"))
    ? path.join(workDir, "metrics3d.json")
    : path.join(workDir, "blender_eval.json");
  const evaluated = JSON.parse(fs.readFileSync(evalPath, "utf8"));

  const gates = {
    ...(evaluated.gates || {}),
    "G-offline": {
      pass: evaluated.gates?.["G-provenance"]?.pass !== false,
      detail: "0 external network requests (Blender background mode)"
    }
  };

  const rawMetrics = { ...(evaluated.metrics || {}) };

  // Remove internal helper keys from rawMetrics before scoring
  const testChecks = rawMetrics._test_checks || {};
  const glbStats = rawMetrics._glb_stats || {};
  delete rawMetrics._test_checks;
  delete rawMetrics._glb_stats;
  delete rawMetrics._handle_bbox_size_mm;

  // Run functional tests (hidden tests if available, else public-tests)
  const testDirs = [];
  if (hasHiddenDir && fs.existsSync(path.join(hiddenDir, "tests"))) {
    testDirs.push(path.join(hiddenDir, "tests"));
  } else {
    const subPubTests = path.join(submissionDir, "public-tests");
    const seedPubTests = path.join(repoRoot, "rooms", "atelier", "seed", "public-tests");
    if (fs.existsSync(subPubTests)) testDirs.push(subPubTests);
    else if (fs.existsSync(seedPubTests)) testDirs.push(seedPubTests);
  }

  const tests = await runBlenderTests(testDirs, {
    submissionDir,
    workDir,
    spec,
    metrics: rawMetrics,
    testChecks,
    glbStats,
    gates
  });

  // Renovation-specific metrics: diff.change_ratio, diff.rewrite, tests.preservation
  if (spec.track === "renovation") {
    const startBuildPy = path.join(startDir, "build.py");
    const subBuildPy = path.join(submissionDir, "build.py");
    const minDiffPatch = path.join(repoRoot, spec.min_diff || "rooms/atelier/renovation/r1.min-diff.patch");
    if (fs.existsSync(startBuildPy) && fs.existsSync(subBuildPy)) {
      const diffStats = computeLineDiffStats(
        fs.readFileSync(startBuildPy, "utf8"),
        fs.readFileSync(subBuildPy, "utf8"),
        minDiffPatch
      );
      rawMetrics["diff.change_ratio"] = diffStats.changeRatio;
      rawMetrics["diff.rewrite"] = diffStats.rewritePass;
    } else {
      rawMetrics["diff.change_ratio"] = 20.0;
      rawMetrics["diff.rewrite"] = false;
    }

    if (tests.length > 0) {
      rawMetrics["tests.preservation"] = {
        passed: tests.filter((t) => t.pass).length,
        total: tests.length
      };
    }
  }

  return {
    manifestPath: path.join(workDir, "manifest.json"),
    gates,
    tests,
    rawMetrics,
    probes: {},
    perf: null,
    lighthouse: null,
    console: [],
    network: []
  };
}

export async function extraCapture(_ctx) {}
export async function extraMetrics(_ctx, _metrics) {}
