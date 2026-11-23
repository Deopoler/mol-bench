import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { prepareRun } from "../../runner/prepare.mjs";
import {
  collectRun,
  updateAwakeState,
  heartbeatAwakeState,
  registerAwakeLaunch,
  evaluateCollectReadiness,
  getRunStatusRows,
  ensureTerminalResult,
  parseRunsTsv
} from "../../runner/collect.mjs";
import { generateLeaderboard } from "../../harness/src/leaderboard.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const WORK_ROOT = path.join(REPO_ROOT, "work");

function makeTmpWorkBase(prefix) {
  try {
    fs.mkdirSync(WORK_ROOT, { recursive: true });
    return fs.mkdtempSync(path.join(WORK_ROOT, prefix));
  } catch (err) {
    if (err?.code === "EPERM" || err?.code === "EACCES") {
      return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    }
    throw err;
  }
}

function makeFixtureRepo(baseDir) {
  const repo = path.join(baseDir, "repo");
  fs.mkdirSync(repo, { recursive: true });

  // Copy real harness/src, contract, schemas, and rooms/aurora/spec.json
  fs.cpSync(path.join(REPO_ROOT, "harness", "src"), path.join(repo, "harness", "src"), { recursive: true });
  fs.cpSync(path.join(REPO_ROOT, "contract"), path.join(repo, "contract"), { recursive: true });
  fs.cpSync(path.join(REPO_ROOT, "schemas"), path.join(repo, "schemas"), { recursive: true });
  fs.mkdirSync(path.join(repo, "rooms", "aurora", "seed", "room"), { recursive: true });
  fs.copyFileSync(
    path.join(REPO_ROOT, "rooms", "aurora", "spec.json"),
    path.join(repo, "rooms", "aurora", "spec.json")
  );
  fs.writeFileSync(path.join(repo, "rooms", "aurora", "prompt.md"), "# Aurora Prompt\nBuild the aurora.\n");
  fs.writeFileSync(path.join(repo, "rooms", "aurora", "seed", "room", "index.html"), "<!doctype html><h1>Seed</h1>\n");
  fs.writeFileSync(path.join(repo, "rooms", "aurora", "seed", ".bench-room"), "aurora\n");

  // Add a hidden directory inside repo AND a hidden/ directory inside harness/src to prove prepare excludes it
  fs.mkdirSync(path.join(repo, "hidden", "aurora"), { recursive: true });
  fs.writeFileSync(path.join(repo, "hidden", "aurora", "grade.json"), JSON.stringify({ seeds: [99] }));
  fs.mkdirSync(path.join(repo, "harness", "src", "hidden"), { recursive: true });
  fs.writeFileSync(path.join(repo, "harness", "src", "hidden", "secret.txt"), "TOP SECRET");

  // Lightweight metrics, node_modules, .venv fixtures (exercises robocopy on Windows quickly)
  fs.mkdirSync(path.join(repo, "metrics", "molmetrics"), { recursive: true });
  fs.writeFileSync(path.join(repo, "metrics", "molmetrics", "__init__.py"), "");
  fs.mkdirSync(path.join(repo, "node_modules", "pkg"), { recursive: true });
  fs.writeFileSync(path.join(repo, "node_modules", "pkg", "index.js"), "export default 1;\n");
  if (!path.resolve(baseDir).startsWith(path.resolve(REPO_ROOT))) {
    for (const dep of ["pngjs", "ajv", "ajv-formats", "fast-deep-equal", "fast-uri", "json-schema-traverse", "require-from-string"]) {
      const srcDep = path.join(REPO_ROOT, "node_modules", dep);
      if (fs.existsSync(srcDep)) {
        fs.cpSync(srcDep, path.join(repo, "node_modules", dep), { recursive: true });
      }
    }
  }
  fs.mkdirSync(path.join(repo, ".venv", "Scripts"), { recursive: true });
  fs.writeFileSync(path.join(repo, ".venv", "pyvenv.cfg"), "home = C:\\Python\n");

  return repo;
}

test("prepareRun creates isolated folder without hidden files and commits start state", () => {
  const tmpBase = makeTmpWorkBase("test-prepare-");
  try {
    const fixtureRepo = makeFixtureRepo(tmpBase);
    const runsRoot = path.join(tmpBase, "runs");
    const { runDir, runMeta } = prepareRun({
      room: "aurora",
      runId: "aurora-test-1",
      seed: 2,
      root: runsRoot,
      repoRoot: fixtureRepo
    });

    assert.equal(runDir, path.resolve(runsRoot, "aurora-test-1"));
    assert.equal(runMeta.room, "aurora");
    assert.equal(runMeta.track, "build");
    assert.equal(runMeta.seed, 2);
    assert.ok(runMeta.created_at);

    // Expected files exist
    assert.equal(fs.existsSync(path.join(runDir, "PROMPT.md")), true);
    assert.equal(fs.existsSync(path.join(runDir, "room", "index.html")), true);
    assert.equal(fs.existsSync(path.join(runDir, "bench", "cli.mjs")), true);
    assert.equal(fs.existsSync(path.join(runDir, "metrics", "molmetrics", "__init__.py")), true);
    assert.equal(fs.existsSync(path.join(runDir, "contract", "bench.d.ts")), true);
    assert.equal(fs.existsSync(path.join(runDir, "schemas", "report.schema.json")), true);
    assert.equal(fs.existsSync(path.join(runDir, "node_modules", "pkg", "index.js")), true);
    assert.equal(fs.existsSync(path.join(runDir, ".venv", "pyvenv.cfg")), true);
    assert.equal(fs.existsSync(path.join(runDir, ".run.json")), true);

    // Hidden files are NOT present
    assert.equal(fs.existsSync(path.join(runDir, "hidden")), false);
    assert.equal(fs.existsSync(path.join(runDir, "bench", "hidden")), false);

    // Git start commit exists with neutral author and clean status
    const log = execFileSync("git", ["log", "-1", "--format=%an <%ae> %s"], {
      cwd: runDir,
      encoding: "utf8"
    }).trim();
    assert.equal(log, "MoL-Bench Runner <runner@mol-bench.local> Start state");
    const status = execFileSync("git", ["status", "--porcelain"], {
      cwd: runDir,
      encoding: "utf8"
    }).trim();
    assert.equal(status, "");

    // bench selfcheck inside runDir uses bench/cli.mjs and finds bench/_spec without repo rooms/
    const selfcheckOut = execFileSync(
      process.execPath,
      [path.join(runDir, "bench", "cli.mjs"), "selfcheck", "--dir", runDir, "--no-capture", "--no-python"],
      { cwd: runDir, encoding: "utf8" }
    );
    assert.match(selfcheckOut, /MoL-Bench selfcheck: aurora/);
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
});

test("prepareRun supports renovation track from anchors/a5 without report.json", () => {
  const tmpBase = makeTmpWorkBase("test-renovation-");
  try {
    const fixtureRepo = makeFixtureRepo(tmpBase);
    fs.mkdirSync(path.join(fixtureRepo, "rooms", "aurora", "renovation"), { recursive: true });
    fs.copyFileSync(
      path.join(REPO_ROOT, "rooms", "aurora", "renovation", "r1.json"),
      path.join(fixtureRepo, "rooms", "aurora", "renovation", "r1.json")
    );
    fs.writeFileSync(
      path.join(fixtureRepo, "rooms", "aurora", "renovation", "r1-prompt.md"),
      "# Aurora r1 Renovation\n"
    );
    const a5Dir = path.join(fixtureRepo, "rooms", "aurora", "anchors", "a5", "room");
    fs.mkdirSync(a5Dir, { recursive: true });
    fs.writeFileSync(path.join(a5Dir, "index.html"), "<!doctype html><h1>A5</h1>\n");
    fs.writeFileSync(
      path.join(fixtureRepo, "rooms", "aurora", "anchors", "a5", "report.json"),
      JSON.stringify({ schema_version: 1, summary: "a5", deliverables: [], claims: [], blocked: false })
    );

    const runsRoot = path.join(tmpBase, "runs");
    const { runDir, runMeta } = prepareRun({
      room: "aurora",
      runId: "aurora-r1-test",
      renovation: "r1",
      root: runsRoot,
      repoRoot: fixtureRepo
    });

    assert.equal(runMeta.track, "renovation");
    assert.equal(runMeta.renovation, "r1");
    assert.equal(fs.existsSync(path.join(runDir, "report.json")), false);
    assert.match(fs.readFileSync(path.join(runDir, "PROMPT.md"), "utf8"), /Aurora r1 Renovation/);
    assert.match(fs.readFileSync(path.join(runDir, "room", "index.html"), "utf8"), /<h1>A5<\/h1>/);
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
});

test("collectRun captures diff, flags leakage, grades, and removes heavy folders", () => {
  const tmpBase = makeTmpWorkBase("test-collect-");
  try {
    const fixtureRepo = makeFixtureRepo(tmpBase);
    const runsRoot = path.join(tmpBase, "runs");
    const resultsDir = path.join(tmpBase, "results");

    const { runDir } = prepareRun({
      room: "aurora",
      runId: "aurora-collect-1",
      root: runsRoot,
      repoRoot: fixtureRepo
    });

    // Simulate agent changes: modify index.html, add new file referencing hidden/
    fs.writeFileSync(path.join(runDir, "room", "index.html"), "<!doctype html><h1>Submission</h1>\n");
    fs.writeFileSync(path.join(runDir, "room", "leak.js"), 'const p = "../hidden/aurora/grade.json";\n');
    fs.writeFileSync(
      path.join(runDir, "report.json"),
      JSON.stringify({
        schema_version: 1,
        summary: "Test submission",
        deliverables: ["room/index.html", "report.json"],
        claims: [],
        blocked: false
      })
    );

    const out = collectRun({
      runId: "aurora-collect-1",
      model: "test-model-alpha",
      root: runsRoot,
      noCapture: true,
      noPython: true,
      repoRoot: fixtureRepo,
      resultsDir
    });

    assert.equal(fs.existsSync(out.resultPath), true);
    assert.equal(fs.existsSync(out.diffPath), true);
    assert.equal(fs.existsSync(path.join(out.subCopyDir, "room", "index.html")), true);
    // Excluded dirs not copied
    assert.equal(fs.existsSync(path.join(out.subCopyDir, "node_modules")), false);
    assert.equal(fs.existsSync(path.join(out.subCopyDir, ".venv")), false);
    assert.equal(fs.existsSync(path.join(out.subCopyDir, "bench")), false);
    assert.equal(fs.existsSync(path.join(out.subCopyDir, "metrics")), false);
    assert.equal(fs.existsSync(path.join(out.subCopyDir, ".git")), false);

    // Diff includes both modified file and untracked file
    const diff = fs.readFileSync(out.diffPath, "utf8");
    assert.match(diff, /room\/index\.html/);
    assert.match(diff, /room\/leak\.js/);

    // Result has model, efficiency.wall_min, leakage flag, and reliability
    assert.equal(out.result.model, "test-model-alpha");
    assert.equal(typeof out.result.efficiency.wall_min, "number");
    assert.equal(out.result.leakage.flagged, true);
    assert.equal(out.result.axes.reliability, 10);

    // Heavy folders removed from runDir; ended_at recorded in .run.json
    assert.equal(fs.existsSync(path.join(runDir, "node_modules")), false);
    assert.equal(fs.existsSync(path.join(runDir, ".venv")), false);
    const updatedRunJson = JSON.parse(fs.readFileSync(path.join(runDir, ".run.json"), "utf8"));
    assert.ok(updatedRunJson.ended_at);
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
});

test("leaderboard aggregates fixture results per room and overall and embeds preview links", () => {
  const tmpBase = makeTmpWorkBase("test-leaderboard-");
  try {
    const resultsDir = path.join(tmpBase, "results");
    const siteDir = path.join(tmpBase, "site", "leaderboard");
    fs.mkdirSync(resultsDir, { recursive: true });

    // Create a dummy preview contact sheet for run-1
    const previewDir = path.join(resultsDir, "submissions", "run-1", "preview");
    fs.mkdirSync(previewDir, { recursive: true });
    fs.writeFileSync(path.join(previewDir, "aurora_sheet_1.png"), Buffer.from([137, 80, 78, 71]));

    const fixtures = [
      {
        run_id: "run-1",
        room: "aurora",
        track: "build",
        model: "Model Alpha",
        seeds: "hidden",
        gates: { "G-load": { pass: true }, "G-report": { pass: true } },
        axes: { craft: 8.6, visual_quality: 8.2, reliability: 10 },
        composite: 8.65,
        efficiency: { wall_min: 12.5 }
      },
      {
        run_id: "run-2",
        room: "lobby",
        track: "build",
        model: "Model Alpha",
        seeds: "hidden",
        gates: { "G-load": { pass: true }, "G-report": { pass: true } },
        axes: { craft: 7.4, visual_quality: 7.8, reliability: 9.0 },
        composite: 7.85,
        efficiency: { wall_min: 18.5 }
      },
      {
        run_id: "run-3",
        room: "aurora",
        track: "build",
        model: "Model Beta",
        seeds: "hidden",
        gates: { "G-load": { pass: false }, "G-report": { pass: true } },
        axes: { craft: 0, visual_quality: 0, reliability: 8.0 },
        composite: 1.2,
        efficiency: { wall_min: 6.0 },
        leakage: { flagged: true, matches: [{ file: "room/x.js", pattern: "hidden/" }] }
      }
    ];

    for (const f of fixtures) {
      fs.writeFileSync(path.join(resultsDir, `${f.run_id}.json`), JSON.stringify(f, null, 2));
    }

    const out = generateLeaderboard({ resultsDir, siteDir });
    assert.equal(out.data.summary.total_runs, 3);
    assert.equal(out.data.summary.models_count, 2);
    assert.equal(out.data.summary.rooms_count, 2);

    // Overall: Model Alpha mean = (8.65 + 7.85)/2 = 8.25 -> 8.3
    assert.equal(out.data.overall[0].model, "Model Alpha");
    assert.equal(out.data.overall[0].composite, 8.3);
    assert.equal(out.data.overall[0].rooms_count, 2);
    assert.equal(out.data.overall[1].model, "Model Beta");
    assert.equal(out.data.overall[1].composite, 1.2);
    assert.equal(out.data.overall[1].leakage_count, 1);

    // Markdown checks
    const md = fs.readFileSync(out.markdownPath, "utf8");
    assert.match(md, /## Overall \(by Model\)/);
    assert.match(md, /### aurora \(build\)/);
    assert.match(md, /### lobby \(build\)/);
    assert.match(md, /Model Alpha/);
    assert.match(md, /submissions\/run-1\/preview\/aurora_sheet_1\.png/);

    // Static site checks (offline, preview copied, data.json written)
    assert.equal(fs.existsSync(out.dataJsonPath), true);
    assert.equal(fs.existsSync(out.indexHtmlPath), true);
    assert.equal(fs.existsSync(path.join(siteDir, "previews", "run-1", "aurora_sheet_1.png")), true);
    const html = fs.readFileSync(out.indexHtmlPath, "utf8");
    assert.match(html, /MoL-Bench Leaderboard/);
    assert.match(html, /previews\/run-1\/aurora_sheet_1\.png/);
    assert.doesNotMatch(html, /https?:\/\/cdn/i);
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
});

test("collectRun detects no-submission once and terminal marker prevents re-collection", () => {
  const tmpBase = makeTmpWorkBase("test-nosub-");
  try {
    const fixtureRepo = makeFixtureRepo(tmpBase);
    const runsRoot = path.join(tmpBase, "runs");
    const resultsDir = path.join(tmpBase, "results");
    const orchestraDir = path.join(tmpBase, "orchestra");
    fs.mkdirSync(orchestraDir, { recursive: true });
    const runsTsvPath = path.join(orchestraDir, "runs.tsv");
    const awakePath = path.join(orchestraDir, "awake.tsv");

    const runId = "aurora__empty-agent";
    const { runDir } = prepareRun({
      room: "aurora",
      runId,
      root: runsRoot,
      repoRoot: fixtureRepo
    });

    // Write only selfcheck.json (no real submission files changed vs start commit)
    fs.writeFileSync(path.join(runDir, "selfcheck.json"), JSON.stringify({ ok: true }));

    fs.writeFileSync(
      runsTsvPath,
      `${runId}\tEmpty Agent\tagent\tterm1\t${runDir}\t1000\t60\n`,
      "utf8"
    );

    // Before collection, status rows lists the run
    const before = getRunStatusRows({ runsTsvPath, awakePath, resultsDir, nowSec: 1300 });
    assert.equal(before.length, 1);
    assert.equal(before[0].rid, runId);

    const out = collectRun({
      runId,
      model: "Empty Agent",
      root: runsRoot,
      noCapture: true,
      noPython: true,
      repoRoot: fixtureRepo,
      resultsDir
    });

    assert.equal(out.result.status, "no-submission");
    assert.match(out.result.reason, /No files changed/i);
    assert.equal(out.result.composite, null);
    assert.equal(typeof out.result.efficiency.active_min, "number");
    assert.equal(fs.existsSync(path.join(resultsDir, `${runId}.json`)), true);
    assert.equal(out.diffPath, null);

    // Mark terminal via ensureTerminalResult (as collect.sh / autopilot.sh do)
    const term = ensureTerminalResult({ runId, runsTsvPath, resultsDir, state: "collected" });
    assert.equal(term.state, "no-submission");
    const tsvRows = parseRunsTsv(runsTsvPath);
    assert.equal(tsvRows[0].status, "no-submission");

    // Never listed or accumulated again on subsequent ticks — even if result file were deleted
    updateAwakeState({ runsTsvPath, awakePath, resultsDir, nowSec: 1600, intervalSec: 300 });
    const after = getRunStatusRows({ runsTsvPath, awakePath, resultsDir, nowSec: 1600 });
    assert.equal(after.length, 0);

    fs.unlinkSync(path.join(resultsDir, `${runId}.json`));
    const afterDelete = getRunStatusRows({ runsTsvPath, awakePath, resultsDir, nowSec: 1900 });
    assert.equal(afterDelete.length, 0, "terminal marker in runs.tsv must prevent re-collection");
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
});

test("awake-time accounting handles simulated sleep gaps and drives OVER and STUCK_HOURS", () => {
  const tmpBase = makeTmpWorkBase("test-awake-");
  try {
    const orchestraDir = path.join(tmpBase, "orchestra");
    const resultsDir = path.join(tmpBase, "results");
    fs.mkdirSync(orchestraDir, { recursive: true });
    fs.mkdirSync(resultsDir, { recursive: true });

    const runsTsvPath = path.join(orchestraDir, "runs.tsv");
    const awakePath = path.join(orchestraDir, "awake.tsv");
    const runId = "aurora__sleep-test";
    fs.writeFileSync(
      runsTsvPath,
      `${runId}\tSleep Model\tclaude\tterm1\t/tmp/r\t1000\t60\n`,
      "utf8"
    );

    // Tick 0 at t=1000 (initializes last_tick)
    const t0 = updateAwakeState({ runsTsvPath, awakePath, resultsDir, nowSec: 1000, intervalSec: 300 });
    assert.equal(t0.add, 0);
    assert.equal(t0.runs[runId], 0);
    assert.equal(t0.since_launch, 0);

    // Tick 1 at t=1300 (normal 5m loop)
    const t1 = updateAwakeState({ runsTsvPath, awakePath, resultsDir, nowSec: 1300, intervalSec: 300 });
    assert.equal(t1.slept, false);
    assert.equal(t1.add, 300);
    assert.equal(t1.runs[runId], 300);
    assert.equal(t1.since_launch, 300);

    // Tick 2 at t=19300 (5h sleep gap: delta=18000 > 2*300+60 -> add only 300s)
    const t2 = updateAwakeState({ runsTsvPath, awakePath, resultsDir, nowSec: 19300, intervalSec: 300 });
    assert.equal(t2.slept, true);
    assert.equal(t2.delta, 18000);
    assert.equal(t2.add, 300);
    assert.equal(t2.runs[runId], 600);
    assert.equal(t2.since_launch, 600);

    // Wall time is 305m (>= 60m limit), but awake time is only 10m -> NOT OVER, NOT STUCK
    const rowsBeforeLimit = getRunStatusRows({ runsTsvPath, awakePath, resultsDir, nowSec: 19300 });
    assert.equal(rowsBeforeLimit.length, 1);
    assert.equal(rowsBeforeLimit[0].elapsedMin, 10);
    assert.equal(rowsBeforeLimit[0].over, "");

    // Advance 10 normal 300s ticks (+3000s = 3600s total awake = 60m -> OVER)
    let cur = 19300;
    for (let i = 0; i < 10; i++) {
      cur += 300;
      updateAwakeState({ runsTsvPath, awakePath, resultsDir, nowSec: cur, intervalSec: 300 });
    }
    const rowsAtLimit = getRunStatusRows({ runsTsvPath, awakePath, resultsDir, nowSec: cur });
    assert.equal(rowsAtLimit[0].elapsedMin, 60);
    assert.equal(rowsAtLimit[0].over, "OVER");

    // Launching a job resets since_launch to 0 for STUCK_HOURS tracking
    registerAwakeLaunch({ awakePath, runId: "aurora__next", nowSec: cur });
    const tAfterLaunch = updateAwakeState({ runsTsvPath, awakePath, resultsDir, nowSec: cur + 300, intervalSec: 300 });
    assert.equal(tAfterLaunch.since_launch, 300);
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
});

test("review fixes: gone/idle gating, retry cap, heartbeat, last-run _since_launch reset, and migration seeding", () => {
  const tmpBase = makeTmpWorkBase("test-review-fixes-");
  try {
    const orchestraDir = path.join(tmpBase, "orchestra");
    const resultsDir = path.join(tmpBase, "results");
    const runDirA = path.join(tmpBase, "runs", "aurora__a");
    const runDirB = path.join(tmpBase, "runs", "aurora__b");
    fs.mkdirSync(orchestraDir, { recursive: true });
    fs.mkdirSync(resultsDir, { recursive: true });
    fs.mkdirSync(runDirA, { recursive: true });
    fs.mkdirSync(runDirB, { recursive: true });
    fs.writeFileSync(path.join(runDirA, "index.html"), "v1");
    fs.writeFileSync(path.join(runDirB, "index.html"), "v1");

    const runsTsvPath = path.join(orchestraDir, "runs.tsv");
    const awakePath = path.join(orchestraDir, "awake.tsv");

    // Finding 8: Run A started 10m ago (start=1000) before awake.tsv exists (now=1600) -> seeded with 600s, not 0
    // Run B started at t=1500 -> seeded with 100s
    fs.writeFileSync(
      runsTsvPath,
      [
        `aurora__a\tModel A\tclaude\ttA\t${runDirA}\t1000\t60`,
        `aurora__b\tModel B\tclaude\ttB\t${runDirB}\t1500\t60`
      ].join("\n") + "\n",
      "utf8"
    );
    const tSeed = updateAwakeState({ runsTsvPath, awakePath, resultsDir, nowSec: 1600, intervalSec: 300 });
    assert.equal(tSeed.runs["aurora__a"], 600);
    assert.equal(tSeed.runs["aurora__b"], 100);

    // Finding 4: End-of-iteration heartbeat counts long (>11m) active work in full (not capped to INTERVAL)
    const tHb = heartbeatAwakeState({ runsTsvPath, awakePath, resultsDir, nowSec: 2500, intervalSec: 300 });
    assert.equal(tHb.add, 900);
    assert.equal(tHb.runs["aurora__a"], 1500);
    assert.equal(tHb.since_launch, 900);

    // Finding 1: `gone` requires 3 consecutive ticks; transient blip resets streak
    assert.equal(evaluateCollectReadiness({ runId: "aurora__a", state: "gone", runDir: runDirA, awakePath, goneTicks: 3 }).collect, false);
    assert.equal(evaluateCollectReadiness({ runId: "aurora__a", state: "gone", runDir: runDirA, awakePath, goneTicks: 3 }).collect, false);
    assert.equal(evaluateCollectReadiness({ runId: "aurora__a", state: "working", runDir: runDirA, awakePath, goneTicks: 3 }).collect, false);
    assert.equal(evaluateCollectReadiness({ runId: "aurora__a", state: "gone", runDir: runDirA, awakePath, goneTicks: 3 }).collect, false);
    assert.equal(evaluateCollectReadiness({ runId: "aurora__a", state: "gone", runDir: runDirA, awakePath, goneTicks: 3 }).collect, false);
    assert.equal(evaluateCollectReadiness({ runId: "aurora__a", state: "gone", runDir: runDirA, awakePath, goneTicks: 3 }).collect, true);

    // Finding 2: `idle` requires 2 consecutive ticks with unchanged runDir mtime
    const mtime1 = new Date("2026-11-21T10:00:00Z");
    const mtime2 = new Date("2026-11-21T10:05:00Z");
    fs.utimesSync(path.join(runDirB, "index.html"), mtime1, mtime1);
    assert.equal(evaluateCollectReadiness({ runId: "aurora__b", state: "idle", runDir: runDirB, awakePath, idleTicks: 2 }).collect, false);
    // File changed between ticks -> streak resets to 1
    fs.utimesSync(path.join(runDirB, "index.html"), mtime2, mtime2);
    assert.equal(evaluateCollectReadiness({ runId: "aurora__b", state: "idle", runDir: runDirB, awakePath, idleTicks: 2 }).collect, false);
    // Unchanged on next tick -> ready to collect
    assert.equal(evaluateCollectReadiness({ runId: "aurora__b", state: "idle", runDir: runDirB, awakePath, idleTicks: 2 }).collect, true);

    // Finding 3: Transient collect failure retries up to maxRetries=3 before writing collect-error
    const r1 = ensureTerminalResult({ runId: "aurora__a", runsTsvPath, awakePath, resultsDir, maxRetries: 3, reason: "blender busy" });
    assert.equal(r1.finalized, false);
    assert.equal(r1.attempts, 1);
    assert.equal(fs.existsSync(path.join(resultsDir, "aurora__a.json")), false);
    // Pending retry bypasses 3-tick gone wait so next tick retries immediately
    assert.equal(evaluateCollectReadiness({ runId: "aurora__a", state: "gone", runDir: runDirA, awakePath, goneTicks: 3 }).collect, true);

    const r2 = ensureTerminalResult({ runId: "aurora__a", runsTsvPath, awakePath, resultsDir, maxRetries: 3, reason: "blender busy" });
    assert.equal(r2.finalized, false);
    assert.equal(r2.attempts, 2);

    const r3 = ensureTerminalResult({ runId: "aurora__a", runsTsvPath, awakePath, resultsDir, maxRetries: 3, reason: "blender busy" });
    assert.equal(r3.finalized, true);
    assert.equal(r3.state, "collect-error");
    assert.equal(fs.existsSync(path.join(resultsDir, "aurora__a.json")), true);
    assert.equal(parseRunsTsv(runsTsvPath)[0].status, "collect-error");

    // Finding 6: `_since_launch` is NOT reset while aurora__b is still active, and resets when last run finishes
    updateAwakeState({ runsTsvPath, awakePath, resultsDir, nowSec: 2800, intervalSec: 300 });
    let rows = getRunStatusRows({ runsTsvPath, awakePath, resultsDir, nowSec: 2800 });
    assert.equal(rows.length, 1);

    fs.writeFileSync(path.join(resultsDir, "aurora__b.json"), JSON.stringify({ run_id: "aurora__b", room: "aurora", composite: 9.0 }));
    const rB = ensureTerminalResult({ runId: "aurora__b", runsTsvPath, awakePath, resultsDir, state: "collected" });
    assert.equal(rB.finalized, true);
    rows = getRunStatusRows({ runsTsvPath, awakePath, resultsDir, nowSec: 2800 });
    assert.equal(rows.length, 0);
    const tAfterLast = updateAwakeState({ runsTsvPath, awakePath, resultsDir, nowSec: 2800, intervalSec: 300 });
    assert.equal(tAfterLast.since_launch, 0);
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
});
