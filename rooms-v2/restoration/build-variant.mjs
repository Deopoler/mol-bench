#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");

export function normalizeVariantSeed(seed) {
  const n = Number(seed) || 1;
  return (((n - 1) % 4) + 4) % 4 + 1;
}

function safeMkdirSync(dirPath) {
  const resolved = path.resolve(dirPath);
  if (fs.existsSync(resolved)) return;
  const toCreate = [];
  let cur = resolved;
  while (cur && !fs.existsSync(cur)) {
    toCreate.push(cur);
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  for (let i = toCreate.length - 1; i >= 0; i--) {
    fs.mkdirSync(toCreate[i]);
  }
}

function copyTreeClean(srcDir, dstDir, filterFn = () => true) {
  if (!fs.existsSync(srcDir)) return;
  safeMkdirSync(dstDir);
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const srcPath = path.join(srcDir, entry.name);
    const dstPath = path.join(dstDir, entry.name);
    if (!filterFn(srcPath, entry)) continue;
    if (entry.isDirectory()) {
      copyTreeClean(srcPath, dstPath, filterFn);
    } else if (entry.isFile()) {
      fs.copyFileSync(srcPath, dstPath);
    }
  }
}

export function resolveHiddenRestorationDirs(repoRoot = REPO_ROOT) {
  const hiddenRoomDir = path.join(repoRoot, "hidden-v2", "restoration");
  const referenceDir = path.join(hiddenRoomDir, "reference");
  const bugsDir = path.join(hiddenRoomDir, "bugs");
  const gradePath = path.join(hiddenRoomDir, "grade.json");
  if (!fs.existsSync(referenceDir) || !fs.existsSync(bugsDir) || !fs.existsSync(gradePath)) {
    throw new Error(
      `Missing hidden-v2/restoration assets (${referenceDir}, ${bugsDir}, or ${gradePath}). ` +
        `Building restoration variants or mutants requires hidden-v2/restoration/ to be present.`
    );
  }
  const grade = JSON.parse(fs.readFileSync(gradePath, "utf8"));
  const patchesPath = path.join(bugsDir, "patches.json");
  const patches = fs.existsSync(patchesPath) ? JSON.parse(fs.readFileSync(patchesPath, "utf8")) : null;
  return { hiddenRoomDir, referenceDir, bugsDir, grade, patches };
}

export function buildFlatBugMap(bugPool, bugModules = {}) {
  const map = new Map();
  if (!bugPool || typeof bugPool !== "object") return map;
  for (const [category, list] of Object.entries(bugPool)) {
    for (const bug of list || []) {
      map.set(bug.id, {
        ...bug,
        category,
        module: bug.module || bugModules[bug.id] || `room/src/modules/${category}.js`
      });
    }
  }
  return map;
}

export function selectBugsForSeed(seed, bugPoolOrGrade, repoRoot = REPO_ROOT) {
  const normSeed = normalizeVariantSeed(seed);
  let grade = null;
  let bugPool = bugPoolOrGrade;
  if (bugPoolOrGrade && bugPoolOrGrade.variants && bugPoolOrGrade.bug_pool) {
    grade = bugPoolOrGrade;
    bugPool = grade.bug_pool;
  } else {
    ({ grade } = resolveHiddenRestorationDirs(repoRoot));
    if (!bugPool) bugPool = grade.bug_pool;
  }
  const ids = grade.variants[String(normSeed)];
  if (!Array.isArray(ids)) {
    throw new Error(`Missing variant definition for seed ${normSeed} in hidden-v2/restoration/grade.json`);
  }
  const silentSet = new Set(grade.variant_silent?.[String(normSeed)] || []);
  const bugMap = buildFlatBugMap(bugPool, grade.bug_modules || {});
  let reportCounter = 0;
  return ids.map((id) => {
    const bug = bugMap.get(id);
    if (!bug) {
      throw new Error(`Missing bug definition "${id}" in bug_pool`);
    }
    const isSilent = Boolean(bug.silent || silentSet.has(id));
    const reportId = isSilent ? null : `R${++reportCounter}`;
    return {
      ...bug,
      silent: isSilent,
      prompt_report_id: reportId
    };
  });
}

/**
 * Render visitor/curator notes ONLY for non-silent bugs using opaque sequential IDs (R1, R2, ...).
 * Never names module filenames, root_cause codes, or the total bug count.
 */
export function renderPromptForBugs(basePromptText, selectedBugs, rootCauseCodes = []) {
  if (!Array.isArray(selectedBugs) || selectedBugs.length === 0) {
    throw new Error(`Expected non-empty selectedBugs for v0.2 restoration, got ${selectedBugs?.length}`);
  }
  const reportedBugs = selectedBugs.filter((b) => !b.silent && b.report);
  const notes = reportedBugs.map((bug, idx) => {
    const rid = bug.prompt_report_id || `R${idx + 1}`;
    const heading = bug.report.title ? ` — ${bug.report.title}` : "";
    return [
      `${idx + 1}. **Visitor / Curator Note \`${rid}\`${heading}**`,
      `   - **EN:** "${bug.report.en}"`,
      `   - **KO:** "${bug.report.ko}"`
    ].join("\n");
  });

  const reportsBlock = `<!-- VISITOR_REPORTS_START -->\n${notes.join("\n\n")}\n<!-- VISITOR_REPORTS_END -->`;

  let out = basePromptText.replace(
    /<!-- VISITOR_REPORTS_START -->[\s\S]*?<!-- VISITOR_REPORTS_END -->/,
    reportsBlock
  );

  if (Array.isArray(rootCauseCodes) && rootCauseCodes.length > 0) {
    const codesJson = JSON.stringify(rootCauseCodes, null, 2);
    out = out.replace(/```json\s*\[\s*"[A-Z0-9_]+"[\s\S]*?\]\s*```/, "```json\n" + codesJson + "\n```");
  }
  return out;
}

/**
 * Apply a single bug onto a target workspace directory.
 * Prefers composable hunk replacements from hidden-v2/restoration/bugs/patches.json so multiple bugs
 * sharing a file compose deterministically; falls back to full-file replacement if patches.json is absent.
 */
export function applyBugModuleReplacement(
  targetDir,
  bugId,
  bugsDir = null,
  repoRoot = REPO_ROOT
) {
  const { bugsDir: resolvedBugsDir, grade, patches } = resolveHiddenRestorationDirs(repoRoot);
  const actualBugsDir = bugsDir || resolvedBugsDir;
  const targetRelModule = patches?.[bugId]?.file || grade.bug_modules?.[bugId];
  if (!targetRelModule) {
    throw new Error(`Unknown bugId "${bugId}" for bug application`);
  }
  const dstPath = path.join(targetDir, targetRelModule);
  safeMkdirSync(path.dirname(dstPath));

  if (patches && patches[bugId] && Array.isArray(patches[bugId].replacements) && fs.existsSync(dstPath)) {
    let src = fs.readFileSync(dstPath, "utf8").replace(/\r\n/g, "\n");
    for (const rep of patches[bugId].replacements) {
      if (!src.includes(rep.find)) {
        throw new Error(`Composable patch ${bugId} target snippet not found in ${targetRelModule}`);
      }
      src = src.replace(rep.find, rep.replace);
    }
    fs.writeFileSync(dstPath, src, "utf8");
    return dstPath;
  }

  const bugFileSrc = path.join(actualBugsDir, `${bugId}.js`);
  if (!fs.existsSync(bugFileSrc)) {
    throw new Error(`Missing buggy module source file for ${bugId}: ${bugFileSrc}`);
  }
  fs.copyFileSync(bugFileSrc, dstPath);
  return dstPath;
}

/**
 * Build a single-bug mutant directory from clean hidden-v2/restoration/reference.
 */
export function buildSingleBugMutant({
  bugId,
  outDir,
  repoRoot = REPO_ROOT
}) {
  const { referenceDir, bugsDir, grade, patches } = resolveHiddenRestorationDirs(repoRoot);
  const resolvedOut = path.resolve(outDir);
  safeMkdirSync(resolvedOut);
  copyTreeClean(referenceDir, resolvedOut, (_p, entry) => entry.name !== ".git");
  const replacedPath = applyBugModuleReplacement(resolvedOut, bugId, bugsDir, repoRoot);
  return {
    bugId,
    module: patches?.[bugId]?.file || grade.bug_modules?.[bugId],
    outDir: resolvedOut,
    replacedPath
  };
}

export function buildVariant({
  seed,
  outDir,
  roomDir = __dirname,
  repoRoot = REPO_ROOT
}) {
  const numSeed = Number(seed);
  if (!Number.isInteger(numSeed)) {
    throw new Error(`Invalid seed "${seed}" (expected integer)`);
  }
  if (!outDir) {
    throw new Error("Missing output directory for build-variant");
  }

  const { referenceDir, bugsDir, grade } = resolveHiddenRestorationDirs(repoRoot);
  const resolvedOut = path.resolve(outDir);
  const specPath = path.join(roomDir, "spec.json");
  const spec = JSON.parse(fs.readFileSync(specPath, "utf8"));
  const selectedBugs = selectBugsForSeed(numSeed, grade, repoRoot);

  const seedGenericDir = path.join(roomDir, "seed");

  safeMkdirSync(resolvedOut);

  // 1. Copy generic seed files (.bench-room, package.json, public-tests, contract, tests/regression)
  if (fs.existsSync(seedGenericDir)) {
    copyTreeClean(seedGenericDir, resolvedOut, (srcPath, entry) => {
      if (entry.name === ".git" || entry.name === "selfcheck.json" || entry.name === "report.json") return false;
      const rel = path.relative(seedGenericDir, srcPath).replace(/\\/g, "/");
      if (rel === "index.html" || rel === "room" || rel.startsWith("room/") || rel === "bench" || rel.startsWith("bench/")) {
        return false;
      }
      return true;
    });
  }

  // Ensure contract/ files are always present
  const contractDst = path.join(resolvedOut, "contract");
  safeMkdirSync(contractDst);
  const benchDtsSrc = path.join(repoRoot, "contract", "bench.d.ts");
  if (fs.existsSync(benchDtsSrc)) {
    fs.copyFileSync(benchDtsSrc, path.join(contractDst, "bench.d.ts"));
  }
  const reportSchemaSrc = path.join(repoRoot, "schemas", "report.schema.json");
  if (fs.existsSync(reportSchemaSrc)) {
    fs.copyFileSync(reportSchemaSrc, path.join(contractDst, "report.schema.json"));
  }

  safeMkdirSync(path.join(resolvedOut, "tests", "regression"));

  // 2. Copy clean reference room files from hidden-v2/restoration/reference
  copyTreeClean(referenceDir, resolvedOut, (_p, entry) => entry.name !== ".git");

  // 3. Apply all selected bugs composably (supports multiple bugs sharing a file)
  for (const bug of selectedBugs) {
    applyBugModuleReplacement(resolvedOut, bug.id, bugsDir, repoRoot);
  }

  // 4. Write variant-specific PROMPT.md and authoritative .run.json
  const promptTemplatePath = path.join(roomDir, "prompt.md");
  const promptTemplate = fs.readFileSync(promptTemplatePath, "utf8");
  const promptContent = renderPromptForBugs(promptTemplate, selectedBugs, spec.root_cause_codes);
  fs.writeFileSync(path.join(resolvedOut, "PROMPT.md"), promptContent, "utf8");
  fs.writeFileSync(
    path.join(resolvedOut, ".run.json"),
    JSON.stringify({ room: "restoration", version: 2, seed: numSeed }, null, 2) + "\n",
    "utf8"
  );

  return {
    seed: numSeed,
    variantSeed: normalizeVariantSeed(numSeed),
    outDir: resolvedOut,
    plantedBugs: selectedBugs.map((b) => b.id),
    silentBugs: selectedBugs.filter((b) => b.silent).map((b) => b.id)
  };
}

function parseCliArgs(argv) {
  const positional = [];
  let outDir = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--out" || arg === "-o") {
      outDir = argv[++i];
    } else if (arg.startsWith("--out=")) {
      outDir = arg.slice("--out=".length);
    } else if (!arg.startsWith("-")) {
      positional.push(arg);
    }
  }
  const seed = positional[0];
  if (!outDir && positional.length >= 2) {
    outDir = positional[1];
  }
  return { seed, outDir };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const { seed, outDir } = parseCliArgs(process.argv.slice(2));
    if (seed === undefined || !outDir) {
      console.error("Usage: node rooms-v2/restoration/build-variant.mjs <seed> [--out <outDir> | <outDir>]");
      process.exit(1);
    }
    const res = buildVariant({ seed, outDir });
    console.log(res.outDir);
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}
