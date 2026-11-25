import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const EXCLUDED_DIRS = new Set(["tests", "public-tests", "node_modules", ".venv", "bench", "metrics", ".git", "out"]);
const EXCLUDED_FILES = new Set(["report.json", "decisions.json"]);
// v0.2 root-only harness artifacts (never excluded in nested paths so submissions cannot hide edits in src/work/ etc.)
const ROOT_WORKSPACE_ARTIFACT_DIRS = new Set(["preview", "work"]);
const ROOT_WORKSPACE_ARTIFACT_FILES = new Set([".run.json", "selfcheck.json", ".bench-room"]);
const HARNESS_CACHE_PREFIXES = ["metrics/", "bench/", "harness/blender/", "metrics3d/", ".venv/"];
const KNOWN_PYTEST_CACHE_SUFFIXES = new Set([
  ".pytest_cache/README.md",
  ".pytest_cache/.gitignore",
  ".pytest_cache/CACHEDIR.TAG",
  ".pytest_cache/v/cache/nodeids",
  ".pytest_cache/v/cache/lastfailed",
  ".pytest_cache/v/cache/stepwise"
]);

/**
 * Returns true ONLY for exact harness-produced cache files:
 * - known metadata files inside root or harness-dir `.pytest_cache/`
 * - `*.pyc` files directly inside `__pycache__/` at root or under harness-owned prefixes
 */
export function isKnownHarnessCacheFile(relPath) {
  const norm = String(relPath || "").replace(/\\/g, "/").replace(/^\.\//, "");
  if (!norm) return false;
  let sub = norm;
  const matchedPrefix = HARNESS_CACHE_PREFIXES.find((p) => norm.startsWith(p));
  if (matchedPrefix) {
    sub = norm.slice(matchedPrefix.length);
  } else if (norm.includes("/") && !norm.startsWith("__pycache__/") && !norm.startsWith(".pytest_cache/")) {
    return false;
  }
  if (KNOWN_PYTEST_CACHE_SUFFIXES.has(sub)) return true;
  const dir = path.posix.dirname(sub);
  const base = path.posix.basename(sub);
  if (path.posix.basename(dir) === "__pycache__" && base.endsWith(".pyc")) {
    return true;
  }
  return false;
}
const BINARY_EXTS = new Set([".png", ".glb", ".blend", ".jpg", ".jpeg", ".gif", ".webp", ".mp4", ".webm", ".woff", ".woff2", ".ttf", ".otf", ".ico", ".pdf", ".zip"]);

function included(rel, excludeWorkspaceArtifacts = false) {
  const parts = rel.replace(/\\/g, "/").split("/");
  const baseName = parts.at(-1);
  if (parts.some((p) => EXCLUDED_DIRS.has(p))) return false;
  if (EXCLUDED_FILES.has(baseName)) return false;
  if (excludeWorkspaceArtifacts) {
    if (parts.length > 1 && ROOT_WORKSPACE_ARTIFACT_DIRS.has(parts[0])) return false;
    if (parts.length === 1 && ROOT_WORKSPACE_ARTIFACT_FILES.has(baseName)) return false;
  }
  return !BINARY_EXTS.has(path.extname(rel).toLowerCase());
}

function walk(root, base = root, out = new Map(), excludeWorkspaceArtifacts = false) {
  const isRoot = root === base;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    const rel = path.relative(base, full).replace(/\\/g, "/");
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRS.has(entry.name)) continue;
      if (excludeWorkspaceArtifacts && isRoot && ROOT_WORKSPACE_ARTIFACT_DIRS.has(entry.name)) continue;
      walk(full, base, out, excludeWorkspaceArtifacts);
    } else if (entry.isFile() && included(rel, excludeWorkspaceArtifacts)) {
      out.set(rel, fs.readFileSync(full, "utf8").split(/\r?\n/));
    }
  }
  return out;
}

// Myers shortest edit script; returns line additions and removals deterministically.
export function lineDiff(a, b) {
  const n = a.length, m = b.length, max = n + m;
  let v = new Map([[1, 0]]);
  const trace = [];
  for (let d = 0; d <= max; d++) {
    trace.push(new Map(v));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && (v.get(k - 1) ?? -1) < (v.get(k + 1) ?? -1)) ? (v.get(k + 1) ?? 0) : (v.get(k - 1) ?? 0) + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x++; y++; }
      v.set(k, x);
      if (x >= n && y >= m) {
        let adds = 0, removes = 0, cx = n, cy = m;
        for (let td = trace.length - 1; td >= 0; td--) {
          const tv = trace[td], ck = cx - cy;
          const pk = ck === -td || (ck !== td && (tv.get(ck - 1) ?? -1) < (tv.get(ck + 1) ?? -1)) ? ck + 1 : ck - 1;
          const px = td === 0 ? 0 : (tv.get(pk) ?? 0), py = px - pk;
          while (cx > px && cy > py) { cx--; cy--; }
          if (td > 0) { if (cx === px) { adds++; cy--; } else { removes++; cx--; } }
        }
        return { added: adds, removed: removes };
      }
    }
  }
  return { added: m, removed: n };
}

export function compareSourceTrees(startDir, submissionDir, opts = {}) {
  const excludeWorkspaceArtifacts = Boolean(opts.excludeWorkspaceArtifacts);
  if (!startDir || !fs.existsSync(startDir) || !fs.statSync(startDir).isDirectory()) throw new Error(`start source directory unavailable: ${startDir || "not provided"}`);
  if (!submissionDir || !fs.existsSync(submissionDir) || !fs.statSync(submissionDir).isDirectory()) throw new Error(`submission directory unavailable: ${submissionDir || "not provided"}`);
  const start = walk(startDir, startDir, new Map(), excludeWorkspaceArtifacts);
  const submission = walk(submissionDir, submissionDir, new Map(), excludeWorkspaceArtifacts);
  const files = [...new Set([...start.keys(), ...submission.keys()])].sort();
  const changedFiles = [];
  let added = 0, removed = 0, changedStartLines = 0, startLines = 0;
  for (const file of files) {
    const a = start.get(file), b = submission.get(file);
    if (a) startLines += a.filter((line) => line.length > 0).length;
    const diff = lineDiff(a || [], b || []);
    added += diff.added; removed += diff.removed;
    changedStartLines += diff.removed;
    if (diff.added || diff.removed) changedFiles.push(file);
  }
  return { added, removed, changedStartLines, startLines, changedFiles };
}

/**
 * Build a sha256 manifest of all non-cache files inside `.venv` (relative paths `.venv/...`).
 */
export function buildVenvManifest(venvDir) {
  const manifest = {};
  if (!venvDir || !fs.existsSync(venvDir)) return manifest;
  const walkVenv = (dir, relBase = ".venv") => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      const rel = `${relBase}/${ent.name}`;
      if (ent.isDirectory()) {
        walkVenv(full, rel);
      } else if (ent.isFile()) {
        if (isKnownHarnessCacheFile(rel)) continue;
        manifest[rel] = crypto.createHash("sha256").update(fs.readFileSync(full)).digest("hex");
      }
    }
  };
  walkVenv(venvDir);
  return manifest;
}

export function readRunVenvManifest(dir) {
  if (!dir) return null;
  const p = path.join(dir, ".run.json");
  if (!fs.existsSync(p)) return null;
  try {
    const meta = JSON.parse(fs.readFileSync(p, "utf8"));
    return meta && typeof meta.venv_manifest === "object" && meta.venv_manifest !== null ? meta.venv_manifest : null;
  } catch {
    return null;
  }
}

export function compareAllFiles(startDir, submissionDir, opts = {}) {
  const excludeWorkspaceArtifacts = Boolean(opts.excludeWorkspaceArtifacts);
  const repoRoot = opts.repoRoot ? path.resolve(opts.repoRoot) : null;
  if (!startDir || !fs.existsSync(startDir) || !fs.statSync(startDir).isDirectory()) throw new Error(`start source directory unavailable: ${startDir || "not provided"}`);
  const venvManifest = excludeWorkspaceArtifacts
    ? (readRunVenvManifest(startDir) || readRunVenvManifest(submissionDir))
    : null;
  const collect = (dir, base = dir, result = new Set()) => {
    const isRoot = dir === base;
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ent.name === ".git" || ent.name === "node_modules") continue;
      if (excludeWorkspaceArtifacts && isRoot && ent.isDirectory() && ROOT_WORKSPACE_ARTIFACT_DIRS.has(ent.name)) continue;
      if (excludeWorkspaceArtifacts && isRoot && ent.isFile() && ROOT_WORKSPACE_ARTIFACT_FILES.has(ent.name)) continue;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        collect(full, base, result);
      } else if (ent.isFile()) {
        const rel = path.relative(base, full).replace(/\\/g, "/");
        if (excludeWorkspaceArtifacts && isKnownHarnessCacheFile(rel)) continue;
        result.add(rel);
      }
    }
    return result;
  };
  const a = collect(startDir), b = collect(submissionDir);
  return [...new Set([...a, ...b])]
    .filter((file) => {
      if (excludeWorkspaceArtifacts && file.startsWith(".venv/") && !a.has(file) && b.has(file)) {
        const subFile = path.join(submissionDir, file);
        if (venvManifest) {
          if (Object.hasOwn(venvManifest, file)) {
            try {
              const sha = crypto.createHash("sha256").update(fs.readFileSync(subFile)).digest("hex");
              if (sha === venvManifest[file]) return false;
            } catch {
              // fall through -> treat as changed
            }
          }
          return true;
        }
        if (repoRoot) {
          const canonical = path.join(repoRoot, file);
          try {
            const stC = fs.statSync(canonical);
            const stS = fs.statSync(subFile);
            if (stC.isFile() && stS.isFile() && stC.size === stS.size && fs.readFileSync(subFile).equals(fs.readFileSync(canonical))) {
              return false;
            }
          } catch {
            // fall through -> treat as changed
          }
        }
      }
      return a.has(file) !== b.has(file) || (a.has(file) && fs.readFileSync(path.join(startDir, file)).equals(fs.readFileSync(path.join(submissionDir, file)))) === false;
    })
    .sort();
}

export function computeDiffMetrics({ startDir, submissionDir, denominator, excludeWorkspaceArtifacts = false }) {
  const diff = compareSourceTrees(startDir, submissionDir, { excludeWorkspaceArtifacts });
  if (!(Number(denominator) > 0)) throw new Error("diff denominator unavailable or not positive");
  return {
    ...diff,
    change_ratio: (diff.added + diff.removed) / Number(denominator),
    rewrite: diff.startLines > 0 ? diff.changedStartLines / diff.startLines < 0.6 : diff.changedStartLines === 0,
  };
}

export function countPatchLines(patchPath) {
  const text = fs.readFileSync(patchPath, "utf8");
  return text.split(/\r?\n/).filter((line) => (line.startsWith("+") && !line.startsWith("+++")) || (line.startsWith("-") && !line.startsWith("---"))).length;
}
