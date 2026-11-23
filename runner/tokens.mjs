#!/usr/bin/env node
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = path.resolve(__dirname, "..");
const DEFAULT_RUNS_ROOT = path.join(os.homedir(), "molbench-runs");

export function getClaudeDir() {
  return process.env.MOLBENCH_CLAUDE_DIR || path.join(os.homedir(), ".claude");
}

export function getCodexDir() {
  return process.env.MOLBENCH_CODEX_DIR || path.join(os.homedir(), ".codex");
}

export function getGeminiDir() {
  return process.env.MOLBENCH_GEMINI_DIR || path.join(os.homedir(), ".gemini");
}

export function encodeClaudeProjectPath(targetPath) {
  // Replaces ':', '\', '/', '_', and '.' with '-'
  // e.g. C:\Users\x\molbench-runs\lobby__claude-haiku-5.5-max -> C--Users-x-molbench-runs-lobby--claude-haiku-5-5-max
  const resolved = path.resolve(targetPath);
  return resolved.replace(/[:\\/_.]/g, "-");
}

function normalizePath(p) {
  return path.resolve(p).toLowerCase().replace(/\\/g, "/");
}

function findFilesRecursive(dir, filterFn) {
  const results = [];
  if (!fs.existsSync(dir)) return results;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findFilesRecursive(full, filterFn));
    } else if (entry.isFile() && filterFn(entry.name, full)) {
      results.push(full);
    }
  }
  return results;
}

function isWithinWindow(timeMs, startMs, endMs, bufferMs = 5 * 60 * 1000) {
  if (Number.isFinite(startMs) && timeMs < startMs - bufferMs) return false;
  if (Number.isFinite(endMs) && timeMs > endMs + bufferMs) return false;
  return true;
}

function parseTimestampValue(val) {
  if (val === null || val === undefined) return null;
  if (typeof val === "number") {
    if (!Number.isFinite(val) || val <= 0) return null;
    return val < 1e12 ? val * 1000 : val;
  }
  if (typeof val === "string") {
    const trimmed = val.trim();
    if (!trimmed) return null;
    if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
      const num = Number(trimmed);
      if (!Number.isFinite(num) || num <= 0) return null;
      return num < 1e12 ? num * 1000 : num;
    }
    const parsed = Date.parse(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function extractEventTimestampMs(obj) {
  if (!obj || typeof obj !== "object") return null;
  const candidates = [
    obj.timestamp,
    obj.created_at,
    obj.ts,
    obj.time,
    obj.message?.timestamp,
    obj.payload?.timestamp,
    obj.payload?.created_at,
    obj.step?.timestamp,
    obj.snapshot?.timestamp,
    obj.metadata?.timestamp
  ];
  for (const c of candidates) {
    const ms = parseTimestampValue(c);
    if (ms !== null) return ms;
  }
  return null;
}

function collectClaudeSessionFile(filePath, seenMsgIds) {
  let input = 0;
  let output = 0;
  let cache_read = 0;
  let cache_write = 0;
  let reasoning = 0;
  const timestamps = [];

  const content = fs.readFileSync(filePath, "utf8");
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    const ts = extractEventTimestampMs(obj);
    if (ts !== null) timestamps.push(ts);

    const msg = obj.message || (obj.type === "assistant" ? obj : null);
    if (msg) {
      if (msg.id) {
        if (seenMsgIds.has(msg.id)) continue;
        seenMsgIds.add(msg.id);
      }
      const usage = msg.usage || obj.usage;
      if (usage) {
        input += usage.input_tokens || 0;
        output += usage.output_tokens || 0;
        cache_read += usage.cache_read_input_tokens || 0;
        cache_write += usage.cache_creation_input_tokens || 0;
        reasoning += usage.reasoning_tokens || usage.reasoning_output_tokens || 0;
      }
    } else if (obj.usage) {
      input += obj.usage.input_tokens || 0;
      output += obj.usage.output_tokens || 0;
      cache_read += obj.usage.cache_read_input_tokens || 0;
      cache_write += obj.usage.cache_creation_input_tokens || 0;
      reasoning += obj.usage.reasoning_tokens || obj.usage.reasoning_output_tokens || 0;
    }
  }

  return { input, output, cache_read, cache_write, reasoning, timestamps };
}

function scanClaudeTokens({ runDir, claudeDir = getClaudeDir(), startedAt = null, endedAt = null }) {
  const encoded = encodeClaudeProjectPath(runDir);
  const projDir = path.join(claudeDir, "projects", encoded);
  if (!fs.existsSync(projDir)) return { tokens: null, timestamps: [] };

  const entries = fs.readdirSync(projDir, { withFileTypes: true });
  const jsonlFiles = entries
    .filter((e) => e.isFile() && e.name.endsWith(".jsonl"))
    .map((e) => path.join(projDir, e.name));
  if (jsonlFiles.length === 0) return { tokens: null, timestamps: [] };

  const seenMsgIds = new Set();
  let input = 0;
  let output = 0;
  let cache_read = 0;
  let cache_write = 0;
  let reasoning = 0;
  let matchingSessions = 0;
  const timestamps = [];

  for (const file of jsonlFiles) {
    const res = collectClaudeSessionFile(file, seenMsgIds);
    input += res.input;
    output += res.output;
    cache_read += res.cache_read;
    cache_write += res.cache_write;
    reasoning += res.reasoning;
    timestamps.push(...res.timestamps);
    matchingSessions++;
  }

  if (matchingSessions === 0) return { tokens: null, timestamps: [] };

  const total = input + output + cache_read + cache_write + reasoning;
  return {
    tokens: {
      source: "claude",
      sessions: matchingSessions,
      input,
      output,
      cache_read,
      cache_write,
      reasoning,
      total
    },
    timestamps
  };
}

export function collectClaudeTokens(opts) {
  return scanClaudeTokens(opts).tokens;
}

function scanCodexTokens({ runDir, codexDir = getCodexDir(), startedAt = null, endedAt = null }) {
  const sessionsDir = path.join(codexDir, "sessions");
  if (!fs.existsSync(sessionsDir)) return { tokens: null, timestamps: [] };

  const files = findFilesRecursive(sessionsDir, (name) => name.startsWith("rollout-") && name.endsWith(".jsonl"));
  if (files.length === 0) return { tokens: null, timestamps: [] };

  const targetNorm = normalizePath(runDir);
  const normRunDirBack = path.resolve(runDir);
  const normRunDirSlash = normRunDirBack.replace(/\\/g, "/");

  let sessionCount = 0;
  let input = 0;
  let output = 0;
  let cache_read = 0;
  let cache_write = 0;
  let reasoning = 0;
  let total = 0;
  const timestamps = [];

  for (const file of files) {
    const content = fs.readFileSync(file, "utf8");
    const normRunDirEscaped = normRunDirBack.replace(/\\/g, "\\\\");
    if (!content.includes(normRunDirBack) && !content.includes(normRunDirSlash) && !content.includes(normRunDirEscaped)) {
      continue;
    }

    let fileMatches = false;
    let lastUsage = null;
    const fileTimestamps = [];

    for (const line of content.split(/\r?\n/)) {
      if (!line.trim()) continue;
      let obj;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }

      const ts = extractEventTimestampMs(obj);
      if (ts !== null) fileTimestamps.push(ts);

      const cwd = obj.payload?.cwd || obj.cwd;
      if (cwd && normalizePath(cwd) === targetNorm) {
        fileMatches = true;
      }

      const usage = obj.payload?.info?.total_token_usage || obj.payload?.total_token_usage || obj.total_token_usage;
      if (usage && typeof usage === "object") {
        lastUsage = usage;
      }
    }

    if (!fileMatches && (content.includes(normRunDirBack) || content.includes(normRunDirSlash))) {
      fileMatches = true;
    }

    if (!fileMatches) continue;
    timestamps.push(...fileTimestamps);
    if (!lastUsage) continue;

    sessionCount++;
    input += lastUsage.input_tokens || 0;
    output += lastUsage.output_tokens || 0;
    cache_read += lastUsage.cached_input_tokens ?? 0;
    cache_write += lastUsage.cache_write_input_tokens ?? 0;
    reasoning += lastUsage.reasoning_output_tokens ?? 0;
    total += lastUsage.total_tokens ?? ((lastUsage.input_tokens || 0) + (lastUsage.output_tokens || 0));
  }

  return {
    tokens: sessionCount === 0
      ? null
      : {
          source: "codex",
          sessions: sessionCount,
          input,
          output,
          cache_read,
          cache_write,
          reasoning,
          total
        },
    timestamps
  };
}

export function collectCodexTokens(opts) {
  return scanCodexTokens(opts).tokens;
}

function scanAgyTokens({ runDir, geminiDir = getGeminiDir(), startedAt = null, endedAt = null }) {
  const brainDir = path.join(geminiDir, "antigravity-cli", "brain");
  if (!fs.existsSync(brainDir)) return { tokens: null, timestamps: [] };

  const normRunDirBack = path.resolve(runDir);
  const normRunDirSlash = normRunDirBack.replace(/\\/g, "/");

  const brainEntries = fs.readdirSync(brainDir, { withFileTypes: true });
  let sessionCount = 0;
  let input = 0;
  let output = 0;
  let cache_read = 0;
  let cache_write = 0;
  let reasoning = 0;
  let total = 0;
  const timestamps = [];

  for (const entry of brainEntries) {
    if (!entry.isDirectory()) continue;
    const fullLog = path.join(brainDir, entry.name, ".system_generated", "logs", "transcript_full.jsonl");
    if (!fs.existsSync(fullLog)) continue;

    const content = fs.readFileSync(fullLog, "utf8");
    const normRunDirEscaped = normRunDirBack.replace(/\\/g, "\\\\");
    const matchesRunDir =
      process.platform === "win32"
        ? (() => {
            const lc = content.toLowerCase();
            return (
              lc.includes(normRunDirBack.toLowerCase()) ||
              lc.includes(normRunDirSlash.toLowerCase()) ||
              lc.includes(normRunDirEscaped.toLowerCase())
            );
          })()
        : content.includes(normRunDirBack) || content.includes(normRunDirSlash) || content.includes(normRunDirEscaped);
    if (!matchesRunDir) {
      continue;
    }

    let fileHasUsage = false;
    for (const line of content.split(/\r?\n/)) {
      if (!line.trim()) continue;
      let obj;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }

      const ts = extractEventTimestampMs(obj);
      if (ts !== null) timestamps.push(ts);

      function walk(node) {
        if (!node || typeof node !== "object") return;
        if (typeof node.input_tokens === "number" || typeof node.output_tokens === "number") {
          fileHasUsage = true;
          const reas =
            typeof node.reasoning_tokens === "number"
              ? node.reasoning_tokens
              : typeof node.reasoning_output_tokens === "number"
                ? node.reasoning_output_tokens
                : typeof node.thinking_tokens === "number"
                  ? node.thinking_tokens
                  : typeof node.thought_tokens === "number"
                    ? node.thought_tokens
                    : typeof node.thoughts_token_count === "number"
                      ? node.thoughts_token_count
                      : 0;
          input += node.input_tokens || 0;
          output += node.output_tokens || 0;
          cache_read += node.cached_tokens ?? node.cache_read_tokens ?? node.cache_read_input_tokens ?? 0;
          cache_write += node.cache_write_input_tokens ?? node.cache_write_tokens ?? 0;
          reasoning += reas;
          total += node.total_tokens ?? ((node.input_tokens || 0) + (node.output_tokens || 0) + reas);
          return;
        }
        for (const k of Object.keys(node)) {
          walk(node[k]);
        }
      }
      walk(obj);
    }

    if (fileHasUsage) {
      sessionCount++;
    }
  }

  return {
    tokens: sessionCount === 0
      ? null
      : {
          source: "agy",
          sessions: sessionCount,
          input,
          output,
          cache_read,
          cache_write,
          reasoning,
          total
        },
    timestamps
  };
}

export function collectAgyTokens(opts) {
  return scanAgyTokens(opts).tokens;
}

function matchesOrchestraTarget(targetPath, runDir, runsRoot) {
  const normTarget = normalizePath(targetPath);
  const normRunDir = normalizePath(runDir);
  const normRunsRoot = normalizePath(runsRoot);

  if (!normTarget.startsWith(normRunsRoot)) return false;
  if (normTarget === normRunDir || normTarget.startsWith(normRunDir + "/")) return true;

  const rel = normTarget.slice(normRunsRoot.length).replace(/^\/+/, "");
  const firstSeg = rel.split("/")[0];
  if (firstSeg.startsWith("wt-")) return true;

  return false;
}

function scanOrchestraTokens({
  runDir,
  runsRoot = DEFAULT_RUNS_ROOT,
  startedAt = null,
  endedAt = null,
  claudeDir = getClaudeDir(),
  codexDir = getCodexDir(),
  geminiDir = getGeminiDir()
}) {
  const startMs = startedAt ? Date.parse(startedAt) : -Infinity;
  const endMs = endedAt ? Date.parse(endedAt) : Infinity;

  const breakdown = {
    claude: { source: "claude", sessions: 0, input: 0, output: 0, cache_read: 0, cache_write: 0, reasoning: 0, total: 0 },
    codex: { source: "codex", sessions: 0, input: 0, output: 0, cache_read: 0, cache_write: 0, reasoning: 0, total: 0 },
    agy: { source: "agy", sessions: 0, input: 0, output: 0, cache_read: 0, cache_write: 0, reasoning: 0, total: 0 }
  };
  const timestamps = [];

  // 1. Claude: conductor transcripts for runDir + any sibling wt-* projects
  const claudeProjectsDir = path.join(claudeDir, "projects");
  if (fs.existsSync(claudeProjectsDir)) {
    const encodedRunsRoot = encodeClaudeProjectPath(runsRoot);
    const encodedRunDir = encodeClaudeProjectPath(runDir);
    const seenMsgIds = new Set();

    const projEntries = fs.readdirSync(claudeProjectsDir, { withFileTypes: true });
    for (const p of projEntries) {
      if (!p.isDirectory()) continue;
      const projName = p.name;
      const isRunProj = projName === encodedRunDir || projName.startsWith(encodedRunDir + "-");
      const isWtProj = projName.startsWith(encodedRunsRoot + "-wt-");
      if (!isRunProj && !isWtProj) continue;

      const fullProjDir = path.join(claudeProjectsDir, projName);
      const jsonlFiles = fs
        .readdirSync(fullProjDir, { withFileTypes: true })
        .filter((e) => e.isFile() && e.name.endsWith(".jsonl"))
        .map((e) => path.join(fullProjDir, e.name));

      for (const file of jsonlFiles) {
        if (startedAt || endedAt) {
          const checkTime = fs.statSync(file).mtimeMs;
          if (!isWithinWindow(checkTime, startMs, endMs)) continue;
        }
        const res = collectClaudeSessionFile(file, seenMsgIds);
        breakdown.claude.sessions++;
        breakdown.claude.input += res.input;
        breakdown.claude.output += res.output;
        breakdown.claude.cache_read += res.cache_read;
        breakdown.claude.cache_write += res.cache_write;
        breakdown.claude.reasoning += res.reasoning;
        timestamps.push(...res.timestamps);
      }
    }
    breakdown.claude.total =
      breakdown.claude.input +
      breakdown.claude.output +
      breakdown.claude.cache_read +
      breakdown.claude.cache_write +
      breakdown.claude.reasoning;
  }

  // 2. Codex: sessions with cwd inside runsRoot matching runDir or wt-*
  const codexSessionsDir = path.join(codexDir, "sessions");
  if (fs.existsSync(codexSessionsDir)) {
    const files = findFilesRecursive(codexSessionsDir, (name) => name.startsWith("rollout-") && name.endsWith(".jsonl"));
    for (const file of files) {
      const content = fs.readFileSync(file, "utf8");
      let targetCwd = null;
      let lastUsage = null;
      let fileTimestamp = null;
      const fileTimestamps = [];

      for (const line of content.split(/\r?\n/)) {
        if (!line.trim()) continue;
        let obj;
        try {
          obj = JSON.parse(line);
        } catch {
          continue;
        }

        const ts = extractEventTimestampMs(obj);
        if (ts !== null) {
          fileTimestamp = ts;
          fileTimestamps.push(ts);
        }

        const cwd = obj.payload?.cwd || obj.cwd;
        if (cwd) targetCwd = cwd;

        const usage = obj.payload?.info?.total_token_usage || obj.payload?.total_token_usage || obj.total_token_usage;
        if (usage && typeof usage === "object") {
          lastUsage = usage;
        }
      }

      if (!targetCwd) continue;
      if (!matchesOrchestraTarget(targetCwd, runDir, runsRoot)) continue;

      const checkTime = fileTimestamp || fs.statSync(file).mtimeMs;
      if (startedAt || endedAt) {
        if (!isWithinWindow(checkTime, startMs, endMs)) continue;
      }

      timestamps.push(...fileTimestamps);
      if (!lastUsage) continue;

      breakdown.codex.sessions++;
      breakdown.codex.input += lastUsage.input_tokens || 0;
      breakdown.codex.output += lastUsage.output_tokens || 0;
      breakdown.codex.cache_read += lastUsage.cached_input_tokens ?? 0;
      breakdown.codex.cache_write += lastUsage.cache_write_input_tokens ?? 0;
      breakdown.codex.reasoning += lastUsage.reasoning_output_tokens ?? 0;
      breakdown.codex.total += lastUsage.total_tokens ?? ((lastUsage.input_tokens || 0) + (lastUsage.output_tokens || 0));
    }
  }

  // 3. AGY: sessions with workspace inside runsRoot matching runDir or wt-*
  const brainDir = path.join(geminiDir, "antigravity-cli", "brain");
  if (fs.existsSync(brainDir)) {
    const brainEntries = fs.readdirSync(brainDir, { withFileTypes: true });
    for (const entry of brainEntries) {
      if (!entry.isDirectory()) continue;
      const fullLog = path.join(brainDir, entry.name, ".system_generated", "logs", "transcript_full.jsonl");
      if (!fs.existsSync(fullLog)) continue;

      const checkTime = fs.statSync(fullLog).mtimeMs;
      if (startedAt || endedAt) {
        if (!isWithinWindow(checkTime, startMs, endMs)) continue;
      }

      const content = fs.readFileSync(fullLog, "utf8");
      let matched = false;
      const normRunsRoot = normalizePath(runsRoot);
      const normRunDir = normalizePath(runDir);

      let fileHasUsage = false;
      let sessionInput = 0;
      let sessionOutput = 0;
      let sessionCacheRead = 0;
      let sessionCacheWrite = 0;
      let sessionReasoning = 0;
      let sessionTotal = 0;
      const fileTimestamps = [];

      for (const line of content.split(/\r?\n/)) {
        if (!line.trim()) continue;
        let obj;
        try {
          obj = JSON.parse(line);
        } catch {
          continue;
        }

        const ts = extractEventTimestampMs(obj);
        if (ts !== null) fileTimestamps.push(ts);

        if (!matched) {
          const ws = obj.workspace || obj.cwd || obj.content || "";
          if (typeof ws === "string" && (ws.includes(runsRoot) || ws.includes(normRunsRoot))) {
            if (matchesOrchestraTarget(ws, runDir, runsRoot) || ws.includes(normRunDir) || ws.includes(path.resolve(runDir))) {
              matched = true;
            } else if (ws.includes("wt-")) {
              matched = true;
            }
          }
        }

        function walk(node) {
          if (!node || typeof node !== "object") return;
          if (typeof node.input_tokens === "number" || typeof node.output_tokens === "number") {
            fileHasUsage = true;
            const reas =
              typeof node.reasoning_tokens === "number"
                ? node.reasoning_tokens
                : typeof node.reasoning_output_tokens === "number"
                  ? node.reasoning_output_tokens
                  : typeof node.thinking_tokens === "number"
                    ? node.thinking_tokens
                    : typeof node.thought_tokens === "number"
                      ? node.thought_tokens
                      : typeof node.thoughts_token_count === "number"
                        ? node.thoughts_token_count
                        : 0;
            sessionInput += node.input_tokens || 0;
            sessionOutput += node.output_tokens || 0;
            sessionCacheRead += node.cached_tokens ?? node.cache_read_tokens ?? node.cache_read_input_tokens ?? 0;
            sessionCacheWrite += node.cache_write_input_tokens ?? node.cache_write_tokens ?? 0;
            sessionReasoning += reas;
            sessionTotal += node.total_tokens ?? ((node.input_tokens || 0) + (node.output_tokens || 0) + reas);
            return;
          }
          for (const k of Object.keys(node)) {
            walk(node[k]);
          }
        }
        walk(obj);
      }

      if (matched) {
        timestamps.push(...fileTimestamps);
      }
      if (matched && fileHasUsage) {
        breakdown.agy.sessions++;
        breakdown.agy.input += sessionInput;
        breakdown.agy.output += sessionOutput;
        breakdown.agy.cache_read += sessionCacheRead;
        breakdown.agy.cache_write += sessionCacheWrite;
        breakdown.agy.reasoning += sessionReasoning;
        breakdown.agy.total += sessionTotal;
      }
    }
  }

  const totalSessions = breakdown.claude.sessions + breakdown.codex.sessions + breakdown.agy.sessions;
  return {
    tokens: totalSessions === 0
      ? null
      : {
          source: "orchestra",
          sessions: totalSessions,
          input: breakdown.claude.input + breakdown.codex.input + breakdown.agy.input,
          output: breakdown.claude.output + breakdown.codex.output + breakdown.agy.output,
          cache_read: breakdown.claude.cache_read + breakdown.codex.cache_read + breakdown.agy.cache_read,
          cache_write: breakdown.claude.cache_write + breakdown.codex.cache_write + breakdown.agy.cache_write,
          reasoning: breakdown.claude.reasoning + breakdown.codex.reasoning + breakdown.agy.reasoning,
          total: breakdown.claude.total + breakdown.codex.total + breakdown.agy.total,
          by_agent: breakdown,
          breakdown
        },
    timestamps
  };
}

export function collectOrchestraTokens(opts) {
  return scanOrchestraTokens(opts).tokens;
}

export function resolveAgent({
  runDir,
  runId = null,
  repoRoot = DEFAULT_REPO_ROOT,
  runsRoot = DEFAULT_RUNS_ROOT,
  agentOverride = null
}) {
  if (agentOverride) {
    const a = String(agentOverride).trim().toLowerCase();
    if (a.includes("claude")) return "claude";
    if (a.includes("codex") || a.includes("gpt")) return "codex";
    if (a.includes("agy") || a.includes("gemini")) return "agy";
    if (a.includes("orchestra")) return "orchestra";
    return a;
  }

  const effectiveRunId = runId || path.basename(runDir);

  // 1. Check .orchestra/runs.tsv (column 3)
  const candidateTsvs = [
    path.join(repoRoot, ".orchestra", "runs.tsv"),
    path.join(process.cwd(), ".orchestra", "runs.tsv"),
    path.join(runsRoot, ".orchestra", "runs.tsv"),
    path.join(path.dirname(runsRoot), ".orchestra", "runs.tsv"),
    path.join(path.dirname(runDir), ".orchestra", "runs.tsv")
  ];
  for (const tsvPath of candidateTsvs) {
    if (fs.existsSync(tsvPath)) {
      try {
        const lines = fs.readFileSync(tsvPath, "utf8").split(/\r?\n/);
        for (const line of lines) {
          if (!line.trim()) continue;
          const cols = line.split("\t");
          if (cols[0] === effectiveRunId || cols[1] === effectiveRunId) {
            const col3 = cols[2]?.trim().toLowerCase();
            if (col3) {
              if (col3.includes("claude")) return "claude";
              if (col3.includes("codex") || col3.includes("gpt")) return "codex";
              if (col3.includes("agy") || col3.includes("gemini")) return "agy";
              if (col3.includes("orchestra")) return "orchestra";
              return col3;
            }
          }
        }
      } catch {
        // ignore
      }
    }
  }

  // 2. Check .run.json
  const runJsonPath = path.join(runDir, ".run.json");
  if (fs.existsSync(runJsonPath)) {
    try {
      const meta = JSON.parse(fs.readFileSync(runJsonPath, "utf8"));
      if (meta.agent) {
        const a = String(meta.agent).trim().toLowerCase();
        if (a.includes("claude")) return "claude";
        if (a.includes("codex") || a.includes("gpt")) return "codex";
        if (a.includes("agy") || a.includes("gemini")) return "agy";
        if (a.includes("orchestra")) return "orchestra";
        return a;
      }
      if (meta.model) {
        const m = String(meta.model).toLowerCase();
        if (m.includes("orchestra")) return "orchestra";
        if (m.includes("claude") || m.includes("haiku") || m.includes("sonnet")) return "claude";
        if (m.includes("codex") || m.includes("gpt")) return "codex";
        if (m.includes("agy") || m.includes("gemini") || m.includes("neon") || m.includes("hydrogen") || m.includes("flash")) return "agy";
      }
    } catch {
      // ignore
    }
  }

  // 3. Heuristic fallback from runId
  const lowerId = effectiveRunId.toLowerCase();
  if (lowerId.includes("orchestra")) return "orchestra";
  if (lowerId.includes("claude") || lowerId.includes("haiku") || lowerId.includes("sonnet")) return "claude";
  if (lowerId.includes("codex") || lowerId.includes("gpt")) return "codex";
  if (lowerId.includes("agy") || lowerId.includes("gemini") || lowerId.includes("neon") || lowerId.includes("hydrogen") || lowerId.includes("flash")) return "agy";

  return "claude";
}

const ACTIVE_MAX_GAP_MS = 5 * 60 * 1000;
const MTIME_SKIP_DIRS = new Set(["node_modules", ".venv", "bench", "metrics", ".git", "work", "preview", "__pycache__"]);

function scanRunAgent({
  runDir,
  agent = null,
  startedAt = null,
  endedAt = null,
  runsRoot = null,
  repoRoot = DEFAULT_REPO_ROOT,
  claudeDir = getClaudeDir(),
  codexDir = getCodexDir(),
  geminiDir = getGeminiDir()
}) {
  const effectiveRunsRoot = runsRoot || path.dirname(runDir);
  const resolvedAgent = resolveAgent({
    runDir,
    runId: path.basename(runDir),
    repoRoot,
    runsRoot: effectiveRunsRoot,
    agentOverride: agent
  });

  if (resolvedAgent === "claude") {
    return scanClaudeTokens({ runDir, claudeDir, startedAt, endedAt });
  } else if (resolvedAgent === "codex") {
    return scanCodexTokens({ runDir, codexDir, startedAt, endedAt });
  } else if (resolvedAgent === "agy") {
    return scanAgyTokens({ runDir, geminiDir, startedAt, endedAt });
  } else if (resolvedAgent === "orchestra") {
    return scanOrchestraTokens({
      runDir,
      runsRoot: effectiveRunsRoot,
      startedAt,
      endedAt,
      claudeDir,
      codexDir,
      geminiDir
    });
  }

  return { tokens: null, timestamps: [] };
}

export function collectTokens(opts) {
  return scanRunAgent(opts).tokens;
}

export function collectActivityTimestamps(opts) {
  return [...scanRunAgent(opts).timestamps].sort((a, b) => a - b);
}

export function collectRunFileMtimes(runDir) {
  const mtimes = [];
  if (!runDir || !fs.existsSync(runDir)) return mtimes;
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (MTIME_SKIP_DIRS.has(e.name) || e.name === "selfcheck.json" || e.name === ".run.json") continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(p);
      } else if (e.isFile()) {
        try {
          const mt = fs.statSync(p).mtimeMs;
          if (Number.isFinite(mt)) mtimes.push(mt);
        } catch {
          // ignore
        }
      }
    }
  };
  walk(runDir);
  return mtimes.sort((a, b) => a - b);
}

/**
 * Sum consecutive timestamp gaps (each capped at maxGapMs, default 5 minutes), in minutes.
 */
export function computeActiveMinutes(timestampsMs, maxGapMs = ACTIVE_MAX_GAP_MS) {
  const sorted = (timestampsMs || [])
    .filter((t) => typeof t === "number" && Number.isFinite(t))
    .sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  if (sorted.length === 1) return 0;

  let totalMs = 0;
  for (let i = 1; i < sorted.length; i++) {
    const gap = Math.max(0, sorted[i] - sorted[i - 1]);
    totalMs += Math.min(gap, maxGapMs);
  }
  return Number((totalMs / 60000).toFixed(4));
}

export function collectActiveTime({
  runDir,
  agent = null,
  startedAt = null,
  endedAt = null,
  runsRoot = null,
  repoRoot = DEFAULT_REPO_ROOT,
  claudeDir = getClaudeDir(),
  codexDir = getCodexDir(),
  geminiDir = getGeminiDir(),
  maxGapMs = ACTIVE_MAX_GAP_MS
}) {
  const sessionTimestamps = collectActivityTimestamps({
    runDir,
    agent,
    startedAt,
    endedAt,
    runsRoot,
    repoRoot,
    claudeDir,
    codexDir,
    geminiDir
  });
  const timestamps = sessionTimestamps.length > 0 ? sessionTimestamps : collectRunFileMtimes(runDir);
  return computeActiveMinutes(timestamps, maxGapMs);
}

export function backfillResults({
  resultsDir = path.join(DEFAULT_REPO_ROOT, "results"),
  runsRoot = DEFAULT_RUNS_ROOT,
  repoRoot = DEFAULT_REPO_ROOT,
  agentOverride = null,
  claudeDir = getClaudeDir(),
  codexDir = getCodexDir(),
  geminiDir = getGeminiDir()
} = {}) {
  const resolvedResultsDir = path.resolve(resultsDir);
  if (!fs.existsSync(resolvedResultsDir)) {
    throw new Error(`Results directory not found: ${resolvedResultsDir}`);
  }

  const entries = fs.readdirSync(resolvedResultsDir, { withFileTypes: true });
  const rows = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    if (entry.name === "data.json" || entry.name === "leaderboard.json") continue;

    const fullPath = path.join(resolvedResultsDir, entry.name);
    try {
      const data = JSON.parse(fs.readFileSync(fullPath, "utf8"));
      const runId = data.run_id || path.basename(entry.name, ".json");
      const runDir = path.resolve(runsRoot, runId);
      const agent = resolveAgent({
        runDir,
        runId,
        repoRoot,
        runsRoot,
        agentOverride: agentOverride || data.agent
      });

      const startedAt = data.created_at || null;
      const endedAt = data.ended_at || null;

      const tokens = collectTokens({
        runDir,
        agent,
        startedAt,
        endedAt,
        runsRoot,
        repoRoot,
        claudeDir,
        codexDir,
        geminiDir
      });

      data.efficiency = {
        ...(data.efficiency || {}),
        tokens
      };

      fs.writeFileSync(fullPath, JSON.stringify(data, null, 2) + "\n", "utf8");

      rows.push({
        runId,
        agent,
        found: tokens !== null,
        sessions: tokens?.sessions ?? 0,
        input: tokens?.input ?? null,
        output: tokens?.output ?? null,
        cache_read: tokens?.cache_read ?? null,
        cache_write: tokens?.cache_write ?? null,
        reasoning: tokens?.reasoning ?? null,
        total: tokens?.total ?? null
      });
    } catch (err) {
      rows.push({
        runId: entry.name,
        error: err.message
      });
    }
  }

  return rows;
}

export function printBackfillTable(rows) {
  console.log("\nToken Backfill Summary:");
  console.log("| Run ID | Agent | Sessions | Input | Output | Cache Read | Cache Write | Reasoning | Total | Status |");
  console.log("|---|---|---:|---:|---:|---:|---:|---:|---:|---|");
  for (const r of rows) {
    if (r.error) {
      console.log(`| ${r.runId} | error | — | — | — | — | — | — | — | ERROR: ${r.error} |`);
    } else if (!r.found) {
      console.log(`| ${r.runId} | ${r.agent} | 0 | — | — | — | — | — | — | not found |`);
    } else {
      console.log(
        `| ${r.runId} | ${r.agent} | ${r.sessions} | ${r.input.toLocaleString()} | ${r.output.toLocaleString()} | ${r.cache_read.toLocaleString()} | ${r.cache_write.toLocaleString()} | ${r.reasoning.toLocaleString()} | ${r.total.toLocaleString()} | updated |`
      );
    }
  }
  console.log("");
}

function main() {
  const argv = process.argv.slice(2);
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const k = a.slice(2);
      if (k === "backfill" || k === "help" || k === "h") {
        flags[k] = true;
      } else {
        flags[k] = argv[++i];
      }
    } else {
      positional.push(a);
    }
  }

  if (flags.help || flags.h || (!flags.backfill && positional.length === 0)) {
    console.log("Usage:");
    console.log("  node runner/tokens.mjs <run-id> [--root <dir>] [--agent claude|codex|agy|orchestra]");
    console.log("  node runner/tokens.mjs --backfill [--results <dir>] [--root <dir>]");
    return;
  }

  const repoRoot = flags["repo-root"] || DEFAULT_REPO_ROOT;
  const runsRoot = flags.root || process.env.MOLBENCH_RUNS || DEFAULT_RUNS_ROOT;

  if (flags.backfill) {
    const resultsDir = flags.results || path.join(repoRoot, "results");
    const rows = backfillResults({ resultsDir, runsRoot, repoRoot, agentOverride: flags.agent });
    printBackfillTable(rows);
    return;
  }

  const runId = positional[0];
  const runDir = path.resolve(runsRoot, runId);
  const agent = resolveAgent({ runDir, runId, repoRoot, runsRoot, agentOverride: flags.agent });

  let startedAt = null;
  let endedAt = null;
  const runJsonPath = path.join(runDir, ".run.json");
  if (fs.existsSync(runJsonPath)) {
    try {
      const meta = JSON.parse(fs.readFileSync(runJsonPath, "utf8"));
      startedAt = meta.created_at || null;
      endedAt = meta.ended_at || null;
    } catch {}
  }

  const tokens = collectTokens({ runDir, agent, startedAt, endedAt, runsRoot, repoRoot });
  console.log(JSON.stringify(tokens, null, 2));
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
