import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateReportGate, validateDecisionsGate, checkScope, combineGates, evaluateAliveGate, evaluateTestSandboxGate, evaluateStaticGates } from "../src/gates.mjs";
import { loadSpec } from "../src/spec.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mol-gates-"));
}

test("G-report validates schemas/report.schema.json", () => {
  const dir = makeTmpDir();
  try {
    assert.equal(validateReportGate(dir, REPO_ROOT).gate.pass, false);

    fs.writeFileSync(path.join(dir, "report.json"), "{ bad json");
    assert.equal(validateReportGate(dir, REPO_ROOT).gate.pass, false);

    // blocked: true without blocked_reason fails schema
    fs.writeFileSync(
      path.join(dir, "report.json"),
      JSON.stringify({
        schema_version: 1,
        summary: "stuck",
        deliverables: [],
        claims: [],
        blocked: true
      })
    );
    assert.equal(validateReportGate(dir, REPO_ROOT).gate.pass, false);

    // valid report passes
    fs.writeFileSync(
      path.join(dir, "report.json"),
      JSON.stringify({
        schema_version: 1,
        summary: "Built aurora",
        deliverables: ["room/index.html", "report.json"],
        claims: [{ metric_id: "lum.mean", status: "verified", meets_target: true, measured_value: 0.2 }],
        blocked: false
      })
    );
    assert.equal(validateReportGate(dir, REPO_ROOT).gate.pass, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("G-decisions validates schemas/decisions.schema.json and exact request_id set", () => {
  const spec = loadSpec("aurora", { renovation: "r1", repoRoot: REPO_ROOT });
  const dir = makeTmpDir();
  try {
    assert.equal(validateDecisionsGate(dir, spec, REPO_ROOT).gate.pass, false);

    // missing request_id A-R4
    fs.writeFileSync(
      path.join(dir, "decisions.json"),
      JSON.stringify({
        schema_version: 1,
        requests: [
          { request_id: "A-R1", status: "done" },
          { request_id: "A-R2", status: "done" },
          { request_id: "A-R3", status: "done" }
        ]
      })
    );
    const missingRes = validateDecisionsGate(dir, spec, REPO_ROOT);
    assert.equal(missingRes.gate.pass, false);
    assert.match(missingRes.gate.detail, /missing: A-R4/);

    // partial without reason fails schema
    fs.writeFileSync(
      path.join(dir, "decisions.json"),
      JSON.stringify({
        schema_version: 1,
        requests: [
          { request_id: "A-R1", status: "done" },
          { request_id: "A-R2", status: "done" },
          { request_id: "A-R3", status: "done" },
          { request_id: "A-R4", status: "partial" }
        ]
      })
    );
    assert.equal(validateDecisionsGate(dir, spec, REPO_ROOT).gate.pass, false);

    // valid decisions
    fs.writeFileSync(
      path.join(dir, "decisions.json"),
      JSON.stringify({
        schema_version: 1,
        requests: [
          { request_id: "A-R1", status: "done" },
          { request_id: "A-R2", status: "done" },
          { request_id: "A-R3", status: "done" },
          { request_id: "A-R4", status: "done" }
        ]
      })
    );
    assert.equal(validateDecisionsGate(dir, spec, REPO_ROOT).gate.pass, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("checkScope counts diff.out_of_scope_files across globs and path separators", () => {
  const res = checkScope(
    ["room/index.html", "room\\src\\shader.glsl", "tests/a.test.mjs", "report.json", "package.json", "docs/notes.md"],
    ["room/**", "tests/**", "report.json"]
  );
  assert.equal(res.outOfScopeCount, 2);
  assert.deepEqual(res.outOfScopeFiles, ["package.json", "docs/notes.md"]);
  assert.equal(res.inScopeFiles.length, 4);
});

test("combineGates merges static and capture gates and marks skipped capture gates as null", () => {
  const skipped = combineGates(
    ["G-load", "G-report"],
    { "G-report": { pass: true, detail: "ok" } },
    {},
    { captureSkipped: true }
  );
  assert.equal(skipped["G-load"].pass, null);
  assert.equal(skipped["G-report"].pass, true);

  const missing = combineGates(
    ["G-load", "G-report"],
    { "G-report": { pass: true, detail: "ok" } },
    {},
    { captureSkipped: false }
  );
  assert.equal(missing["G-load"].pass, false);
});

test("G-alive passes only when normal-variant time.motion median exceeds 0.0005", () => {
  const mk = (vals) => ({
    "time.motion": { raw: vals[0], samples: vals.map((v, i) => ({ key: `motion_s${i}_1440x900_light_normal`, value: v })) }
  });
  assert.equal(evaluateAliveGate(mk([0.012, 0.015, 0.011])).pass, true);
  assert.equal(evaluateAliveGate(mk([0, 0, 0])).pass, false);
  assert.equal(evaluateAliveGate(mk([0.0005, 0.0005])).pass, false);
  // non-normal variants are ignored when normal samples exist
  assert.equal(
    evaluateAliveGate({ "time.motion": [{ key: "m_a_normal", value: 0 }, { key: "m_b_reduced", value: 0.5 }] }).pass,
    false
  );
  // scalar fallback
  assert.equal(evaluateAliveGate({ "time.motion": 0.01 }).pass, true);
  // missing metric: fail normally, null when capture/python was skipped
  assert.equal(evaluateAliveGate({}).pass, false);
  assert.equal(evaluateAliveGate({}, { skipped: true }).pass, null);
});

test("G-alive failure is reported through combineGates", () => {
  const combined = combineGates(["G-load", "G-alive"], {}, { "G-load": { pass: true }, "G-alive": evaluateAliveGate({}) });
  assert.equal(combined["G-alive"].pass, false);
});

test("G-test-sandbox passes clean black-box tests and rejects source/fs/dynamic violations", () => {
  const dir = makeTmpDir();
  try {
    // Absent tests/regression passes
    assert.equal(evaluateTestSandboxGate(dir).pass, true);

    const regDir = path.join(dir, "tests", "regression");
    fs.mkdirSync(regDir, { recursive: true });
    fs.writeFileSync(
      path.join(regDir, "clean.test.mjs"),
      `// Comment mentioning fs and room/src should not trigger violations
import test from "node:test";
import assert from "node:assert/strict";
import { openRoom } from "../../bench/testing/room-harness.mjs";
/* block comment: import fs from "node:fs"; eval("1") */
test("B1 black-box", async () => { assert.ok(typeof openRoom === "function"); });
`
    );
    const cleanRes = evaluateTestSandboxGate(dir);
    assert.equal(cleanRes.pass, true);
    assert.equal(cleanRes.filesScanned, 1);

    // 1. Direct import of room/src/** fails
    fs.writeFileSync(path.join(regDir, "bad_room.test.mjs"), `import { foo } from "../../room/src/tonemap.js";\n`);
    const badRoom = evaluateTestSandboxGate(dir);
    assert.equal(badRoom.pass, false);
    assert.ok(badRoom.violations.some((v) => v.rule === "forbidden_room_import"));
    fs.unlinkSync(path.join(regDir, "bad_room.test.mjs"));

    // 2. node:fs import fails
    fs.writeFileSync(path.join(regDir, "bad_fs.test.mjs"), `import fs from "node:fs";\n`);
    const badFs = evaluateTestSandboxGate(dir);
    assert.equal(badFs.pass, false);
    assert.ok(badFs.violations.some((v) => v.rule === "forbidden_builtin_import"));
    fs.unlinkSync(path.join(regDir, "bad_fs.test.mjs"));

    // 3. child_process + dynamic import + eval fail
    fs.writeFileSync(
      path.join(regDir, "bad_dyn.test.mjs"),
      `const cp = require("child_process");\nconst p = "./x";\nawait import(p);\neval("1+1");\n`
    );
    const badDyn = evaluateTestSandboxGate(dir);
    assert.equal(badDyn.pass, false);
    assert.ok(badDyn.violations.some((v) => v.rule === "forbidden_builtin_import"));
    assert.ok(badDyn.violations.some((v) => v.rule === "forbidden_dynamic_import"));
    assert.ok(badDyn.violations.some((v) => v.rule === "forbidden_dynamic_code"));

    // Wired through evaluateStaticGates
    const staticRes = evaluateStaticGates(dir, { gates: ["G-test-sandbox"], track: "build" }, { repoRoot: REPO_ROOT });
    assert.equal(staticRes.gates["G-test-sandbox"].pass, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
