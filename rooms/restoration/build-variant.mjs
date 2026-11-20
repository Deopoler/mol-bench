#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");

/**
 * All 16 4-bit bug selection tuples across [color, depth, lifecycle, view_time].
 * Seeds 1-4 (indices 0-3) cover every bug in the 8-bug pool exactly twice.
 * Seeds 5-16 (indices 4-15) cover the remaining 12 combinations deterministically.
 */
export const VARIANT_BITS_16 = Object.freeze([
  [0, 0, 0, 0], // seed 1:  B1, B2, B3, B4
  [1, 1, 1, 1], // seed 2:  B8, B6, B7, B5
  [0, 1, 0, 1], // seed 3:  B1, B6, B3, B5
  [1, 0, 1, 0], // seed 4:  B8, B2, B7, B4
  [0, 0, 1, 1], // seed 5:  B1, B2, B7, B5 (contest_seed)
  [1, 1, 0, 0], // seed 6:  B8, B6, B3, B4
  [0, 1, 1, 0], // seed 7:  B1, B6, B7, B4
  [1, 0, 0, 1], // seed 8:  B8, B2, B3, B5
  [0, 0, 0, 1], // seed 9:  B1, B2, B3, B5
  [0, 0, 1, 0], // seed 10: B1, B2, B7, B4
  [0, 1, 0, 0], // seed 11: B1, B6, B3, B4
  [1, 0, 0, 0], // seed 12: B8, B2, B3, B4
  [1, 1, 1, 0], // seed 13: B8, B6, B7, B4
  [1, 1, 0, 1], // seed 14: B8, B6, B3, B5
  [1, 0, 1, 1], // seed 15: B8, B2, B7, B5
  [0, 1, 1, 1]  // seed 16: B1, B6, B7, B5
]);

export const BUG_CATEGORIES = Object.freeze(["color", "depth", "lifecycle", "view_time"]);

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function findMulberrySeedForBits(targetBits) {
  for (let candidate = 1; candidate < 5000; candidate++) {
    const gen = mulberry32(candidate);
    let ok = true;
    for (let i = 0; i < 4; i++) {
      const bit = Math.floor(gen() * 2);
      if (bit !== targetBits[i]) {
        ok = false;
        break;
      }
    }
    if (ok) return candidate;
  }
  return 1;
}

export function createBugSelectionRng(seed) {
  const n = Number(seed) || 1;
  const idx = (((n - 1) % 16) + 16) % 16;
  const subSeed = findMulberrySeedForBits(VARIANT_BITS_16[idx]);
  const gen = mulberry32(subSeed);
  return {
    next: () => gen(),
    int: (max) => Math.floor(gen() * max)
  };
}

/**
 * Select 4 bugs following spec.json:
 * "for each category in order [color, depth, lifecycle, view_time]: pick pool[category][rng.int(2)]"
 */
export function selectBugsForSeed(seed, bugPool) {
  const rng = createBugSelectionRng(seed);
  const selected = [];
  for (const category of BUG_CATEGORIES) {
    const pool = bugPool[category];
    if (!Array.isArray(pool) || pool.length < 2) {
      throw new Error(`Invalid bug_pool category "${category}"`);
    }
    selected.push(pool[rng.int(2)]);
  }
  return selected;
}

/**
 * Parse and apply a unified diff patch file onto a base directory.
 */
export function applyUnifiedPatch(baseDir, patchText, patchLabel = "patch") {
  const normalizedPatch = patchText.replace(/\r\n/g, "\n");
  const lines = normalizedPatch.split("\n");
  let targetRelPath = null;
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith("+++ ")) {
      const rawPath = line.slice(4).trim();
      targetRelPath = rawPath.replace(/^[ab]\//, "");
      i++;
      continue;
    }
    if (line.startsWith("@@ ")) {
      if (!targetRelPath) {
        throw new Error(`Missing target path before hunk in ${patchLabel}`);
      }
      i++;
      const oldBlock = [];
      const newBlock = [];
      while (i < lines.length && !lines[i].startsWith("@@ ") && !lines[i].startsWith("--- ")) {
        const hLine = lines[i];
        if (hLine === "" && i === lines.length - 1) {
          i++;
          break;
        }
        const prefix = hLine[0];
        const body = hLine.slice(1);
        if (prefix === " ") {
          oldBlock.push(body);
          newBlock.push(body);
        } else if (prefix === "-") {
          oldBlock.push(body);
        } else if (prefix === "+") {
          newBlock.push(body);
        } else if (hLine === "\\ No newline at end of file") {
          // ignore marker
        } else if (hLine === "") {
          oldBlock.push("");
          newBlock.push("");
        }
        i++;
      }

      const filePath = path.join(baseDir, targetRelPath);
      const original = fs.readFileSync(filePath, "utf8").replace(/\r\n/g, "\n");
      const oldStr = oldBlock.join("\n");
      const newStr = newBlock.join("\n");
      const pos = original.indexOf(oldStr);
      if (pos === -1) {
        throw new Error(`Failed to apply ${patchLabel} to ${targetRelPath}: hunk context not found`);
      }
      const updated = original.slice(0, pos) + newStr + original.slice(pos + oldStr.length);
      fs.writeFileSync(filePath, updated, "utf8");
      continue;
    }
    i++;
  }
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

export function renderPromptForBugs(basePromptText, selectedBugs, rootCauseCodes = []) {
  const reportLines = selectedBugs.map((bug, idx) => {
    return [
      `${idx + 1}. **Report \`${bug.id}\`**`,
      `   - **EN:** "${bug.report.en}"`,
      `   - **KO:** "${bug.report.ko}"`
    ].join("\n");
  });
  const reportsBlock = `<!-- VISITOR_REPORTS_START -->\n${reportLines.join("\n\n")}\n<!-- VISITOR_REPORTS_END -->`;

  let out = basePromptText.replace(
    /<!-- VISITOR_REPORTS_START -->[\s\S]*?<!-- VISITOR_REPORTS_END -->/,
    reportsBlock
  );

  if (Array.isArray(rootCauseCodes) && rootCauseCodes.length > 0) {
    const codesJson = JSON.stringify(rootCauseCodes, null, 2);
    out = out.replace(/```json\s*\[\s*"COLOR_SPACE_DOUBLE_ENCODE"[\s\S]*?\]\s*```/, "```json\n" + codesJson + "\n```");
  }
  return out;
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

  const resolvedOut = path.resolve(outDir);
  const specPath = path.join(roomDir, "spec.json");
  const spec = JSON.parse(fs.readFileSync(specPath, "utf8"));
  const selectedBugs = selectBugsForSeed(numSeed, spec.bug_pool);

  const seedGenericDir = path.join(roomDir, "seed");
  const referenceDir = path.join(roomDir, "reference");
  const bugsDir = path.join(roomDir, "bugs");

  safeMkdirSync(resolvedOut);

  // 1. Copy generic seed files (.bench-room, package.json, public-tests, contract, tests/regression)
  if (fs.existsSync(seedGenericDir)) {
    copyTreeClean(seedGenericDir, resolvedOut, (srcPath, entry) => {
      if (entry.name === ".git" || entry.name === "selfcheck.json" || entry.name === "report.json") return false;
      const rel = path.relative(seedGenericDir, srcPath).replace(/\\/g, "/");
      // Generic parts only; room/ and index.html come fresh from reference/ + patches
      if (rel === "index.html" || rel === "room" || rel.startsWith("room/")) return false;
      return true;
    });
  }

  // Ensure contract/ files are always present in variant workspace
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

  // Ensure tests/regression directory exists
  safeMkdirSync(path.join(resolvedOut, "tests", "regression"));

  // 2. Copy clean reference room files
  copyTreeClean(referenceDir, resolvedOut, (_p, entry) => entry.name !== ".git");

  // 3. Apply the 4 selected bug patches onto the variant workspace
  for (const bug of selectedBugs) {
    const patchPath = path.join(bugsDir, `${bug.id}.patch`);
    if (!fs.existsSync(patchPath)) {
      throw new Error(`Missing patch file for bug ${bug.id}: ${patchPath}`);
    }
    const patchText = fs.readFileSync(patchPath, "utf8");
    applyUnifiedPatch(resolvedOut, patchText, `${bug.id}.patch`);
  }

  // 4. Write variant-specific PROMPT.md with the 4 visitor reports & public root_cause_codes
  const promptTemplatePath = path.join(roomDir, "prompt.md");
  const promptTemplate = fs.readFileSync(promptTemplatePath, "utf8");
  const promptContent = renderPromptForBugs(promptTemplate, selectedBugs, spec.root_cause_codes);
  fs.writeFileSync(path.join(resolvedOut, "PROMPT.md"), promptContent, "utf8");

  return {
    seed: numSeed,
    outDir: resolvedOut,
    plantedBugs: selectedBugs.map((b) => b.id)
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
      console.error("Usage: node rooms/restoration/build-variant.mjs <seed> [--out <outDir> | <outDir>]");
      process.exit(1);
    }
    const res = buildVariant({ seed, outDir });
    console.log(res.outDir);
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}
