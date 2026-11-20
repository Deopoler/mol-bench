import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { compareAllFiles, computeDiffMetrics, countPatchLines } from "../src/diffmetrics.mjs";
import { checkScope } from "../src/gates.mjs";
import { scoreSubmission } from "../src/score.mjs";

function tree(files) {
  const dir = fs.mkdtempSync(path.join(process.cwd(), "work", "mol-diff-"));
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(dir, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content);
  }
  return dir;
}

test("minimal source diff has ratio near one", () => {
  const start = tree({ "src.js": "one\ntwo\nthree\n" });
  const sub = tree({ "src.js": "one\nTWO\nthree\n" });
  const patch = path.join(process.cwd(), "work", `mol-patch-${process.pid}.patch`); fs.writeFileSync(patch, "--- a/src.js\n+++ b/src.js\n@@\n-two\n+TWO\n");
  const denominator = countPatchLines(patch);
  assert.equal(denominator, 2);
  assert.equal(computeDiffMetrics({ startDir: start, submissionDir: sub, denominator }).change_ratio, 1);
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
  const changed = compareAllFiles(start, sub);
  assert.deepEqual(changed, ["docs/new.txt", "docs/old.txt"]);
  assert.equal(checkScope(changed, ["src/**", "report.json"]).outOfScopeCount, 2);
});
