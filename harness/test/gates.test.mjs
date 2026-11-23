import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateReportGate, validateDecisionsGate, checkScope, combineGates, evaluateAliveGate, evaluateTestSandboxGate, evaluateStaticGates, registerGate, unregisterGate } from "../src/gates.mjs";
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

test("G-test-sandbox enforces strict allowlist, transitive scan, symlinks, and rejects every review bypass", () => {
  const dir = makeTmpDir();
  try {
    // Missing tests/regression fails when required (default), passes only when requireTests: false
    assert.equal(evaluateTestSandboxGate(dir).pass, false);
    assert.equal(evaluateTestSandboxGate(dir, { requireTests: false }).pass, true);

    const regDir = path.join(dir, "tests", "regression");
    fs.mkdirSync(regDir, { recursive: true });
    // Empty tests/regression fails when required
    assert.equal(evaluateTestSandboxGate(dir).pass, false);

    // Clean black-box test + relative helper inside tests/regression + process.env.MOL_* allowed
    fs.writeFileSync(
      path.join(regDir, "helper.mjs"),
      `export const targetEnv = process.env.MOL_TARGET_DIR;\nexport function ok() { return true; }\n`
    );
    fs.writeFileSync(
      path.join(regDir, "clean.test.mjs"),
      `// Comment mentioning fs, process.getBuiltinModule, room/src should not trigger violations
import test from "node:test";
import assert from "node:assert/strict";
import { openRoom } from "../../bench/testing/room-harness.mjs";
import { ok } from "./helper.mjs";
/* block comment: import fs from "node:fs"; eval("1") */
test("B1 black-box", async () => { assert.ok(typeof openRoom === "function" && ok()); });
`
    );
    const cleanRes = evaluateTestSandboxGate(dir);
    assert.equal(cleanRes.pass, true, cleanRes.detail);
    assert.equal(cleanRes.filesScanned, 2);

    const assertRejected = (filename, code, expectedRule, extraSetup = null) => {
      const target = path.join(regDir, filename);
      if (extraSetup) extraSetup();
      fs.writeFileSync(target, code);
      try {
        const res = evaluateTestSandboxGate(dir);
        assert.equal(res.pass, false, `Expected bypass to be rejected: ${filename} -> ${code}`);
        if (expectedRule) {
          assert.ok(
            res.violations.some((v) => v.rule === expectedRule),
            `Expected rule ${expectedRule} for ${filename}, got ${JSON.stringify(res.violations)}`
          );
        }
      } finally {
        if (fs.existsSync(target)) fs.unlinkSync(target);
      }
    };

    // Finding #1: escape outside tests/regression into tests/helper.js
    assertRejected("escape_tests.test.mjs", `import { x } from "../helper.js";\n`, "forbidden_escape_import");
    // Finding #1: direct room/src import
    assertRejected("room_src.test.mjs", `import { foo } from "../../room/src/tonemap.js";\n`, "forbidden_escape_import");
    // Finding #1: non-JS import inside tests/regression
    assertRejected("non_js.test.mjs", `import cfg from "./data.json";\n`, "forbidden_non_js_import");
    // Finding #1: transitive helper violation inside tests/regression
    assertRejected("bad_helper.mjs", `import fs from "node:fs";\nexport const x = fs;\n`, "disallowed_import");

    // Finding #2: dynamic import/require evasions & no-space static import
    assertRejected("concat_import.test.mjs", `await import("f" + "s");\n`, "forbidden_dynamic_import");
    assertRejected("concat_req.test.mjs", `require("c" + "hild_process");\n`, "forbidden_dynamic_import");
    assertRejected("import_with.test.mjs", `await import("playwright", { with: { type: "json" } });\n`, "forbidden_dynamic_import");
    assertRejected("tpl_import.test.mjs", "const x = 'fs'; await import(`${x}`);\n", "forbidden_dynamic_import");
    assertRejected("nospace_import.test.mjs", `import"fs";\n`, "disallowed_import");

    // Finding #3: blocklist misses (now blocked by allowlist + process guard)
    assertRejected("builtin_mod.test.mjs", `const fs = process.getBuiltinModule("fs");\n`, "forbidden_process_access");
    assertRejected("proc_bracket.test.mjs", `const b = process["binding"];\n`, "forbidden_process_access");
    assertRejected("proc_dlopen.test.mjs", `process.dlopen({}, "a.node");\n`, "forbidden_process_access");
    assertRejected("proc_alias.test.mjs", `const p = process;\n`, "forbidden_process_access");
    assertRejected("import_os.test.mjs", `import os from "node:os";\n`, "disallowed_import");
    assertRejected("import_net.test.mjs", `import net from "net";\n`, "disallowed_import");
    assertRejected("import_http.test.mjs", `import http from "http";\n`, "disallowed_import");
    assertRejected("import_inspector.test.mjs", `import ins from "inspector";\n`, "disallowed_import");
    assertRejected("meta_resolve.test.mjs", `const u = import.meta.resolve("fs");\n`, "forbidden_import_meta_resolve");
    assertRejected("abs_unix.test.mjs", `import "/etc/passwd";\n`, "forbidden_absolute_import");
    assertRejected("abs_win.test.mjs", `import "C:/Windows/win.ini";\n`, "forbidden_absolute_import");
    assertRejected("file_url.test.mjs", `import "file:///etc/passwd";\n`, "forbidden_file_url");
    assertRejected("eval_code.test.mjs", `eval("1+1");\n`, "forbidden_dynamic_code");
    assertRejected("fn_code.test.mjs", `new Function("return 1")();\n`, "forbidden_dynamic_code");

    // Finding #1: symlink test (skip gracefully if OS denies symlink creation without admin)
    const outsideFile = path.join(dir, "secret.mjs");
    fs.writeFileSync(outsideFile, `export const s = 1;\n`);
    const linkPath = path.join(regDir, "linked.test.mjs");
    let symlinkCreated = false;
    try {
      fs.symlinkSync(outsideFile, linkPath);
      symlinkCreated = true;
    } catch {
      // Windows non-elevated symlink creation may throw EPERM
    }
    if (symlinkCreated) {
      try {
        const symRes = evaluateTestSandboxGate(dir);
        assert.equal(symRes.pass, false);
        assert.ok(symRes.violations.some((v) => v.rule === "forbidden_symlink"));
      } finally {
        fs.unlinkSync(linkPath);
      }
    }

    // Custom gate registration hook
    registerGate("G-custom-check", () => ({ pass: true, detail: "custom ok" }));
    try {
      const staticRes = evaluateStaticGates(
        dir,
        { gates: ["G-test-sandbox", "G-custom-check"], track: "build" },
        { repoRoot: REPO_ROOT }
      );
      assert.equal(staticRes.gates["G-test-sandbox"].pass, true);
      assert.equal(staticRes.gates["G-custom-check"].pass, true);
      assert.throws(() => registerGate("G-test-sandbox", () => ({ pass: true, detail: "" })), /already registered/);
    } finally {
      unregisterGate("G-custom-check");
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
