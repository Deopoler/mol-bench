#!/usr/bin/env node
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { registerMetrics } from "../harness/src/registry.mjs";
import { loadSpec, parseVersion, resolveVersionPaths } from "../harness/src/spec.mjs";

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

function copyTreeFiltered(srcDir, dstDir, shouldInclude, rootBase = srcDir) {
  if (!fs.existsSync(srcDir)) {
    throw new Error(`Source directory does not exist: ${srcDir}`);
  }
  fs.mkdirSync(dstDir, { recursive: true });
  const entries = fs.readdirSync(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(srcDir, entry.name);
    const dstPath = path.join(dstDir, entry.name);
    const st = fs.lstatSync(srcPath);
    if (st.isSymbolicLink()) {
      throw new Error(`Symlink not allowed in source tree: ${srcPath}`);
    }
    if (!shouldInclude(srcPath, entry, rootBase)) continue;
    if (st.isDirectory()) {
      copyTreeFiltered(srcPath, dstPath, shouldInclude, rootBase);
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

function resolvePromptPath(repoRoot, room, renovation, runDir, versionPaths = null) {
  const roomsDir = versionPaths?.roomsDir || path.join(repoRoot, "rooms");
  if (renovation) {
    const candidates = [
      path.join(roomsDir, room, "renovation", `${renovation}-prompt.md`),
      path.join(roomsDir, room, "renovation", `${renovation}.md`),
      path.join(roomsDir, room, "renovation", "chain", `${renovation}-prompt.md`),
      path.join(roomsDir, room, "renovation", "chain", `${renovation}.md`)
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

  const promptPath = path.join(roomsDir, room, "prompt.md");
  if (fs.existsSync(promptPath)) return promptPath;
  throw new Error(`Room prompt not found: ${promptPath}`);
}

function isInsideDir(targetPath, parentDir) {
  const rel = path.relative(path.resolve(parentDir), path.resolve(targetPath));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

export function verifyNoHiddenReachable(runDir, repoRoot) {
  const hiddenRoot = path.resolve(repoRoot, "hidden");
  const hiddenV2Root = path.resolve(repoRoot, "hidden-v2");
  const badDirect = [
    path.join(runDir, "hidden"),
    path.join(runDir, "hidden-v2"),
    path.join(runDir, "bench", "hidden"),
    path.join(runDir, "bench", "hidden-v2")
  ];
  for (const p of badDirect) {
    if (fs.existsSync(p)) {
      throw new Error(`Hidden directory leaked into run folder: ${p}`);
    }
  }

  function walk(dir, inHeavyDir = false) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const lower = entry.name.toLowerCase();
      if (!inHeavyDir && (lower === "hidden" || lower === "hidden-v2")) {
        throw new Error(`Hidden file/directory reachable in run folder: ${fullPath}`);
      }
      if (entry.isSymbolicLink()) {
        const resolved = fs.realpathSync(fullPath);
        if (isInsideDir(resolved, hiddenRoot) || isInsideDir(resolved, hiddenV2Root) || !isInsideDir(resolved, runDir)) {
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

function copyRoomSpecIntoBench(repoRoot, runDir, room, renovation, versionPaths = null) {
  const roomsDir = versionPaths?.roomsDir || path.join(repoRoot, "rooms");
  const specDstDir = path.join(runDir, "bench", "_spec", room);
  fs.mkdirSync(specDstDir, { recursive: true });
  const baseSpecSrc = path.join(roomsDir, room, "spec.json");
  if (fs.existsSync(baseSpecSrc)) {
    writeSanitizedSpec(baseSpecSrc, path.join(specDstDir, "spec.json"));
  }
  if (renovation) {
    const primaryRen = path.join(roomsDir, room, "renovation", `${renovation}.json`);
    const chainRen = path.join(roomsDir, room, "renovation", "chain", `${renovation}.json`);
    const renSrc = fs.existsSync(primaryRen) ? primaryRen : chainRen;
    if (fs.existsSync(renSrc)) {
      const renDstDir = path.join(specDstDir, "renovation");
      fs.mkdirSync(renDstDir, { recursive: true });
      writeSanitizedSpec(renSrc, path.join(renDstDir, `${renovation}.json`));
    }
  }
}

const EXCLUDED_START_DIRS = new Set([
  ".git", "node_modules", ".venv", "bench", "metrics", "work", "preview", "__pycache__", ".pytest_cache", "hidden", "hidden-v2"
]);

export function prepareRun({
  room,
  runId,
  renovation = null,
  version = 1,
  seed = null,
  startDir = null,
  chainRound = null,
  parentRunId = null,
  root = process.env.MOLBENCH_RUNS || DEFAULT_RUNS_ROOT,
  repoRoot = DEFAULT_REPO_ROOT
}) {
  if (!room) throw new Error("Missing required <room> argument.");
  if (!runId) throw new Error("Missing required --run-id <id> argument.");

  const v = parseVersion(version);
  const resolvedRepoRoot = path.resolve(repoRoot);
  const versionPaths = resolveVersionPaths(v, resolvedRepoRoot);
  const roomsDir = versionPaths.roomsDir;
  const spec = loadSpec(room, { renovation, version: v, repoRoot: resolvedRepoRoot });
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
    // 1. Copy room seed / renovation start / restoration variant / chain handoff startDir
    if (startDir) {
      const resolvedStart = path.resolve(startDir);
      if (!fs.existsSync(resolvedStart)) {
        throw new Error(`Start directory does not exist: ${resolvedStart}`);
      }
      copyTreeFiltered(resolvedStart, runDir, (srcPath, entry) => {
        const rel = path.relative(resolvedStart, srcPath).replace(/\\/g, "/");
        const parts = rel.split("/");
        const lower = entry.name.toLowerCase();
        if (lower === "hidden" || lower === "hidden-v2") return false;
        if (parts.length === 1 && EXCLUDED_START_DIRS.has(entry.name)) return false;
        if (rel === "report.json" || rel === "decisions.json" || rel === "selfcheck.json" || rel === ".run.json" || rel === ".bench-room") return false;
        return true;
      });
    } else if (renovation) {
      const a5Dir = path.join(roomsDir, room, "anchors", "a5");
      if (!fs.existsSync(a5Dir)) {
        throw new Error(`Renovation start anchor not found: ${a5Dir}`);
      }
      copyTreeFiltered(a5Dir, runDir, (srcPath, entry) => {
        const rel = path.relative(a5Dir, srcPath).replace(/\\/g, "/");
        if (entry.name === ".git" || entry.name.toLowerCase() === "hidden" || entry.name.toLowerCase() === "hidden-v2") return false;
        if (rel === "report.json" || rel === "decisions.json" || rel === "selfcheck.json") return false;
        return true;
      });
    } else if (room === "restoration") {
      const buildVariantScript = path.join(roomsDir, "restoration", "build-variant.mjs");
      if (fs.existsSync(buildVariantScript)) {
        const stdout = execFileSync(
          process.execPath,
          [buildVariantScript, String(effectiveSeed), "--out", runDir],
          { cwd: resolvedRepoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
        ).trim();
        const entriesNow = fs.readdirSync(runDir);
        if (entriesNow.length === 0 && stdout && fs.existsSync(stdout) && fs.statSync(stdout).isDirectory()) {
          copyTreeFiltered(stdout, runDir, (_p, entry) => entry.name !== ".git" && entry.name.toLowerCase() !== "hidden" && entry.name.toLowerCase() !== "hidden-v2");
        }
      } else {
        const fallbackSeedDir = path.join(roomsDir, "restoration", "seed");
        if (!fs.existsSync(fallbackSeedDir)) {
          throw new Error(`Restoration variant builder not found: ${buildVariantScript}`);
        }
        copyTreeFiltered(fallbackSeedDir, runDir, (_p, entry) => entry.name !== ".git" && entry.name.toLowerCase() !== "hidden" && entry.name.toLowerCase() !== "hidden-v2");
      }
    } else {
      const seedDir = path.join(roomsDir, room, "seed");
      if (!fs.existsSync(seedDir)) {
        throw new Error(`Room seed directory not found: ${seedDir}`);
      }
      copyTreeFiltered(seedDir, runDir, (_p, entry) => entry.name !== ".git" && entry.name.toLowerCase() !== "hidden" && entry.name.toLowerCase() !== "hidden-v2");
    }

    // 2. PROMPT.md
    const promptSrc = resolvePromptPath(resolvedRepoRoot, room, renovation, runDir, versionPaths);
    const promptDst = path.join(runDir, "PROMPT.md");
    if (path.resolve(promptSrc) !== path.resolve(promptDst)) {
      fs.copyFileSync(promptSrc, promptDst);
    }

    // 3. bench/ (copy of harness/src without hidden/)
    const harnessSrcDir = path.join(resolvedRepoRoot, "harness", "src");
    const benchDstDir = path.join(runDir, "bench");
    copyTreeFiltered(harnessSrcDir, benchDstDir, (srcPath, entry) => {
      const lower = entry.name.toLowerCase();
      if (lower === "hidden" || lower === "hidden-v2") return false;
      if (entry.name === ".git" || entry.name === "__pycache__" || entry.name.endsWith(".pyc")) return false;
      const rel = path.relative(harnessSrcDir, srcPath).replace(/\\/g, "/");
      if (rel.split("/").some((seg) => seg.toLowerCase() === "hidden" || seg.toLowerCase() === "hidden-v2")) return false;
      return true;
    });
    copyRoomSpecIntoBench(resolvedRepoRoot, runDir, room, renovation, versionPaths);

    // 3b. Blender tooling used by `bench selfcheck` in Blender rooms (no hidden data inside).
    const isBlenderRoom = String(spec.contract || spec._baseSpec?.contract || "").includes("blender");
    if (isBlenderRoom) {
      for (const rel of [path.join("harness", "blender"), "metrics3d"]) {
        const src = path.join(resolvedRepoRoot, rel);
        if (!fs.existsSync(src)) continue;
        copyTreeFiltered(src, path.join(runDir, rel), (_srcPath, entry) => {
          const lower = entry.name.toLowerCase();
          return !(lower === "hidden" || lower === "hidden-v2" || entry.name === "__pycache__" || entry.name.endsWith(".pyc"));
        });
      }
    }

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

    // 6. .run.json and (for v2) .bench-room
    const runMeta = {
      run_id: runId,
      room,
      track,
      ...(renovation ? { renovation } : {}),
      ...(v === 2 ? { version: 2, bench_version: versionPaths.benchVersion } : {}),
      ...(chainRound !== null ? { chain_round: chainRound } : {}),
      ...(parentRunId ? { parent_run_id: parentRunId } : {}),
      seed: effectiveSeed ?? null,
      ...(spec.time_limit_active_min !== undefined ? { time_limit_active_min: spec.time_limit_active_min } : {}),
      created_at: new Date().toISOString()
    };
    fs.writeFileSync(path.join(runDir, ".run.json"), JSON.stringify(runMeta, null, 2) + "\n", "utf8");
    if (v === 2) {
      const benchRoomObj = {
        room,
        ...(renovation ? { renovation } : {}),
        version: 2,
        bench_version: versionPaths.benchVersion
      };
      fs.writeFileSync(path.join(runDir, ".bench-room"), JSON.stringify(benchRoomObj, null, 2) + "\n", "utf8");
    }

    // 7. Verify no hidden files or symlinks are reachable
    verifyNoHiddenReachable(runDir, resolvedRepoRoot);

    // 8. git init + neutral initial commit (ignore heavy vendor folders so diffs stay clean and fast)
    execFileSync("git", ["init"], { cwd: runDir, stdio: ["ignore", "pipe", "pipe"] });
    execFileSync("git", ["config", "core.autocrlf", "false"], { cwd: runDir, stdio: ["ignore", "pipe", "pipe"] });
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

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  if (flags.help || flags.h || positional.length === 0) {
    console.log(
      "Usage: node runner/prepare.mjs <room> --run-id <id> [--version 1|2] [--renovation r1] [--seed N] [--root <dir>]"
    );
    return;
  }
  const room = positional[0];
  if (parseVersion(flags.version ?? 1) === 2) {
    // v0.2 room specs may use adapter-registered metric ids; register them before the spec is validated.
    const adapterPath = path.join(flags["repo-root"] || DEFAULT_REPO_ROOT, "harness", "src", "rooms-v2", `${room}.mjs`);
    if (fs.existsSync(adapterPath)) {
      const adapter = await import(pathToFileURL(adapterPath).href);
      const defs = typeof adapter.registerMetrics === "function" ? adapter.registerMetrics() : null;
      if (defs && typeof defs === "object") registerMetrics(defs, { replace: false });
    }
  }
  const { runDir } = prepareRun({
    room,
    runId: flags["run-id"],
    renovation: flags.renovation ?? null,
    version: flags.version ?? 1,
    seed: flags.seed ?? null,
    startDir: flags["start-dir"] ?? null,
    root: flags.root || process.env.MOLBENCH_RUNS || DEFAULT_RUNS_ROOT,
    repoRoot: flags["repo-root"] || DEFAULT_REPO_ROOT
  });
  console.log(runDir);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  });
}
