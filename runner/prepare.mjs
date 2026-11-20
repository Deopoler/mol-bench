#!/usr/bin/env node
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadSpec } from "../harness/src/spec.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = path.resolve(__dirname, "..");
const DEFAULT_RUNS_ROOT = path.join(os.homedir(), "molbench-runs");
const GIT_AUTHOR_NAME = "MoL-Bench Runner";
const GIT_AUTHOR_EMAIL = "runner@mol-bench.local";

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        flags[key] = true;
      } else {
        flags[key] = argv[++i];
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

function copyTreeFiltered(srcDir, dstDir, shouldInclude) {
  if (!fs.existsSync(srcDir)) {
    throw new Error(`Source directory does not exist: ${srcDir}`);
  }
  fs.mkdirSync(dstDir, { recursive: true });
  const entries = fs.readdirSync(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(srcDir, entry.name);
    const dstPath = path.join(dstDir, entry.name);
    if (!shouldInclude(srcPath, entry)) continue;
    if (entry.isDirectory()) {
      copyTreeFiltered(srcPath, dstPath, shouldInclude);
    } else if (entry.isSymbolicLink()) {
      const real = fs.realpathSync(srcPath);
      const stat = fs.statSync(real);
      if (stat.isDirectory()) {
        copyTreeFiltered(real, dstPath, shouldInclude);
      } else {
        fs.copyFileSync(real, dstPath);
      }
    } else {
      fs.copyFileSync(srcPath, dstPath);
    }
  }
}

function copyHeavyDir(srcDir, dstDir) {
  if (!fs.existsSync(srcDir)) {
    throw new Error(`Required dependency directory does not exist: ${srcDir}`);
  }
  if (process.platform === "win32") {
    const cleanSrc = path.resolve(srcDir).replace(/[\\/]+$/, "");
    const cleanDst = path.resolve(dstDir).replace(/[\\/]+$/, "");
    fs.mkdirSync(cleanDst, { recursive: true });
    const res = spawnSync(
      "robocopy",
      [cleanSrc, cleanDst, "/E", "/MT:16", "/NFL", "/NDL", "/NJH", "/NJS", "/NC", "/NS", "/NP"],
      { encoding: "utf8", windowsHide: true }
    );
    if (res.error) {
      throw new Error(`robocopy failed for ${cleanSrc}: ${res.error.message}`);
    }
    // Robocopy exit codes 0-7 indicate success; >= 8 indicates failure.
    if (res.status === null || res.status >= 8) {
      throw new Error(
        `robocopy failed (exit ${res.status}) copying ${cleanSrc} -> ${cleanDst}: ${res.stdout || ""} ${res.stderr || ""}`.trim()
      );
    }
    return;
  }
  fs.cpSync(srcDir, dstDir, { recursive: true });
}

function resolvePromptPath(repoRoot, room, renovation, runDir) {
  if (renovation) {
    const candidates = [
      path.join(repoRoot, "rooms", room, "renovation", `${renovation}-prompt.md`),
      path.join(repoRoot, "rooms", room, "renovation", `${renovation}.md`)
    ];
    for (const c of candidates) {
      if (fs.existsSync(c)) return c;
    }
    throw new Error(`Renovation prompt not found (tried ${candidates.join(", ")})`);
  }

  if (room === "restoration") {
    const generatedPrompt = path.join(runDir, "PROMPT.md");
    if (fs.existsSync(generatedPrompt)) return generatedPrompt;
  }

  const promptPath = path.join(repoRoot, "rooms", room, "prompt.md");
  if (fs.existsSync(promptPath)) return promptPath;
  throw new Error(`Room prompt not found: ${promptPath}`);
}

function isInsideDir(targetPath, parentDir) {
  const rel = path.relative(path.resolve(parentDir), path.resolve(targetPath));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

export function verifyNoHiddenReachable(runDir, repoRoot) {
  const hiddenRoot = path.resolve(repoRoot, "hidden");
  const badDirect = [path.join(runDir, "hidden"), path.join(runDir, "bench", "hidden")];
  for (const p of badDirect) {
    if (fs.existsSync(p)) {
      throw new Error(`Hidden directory leaked into run folder: ${p}`);
    }
  }

  function walk(dir, inHeavyDir = false) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (!inHeavyDir && entry.name.toLowerCase() === "hidden") {
        throw new Error(`Hidden file/directory reachable in run folder: ${fullPath}`);
      }
      if (entry.isSymbolicLink()) {
        const resolved = fs.realpathSync(fullPath);
        if (isInsideDir(resolved, hiddenRoot) || !isInsideDir(resolved, runDir)) {
          throw new Error(`Symlink escapes run folder or reaches hidden/: ${fullPath} -> ${resolved}`);
        }
      }
      if (entry.isDirectory()) {
        const isHeavy = entry.name === "node_modules" || entry.name === ".venv" || entry.name === ".git";
        if (!isHeavy) {
          walk(fullPath, false);
        }
      }
    }
  }

  walk(runDir, false);
}

// Keys that would leak hidden information to contestants (answers, attacks, hidden params, anchor traits).
const PRIVATE_SPEC_KEYS = new Set([
  "attacks", "hidden_tests", "bug_pool", "hidden_params", "expected_decision", "notes",
  "start", "min_diff", "root_cause_codes_notes", "preservation_exclude", "generator"
]);

export function sanitizeSpec(value) {
  if (Array.isArray(value)) return value.map(sanitizeSpec);
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (PRIVATE_SPEC_KEYS.has(k)) continue;
      out[k] = sanitizeSpec(v);
    }
    return out;
  }
  return value;
}

function writeSanitizedSpec(src, dst) {
  const spec = JSON.parse(fs.readFileSync(src, "utf8"));
  fs.writeFileSync(dst, JSON.stringify(sanitizeSpec(spec), null, 2));
}

function copyRoomSpecIntoBench(repoRoot, runDir, room, renovation) {
  const specDstDir = path.join(runDir, "bench", "_spec", room);
  fs.mkdirSync(specDstDir, { recursive: true });
  const baseSpecSrc = path.join(repoRoot, "rooms", room, "spec.json");
  if (fs.existsSync(baseSpecSrc)) {
    writeSanitizedSpec(baseSpecSrc, path.join(specDstDir, "spec.json"));
  }
  if (renovation) {
    const renSrc = path.join(repoRoot, "rooms", room, "renovation", `${renovation}.json`);
    if (fs.existsSync(renSrc)) {
      const renDstDir = path.join(specDstDir, "renovation");
      fs.mkdirSync(renDstDir, { recursive: true });
      writeSanitizedSpec(renSrc, path.join(renDstDir, `${renovation}.json`));
    }
  }
}

export function prepareRun({
  room,
  runId,
  renovation = null,
  seed = null,
  root = process.env.MOLBENCH_RUNS || DEFAULT_RUNS_ROOT,
  repoRoot = DEFAULT_REPO_ROOT
}) {
  if (!room) throw new Error("Missing required <room> argument.");
  if (!runId) throw new Error("Missing required --run-id <id> argument.");

  const resolvedRepoRoot = path.resolve(repoRoot);
  const spec = loadSpec(room, { renovation, repoRoot: resolvedRepoRoot });
  const track = spec.track || (renovation ? "renovation" : "build");

  let effectiveSeed = seed;
  if (effectiveSeed !== null && effectiveSeed !== undefined) {
    effectiveSeed = Number(effectiveSeed);
    if (!Number.isInteger(effectiveSeed)) {
      throw new Error(`Invalid --seed value "${seed}" (expected integer).`);
    }
  } else if (room === "restoration" && !renovation) {
    effectiveSeed = spec.capture?.public_seeds?.[0] ?? 1;
  }

  const runDir = path.resolve(root, runId);
  if (fs.existsSync(runDir) && fs.readdirSync(runDir).length > 0) {
    throw new Error(`Run directory already exists and is non-empty: ${runDir}`);
  }
  fs.mkdirSync(runDir, { recursive: true });

  try {
    // 1. Copy room seed / renovation start / restoration variant
    if (renovation) {
      const a5Dir = path.join(resolvedRepoRoot, "rooms", room, "anchors", "a5");
      if (!fs.existsSync(a5Dir)) {
        throw new Error(`Renovation start anchor not found: ${a5Dir}`);
      }
      copyTreeFiltered(a5Dir, runDir, (srcPath, entry) => {
        const rel = path.relative(a5Dir, srcPath).replace(/\\/g, "/");
        if (entry.name === ".git") return false;
        if (rel === "report.json" || rel === "decisions.json" || rel === "selfcheck.json") return false;
        return true;
      });
    } else if (room === "restoration") {
      const buildVariantScript = path.join(resolvedRepoRoot, "rooms", "restoration", "build-variant.mjs");
      if (fs.existsSync(buildVariantScript)) {
        const stdout = execFileSync(
          process.execPath,
          [buildVariantScript, String(effectiveSeed), "--out", runDir],
          { cwd: resolvedRepoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
        ).trim();
        const entriesNow = fs.readdirSync(runDir);
        if (entriesNow.length === 0 && stdout && fs.existsSync(stdout) && fs.statSync(stdout).isDirectory()) {
          copyTreeFiltered(stdout, runDir, (_p, entry) => entry.name !== ".git");
        }
      } else {
        const fallbackSeedDir = path.join(resolvedRepoRoot, "rooms", "restoration", "seed");
        if (!fs.existsSync(fallbackSeedDir)) {
          throw new Error(`Restoration variant builder not found: ${buildVariantScript}`);
        }
        copyTreeFiltered(fallbackSeedDir, runDir, (_p, entry) => entry.name !== ".git");
      }
    } else {
      const seedDir = path.join(resolvedRepoRoot, "rooms", room, "seed");
      if (!fs.existsSync(seedDir)) {
        throw new Error(`Room seed directory not found: ${seedDir}`);
      }
      copyTreeFiltered(seedDir, runDir, (_p, entry) => entry.name !== ".git");
    }

    // 2. PROMPT.md
    const promptSrc = resolvePromptPath(resolvedRepoRoot, room, renovation, runDir);
    const promptDst = path.join(runDir, "PROMPT.md");
    if (path.resolve(promptSrc) !== path.resolve(promptDst)) {
      fs.copyFileSync(promptSrc, promptDst);
    }

    // 3. bench/ (copy of harness/src without hidden/)
    const harnessSrcDir = path.join(resolvedRepoRoot, "harness", "src");
    const benchDstDir = path.join(runDir, "bench");
    copyTreeFiltered(harnessSrcDir, benchDstDir, (srcPath, entry) => {
      if (entry.name.toLowerCase() === "hidden") return false;
      if (entry.name === ".git" || entry.name === "__pycache__" || entry.name.endsWith(".pyc")) return false;
      const rel = path.relative(harnessSrcDir, srcPath).replace(/\\/g, "/");
      if (rel.split("/").some((seg) => seg.toLowerCase() === "hidden")) return false;
      return true;
    });
    copyRoomSpecIntoBench(resolvedRepoRoot, runDir, room, renovation);

    // 4. metrics/, contract/, schemas/
    const metricsSrcDir = path.join(resolvedRepoRoot, "metrics");
    if (!fs.existsSync(metricsSrcDir)) {
      throw new Error(`metrics directory not found: ${metricsSrcDir}`);
    }
    copyTreeFiltered(metricsSrcDir, path.join(runDir, "metrics"), (_p, entry) => {
      return entry.name !== "__pycache__" && entry.name !== ".pytest_cache" && !entry.name.endsWith(".pyc");
    });

    const contractSrcDir = path.join(resolvedRepoRoot, "contract");
    if (!fs.existsSync(contractSrcDir)) {
      throw new Error(`contract directory not found: ${contractSrcDir}`);
    }
    copyTreeFiltered(contractSrcDir, path.join(runDir, "contract"), (_p, entry) => entry.name !== ".git");

    const schemasSrcDir = path.join(resolvedRepoRoot, "schemas");
    if (!fs.existsSync(schemasSrcDir)) {
      throw new Error(`schemas directory not found: ${schemasSrcDir}`);
    }
    copyTreeFiltered(schemasSrcDir, path.join(runDir, "schemas"), (_p, entry) => entry.name !== ".git");

    // 5. node_modules/ and .venv/
    copyHeavyDir(path.join(resolvedRepoRoot, "node_modules"), path.join(runDir, "node_modules"));
    copyHeavyDir(path.join(resolvedRepoRoot, ".venv"), path.join(runDir, ".venv"));

    // 6. .run.json
    const runMeta = {
      run_id: runId,
      room,
      track,
      ...(renovation ? { renovation } : {}),
      seed: effectiveSeed ?? null,
      created_at: new Date().toISOString()
    };
    fs.writeFileSync(path.join(runDir, ".run.json"), JSON.stringify(runMeta, null, 2) + "\n", "utf8");

    // 7. Verify no hidden files or symlinks are reachable
    verifyNoHiddenReachable(runDir, resolvedRepoRoot);

    // 8. git init + neutral initial commit (ignore heavy vendor folders so diffs stay clean and fast)
    execFileSync("git", ["init"], { cwd: runDir, stdio: ["ignore", "pipe", "pipe"] });
    const excludeFile = path.join(runDir, ".git", "info", "exclude");
    fs.mkdirSync(path.dirname(excludeFile), { recursive: true });
    fs.writeFileSync(
      excludeFile,
      ["node_modules/", ".venv/", "__pycache__/", "*.pyc", ""].join("\n"),
      "utf8"
    );
    execFileSync("git", ["add", "-A"], { cwd: runDir, stdio: ["ignore", "pipe", "pipe"] });
    execFileSync(
      "git",
      ["-c", `user.name=${GIT_AUTHOR_NAME}`, "-c", `user.email=${GIT_AUTHOR_EMAIL}`, "commit", "-m", "Start state", "--allow-empty"],
      { cwd: runDir, stdio: ["ignore", "pipe", "pipe"] }
    );

    return { runDir, runMeta };
  } catch (err) {
    throw err;
  }
}

function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  if (flags.help || flags.h || positional.length === 0) {
    console.log(
      "Usage: node runner/prepare.mjs <room> --run-id <id> [--renovation r1] [--seed N] [--root <dir>]"
    );
    return;
  }
  const room = positional[0];
  const { runDir } = prepareRun({
    room,
    runId: flags["run-id"],
    renovation: flags.renovation ?? null,
    seed: flags.seed ?? null,
    root: flags.root || process.env.MOLBENCH_RUNS || DEFAULT_RUNS_ROOT,
    repoRoot: flags["repo-root"] || DEFAULT_REPO_ROOT
  });
  console.log(runDir);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    main();
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}
