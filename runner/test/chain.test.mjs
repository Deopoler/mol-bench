import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { scoreChain, shouldAdvanceChain, runChain } from "../chain.mjs";

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

function makeChainFixtureRepo(baseDir) {
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

  const roomBase = path.join(repo, "rooms-v2", "lobby");
  const chainDir = path.join(roomBase, "renovation", "chain");
  const a5Dir = path.join(roomBase, "anchors", "a5", "lobby");
  fs.mkdirSync(chainDir, { recursive: true });
  fs.mkdirSync(a5Dir, { recursive: true });
  fs.writeFileSync(path.join(a5Dir, "index.html"), "<!doctype html><h1>Lobby Start</h1>\n");

  const baseSpec = {
    room: "lobby",
    spec_version: "0.2.0",
    track: "build",
    title: "Lobby v2",
    time_limit_min: 50,
    time_limit_active_min: 50,
    scope: ["lobby/**", "report.json"],
    deliverables: ["lobby/index.html", "report.json"],
    gates: ["G-report"],
    composite: { craft: 0.45, reliability: 0.55 },
    metrics: [
      { id: "diff.out_of_scope_files", axis: "craft", weight: 1, score: { type: "lower", full: 0, zero: 3 } },
      { id: "report.honesty", axis: "reliability", weight: 6, score: { type: "higher", full: 10, zero: 0 } },
      { id: "report.autonomy", axis: "reliability", weight: 4, score: { type: "higher", full: 10, zero: 0 } },
    ],
  };
  fs.writeFileSync(path.join(roomBase, "spec.json"), JSON.stringify(baseSpec, null, 2));

  fs.writeFileSync(
    path.join(chainDir, "chain.json"),
    JSON.stringify({
      room: "lobby",
      chain: "chain",
      start_anchor: "a5",
      rounds: [
        { id: "r1", weight: 0.25 },
        { id: "r2", weight: 0.35 },
        { id: "r3", weight: 0.4 },
      ],
      time_limit_active_min: 60,
    }, null, 2)
  );

  for (const rId of ["r1", "r2", "r3"]) {
    const reqId = `LC-${rId.toUpperCase()}`;
    const renSpec = {
      room: "lobby",
      renovation: rId,
      spec_version: "0.2.0",
      track: "renovation",
      title: `Lobby Chain ${rId}`,
      time_limit_min: 20,
      time_limit_active_min: 20,
      scope: ["lobby/**", "report.json", "decisions.json"],
      deliverables: ["lobby/index.html", "report.json", "decisions.json"],
      gates: ["G-report", "G-decisions"],
      requests: [
        {
          id: reqId,
          kind: "concrete",
          text: { en: `Complete ${rId}`, ko: `${rId} 완료` },
          weight: 1,
          expected_decision: { status: ["done"], reason: ["NONE"] },
          metrics: [
            { id: "diff.out_of_scope_files", weight: 1, score: { type: "lower", full: 0, zero: 3 } },
          ],
        },
      ],
      composite: { revision: 0.65, craft: 0.2, reliability: 0.15 },
      metrics: [
        { id: `request.${reqId}`, axis: "revision", weight: 2, score: { type: "higher", full: 10, zero: 0 } },
        { id: "diff.out_of_scope_files", axis: "craft", weight: 1, score: { type: "lower", full: 0, zero: 3 } },
        { id: "report.honesty", axis: "reliability", weight: 6, score: { type: "higher", full: 10, zero: 0 } },
        { id: "report.autonomy", axis: "reliability", weight: 4, score: { type: "higher", full: 10, zero: 0 } },
      ],
    };
    fs.writeFileSync(path.join(chainDir, `${rId}.json`), JSON.stringify(renSpec, null, 2));
    fs.writeFileSync(path.join(chainDir, `${rId}-prompt.md`), `# Prompt ${rId}\n`);
  }

  return repo;
}

function writeRoundDeliverables(runDir, rId, { validDecisions = true, marker = rId } = {}) {
  const htmlPath = path.join(runDir, "lobby", "index.html");
  const prev = fs.readFileSync(htmlPath, "utf8");
  fs.writeFileSync(htmlPath, `${prev}<!-- ${marker} -->\n`);
  const reqId = `LC-${rId.toUpperCase()}`;
  fs.writeFileSync(
    path.join(runDir, "report.json"),
    JSON.stringify({
      schema_version: 1,
      summary: `Done ${rId}`,
      deliverables: ["lobby/index.html", "report.json", "decisions.json"],
      claims: [],
      blocked: false,
    })
  );
  fs.writeFileSync(
    path.join(runDir, "decisions.json"),
    JSON.stringify(
      validDecisions
        ? { schema_version: 1, requests: [{ request_id: reqId, status: "done", reason: "NONE" }] }
        : { schema_version: 1, requests: [{ request_id: "WRONG-ID", status: "done", reason: "NONE" }] }
    )
  );
}

test("scoreChain and shouldAdvanceChain implement partial-chain 1/3, 2/3, 3/3 scoring", () => {
  const passR1 = {
    renovation: "r1",
    composite: 8.0,
    axes: { revision: 8.0, craft: 8.0, visual_quality: 8.0, reliability: 10 },
    gates: { "G-load": { pass: true }, "G-decisions": { pass: true }, "G-report": { pass: true } },
  };
  const passR2 = {
    renovation: "r2",
    composite: 6.0,
    axes: { revision: 6.0, craft: 6.0, visual_quality: 6.0, reliability: 10 },
    gates: { "G-load": { pass: true }, "G-decisions": { pass: true }, "G-report": { pass: true } },
  };
  const passR3 = {
    renovation: "r3",
    composite: 9.0,
    axes: { revision: 9.0, craft: 9.0, visual_quality: 9.0, reliability: 10 },
    gates: { "G-load": { pass: true }, "G-decisions": { pass: true }, "G-report": { pass: true } },
  };

  // 1/3 completed (r1=8.0 -> 0.25*8.0 = 2.0)
  const s1 = scoreChain([passR1]);
  assert.equal(s1.rounds_completed, "1/3");
  assert.equal(s1.composite_chain, 2.0);
  assert.equal(s1.per_round[1].status, "not-run");
  assert.equal(s1.per_round[2].status, "not-run");

  // 2/3 completed (r1=8.0, r2=6.0 -> 0.25*8 + 0.35*6 = 4.1)
  const s2 = scoreChain([passR1, passR2]);
  assert.equal(s2.rounds_completed, "2/3");
  assert.equal(s2.composite_chain, 4.1);
  assert.equal(s2.per_round[2].composite, 0);

  // 3/3 completed (0.25*8 + 0.35*6 + 0.40*9 = 7.7)
  const s3 = scoreChain([passR1, passR2, passR3]);
  assert.equal(s3.rounds_completed, "3/3");
  assert.equal(s3.composite_chain, 7.7);

  // Hard non-report gate failure stops chain, while G-report failure alone advances
  assert.equal(shouldAdvanceChain({ composite: 1.5, gates: { "G-load": { pass: false }, "G-report": { pass: true } } }).advance, false);
  assert.equal(shouldAdvanceChain({ composite: 7.5, gates: { "G-load": { pass: true }, "G-report": { pass: false } } }).advance, true);
  assert.equal(shouldAdvanceChain({ status: "no-submission", composite: null, gates: {} }).advance, false);
});

test("runChain executes 1/3, 2/3, and 3/3 handoffs without launching rounds after a gate failure", async () => {
  const tmpBase = makeTmpBase("test-chain-");
  try {
    const repo = makeChainFixtureRepo(tmpBase);
    const runsRoot = path.join(tmpBase, "runs");
    const resultsDir = path.join(tmpBase, "results-v2");

    // Case 1: 1/3 (r1 passes, r2 fails G-decisions -> r3 NOT launched)
    const launched1 = [];
    const res1 = await runChain({
      room: "lobby",
      runId: "lobby-chain__m1",
      model: "Model 1",
      version: 2,
      root: runsRoot,
      resultsDir,
      repoRoot: repo,
      hidden: false,
      noCapture: true,
      noPython: true,
      runnerFn: ({ round, runDir }) => {
        launched1.push(round);
        if (round === "r1") writeRoundDeliverables(runDir, "r1", { validDecisions: true });
        if (round === "r2") writeRoundDeliverables(runDir, "r2", { validDecisions: false });
      },
    });
    assert.deepEqual(launched1, ["r1", "r2"], "r3 must NOT launch when r2 fails hard gate");
    assert.equal(res1.result.rounds_completed, "1/3");
    assert.equal(fs.existsSync(path.join(runsRoot, "lobby-chain__m1__r3")), false);

    // Case 2: 2/3 (r1 & r2 pass, r3 makes no submission -> stopped at 2/3)
    const launched2 = [];
    const res2 = await runChain({
      room: "lobby",
      runId: "lobby-chain__m2",
      model: "Model 2",
      version: 2,
      root: runsRoot,
      resultsDir,
      repoRoot: repo,
      hidden: false,
      noCapture: true,
      noPython: true,
      runnerFn: ({ round, runDir }) => {
        launched2.push(round);
        if (round === "r1" || round === "r2") {
          writeRoundDeliverables(runDir, round, { validDecisions: true });
        }
        // r3 makes no changes -> no-submission
      },
    });
    assert.deepEqual(launched2, ["r1", "r2", "r3"]);
    assert.equal(res2.result.rounds_completed, "2/3");
    assert.equal(res2.result.rounds[2].composite, 0);

    // Case 3: 3/3 full handoff (r2 inherits r1's marker, r3 inherits r2's marker)
    const seenInR3 = [];
    const res3 = await runChain({
      room: "lobby",
      runId: "lobby-chain__m3",
      model: "Model 3",
      version: 2,
      root: runsRoot,
      resultsDir,
      repoRoot: repo,
      hidden: false,
      noCapture: true,
      noPython: true,
      runnerFn: ({ round, runDir }) => {
        const htmlBefore = fs.readFileSync(path.join(runDir, "lobby", "index.html"), "utf8");
        if (round === "r2") assert.match(htmlBefore, /<!-- r1 -->/);
        if (round === "r3") {
          assert.match(htmlBefore, /<!-- r1 -->/);
          assert.match(htmlBefore, /<!-- r2 -->/);
          seenInR3.push(htmlBefore);
        }
        writeRoundDeliverables(runDir, round, { validDecisions: true });
      },
    });
    assert.equal(seenInR3.length, 1);
    assert.equal(res3.result.rounds_completed, "3/3");
    assert.equal(res3.result.bench_version, "0.2.0");
    assert.equal(res3.result.track, "chain");
    const diagRounds = () => JSON.stringify(
      (res3.result.round_results || []).map((r) => ({
        round: r.renovation,
        gates: r.gates,
        axes: r.axes,
        composite: r.composite,
        leakage: r.leakage,
        out_of_scope: r.metrics?.["diff.out_of_scope_files"],
        warnings: r.warnings,
      })),
    );
    assert.ok(res3.result.composite_chain > 5, `expected high composite_chain, got ${res3.result.composite_chain}; rounds=${diagRounds()}`);
    assert.equal(fs.existsSync(res3.resultPath), true);

    // Case 6: simulate dirty parent git repo enclosing runs/ & results-v2/ (as on host work/) -> GIT_CEILING_DIRECTORIES keeps diff clean
    const dirtyParent = fs.mkdtempSync(path.join(tmpBase, "dirty-host-git-"));
    execFileSync("git", ["init"], { cwd: dirtyParent, stdio: "ignore" });
    for (const f of ["x.txt", "y.txt", "z.txt"]) fs.writeFileSync(path.join(dirtyParent, f), "v1\n");
    execFileSync("git", ["add", "-A"], { cwd: dirtyParent, stdio: "ignore" });
    execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@t", "commit", "-m", "base"], { cwd: dirtyParent, stdio: "ignore" });
    for (const f of ["x.txt", "y.txt", "z.txt"]) fs.writeFileSync(path.join(dirtyParent, f), "dirty-v2\n");
    const hostRes = await runChain({
      room: "lobby",
      runId: "lobby-chain__dirtyhost",
      model: "Model HostSim",
      version: 2,
      root: path.join(dirtyParent, "runs"),
      resultsDir: path.join(dirtyParent, "results-v2"),
      repoRoot: repo,
      hidden: false,
      noCapture: true,
      noPython: true,
      runnerFn: ({ round, runDir }) => writeRoundDeliverables(runDir, round, { validDecisions: true }),
    });
    assert.equal(hostRes.result.rounds_completed, "3/3");
    assert.ok(hostRes.result.composite_chain > 5, `dirty parent git must not pollute renovation diff (got ${hostRes.result.composite_chain})`);
    assert.equal(hostRes.result.round_results[0].metrics["diff.out_of_scope_files"].raw, 0);

    // Case 4: runChain rejects invocation with neither runnerFn nor agentCmd
    await assert.rejects(
      () => runChain({ room: "lobby", runId: "lobby-chain__empty", model: "Model X", version: 2, root: runsRoot, resultsDir, repoRoot: repo }),
      /requires a runnerFn/,
    );

    // Case 5: runChain refuses handoff when r1 flags leakage
    const launchedLeak = [];
    const leakRes = await runChain({
      room: "lobby",
      runId: "lobby-chain__leak",
      model: "Model Leak",
      version: 2,
      root: runsRoot,
      resultsDir,
      repoRoot: repo,
      hidden: false,
      noCapture: true,
      noPython: true,
      runnerFn: ({ round, runDir }) => {
        launchedLeak.push(round);
        writeRoundDeliverables(runDir, round, { validDecisions: true });
        fs.writeFileSync(path.join(runDir, "lobby", "leak.js"), 'const x = "hidden-v2";\n');
      },
    });
    assert.deepEqual(launchedLeak, ["r1"], "chain must refuse handoff to r2 when r1 has leakage");
    assert.equal(leakRes.result.rounds_completed, "0/3");
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
});
