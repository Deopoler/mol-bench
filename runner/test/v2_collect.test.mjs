import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { prepareRun } from "../prepare.mjs";
import { collectRun } from "../collect.mjs";
import {
  loadResultFiles,
  buildLeaderboardData,
  formatLeaderboardMarkdown,
  buildLeaderboardHtml,
  generateLeaderboard,
} from "../../harness/src/leaderboard.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const WORK_ROOT = path.join(REPO_ROOT, "work");

function makeTmpBase(prefix) {
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

function makeV2FixtureRepo(baseDir) {
  const repo = path.join(baseDir, "repo");
  fs.mkdirSync(repo, { recursive: true });

  fs.cpSync(path.join(REPO_ROOT, "harness", "src"), path.join(repo, "harness", "src"), { recursive: true });
  fs.cpSync(path.join(REPO_ROOT, "contract"), path.join(repo, "contract"), { recursive: true });
  fs.cpSync(path.join(REPO_ROOT, "schemas"), path.join(repo, "schemas"), { recursive: true });
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

  const roomDir = path.join(repo, "rooms-v2", "aurora");
  fs.mkdirSync(path.join(roomDir, "seed", "room"), { recursive: true });
  fs.writeFileSync(
    path.join(roomDir, "spec.json"),
    JSON.stringify({
      room: "aurora",
      spec_version: "0.2.0",
      track: "build",
      title: "Aurora v0.2",
      time_limit_min: 45,
      time_limit_active_min: 45,
      fail_closed: true,
      scope: ["room/**", "report.json"],
      deliverables: ["room/index.html", "report.json"],
      gates: ["G-report"],
      composite: { reliability: 1.0 },
      metrics: [
        { id: "report.honesty", axis: "reliability", weight: 6, score: { type: "higher", full: 10, zero: 0 } },
        { id: "report.autonomy", axis: "reliability", weight: 4, score: { type: "higher", full: 10, zero: 0 } },
      ],
    }, null, 2)
  );
  fs.writeFileSync(path.join(roomDir, "prompt.md"), "# Aurora v0.2\n");
  fs.writeFileSync(path.join(roomDir, "seed", "room", "index.html"), "<!doctype html><h1>Seed v2</h1>\n");

  // hidden-v2 and harness/src/hidden-v2 must never leak into run folders
  fs.mkdirSync(path.join(repo, "hidden-v2", "aurora"), { recursive: true });
  fs.writeFileSync(path.join(repo, "hidden-v2", "aurora", "grade.json"), JSON.stringify({ seeds: [777] }));
  fs.mkdirSync(path.join(repo, "harness", "src", "hidden-v2"), { recursive: true });
  fs.writeFileSync(path.join(repo, "harness", "src", "hidden-v2", "secret.txt"), "TOP SECRET V2");

  // Pre-seed results-v2/efficiency-baselines.json
  fs.mkdirSync(path.join(repo, "results-v2"), { recursive: true });
  fs.writeFileSync(
    path.join(repo, "results-v2", "efficiency-baselines.json"),
    JSON.stringify({
      tracks: {
        aurora: {
          claude: { out_reas_median: 500 },
        },
      },
    })
  );

  return repo;
}

test("prepareRun --version 2 uses rooms-v2, excludes hidden-v2, writes bench_version 0.2.0, and collectRun outputs to results-v2 with v0.2 efficiency", () => {
  const tmpBase = makeTmpBase("test-v2-collect-");
  try {
    const repo = makeV2FixtureRepo(tmpBase);
    const runsRoot = path.join(tmpBase, "runs");
    const claudeDir = path.join(tmpBase, "claude-logs");

    const runId = "aurora__claude-sonnet-5.5-high";
    const { runDir, runMeta } = prepareRun({
      room: "aurora",
      runId,
      version: 2,
      root: runsRoot,
      repoRoot: repo,
    });

    assert.equal(runMeta.version, 2);
    assert.equal(runMeta.bench_version, "0.2.0");
    assert.equal(runMeta.time_limit_active_min, 45);
    assert.equal(fs.existsSync(path.join(runDir, "hidden-v2")), false);
    assert.equal(fs.existsSync(path.join(runDir, "bench", "hidden-v2")), false);
    const benchRoom = JSON.parse(fs.readFileSync(path.join(runDir, ".bench-room"), "utf8"));
    assert.equal(benchRoom.room, "aurora");
    assert.equal(benchRoom.version, 2);
    assert.equal(benchRoom.bench_version, "0.2.0");

    // Write simulated Claude session log for token & active_min collection
    const encoded = path.resolve(runDir).replace(/[:\\/_.]/g, "-");
    const projDir = path.join(claudeDir, "projects", encoded);
    fs.mkdirSync(projDir, { recursive: true });
    fs.writeFileSync(
      path.join(projDir, "session.jsonl"),
      [
        JSON.stringify({ timestamp: "2026-11-23T10:00:00Z", type: "user" }),
        JSON.stringify({
          timestamp: "2026-11-23T10:04:00Z",
          type: "assistant",
          message: { id: "m1", usage: { input_tokens: 1000, output_tokens: 450, cache_read_input_tokens: 2000, reasoning_tokens: 50 } },
        }),
      ].join("\n")
    );

    // Simulate submission edits
    fs.writeFileSync(path.join(runDir, "room", "index.html"), "<!doctype html><h1>Submission v2</h1>\n");
    fs.writeFileSync(
      path.join(runDir, "report.json"),
      JSON.stringify({ schema_version: 1, summary: "Done", deliverables: ["room/index.html", "report.json"], claims: [], blocked: false })
    );

    // Collect WITHOUT explicit resultsDir -> must auto-resolve to repo/results-v2/
    const out = collectRun({
      runId,
      model: "Claude Sonnet 5.5 (high)",
      root: runsRoot,
      noCapture: true,
      noPython: true,
      repoRoot: repo,
      claudeDir,
    });

    assert.equal(path.dirname(out.resultPath), path.join(repo, "results-v2"));
    assert.equal(out.result.bench_version, "0.2.0");
    assert.equal(out.result.efficiency.provider_group, "claude");
    assert.equal(out.result.efficiency.cli_source, "claude");
    assert.equal(out.result.efficiency.active_min, 4);
    assert.equal(out.result.efficiency.time_limit_active_min, 45);
    assert.equal(out.result.efficiency.timed_out_active, false);
    assert.equal(out.result.efficiency.tokens.output, 450);
    assert.equal(out.result.efficiency.tokens.reasoning, 50);
    assert.equal(out.result.efficiency.tokens.cache_read, 2000);
    // (450 + 50) / 500 baseline = 1.0
    assert.equal(out.result.efficiency.provider_tok_ratio, 1);
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
});

test("versioned leaderboard renders existing v0.1 results/*.json unchanged and adds v0.2 | v0.1 switcher with within-provider Pareto & ratios", () => {
  const tmpBase = makeTmpBase("test-lb-v2-");
  try {
    // 1. Existing real results/*.json parse cleanly under v0.1
    const realResultsDir = path.join(REPO_ROOT, "results");
    const loadedRealV1 = loadResultFiles(realResultsDir);
    assert.ok(loadedRealV1.length >= 24, `expected >= 24 existing v0.1 results, got ${loadedRealV1.length}`);
    const v1Data = buildLeaderboardData(loadedRealV1, { resultsDir: realResultsDir, version: 1 });
    assert.equal(v1Data.summary.total_runs, loadedRealV1.length);
    const v1Md = formatLeaderboardMarkdown(v1Data, { version: 1 });
    assert.match(v1Md, /# MoL-Bench Leaderboard/);
    assert.match(v1Md, /Output tok/);

    // 2. v0.2 within-provider Pareto, tie-break, and switcher HTML
    const resultsV1 = path.join(tmpBase, "results");
    const resultsV2 = path.join(tmpBase, "results-v2");
    const siteDir = path.join(tmpBase, "site", "leaderboard");
    fs.mkdirSync(resultsV1, { recursive: true });
    fs.mkdirSync(resultsV2, { recursive: true });

    fs.writeFileSync(
      path.join(resultsV1, "lobby__v1-model.json"),
      JSON.stringify({
        run_id: "lobby__v1-model",
        room: "lobby",
        track: "build",
        model: "V1 Model",
        gates: { "G-load": { pass: true } },
        axes: { craft: 9.0, visual_quality: 9.0, reliability: 10 },
        composite: 9.2,
        efficiency: { wall_min: 10.0, active_min: 8.0, tokens: { output: 5000, total: 20000 } },
      })
    );

    const v2Fixtures = [
      // Within gemini: Neon High (composite 7.2, out+reas=60k) dominates Neon Med (composite 6.5, out+reas=80k),
      // while Flash High (composite 5.8, out+reas=30k) is also Pareto (cheaper!).
      {
        run_id: "aurora__gemini-neon-high",
        room: "aurora",
        track: "build",
        bench_version: "0.2.0",
        model: "Gemini 4 Neon (High)",
        gates: { "G-load": { pass: true } },
        axes: { craft: 7.0, visual_quality: 7.0, reliability: 10 },
        composite: 7.2,
        efficiency: {
          provider_group: "gemini",
          cli_source: "agy",
          active_min: 15.0,
          wall_min: 20.0,
          tokens: { input: 200000, output: 50000, reasoning: 10000, cache_read: 0, total: 260000 },
        },
      },
      {
        run_id: "aurora__gemini-neon-med",
        room: "aurora",
        track: "build",
        bench_version: "0.2.0",
        model: "Gemini 4 Neon (Med)",
        gates: { "G-load": { pass: true } },
        axes: { craft: 6.0, visual_quality: 6.0, reliability: 10 },
        composite: 6.5,
        efficiency: {
          provider_group: "gemini",
          cli_source: "agy",
          active_min: 18.0,
          wall_min: 22.0,
          tokens: { input: 250000, output: 70000, reasoning: 10000, cache_read: 0, total: 330000 },
        },
      },
      {
        run_id: "aurora__gemini-flash-high",
        room: "aurora",
        track: "build",
        bench_version: "0.2.0",
        model: "Gemini 3.8 Flash (High)",
        gates: { "G-load": { pass: true } },
        axes: { craft: 5.5, visual_quality: 5.5, reliability: 10 },
        composite: 5.8,
        efficiency: {
          provider_group: "gemini",
          cli_source: "agy",
          active_min: 12.0,
          wall_min: 15.0,
          tokens: { input: 100000, output: 25000, reasoning: 5000, cache_read: 0, total: 130000 },
        },
      },
      // Claude run in same room -> separate provider_group Pareto frontier
      {
        run_id: "aurora__claude-sonnet-high",
        room: "aurora",
        track: "build",
        bench_version: "0.2.0",
        model: "Claude Sonnet 5.5 (high)",
        gates: { "G-load": { pass: true } },
        axes: { craft: 6.8, visual_quality: 7.0, reliability: 10 },
        composite: 7.21, // same [7.20, 7.25) v2 bucket as 7.20! Same reliability -> claude < gemini -> ties cleanly
        efficiency: {
          provider_group: "claude",
          cli_source: "claude",
          active_min: 14.0,
          wall_min: 16.0,
          tokens: { input: 100, output: 65000, reasoning: 0, cache_read: 5000000, total: 5065100 },
        },
      },
    ];
    for (const f of v2Fixtures) {
      fs.writeFileSync(path.join(resultsV2, `${f.run_id}.json`), JSON.stringify(f, null, 2));
    }

    const out = generateLeaderboard({
      resultsDir: resultsV1,
      resultsV2Dir: resultsV2,
      siteDir,
      writeV1Md: true,
      writeV2Md: true,
    });

    assert.ok(out.dataV2);
    const rNeonHigh = out.dataV2.runs.find((r) => r.run_id === "aurora__gemini-neon-high");
    const rNeonMed = out.dataV2.runs.find((r) => r.run_id === "aurora__gemini-neon-med");
    const rFlash = out.dataV2.runs.find((r) => r.run_id === "aurora__gemini-flash-high");
    const rClaude = out.dataV2.runs.find((r) => r.run_id === "aurora__claude-sonnet-high");

    assert.equal(rNeonHigh.pareto_within_provider, true);
    assert.equal(rNeonMed.pareto_within_provider, false);
    assert.equal(rFlash.pareto_within_provider, true);
    assert.equal(rClaude.pareto_within_provider, true);

    // Empirical within-provider ratio (gemini median out+reas = 60k -> NeonHigh=1.0, Flash=0.5)
    assert.equal(rNeonHigh.efficiency.provider_tok_ratio, 1);
    assert.equal(rFlash.efficiency.provider_tok_ratio, 0.5);

    // Cross-provider tie-break within 0.05 (7.17 vs 7.20, same reliability 10) orders alphabetically by run_id
    assert.equal(out.dataV2.rooms.aurora.runs[0].run_id, "aurora__claude-sonnet-high");
    assert.equal(out.dataV2.rooms.aurora.runs[1].run_id, "aurora__gemini-neon-high");

    const mdV2 = fs.readFileSync(out.markdownV2Path, "utf8");
    assert.match(mdV2, /Out\+Reas/);
    assert.match(mdV2, /Tok Ratio/);
    assert.match(mdV2, /Cache Read/);
    assert.match(mdV2, /Pareto/);

    const html = fs.readFileSync(out.indexHtmlPath, "utf8");
    assert.match(html, /ver-btn-v2/);
    assert.match(html, /ver-btn-v1/);
    assert.match(html, /__LEADERBOARD_DATASETS__/);
    assert.match(html, /V1 Model/);
    assert.match(html, /Gemini 4 Neon \(High\)/);
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
});

test("review fixes: symlink refusal, root-only start exclusions, gitignored/concat leak scan fail-closed, and transitive v2 sort", () => {
  const tmpBase = makeTmpBase("test-review-fixes-");
  try {
    const repo = makeV2FixtureRepo(tmpBase);
    const runsRoot = path.join(tmpBase, "runs");
    const resultsV2 = path.join(tmpBase, "results-v2");

    // 1. Root-only EXCLUDED_START_DIRS preserves nested src/metrics/ and src/work/ during handoff
    const startSnap = path.join(tmpBase, "start-snap");
    fs.mkdirSync(path.join(startSnap, "metrics"), { recursive: true });
    fs.writeFileSync(path.join(startSnap, "metrics", "ignored-root.py"), "# root harness dir\n");
    fs.mkdirSync(path.join(startSnap, "room", "src", "metrics"), { recursive: true });
    fs.mkdirSync(path.join(startSnap, "room", "src", "work"), { recursive: true });
    fs.writeFileSync(path.join(startSnap, "room", "src", "metrics", "app-metrics.js"), "export const x = 1;\n");
    fs.writeFileSync(path.join(startSnap, "room", "src", "work", "jobs.js"), "export const j = 2;\n");

    const { runDir } = prepareRun({
      room: "aurora",
      runId: "aurora__nested-dirs",
      version: 2,
      startDir: startSnap,
      root: runsRoot,
      repoRoot: repo,
    });
    assert.equal(fs.existsSync(path.join(runDir, "room", "src", "metrics", "app-metrics.js")), true);
    assert.equal(fs.existsSync(path.join(runDir, "room", "src", "work", "jobs.js")), true);
    assert.equal(fs.existsSync(path.join(runDir, "metrics", "ignored-root.py")), false);

    // 2. Symlink in startDir MUST throw (never dereference)
    const symStart = path.join(tmpBase, "sym-start");
    fs.mkdirSync(path.join(symStart, "room"), { recursive: true });
    fs.writeFileSync(path.join(symStart, "room", "ok.js"), "export {};\n");
    let symlinkCreated = false;
    try {
      fs.symlinkSync(path.join(repo, "hidden-v2", "aurora", "grade.json"), path.join(symStart, "room", "sneak.json"));
      symlinkCreated = true;
    } catch {
      // Skip symlink-creation assertion if OS forbids creating symlinks without elevation
    }
    if (symlinkCreated) {
      assert.throws(
        () => prepareRun({ room: "aurora", runId: "aurora__sym-deny", version: 2, startDir: symStart, root: runsRoot, repoRoot: repo }),
        /Symlink not allowed/,
      );
    }

    // 3. Leakage scan catches gitignored files + concatenated 'hid'+'den-v2' + /hidden without trailing slash and fails closed
    const leakPrep = prepareRun({
      room: "aurora",
      runId: "aurora__leak-fail-closed",
      version: 2,
      root: runsRoot,
      repoRoot: repo,
    });
    fs.writeFileSync(path.join(leakPrep.runDir, ".gitignore"), "secret-ignored.js\n");
    fs.writeFileSync(path.join(leakPrep.runDir, "secret-ignored.js"), "const p = 'hid' + 'den-v2';\n");
    fs.writeFileSync(path.join(leakPrep.runDir, "room", "index.html"), "<!doctype html><h1>Leaked</h1>\n");
    fs.writeFileSync(
      path.join(leakPrep.runDir, "report.json"),
      JSON.stringify({ schema_version: 1, summary: "Done", deliverables: ["room/index.html", "report.json"], claims: [], blocked: false }),
    );
    const leaked = collectRun({
      runId: "aurora__leak-fail-closed",
      model: "Leaker",
      version: 2,
      hidden: false,
      noCapture: true,
      noPython: true,
      root: runsRoot,
      resultsDir: resultsV2,
      repoRoot: repo,
    });
    assert.equal(leaked.result.leakage.flagged, true);
    assert.equal(leaked.result.gates["G-leakage"].pass, false);
    assert.equal(leaked.result.invalid, true);
    assert.equal(leaked.result.invalid_reason, "leakage_detected");
    assert.equal(leaked.result.composite, null);

    // 3b. Legitimate overflow:hidden/*...*/ CSS and files under .git/ or node_modules/ must NOT false-positive G-leakage
    const cleanCssPrep = prepareRun({
      room: "aurora",
      runId: "aurora__css-not-leak",
      version: 2,
      root: runsRoot,
      repoRoot: repo,
    });
    fs.writeFileSync(
      path.join(cleanCssPrep.runDir, "room", "index.html"),
      "<!doctype html><style>body{overflow:hidden/*vendor*/;visibility:hidden;}</style><h1>Clean</h1>\n",
    );
    fs.writeFileSync(
      path.join(cleanCssPrep.runDir, "report.json"),
      JSON.stringify({ schema_version: 1, summary: "Done", deliverables: ["room/index.html", "report.json"], claims: [], blocked: false }),
    );
    const cleanCss = collectRun({
      runId: "aurora__css-not-leak",
      model: "Clean CSS",
      version: 2,
      hidden: false,
      noCapture: true,
      noPython: true,
      root: runsRoot,
      resultsDir: resultsV2,
      repoRoot: repo,
    });
    assert.equal(cleanCss.result.leakage.flagged, false, `overflow:hidden/*vendor*/ must not false-positive leakage: ${JSON.stringify(cleanCss.result.leakage)}`);
    assert.equal(cleanCss.result.invalid ?? false, false);

    // 4. Transitive v2 leaderboard comparator (permutation invariant even across A-B=0.04, B-C=0.04, A-C=0.08 & mixed providers)
    const lbDir = path.join(tmpBase, "lb-transitivity");
    const makeRun = (runId, comp, provider, outTok) => ({
      run_id: runId,
      room: "aurora",
      track: "build",
      bench_version: "0.2.0",
      model: runId,
      gates: { "G-load": { pass: true } },
      axes: { craft: comp, visual_quality: comp, reliability: 10 },
      composite: comp,
      efficiency: {
        provider_group: provider,
        cli_source: provider === "gemini" ? "agy" : provider,
        tokens: { input: 1000, output: outTok, reasoning: 0, total: 1000 + outTok },
      },
    });
    const baseItems = [
      makeRun("run_a_claude_804", 8.04, "claude", 50000),
      makeRun("run_b_gemini_802", 8.02, "gemini", 40000),
      makeRun("run_c_claude_800", 8.00, "claude", 20000),
      makeRun("run_d_gemini_799", 7.99, "gemini", 10000),
    ];
    fs.mkdirSync(lbDir, { recursive: true });
    for (const r of baseItems) fs.writeFileSync(path.join(lbDir, `${r.run_id}.json`), JSON.stringify(r));
    const loaded = loadResultFiles(lbDir, { version: 2 });
    const orders = new Set();
    const perms = [
      [0, 1, 2, 3], [3, 2, 1, 0], [1, 3, 0, 2], [2, 0, 3, 1], [1, 2, 3, 0], [3, 0, 2, 1],
    ];
    for (const p of perms) {
      const data = buildLeaderboardData(p.map((i) => loaded[i]), { version: 2 });
      orders.add(data.rooms.aurora.runs.map((r) => r.run_id).join(","));
      assert.equal(data.rooms.aurora.runs[3].run_id, "run_d_gemini_799", "7.99 in lower bucket must rank last");
    }
    assert.equal(orders.size, 1, "v2 leaderboard ordering must be identical across all input permutations");
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
});
