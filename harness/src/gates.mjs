import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = path.resolve(__dirname, "..", "..");

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

/**
 * Evaluate static gates (G-report, G-decisions) and optional scope check.
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
