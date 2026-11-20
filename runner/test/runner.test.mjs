import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { prepareRun } from "../../runner/prepare.mjs";
import { collectRun } from "../../runner/collect.mjs";
import { generateLeaderboard } from "../../harness/src/leaderboard.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const WORK_ROOT = path.join(REPO_ROOT, "work");

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
  fs.mkdirSync(path.join(repo, ".venv", "Scripts"), { recursive: true });
  fs.writeFileSync(path.join(repo, ".venv", "pyvenv.cfg"), "home = C:\\Python\n");

  return repo;
}

test("prepareRun creates isolated folder without hidden files and commits start state", () => {
  fs.mkdirSync(WORK_ROOT, { recursive: true });
  const tmpBase = fs.mkdtempSync(path.join(WORK_ROOT, "test-prepare-"));
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
  fs.mkdirSync(WORK_ROOT, { recursive: true });
  const tmpBase = fs.mkdtempSync(path.join(WORK_ROOT, "test-renovation-"));
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
  fs.mkdirSync(WORK_ROOT, { recursive: true });
  const tmpBase = fs.mkdtempSync(path.join(WORK_ROOT, "test-collect-"));
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
  fs.mkdirSync(WORK_ROOT, { recursive: true });
  const tmpBase = fs.mkdtempSync(path.join(WORK_ROOT, "test-leaderboard-"));
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
