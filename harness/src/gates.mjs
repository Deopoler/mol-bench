import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const IS_ISOLATED_BENCH =
  fs.existsSync(path.join(__dirname, "..", "schemas")) &&
  !fs.existsSync(path.join(__dirname, "..", "..", "harness"));
const DEFAULT_REPO_ROOT = IS_ISOLATED_BENCH ? path.resolve(__dirname, "..") : path.resolve(__dirname, "..", "..");

const validators = new Map();

function loadValidator(schemaName, repoRoot = DEFAULT_REPO_ROOT) {
  const schemaPath = path.resolve(repoRoot, "schemas", schemaName);
  if (!validators.has(schemaPath)) {
    const schema = JSON.parse(fs.readFileSync(schemaPath, "utf8"));
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    addFormats(ajv);
    validators.set(schemaPath, ajv.compile(schema));
  }
  return validators.get(schemaPath);
}

/**
 * G-report: report.json exists and validates against schemas/report.schema.json.
 */
export function validateReportGate(submissionDir, repoRoot = DEFAULT_REPO_ROOT) {
  const reportPath = path.join(submissionDir, "report.json");
  if (!fs.existsSync(reportPath)) {
    return {
      gate: { pass: false, detail: "report.json not found" },
      report: null
    };
  }
  let report;
  try {
    report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  } catch (err) {
    return {
      gate: { pass: false, detail: `report.json invalid JSON: ${err.message}` },
      report: null
    };
  }

  const validate = loadValidator("report.schema.json", repoRoot);
  if (!validate(report)) {
    const errs = (validate.errors || []).map((e) => `${e.instancePath || "/"} ${e.message}`).join("; ");
    return {
      gate: { pass: false, detail: `report.json schema error: ${errs}` },
      report
    };
  }

  return {
    gate: { pass: true, detail: "valid report.json" },
    report
  };
}

/**
 * G-decisions: decisions.json exists, validates against schemas/decisions.schema.json,
 * and has exactly one entry per request_id in spec.requests.
 */
export function validateDecisionsGate(submissionDir, spec, repoRoot = DEFAULT_REPO_ROOT) {
  const decisionsPath = path.join(submissionDir, "decisions.json");
  if (!fs.existsSync(decisionsPath)) {
    return {
      gate: { pass: false, detail: "decisions.json not found" },
      decisions: null
    };
  }
  let decisions;
  try {
    decisions = JSON.parse(fs.readFileSync(decisionsPath, "utf8"));
  } catch (err) {
    return {
      gate: { pass: false, detail: `decisions.json invalid JSON: ${err.message}` },
      decisions: null
    };
  }

  const validate = loadValidator("decisions.schema.json", repoRoot);
  if (!validate(decisions)) {
    const errs = (validate.errors || []).map((e) => `${e.instancePath || "/"} ${e.message}`).join("; ");
    return {
      gate: { pass: false, detail: `decisions.json schema error: ${errs}` },
      decisions
    };
  }

  const expectedIds = (spec?.requests || []).map((r) => r.id);
  const seen = new Map();
  for (const item of decisions.requests || []) {
    seen.set(item.request_id, (seen.get(item.request_id) || 0) + 1);
  }

  const missing = expectedIds.filter((id) => !seen.has(id));
  const duplicates = [...seen.entries()].filter(([, count]) => count > 1).map(([id]) => id);
  const unknown = [...seen.keys()].filter((id) => !expectedIds.includes(id));

  if (missing.length > 0 || duplicates.length > 0 || unknown.length > 0) {
    const parts = [];
    if (missing.length > 0) parts.push(`missing: ${missing.join(", ")}`);
    if (duplicates.length > 0) parts.push(`duplicate: ${duplicates.join(", ")}`);
    if (unknown.length > 0) parts.push(`unknown: ${unknown.join(", ")}`);
    return {
      gate: { pass: false, detail: `decisions.json request_id mismatch (${parts.join("; ")})` },
      decisions
    };
  }

  return {
    gate: { pass: true, detail: "valid decisions.json" },
    decisions
  };
}

function globToRegExp(glob) {
  const normalized = glob.replace(/\\/g, "/").replace(/^\.\//, "");
  let regexStr = "^";
  let i = 0;
  while (i < normalized.length) {
    const ch = normalized[i];
    if (ch === "*") {
      if (normalized[i + 1] === "*") {
        if (normalized[i + 2] === "/") {
          regexStr += "(?:.*/)?";
          i += 3;
        } else {
          regexStr += ".*";
          i += 2;
        }
      } else {
        regexStr += "[^/]*";
        i += 1;
      }
    } else if (ch === "?") {
      regexStr += "[^/]";
      i += 1;
    } else if ("\\^$.|+()[]{}".includes(ch)) {
      regexStr += `\\${ch}`;
      i += 1;
    } else {
      regexStr += ch;
      i += 1;
    }
  }
  regexStr += "$";
  return new RegExp(regexStr);
}

export function matchGlob(filePath, pattern) {
  const normFile = filePath.replace(/\\/g, "/").replace(/^\.\//, "");
  return globToRegExp(pattern).test(normFile);
}

/**
 * Compute diff.out_of_scope_files from a list of changed file paths and spec.scope globs.
 */
export function checkScope(changedFiles = [], scopeGlobs = []) {
  const outOfScopeFiles = [];
  const inScopeFiles = [];
  for (const f of changedFiles) {
    const norm = f.replace(/\\/g, "/").replace(/^\.\//, "");
    if (!norm) continue;
    const ok = scopeGlobs.some((g) => matchGlob(norm, g));
    if (ok) inScopeFiles.push(norm);
    else outOfScopeFiles.push(norm);
  }
  return {
    outOfScopeCount: outOfScopeFiles.length,
    outOfScopeFiles,
    inScopeFiles
  };
}

/**
 * Optionally read changed files via `git diff --name-only` inside a submission directory.
 * Returns null if git diff cannot be obtained.
 */
export function getGitChangedFiles(submissionDir, baseRef = "HEAD") {
  try {
    const out = execFileSync("git", ["diff", "--name-only", baseRef], {
      cwd: submissionDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    });
    return out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  } catch {
    return null;
  }
}

const TEST_SANDBOX_EXTS = new Set([".js", ".mjs", ".cjs", ".ts", ".mts", ".cts"]);
const FORBIDDEN_BUILTIN_MODULES = new Set([
  "fs",
  "node:fs",
  "fs/promises",
  "node:fs/promises",
  "child_process",
  "node:child_process",
  "vm",
  "node:vm",
  "module",
  "node:module",
  "worker_threads",
  "node:worker_threads"
]);

function stripJsCommentsPreserveLines(source) {
  let out = "";
  let i = 0;
  let state = "code"; // code | single | double | template | line_comment | block_comment
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (state === "code") {
      if (ch === "/" && next === "/") {
        state = "line_comment";
        out += "  ";
        i += 2;
      } else if (ch === "/" && next === "*") {
        state = "block_comment";
        out += "  ";
        i += 2;
      } else if (ch === "'") {
        state = "single";
        out += ch;
        i += 1;
      } else if (ch === '"') {
        state = "double";
        out += ch;
        i += 1;
      } else if (ch === "`") {
        state = "template";
        out += ch;
        i += 1;
      } else {
        out += ch;
        i += 1;
      }
    } else if (state === "line_comment") {
      if (ch === "\n") {
        state = "code";
        out += "\n";
      } else {
        out += " ";
      }
      i += 1;
    } else if (state === "block_comment") {
      if (ch === "*" && next === "/") {
        state = "code";
        out += "  ";
        i += 2;
      } else if (ch === "\n") {
        out += "\n";
        i += 1;
      } else {
        out += " ";
        i += 1;
      }
    } else if (state === "single" || state === "double" || state === "template") {
      const quote = state === "single" ? "'" : state === "double" ? '"' : "`";
      if (ch === "\\" && next !== undefined) {
        out += ch + next;
        i += 2;
      } else if (ch === quote) {
        state = "code";
        out += ch;
        i += 1;
      } else {
        out += ch;
        i += 1;
      }
    }
  }
  return out;
}

function isAllowedHarnessSpecifier(specifier, fileDir, submissionDir) {
  const norm = specifier.replace(/\\/g, "/");
  if (/\/testing\/room-harness\.mjs$/.test(norm)) return true;
  if (norm.startsWith(".")) {
    const resolved = path.resolve(fileDir, norm).replace(/\\/g, "/");
    if (/\/(?:bench|harness\/src)\/testing\/room-harness\.mjs$/.test(resolved)) return true;
    const testsRoot = path.resolve(submissionDir, "tests").replace(/\\/g, "/");
    if (resolved === testsRoot || resolved.startsWith(`${testsRoot}/`)) return true;
  }
  return false;
}

function lineNumberAt(text, index) {
  let line = 1;
  for (let i = 0; i < index; i++) {
    if (text[i] === "\n") line++;
  }
  return line;
}

/**
 * G-test-sandbox (v0.2 Restoration): static scan of black-box regression tests
 * verifying they never import room/src/**, use fs/child_process/vm/module,
 * escape tests/ (except room-harness.mjs), or run dynamic eval/Function.
 */
export function evaluateTestSandboxGate(submissionDir, opts = {}) {
  const testDirRel = opts.testDir || "tests/regression";
  const testRoot = path.resolve(submissionDir, testDirRel);
  const violations = [];
  let filesScanned = 0;

  if (!fs.existsSync(testRoot) || !fs.statSync(testRoot).isDirectory()) {
    return {
      pass: true,
      detail: `no regression test files in ${testDirRel} (0 violations)`,
      violations: [],
      filesScanned: 0
    };
  }

  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === ".git") continue;
        walk(full);
      } else if (entry.isFile() && TEST_SANDBOX_EXTS.has(path.extname(entry.name).toLowerCase())) {
        filesScanned += 1;
        const relFile = path.relative(submissionDir, full).replace(/\\/g, "/");
        const raw = fs.readFileSync(full, "utf8");
        const code = stripJsCommentsPreserveLines(raw);
        const fileDir = path.dirname(full);

        const record = (index, rule, snippet) => {
          violations.push({
            file: relFile,
            line: lineNumberAt(code, index),
            rule,
            snippet: String(snippet).trim().slice(0, 120)
          });
        };

        // 1. Static import/export from "...", require("..."), dynamic import("...")
        const specPatterns = [
          /\b(?:import|export)\s+(?:[^'"]*?\s+from\s+)?["'`]([^"'`]+)["'`]/g,
          /\bimport\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/g,
          /\brequire\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/g
        ];
        for (const re of specPatterns) {
          for (const m of code.matchAll(re)) {
            const spec = m[1].trim();
            const normSpec = spec.replace(/\\/g, "/");
            if (FORBIDDEN_BUILTIN_MODULES.has(normSpec)) {
              record(m.index, "forbidden_builtin_import", m[0]);
              continue;
            }
            if (/(?:^|\/)room(?:\/|$)/.test(normSpec)) {
              record(m.index, "forbidden_room_import", m[0]);
              continue;
            }
            if (normSpec.startsWith("file://")) {
              record(m.index, "forbidden_file_url", m[0]);
              continue;
            }
            if (normSpec.startsWith(".") && !isAllowedHarnessSpecifier(normSpec, fileDir, submissionDir)) {
              record(m.index, "forbidden_escape_import", m[0]);
            }
          }
        }

        // 2. Dynamic non-literal import(...) or require(...)
        for (const m of code.matchAll(/\b(?:import|require)\s*\(\s*([^"'`\s)][^)]*)\)/g)) {
          record(m.index, "forbidden_dynamic_import", m[0]);
        }

        // 3. Dynamic code execution / Node internals
        const dynamicPatterns = [
          { re: /\beval\s*\(/g, rule: "forbidden_dynamic_code" },
          { re: /\bnew\s+Function\s*\(/g, rule: "forbidden_dynamic_code" },
          { re: /\bcreateRequire\s*\(/g, rule: "forbidden_dynamic_code" },
          { re: /\bprocess\s*\.\s*(?:binding|mainModule|_linkedBinding)\b/g, rule: "forbidden_dynamic_code" },
          { re: /\b(?:fetch|new\s+URL)\s*\(\s*["'`]file:\/\//gi, rule: "forbidden_file_url" }
        ];
        for (const { re, rule } of dynamicPatterns) {
          for (const m of code.matchAll(re)) {
            record(m.index, rule, m[0]);
          }
        }
      }
    }
  }

  walk(testRoot);

  if (violations.length > 0) {
    const first = violations[0];
    return {
      pass: false,
      detail: `${violations.length} test-sandbox violation(s); first: ${first.file}:${first.line} [${first.rule}] ${first.snippet}`,
      violations,
      filesScanned
    };
  }

  return {
    pass: true,
    detail: `clean black-box regression tests (${filesScanned} file(s) scanned, 0 violations)`,
    violations: [],
    filesScanned
  };
}

/**
 * Evaluate static gates (G-report, G-decisions, G-test-sandbox) and optional scope check.
 */
export function evaluateStaticGates(submissionDir, spec, opts = {}) {
  const repoRoot = opts.repoRoot || DEFAULT_REPO_ROOT;
  const staticGates = {};

  const reportRes = validateReportGate(submissionDir, repoRoot);
  if (spec.gates.includes("G-report")) {
    staticGates["G-report"] = reportRes.gate;
  }

  let decisionsRes = { gate: null, decisions: null };
  if (spec.gates.includes("G-decisions") || spec.track === "renovation") {
    decisionsRes = validateDecisionsGate(submissionDir, spec, repoRoot);
    if (spec.gates.includes("G-decisions")) {
      staticGates["G-decisions"] = decisionsRes.gate;
    }
  }

  if (spec.gates.includes("G-test-sandbox")) {
    staticGates["G-test-sandbox"] = evaluateTestSandboxGate(submissionDir, {
      testDir: spec.test_sandbox?.dir
    });
  }

  let scopeCheck = null;
  const changedFiles = opts.changedFiles ?? null;
  if (Array.isArray(changedFiles)) {
    scopeCheck = checkScope(changedFiles, spec.scope || []);
  }

  return {
    gates: staticGates,
    report: reportRes.report,
    decisions: decisionsRes.decisions,
    scopeCheck
  };
}

/**
 * Combine spec-declared gates with static and capture-time gate results.
 * Capture-time gates missing because capture was skipped are marked pass: null.
 */
export const ALIVE_MIN_MOTION = 0.0005;

/**
 * G-alive (room-optional, animated rooms): passes iff the median time.motion of the
 * "normal" variant samples exceeds ALIVE_MIN_MOTION. Returns pass:null when the motion
 * metric could not be evaluated because capture/python was skipped on purpose.
 */
export function evaluateAliveGate(rawMetrics = {}, opts = {}) {
  const { skipped = false } = opts;
  const entry = rawMetrics["time.motion"];
  const samples = Array.isArray(entry) ? entry : Array.isArray(entry?.samples) ? entry.samples : null;
  let values = [];
  if (samples) {
    const nums = samples.filter((x) => Number.isFinite(Number(x?.value)));
    const normal = nums.filter((x) => /(^|_)normal$/.test(String(x.key ?? "")));
    values = (normal.length ? normal : nums).map((x) => Number(x.value));
  } else {
    const raw = entry && typeof entry === "object" ? (entry.raw ?? entry.value) : entry;
    if (Number.isFinite(Number(raw)) && raw !== null && raw !== "") values = [Number(raw)];
  }
  if (!values.length) {
    return skipped
      ? { pass: null, detail: "not evaluated (time.motion unavailable)" }
      : { pass: false, detail: "time.motion not measured; cannot show the scene is animated" };
  }
  values.sort((a, b) => a - b);
  const mid = Math.floor(values.length / 2);
  const median = values.length % 2 ? values[mid] : (values[mid - 1] + values[mid]) / 2;
  return {
    pass: median > ALIVE_MIN_MOTION,
    detail: `time.motion median ${median.toPrecision(4)} (normal variant, n=${values.length}) must be > ${ALIVE_MIN_MOTION}`
  };
}

export function combineGates(specGates = [], staticGates = {}, captureGates = {}, opts = {}) {
  const { captureSkipped = false } = opts;
  const combined = {};

  for (const gateId of specGates) {
    if (Object.hasOwn(staticGates, gateId)) {
      combined[gateId] = staticGates[gateId];
    } else if (Object.hasOwn(captureGates, gateId)) {
      combined[gateId] = captureGates[gateId];
    } else if (captureSkipped) {
      combined[gateId] = { pass: null, detail: "not evaluated (capture skipped)" };
    } else {
      combined[gateId] = { pass: false, detail: "missing gate result" };
    }
  }

  for (const [k, v] of Object.entries(staticGates)) {
    if (!Object.hasOwn(combined, k)) combined[k] = v;
  }
  for (const [k, v] of Object.entries(captureGates)) {
    if (!Object.hasOwn(combined, k)) combined[k] = v;
  }

  return combined;
}
