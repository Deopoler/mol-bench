import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  collectTokens,
  collectClaudeTokens,
  collectCodexTokens,
  collectAgyTokens,
  collectOrchestraTokens,
  resolveAgent,
  encodeClaudeProjectPath,
  backfillResults,
  printBackfillTable
} from "../tokens.mjs";
import { formatTok, generateLeaderboard } from "../../harness/src/leaderboard.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, "fixtures");
const CLAUDE_FIXTURES = path.join(FIXTURES_DIR, "claude");
const CODEX_FIXTURES = path.join(FIXTURES_DIR, "codex");
const GEMINI_FIXTURES = path.join(FIXTURES_DIR, "gemini");

test("formatTok formats numbers to human-readable string", () => {
  assert.equal(formatTok(null), "—");
  assert.equal(formatTok(undefined), "—");
  assert.equal(formatTok(NaN), "—");
  assert.equal(formatTok(0), "0");
  assert.equal(formatTok(340), "340");
  assert.equal(formatTok(999), "999");
  assert.equal(formatTok(28842), "28.8k");
  assert.equal(formatTok(615000), "615k");
  assert.equal(formatTok(4177303), "4.2M");
  assert.equal(formatTok(79600000), "79.6M");
  assert.equal(formatTok(120000000), "120M");
});

test("encodeClaudeProjectPath replaces :, \\, /, _, and . with -", () => {
  const samplePath = "C:\\Users\\x\\molbench-runs\\lobby__claude-haiku-5.5-max";
  const encoded = encodeClaudeProjectPath(samplePath);
  assert.equal(encoded, "C--Users-x-molbench-runs-lobby--claude-haiku-5-5-max");
});

test("collectClaudeTokens sums usage and dedupes repeated message.id", () => {
  const runDir = "C:\\Users\\test\\runs\\lobby__claude-haiku-5.5-max";
  const tokens = collectClaudeTokens({
    runDir,
    claudeDir: CLAUDE_FIXTURES
  });

  assert.ok(tokens);
  assert.equal(tokens.source, "claude");
  assert.equal(tokens.sessions, 1);
  // Line 1: in:12, out:340, read:5000, write:800 (id: msg_1)
  // Line 2: duplicate msg_1 (should be skipped)
  // Line 3: in:20, out:100, read:1000, write:200 (id: msg_2)
  assert.equal(tokens.input, 32);
  assert.equal(tokens.output, 440);
  assert.equal(tokens.cache_read, 6000);
  assert.equal(tokens.cache_write, 1000);
  assert.equal(tokens.reasoning, 0);
  assert.equal(tokens.total, 7472);
});

test("collectCodexTokens takes LAST total_token_usage from matching session", () => {
  const runDir = "C:\\Users\\test\\runs\\lobby__gpt-6-luna-max";
  const tokens = collectCodexTokens({
    runDir,
    codexDir: CODEX_FIXTURES
  });

  assert.ok(tokens);
  assert.equal(tokens.source, "codex");
  assert.equal(tokens.sessions, 1);
  assert.equal(tokens.input, 4177303);
  assert.equal(tokens.output, 28842);
  assert.equal(tokens.cache_read, 4056064);
  assert.equal(tokens.cache_write, 0);
  assert.equal(tokens.reasoning, 13887);
  assert.equal(tokens.total, 4206145);
});

test("collectAgyTokens sums all input_tokens and output_tokens in transcript_full.jsonl", () => {
  const runDir = "C:\\Users\\test\\runs\\lobby__gemini-2.5-flash";
  const tokens = collectAgyTokens({
    runDir,
    geminiDir: GEMINI_FIXTURES
  });

  assert.ok(tokens);
  assert.equal(tokens.source, "agy");
  assert.equal(tokens.sessions, 1);
  // line 1: in:500, out:80
  // line 2: in:750, out:120
  assert.equal(tokens.input, 1250);
  assert.equal(tokens.output, 200);
  assert.equal(tokens.cache_read, 0);
  assert.equal(tokens.cache_write, 0);
  assert.equal(tokens.reasoning, 0);
  assert.equal(tokens.total, 1450);
});

test("collectOrchestraTokens sums conductor and all worker sessions with breakdown", () => {
  const runsRoot = "C:\\Users\\test\\runs";
  const runDir = "C:\\Users\\test\\runs\\lobby__orchestra-high";
  const tokens = collectOrchestraTokens({
    runDir,
    runsRoot,
    claudeDir: CLAUDE_FIXTURES,
    codexDir: CODEX_FIXTURES,
    geminiDir: GEMINI_FIXTURES
  });

  assert.ok(tokens);
  assert.equal(tokens.source, "orchestra");
  // Conductor (Claude): 1 session (in:100, out:50, cr:500, cw:50, total:700)
  // Worker 1 (Claude in wt-worker1): 1 session (in:200, out:100, cr:1000, cw:100, total:1400)
  // Worker 2 (Codex in wt-worker2): 1 session (in:300, out:80, cr:50, cw:0, reasoning:20, total:380)
  // Worker 3 (AGY in wt-worker3): 1 session (in:400, out:150, cr:0, cw:0, reasoning:0, total:550)
  assert.equal(tokens.sessions, 4);
  assert.equal(tokens.input, 100 + 200 + 300 + 400); // 1000
  assert.equal(tokens.output, 50 + 100 + 80 + 150); // 380
  assert.equal(tokens.cache_read, 500 + 1000 + 50); // 1550
  assert.equal(tokens.cache_write, 50 + 100); // 150
  assert.equal(tokens.reasoning, 20); // 20
  assert.equal(tokens.total, 700 + 1400 + 380 + 550); // 3030

  // Per-agent breakdown
  assert.ok(tokens.by_agent);
  assert.equal(tokens.by_agent.claude.sessions, 2);
  assert.equal(tokens.by_agent.claude.total, 2100);
  assert.equal(tokens.by_agent.codex.sessions, 1);
  assert.equal(tokens.by_agent.codex.total, 380);
  assert.equal(tokens.by_agent.agy.sessions, 1);
  assert.equal(tokens.by_agent.agy.total, 550);
});

test("resolveAgent correctly detects agent type from different sources", () => {
  const runsRoot = "C:\\Users\\test\\runs";
  const repoRoot = path.join(FIXTURES_DIR, "orchestra");

  // 1. Explicit override
  assert.equal(resolveAgent({ runDir: "C:\\any", agentOverride: "codex" }), "codex");
  assert.equal(resolveAgent({ runDir: "C:\\any", agentOverride: "claude" }), "claude");

  // 2. From .orchestra/runs.tsv column 3
  assert.equal(
    resolveAgent({
      runDir: path.join(runsRoot, "lobby__claude-haiku-5.5-max"),
      runId: "lobby__claude-haiku-5.5-max",
      repoRoot,
      runsRoot
    }),
    "claude"
  );
  assert.equal(
    resolveAgent({
      runDir: path.join(runsRoot, "lobby__gpt-6-luna-max"),
      runId: "lobby__gpt-6-luna-max",
      repoRoot,
      runsRoot
    }),
    "codex"
  );
  assert.equal(
    resolveAgent({
      runDir: path.join(runsRoot, "lobby__gemini-2.5-flash"),
      runId: "lobby__gemini-2.5-flash",
      repoRoot,
      runsRoot
    }),
    "agy"
  );
  assert.equal(
    resolveAgent({
      runDir: path.join(runsRoot, "lobby__orchestra-high"),
      runId: "lobby__orchestra-high",
      repoRoot,
      runsRoot
    }),
    "orchestra"
  );

  // 3. Fallback inference from runId
  assert.equal(resolveAgent({ runDir: "C:\\runs\\room__claude-sonnet-5.5" }), "claude");
  assert.equal(resolveAgent({ runDir: "C:\\runs\\room__gpt-5-preview" }), "codex");
  assert.equal(resolveAgent({ runDir: "C:\\runs\\room__gemini-pro" }), "agy");
  assert.equal(resolveAgent({ runDir: "C:\\runs\\room__orchestra-run" }), "orchestra");
});

test("collectTokens returns null when session logs are not found", () => {
  const result = collectTokens({
    runDir: "C:\\Users\\test\\runs\\non_existent_run",
    agent: "claude",
    claudeDir: CLAUDE_FIXTURES
  });
  assert.equal(result, null);
});

test("backfillResults updates efficiency.tokens without touching other fields", () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "mol-backfill-test-"));
  try {
    const resultsDir = path.join(tmpBase, "results");
    fs.mkdirSync(resultsDir, { recursive: true });

    const fixtureRun = {
      run_id: "lobby__claude-haiku-5.5-max",
      room: "lobby",
      model: "Claude Haiku 5.5 (max)",
      composite: 9.2,
      axes: { craft: 9.0, visual_quality: 9.2, reliability: 10 },
      efficiency: { wall_min: 15.2 }
    };
    fs.writeFileSync(path.join(resultsDir, `${fixtureRun.run_id}.json`), JSON.stringify(fixtureRun, null, 2));

    const rows = backfillResults({
      resultsDir,
      runsRoot: "C:\\Users\\test\\runs",
      claudeDir: CLAUDE_FIXTURES,
      codexDir: CODEX_FIXTURES,
      geminiDir: GEMINI_FIXTURES
    });

    assert.equal(rows.length, 1);
    assert.equal(rows[0].found, true);
    assert.equal(rows[0].total, 7472);

    const updated = JSON.parse(fs.readFileSync(path.join(resultsDir, `${fixtureRun.run_id}.json`), "utf8"));
    assert.equal(updated.composite, 9.2);
    assert.equal(updated.efficiency.wall_min, 15.2);
    assert.ok(updated.efficiency.tokens);
    assert.equal(updated.efficiency.tokens.total, 7472);
    assert.equal(updated.efficiency.tokens.source, "claude");
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
});

test("leaderboard includes Output tok and Total tok in markdown and html data", () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "mol-lb-tokens-test-"));
  try {
    const resultsDir = path.join(tmpBase, "results");
    const siteDir = path.join(tmpBase, "site");
    fs.mkdirSync(resultsDir, { recursive: true });

    const runs = [
      {
        run_id: "lobby__claude-haiku-5.5-max",
        room: "lobby",
        model: "Claude Haiku 5.5",
        composite: 9.0,
        axes: { craft: 9.0, visual_quality: 9.0, reliability: 9.0 },
        efficiency: {
          wall_min: 12.0,
          tokens: {
            source: "claude",
            sessions: 1,
            input: 500000,
            output: 28842,
            cache_read: 0,
            cache_write: 0,
            reasoning: 0,
            total: 528842
          }
        }
      },
      {
        run_id: "lobby__gpt-6-luna-max",
        room: "lobby",
        model: "GPT-6 Luna",
        composite: 8.5,
        axes: { craft: 8.5, visual_quality: 8.5, reliability: 8.5 },
        efficiency: {
          wall_min: 14.0,
          tokens: {
            source: "codex",
            sessions: 1,
            input: 4177303,
            output: 615000,
            cache_read: 4056064,
            cache_write: 0,
            reasoning: 13887,
            total: 79600000
          }
        }
      }
    ];

    for (const r of runs) {
      fs.writeFileSync(path.join(resultsDir, `${r.run_id}.json`), JSON.stringify(r, null, 2));
    }

    const out = generateLeaderboard({ resultsDir, siteDir });
    const md = fs.readFileSync(out.markdownPath, "utf8");

    // Markdown contains token columns in header and formatted values in rows
    assert.match(md, /Output tok/);
    assert.match(md, /Total tok/);
    assert.match(md, /28\.8k/);
    assert.match(md, /615k/);
    assert.match(md, /79\.6M/);

    // Data json contains token efficiency
    const dataJson = JSON.parse(fs.readFileSync(out.dataJsonPath, "utf8"));
    const run1 = dataJson.runs.find((x) => x.run_id === "lobby__claude-haiku-5.5-max");
    assert.equal(run1.efficiency.tokens_out, 28842);
    assert.equal(run1.efficiency.tokens_total, 528842);

    const run2 = dataJson.runs.find((x) => x.run_id === "lobby__gpt-6-luna-max");
    assert.equal(run2.efficiency.tokens_out, 615000);
    assert.equal(run2.efficiency.tokens_total, 79600000);
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
});
