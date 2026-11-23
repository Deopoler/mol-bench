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
const DEFAULT_ALLOWED_BARE_SPECIFIERS = Object.freeze([
  "node:test",
  "node:assert",
  "node:assert/strict",
  "playwright"
]);

const BUILTIN_STATIC_GATES = new Set(["G-report", "G-decisions", "G-test-sandbox"]);
const CUSTOM_STATIC_GATES = new Map();

/**
 * Register a custom static gate evaluator (M1 Extension Protocol).
 * @param {string} gateId Gate identifier starting with "G-"
 * @param {(submissionDir: string, spec: object, opts: object) => { pass: boolean|null, detail: string }} evaluator
 */
export function registerGate(gateId, evaluator) {
  if (typeof gateId !== "string" || !/^G-[a-z0-9-]+$/.test(gateId)) {
    throw new Error(`Invalid gate id: "${gateId}"`);
  }
  if (typeof evaluator !== "function") {
    throw new Error(`Gate evaluator for "${gateId}" must be a function`);
  }
  if (BUILTIN_STATIC_GATES.has(gateId) || CUSTOM_STATIC_GATES.has(gateId)) {
    throw new Error(`Gate "${gateId}" is already registered`);
  }
  CUSTOM_STATIC_GATES.set(gateId, evaluator);
}

export function unregisterGate(gateId) {
  CUSTOM_STATIC_GATES.delete(gateId);
}

/**
 * Minimal JS lexer for static sandbox allowlist verification.
 * Emits tokens `{ type, value, raw, index, line }` skipping whitespace and comments.
 * Token types: "ident" | "string" | "template" | "punct" | "other"
 */
function tokenizeJsForSandbox(source) {
  const tokens = [];
  let i = 0;
  let line = 1;
  const len = source.length;

  while (i < len) {
    const ch = source[i];
    const next = source[i + 1];

    // Whitespace
    if (ch === " " || ch === "\t" || ch === "\r" || ch === "\f" || ch === "\v") {
      i += 1;
      continue;
    }
    if (ch === "\n") {
      line += 1;
      i += 1;
      continue;
    }

    // Line comment
    if (ch === "/" && next === "/") {
      i += 2;
      while (i < len && source[i] !== "\n") i += 1;
      continue;
    }
    // Block comment
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < len && !(source[i] === "*" && source[i + 1] === "/")) {
        if (source[i] === "\n") line += 1;
        i += 1;
      }
      i += 2;
      continue;
    }

    // Single or double quoted string literal
    if (ch === "'" || ch === '"') {
      const start = i;
      const startLine = line;
      const quote = ch;
      i += 1;
      let val = "";
      while (i < len && source[i] !== quote) {
        if (source[i] === "\\" && i + 1 < len) {
          const esc = source[i + 1];
          if (esc === "\n") line += 1;
          val += esc === "n" ? "\n" : esc === "r" ? "\r" : esc === "t" ? "\t" : esc;
          i += 2;
        } else {
          if (source[i] === "\n") line += 1;
          val += source[i];
          i += 1;
        }
      }
      if (i < len) i += 1;
      tokens.push({ type: "string", value: val, raw: source.slice(start, i), index: start, line: startLine });
      continue;
    }

    // Template literal (tracks nested ${ ... } expressions as raw template so we can reject non-plain imports)
    if (ch === "`") {
      const start = i;
      const startLine = line;
      i += 1;
      let braceDepth = 0;
      while (i < len) {
        if (source[i] === "\\" && i + 1 < len) {
          if (source[i + 1] === "\n") line += 1;
          i += 2;
          continue;
        }
        if (source[i] === "$" && source[i + 1] === "{") {
          braceDepth += 1;
          i += 2;
          continue;
        }
        if (braceDepth > 0) {
          if (source[i] === "{") braceDepth += 1;
          else if (source[i] === "}") braceDepth -= 1;
          if (source[i] === "\n") line += 1;
          i += 1;
          continue;
        }
        if (source[i] === "`") {
          i += 1;
          break;
        }
        if (source[i] === "\n") line += 1;
        i += 1;
      }
      const raw = source.slice(start, i);
      tokens.push({ type: "template", value: raw.slice(1, -1), raw, index: start, line: startLine });
      continue;
    }

    // Identifier / keyword
    if (/[A-Za-z_$]/.test(ch)) {
      const start = i;
      i += 1;
      while (i < len && /[A-Za-z0-9_$]/.test(source[i])) i += 1;
      const word = source.slice(start, i);
      tokens.push({ type: "ident", value: word, raw: word, index: start, line });
      continue;
    }

    // Optional chaining `?.`
    if (ch === "?" && next === ".") {
      tokens.push({ type: "punct", value: "?.", raw: "?.", index: i, line });
      i += 2;
      continue;
    }

    // Single punctuation
    if ("(){}[];,.:+-*/=!<>?&|^~@".includes(ch)) {
      tokens.push({ type: "punct", value: ch, raw: ch, index: i, line });
      i += 1;
      continue;
    }

    // Numbers / other
    const start = i;
    while (i < len && !/[\s'"`(){}[\];,.:+\-*/=!<>?&|^~@A-Za-z_$]/.test(source[i])) i += 1;
    const raw = source.slice(start, i) || ch;
    if (i === start) i += 1;
    tokens.push({ type: "other", value: raw, raw, index: start, line });
  }
  return tokens;
}

function isSubPath(childPath, parentPath) {
  const rel = path.relative(parentPath, childPath);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function isAllowedRoomHarnessTarget(resolvedPath, submissionDir) {
  const norm = resolvedPath.replace(/\\/g, "/");
  const workspaceHarness = path.resolve(submissionDir, "bench", "testing", "room-harness.mjs").replace(/\\/g, "/");
  const repoHarness = path.resolve(DEFAULT_REPO_ROOT, "harness", "src", "testing", "room-harness.mjs").replace(/\\/g, "/");
  if (norm === workspaceHarness || norm === repoHarness) return true;
  if (/\/(?:bench|harness\/src)\/testing\/room-harness\.mjs$/.test(norm)) return true;
  return false;
}

function hasSymlinkInChain(baseDir, targetPath) {
  const rel = path.relative(baseDir, targetPath);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return false;
  let cur = path.resolve(baseDir);
  if (fs.existsSync(cur) && fs.lstatSync(cur).isSymbolicLink()) return true;
  const parts = rel.split(path.sep).filter(Boolean);
  for (const part of parts) {
    cur = path.join(cur, part);
    if (!fs.existsSync(cur)) break;
    if (fs.lstatSync(cur).isSymbolicLink()) return true;
  }
  return false;
}

/**
 * G-test-sandbox (v0.2 Restoration): strict static ALLOWLIST scan of black-box
 * regression tests (plus transitive relative imports inside testDir).
 *
 * Allowed specifiers (plain string literals only):
 * - Bare: node:test, node:assert, node:assert/strict, playwright (+ optional opts.allowedBareSpecifiers)
 * - room-harness.mjs (bench/testing/room-harness.mjs or harness/src/testing/room-harness.mjs)
 * - Relative JS/TS modules strictly inside testDir (scanned transitively; symlinks & non-JS rejected)
 *
 * Rejects: all other imports, absolute/file: specifiers, non-literal import()/require(),
 * import.meta.resolve, eval/Function/createRequire, symlinks, and any `process` usage
 * other than `process.env.MOL_*`.
 */
export function evaluateTestSandboxGate(submissionDir, opts = {}) {
  const testDirRel = opts.testDir || "tests/regression";
  const requireTests = opts.requireTests !== undefined ? Boolean(opts.requireTests) : true;
  const allowedBare = new Set([
    ...DEFAULT_ALLOWED_BARE_SPECIFIERS,
    ...(Array.isArray(opts.allowedBareSpecifiers) ? opts.allowedBareSpecifiers : [])
  ]);

  const absSubmission = path.resolve(submissionDir);
  const testRoot = path.resolve(absSubmission, testDirRel);
  const violations = [];

  if (!fs.existsSync(testRoot)) {
    if (requireTests) {
      return {
        pass: false,
        detail: `no regression test directory found at ${testDirRel} (required by G-test-sandbox)`,
        violations: [],
        filesScanned: 0
      };
    }
    return {
      pass: true,
      detail: `no regression test files in ${testDirRel} (0 violations)`,
      violations: [],
      filesScanned: 0
    };
  }

  if (hasSymlinkInChain(absSubmission, testRoot)) {
    violations.push({
      file: testDirRel.replace(/\\/g, "/"),
      line: 1,
      rule: "forbidden_symlink",
      snippet: `${testDirRel} contains a symbolic link`
    });
    return {
      pass: false,
      detail: `1 test-sandbox violation(s); first: ${testDirRel}:1 [forbidden_symlink] symbolic link in test path`,
      violations,
      filesScanned: 0
    };
  }

  if (!fs.statSync(testRoot).isDirectory()) {
    return {
      pass: false,
      detail: `${testDirRel} is not a directory`,
      violations: [],
      filesScanned: 0
    };
  }

  const realTestRoot = fs.realpathSync(testRoot);
  const filesToScan = [];
  const queued = new Set();

  function enqueueFile(absFile) {
    const resolved = path.resolve(absFile);
    if (!queued.has(resolved)) {
      queued.add(resolved);
      filesToScan.push(resolved);
    }
  }

  function walkInitial(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const relFile = path.relative(absSubmission, full).replace(/\\/g, "/");
      let lstat;
      try {
        lstat = fs.lstatSync(full);
      } catch {
        continue;
      }
      if (entry.isSymbolicLink() || lstat.isSymbolicLink()) {
        violations.push({
          file: relFile,
          line: 1,
          rule: "forbidden_symlink",
          snippet: `symlink not allowed: ${relFile}`
        });
        continue;
      }
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === ".git") continue;
        walkInitial(full);
      } else if (entry.isFile() && TEST_SANDBOX_EXTS.has(path.extname(entry.name).toLowerCase())) {
        enqueueFile(full);
      }
    }
  }

  walkInitial(testRoot);

  let filesScanned = 0;
  for (let idx = 0; idx < filesToScan.length; idx++) {
    const full = filesToScan[idx];
    const relFile = path.relative(absSubmission, full).replace(/\\/g, "/");
    if (!fs.existsSync(full)) continue;
    if (fs.lstatSync(full).isSymbolicLink()) {
      violations.push({
        file: relFile,
        line: 1,
        rule: "forbidden_symlink",
        snippet: `symlink not allowed: ${relFile}`
      });
      continue;
    }

    filesScanned += 1;
    const raw = fs.readFileSync(full, "utf8");
    const tokens = tokenizeJsForSandbox(raw);
    const fileDir = path.dirname(full);

    const record = (tok, rule, snippet) => {
      violations.push({
        file: relFile,
        line: tok?.line ?? 1,
        rule,
        snippet: String(snippet ?? tok?.raw ?? "").trim().slice(0, 120)
      });
    };

    const validateSpecifier = (specifier, tok, snippet) => {
      const spec = String(specifier).trim();
      const norm = spec.replace(/\\/g, "/");

      if (!spec) {
        record(tok, "disallowed_import", snippet);
        return;
      }
      if (/^file:/i.test(norm)) {
        record(tok, "forbidden_file_url", snippet);
        return;
      }
      if (norm.startsWith("/") || /^[A-Za-z]:[\\/]/.test(spec) || spec.startsWith("\\")) {
        record(tok, "forbidden_absolute_import", snippet);
        return;
      }
      if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(norm) && !norm.startsWith("node:")) {
        record(tok, "disallowed_import", snippet);
        return;
      }

      if (norm.startsWith(".")) {
        const resolved = path.resolve(fileDir, spec);
        if (isAllowedRoomHarnessTarget(resolved, absSubmission)) {
          if (fs.existsSync(resolved) && fs.lstatSync(resolved).isSymbolicLink()) {
            record(tok, "forbidden_symlink", snippet);
          }
          return;
        }
        if (!isSubPath(resolved, testRoot)) {
          record(tok, "forbidden_escape_import", snippet);
          return;
        }
        const ext = path.extname(resolved).toLowerCase();
        if (!TEST_SANDBOX_EXTS.has(ext)) {
          record(tok, "forbidden_non_js_import", snippet);
          return;
        }
        if (hasSymlinkInChain(testRoot, resolved)) {
          record(tok, "forbidden_symlink", snippet);
          return;
        }
        if (fs.existsSync(resolved)) {
          const realTarget = fs.realpathSync(resolved);
          if (!isSubPath(realTarget, realTestRoot)) {
            record(tok, "forbidden_symlink", snippet);
            return;
          }
          enqueueFile(resolved);
        }
        return;
      }

      // Bare specifier — strict allowlist
      if (!allowedBare.has(norm)) {
        record(tok, "disallowed_import", snippet);
      }
    };

    const checkCallArgSingleString = (openParenTokenIdx, kwTok) => {
      let depth = 0;
      let closeIdx = -1;
      for (let j = openParenTokenIdx; j < tokens.length; j++) {
        const t = tokens[j];
        if (t.type === "punct" && t.value === "(") depth += 1;
        else if (t.type === "punct" && t.value === ")") {
          depth -= 1;
          if (depth === 0) {
            closeIdx = j;
            break;
          }
        }
      }
      if (closeIdx === -1) {
        record(kwTok, "forbidden_dynamic_import", `${kwTok.value}(...)`);
        return;
      }
      const argTokens = tokens.slice(openParenTokenIdx + 1, closeIdx);
      const snippet = tokens.slice(openParenTokenIdx - 1, closeIdx + 1).map((t) => t.raw).join(" ");
      if (argTokens.length === 1 && argTokens[0].type === "string") {
        validateSpecifier(argTokens[0].value, kwTok, snippet);
      } else {
        record(kwTok, "forbidden_dynamic_import", snippet);
      }
    };

    for (let ti = 0; ti < tokens.length; ti++) {
      const tok = tokens[ti];
      const prev = ti > 0 ? tokens[ti - 1] : null;
      const next = ti + 1 < tokens.length ? tokens[ti + 1] : null;

      // Reject any file:// URL literal
      if ((tok.type === "string" || tok.type === "template") && /file:\/\//i.test(tok.value)) {
        record(tok, "forbidden_file_url", tok.raw);
        continue;
      }

      // 1. import statements, dynamic import(...), import.meta.resolve
      if (tok.type === "ident" && tok.value === "import") {
        if (next && next.type === "punct" && next.value === "(") {
          checkCallArgSingleString(ti + 1, tok);
          continue;
        }
        if (next && next.type === "punct" && next.value === ".") {
          const t2 = tokens[ti + 2];
          const t3 = tokens[ti + 3];
          const t4 = tokens[ti + 4];
          if (t2?.value === "meta" && t3?.value === "." && t4?.value === "resolve") {
            record(tok, "forbidden_import_meta_resolve", "import.meta.resolve");
          }
          continue;
        }
        // Ignore property access like obj.import
        if (prev && prev.type === "punct" && (prev.value === "." || prev.value === "?.")) {
          continue;
        }
        // Side-effect import: `import"fs"` or `import "fs"`
        if (next && next.type === "string") {
          validateSpecifier(next.value, tok, `import ${next.raw}`);
          continue;
        }
        if (next && next.type === "template") {
          record(tok, "forbidden_dynamic_import", `import ${next.raw}`);
          continue;
        }
        // Standard `import ... from "..."`
        for (let j = ti + 1; j < tokens.length; j++) {
          const tj = tokens[j];
          if (tj.type === "punct" && tj.value === ";") break;
          if (tj.type === "ident" && tj.value === "from") {
            const specTok = tokens[j + 1];
            if (specTok && specTok.type === "string") {
              validateSpecifier(specTok.value, tok, `import ... from ${specTok.raw}`);
            } else {
              record(tok, "forbidden_dynamic_import", `import ... from ${specTok?.raw ?? ""}`);
            }
            break;
          }
        }
        continue;
      }

      // 2. Re-export `export ... from "..."`
      if (tok.type === "ident" && tok.value === "export" && !(prev?.type === "punct" && prev.value === ".")) {
        for (let j = ti + 1; j < tokens.length; j++) {
          const tj = tokens[j];
          if (tj.type === "punct" && (tj.value === ";" || tj.value === "=")) break;
          if (tj.type === "ident" && (tj.value === "function" || tj.value === "const" || tj.value === "let" || tj.value === "var" || tj.value === "class" || tj.value === "default")) {
            break;
          }
          if (tj.type === "ident" && tj.value === "from") {
            const specTok = tokens[j + 1];
            if (specTok && specTok.type === "string") {
              validateSpecifier(specTok.value, tok, `export ... from ${specTok.raw}`);
            } else {
              record(tok, "forbidden_dynamic_import", `export ... from ${specTok?.raw ?? ""}`);
            }
            break;
          }
        }
        continue;
      }

      // 3. require(...)
      if (tok.type === "ident" && tok.value === "require" && next?.type === "punct" && next.value === "(") {
        checkCallArgSingleString(ti + 1, tok);
        continue;
      }

      // 4. eval / Function / createRequire
      if (tok.type === "ident" && (tok.value === "eval" || tok.value === "Function" || tok.value === "createRequire")) {
        if (next?.type === "punct" && next.value === "(") {
          record(tok, "forbidden_dynamic_code", `${tok.value}(`);
          continue;
        }
      }

      // 5. `process` access: ONLY `process.env.MOL_*` (or `process.env?.MOL_*`) is allowed
      if (tok.type === "ident" && tok.value === "process") {
        // Allow object key `{ process: ... }`
        if (next?.type === "punct" && next.value === ":") continue;
        // Allow non-global property access like `obj.process`, EXCEPT `globalThis.process` / `global.process`
        if (prev?.type === "punct" && (prev.value === "." || prev.value === "?.")) {
          const objTok = ti >= 2 ? tokens[ti - 2] : null;
          if (objTok?.type !== "ident" || (objTok.value !== "globalThis" && objTok.value !== "global")) {
            continue;
          }
        }
        // Check exact pattern: process (. | ?.) env (. | ?.) MOL_...
        const t1 = tokens[ti + 1];
        const t2 = tokens[ti + 2];
        const t3 = tokens[ti + 3];
        const t4 = tokens[ti + 4];
        const isAllowedEnv =
          t1?.type === "punct" && (t1.value === "." || t1.value === "?.") &&
          t2?.type === "ident" && t2.value === "env" &&
          t3?.type === "punct" && (t3.value === "." || t3.value === "?.") &&
          t4?.type === "ident" && /^MOL_[A-Z0-9_]+$/.test(t4.value);
        if (!isAllowedEnv) {
          const snippet = tokens.slice(ti, Math.min(tokens.length, ti + 5)).map((t) => t.raw).join("");
          record(tok, "forbidden_process_access", snippet);
        }
      }
    }
  }

  if (violations.length > 0) {
    const first = violations[0];
    return {
      pass: false,
      detail: `${violations.length} test-sandbox violation(s); first: ${first.file}:${first.line} [${first.rule}] ${first.snippet}`,
      violations,
      filesScanned
    };
  }

  if (filesScanned === 0 && requireTests) {
    return {
      pass: false,
      detail: `no regression test files found in ${testDirRel} (required by G-test-sandbox)`,
      violations: [],
      filesScanned: 0
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
 * Evaluate static gates (G-report, G-decisions, G-test-sandbox, plus registered custom gates)
 * and optional scope check.
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
      testDir: spec.test_sandbox?.dir,
      requireTests: spec.test_sandbox?.required !== false
    });
  }

  for (const [gateId, evaluator] of CUSTOM_STATIC_GATES.entries()) {
    if (spec.gates.includes(gateId)) {
      staticGates[gateId] = evaluator(submissionDir, spec, opts);
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
