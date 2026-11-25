import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildVenvManifest, compareAllFiles, computeDiffMetrics, countPatchLines } from "../src/diffmetrics.mjs";
import { checkScope } from "../src/gates.mjs";
import { scoreSubmission } from "../src/score.mjs";

function makeTmpWorkDir(prefix) {
  try {
    fs.mkdirSync(path.join(process.cwd(), "work"), { recursive: true });
    return fs.mkdtempSync(path.join(process.cwd(), "work", prefix));
  } catch (err) {
    if (err?.code === "EPERM" || err?.code === "EACCES" || err?.code === "ENOENT") {
      return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    }
    throw err;
  }
}

function tree(files) {
  const dir = makeTmpWorkDir("mol-diff-");
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(dir, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content);
  }
  return dir;
}

test("minimal source diff has ratio near one", () => {
  const start = tree({ "src.js": "one\ntwo\nthree\n" });
  const sub = tree({ "src.js": "one\nTWO\nthree\n" });
  const patchDir = makeTmpWorkDir("mol-patch-");
  const patch = path.join(patchDir, `mol-patch-${process.pid}.patch`);
  try {
    fs.writeFileSync(patch, "--- a/src.js\n+++ b/src.js\n@@\n-two\n+TWO\n");
    const denominator = countPatchLines(patch);
    assert.equal(denominator, 2);
    assert.equal(computeDiffMetrics({ startDir: start, submissionDir: sub, denominator }).change_ratio, 1);
  } finally {
    fs.rmSync(start, { recursive: true, force: true });
    fs.rmSync(sub, { recursive: true, force: true });
    fs.rmSync(patchDir, { recursive: true, force: true });
  }
});

test("rewriting a whole file fails rewrite and score gate forces change ratio to zero", () => {
  const start = tree({ "src.js": Array.from({ length: 20 }, (_, i) => `line${i}`).join("\n") });
  const sub = tree({ "src.js": Array.from({ length: 20 }, (_, i) => `new${i}`).join("\n") });
  const metrics = computeDiffMetrics({ startDir: start, submissionDir: sub, denominator: 2 });
  assert.equal(metrics.rewrite, false);
  const spec = { track: "renovation", metrics: [
    { id: "diff.change_ratio", axis: "revision", weight: 1, score: { type: "lower", full: 2, zero: 8 } },
    { id: "diff.rewrite", axis: "revision", weight: 1, score: { type: "pass" } }
  ] };
  const scored = scoreSubmission(spec, { "diff.change_ratio": metrics.change_ratio, "diff.rewrite": metrics.rewrite });
  assert.equal(scored.metrics["diff.change_ratio"].score, 0);
  assert.equal(scored.metrics["diff.change_ratio"].forcedZeroBy, "diff.rewrite");
});

test("file comparison supplies out-of-scope files when git diff is unavailable", () => {
  const start = tree({ "src/keep.js": "same\n", "docs/old.txt": "old\n" });
  const sub = tree({ "src/keep.js": "same\n", "docs/new.txt": "new\n" });
  try {
    const changed = compareAllFiles(start, sub);
    assert.deepEqual(changed, ["docs/new.txt", "docs/old.txt"]);
    assert.equal(checkScope(changed, ["src/**", "report.json"]).outOfScopeCount, 2);
  } finally {
    fs.rmSync(start, { recursive: true, force: true });
    fs.rmSync(sub, { recursive: true, force: true });
  }
});

test("v0.2 excludeWorkspaceArtifacts ignores root harness files only and never hides nested edits", () => {
  const start = tree({ "room/src/app.js": "const a = 1;\n" });
  const sub = tree({
    "room/src/app.js": "const a = 2;\n",
    ".run.json": '{"run_id":"x"}\n',
    "selfcheck.json": '{}\n',
    ".bench-room": '{"room":"restoration","version":2}\n',
    "preview/sheet_1.png": "png",
    "work/tmp/out.json": "{}",
    // Nested paths with artifact names MUST NOT be excluded (prevents hiding out-of-scope edits)
    "src/work/hidden.js": "export const cheat = 1;\n",
    "room/preview/hack.js": "export const hack = 1;\n",
    "room/.run.json": '{"nested":true}\n',
    "bench/tamper.js": "export const t = 1;\n"
  });
  try {
    // v0.1 default behavior untouched
    const v1Changed = compareAllFiles(start, sub);
    assert.ok(v1Changed.includes(".run.json"));
    assert.ok(v1Changed.includes("selfcheck.json"));
    assert.ok(v1Changed.includes("preview/sheet_1.png"));
    assert.ok(v1Changed.includes("work/tmp/out.json"));

    // v0.2 excludes root harness artifacts only; nested work/preview/.run.json and bench/ stay visible
    const v2Changed = compareAllFiles(start, sub, { excludeWorkspaceArtifacts: true });
    assert.deepEqual(v2Changed, [
      "bench/tamper.js",
      "room/.run.json",
      "room/preview/hack.js",
      "room/src/app.js",
      "src/work/hidden.js"
    ]);
    assert.equal(checkScope(v2Changed, ["room/src/**"]).outOfScopeCount, 4);
  } finally {
    fs.rmSync(start, { recursive: true, force: true });
    fs.rmSync(sub, { recursive: true, force: true });
  }
});

test("v0.2 excludeWorkspaceArtifacts ignores only known cache files and unmodified .venv while catching hidden edits", () => {
  const start = tree({ "room/src/app.js": "const a = 1;\n" });
  const repoRoot = tree({
    ".venv/pyvenv.cfg": "home = C:\\Python\n",
    ".venv/Lib/site-packages/ok.py": "x = 1\n"
  });
  const sub = tree({
    "room/src/app.js": "const a = 1;\n",
    ".venv/pyvenv.cfg": "home = C:\\Python\n",
    ".venv/Lib/site-packages/ok.py": "x = 1\n",
    ".venv/Lib/site-packages/__pycache__/ok.cpython-314.pyc": "pyc",
    ".venv/Lib/site-packages/sitecustomize.py": "import os\n",
    "__pycache__/mod.cpython-314.pyc": "pyc",
    "__pycache__/evil.js": "export const x = 1;\n",
    ".pytest_cache/README.md": "# pytest cache\n",
    ".pytest_cache/evil.js": "export const y = 1;\n",
    "metrics/molmetrics/__pycache__/io.pyc": "pyc",
    "metrics/molmetrics/__pycache__/evil.py": "print('evil')\n",
    "room/src/__pycache__/sneak.js": "export const cheat = 1;\n",
    "package.json": "{\"hack\":true}\n"
  });
  try {
    const changed = compareAllFiles(start, sub, { excludeWorkspaceArtifacts: true, repoRoot });
    assert.deepEqual(changed, [
      ".pytest_cache/evil.js",
      ".venv/Lib/site-packages/sitecustomize.py",
      "__pycache__/evil.js",
      "metrics/molmetrics/__pycache__/evil.py",
      "package.json",
      "room/src/__pycache__/sneak.js"
    ]);
    assert.equal(checkScope(changed, ["room/src/**", "report.json"]).outOfScopeCount, 5);
  } finally {
    fs.rmSync(start, { recursive: true, force: true });
    fs.rmSync(sub, { recursive: true, force: true });
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("v0.2 .venv manifest in .run.json prevents false positives on repo .venv drift while catching .venv edits", () => {
  const start = tree({
    "room/src/app.js": "const a = 1;\n"
  });
  const sub = tree({
    "room/src/app.js": "const a = 1;\n",
    ".venv/pyvenv.cfg": "home = C:\\PrepareTimePython\n",
    ".venv/Lib/site-packages/pkg.py": "v = 1\n",
    ".venv/Lib/site-packages/__pycache__/pkg.cpython-314.pyc": "pyc-runtime"
  });
  const venvManifest = buildVenvManifest(path.join(sub, ".venv"));
  assert.equal(Object.hasOwn(venvManifest, ".venv/Lib/site-packages/pkg.py"), true);
  assert.equal(Object.hasOwn(venvManifest, ".venv/Lib/site-packages/__pycache__/pkg.cpython-314.pyc"), false);
  fs.writeFileSync(path.join(sub, ".run.json"), JSON.stringify({ run_id: "x", venv_manifest: venvManifest }));

  // Live repoRoot/.venv drifted after prepare -> manifest must take precedence
  const driftedRepoRoot = tree({
    ".venv/pyvenv.cfg": "home = C:\\UpdatedRepoPython\n"
  });
  try {
    assert.deepEqual(
      compareAllFiles(start, sub, { excludeWorkspaceArtifacts: true, repoRoot: driftedRepoRoot }),
      []
    );

    // Tampered .venv file still caught against manifest
    fs.writeFileSync(path.join(sub, ".venv", "Lib", "site-packages", "pkg.py"), "v = 999\n");
    assert.deepEqual(
      compareAllFiles(start, sub, { excludeWorkspaceArtifacts: true, repoRoot: driftedRepoRoot }),
      [".venv/Lib/site-packages/pkg.py"]
    );

    // Fallback when venv_manifest is absent (old run): compares against live repoRoot/.venv
    fs.rmSync(path.join(sub, ".run.json"));
    const legacySub = tree({
      "room/src/app.js": "const a = 1;\n",
      ".venv/pyvenv.cfg": "home = C:\\UpdatedRepoPython\n"
    });
    try {
      assert.deepEqual(
        compareAllFiles(start, legacySub, { excludeWorkspaceArtifacts: true, repoRoot: driftedRepoRoot }),
        []
      );
    } finally {
      fs.rmSync(legacySub, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(start, { recursive: true, force: true });
    fs.rmSync(sub, { recursive: true, force: true });
    fs.rmSync(driftedRepoRoot, { recursive: true, force: true });
  }
});
