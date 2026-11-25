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
  printBackfillTable,
  computeActiveMinutes,
  collectActiveTime
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

test("computeActiveMinutes caps each consecutive gap at 5 minutes", () => {
  const min = 60 * 1000;
  const base = Date.parse("2026-11-21T10:00:00Z");
  // Gaps: +2m, +2m, +180m (capped at 5m), +2m => 11m
  const ts = [base, base + 2 * min, base + 4 * min, base + 184 * min, base + 186 * min];
  assert.equal(computeActiveMinutes(ts), 11);
  assert.equal(computeActiveMinutes([base]), 0);
  assert.equal(computeActiveMinutes([]), null);
});

test("collectActiveTime parses session log timestamps with gap capping and falls back to file mtimes", () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "mol-active-test-"));
  try {
    const claudeDir = path.join(tmpBase, "claude");
    const runDir = path.join(tmpBase, "runs", "aurora__claude-active-1");
    fs.mkdirSync(runDir, { recursive: true });

    // 1. Session log with timestamps including a 90-minute gap
    const encoded = encodeClaudeProjectPath(runDir);
    const projDir = path.join(claudeDir, "projects", encoded);
    fs.mkdirSync(projDir, { recursive: true });
    const logLines = [
      JSON.stringify({ timestamp: "2026-11-21T10:00:00Z", type: "user" }),
      JSON.stringify({ timestamp: "2026-11-21T10:03:00Z", type: "assistant", message: { id: "m1", usage: { input_tokens: 10, output_tokens: 20 } } }),
      JSON.stringify({ timestamp: "2026-11-21T11:33:00Z", type: "assistant", message: { id: "m2", usage: { input_tokens: 10, output_tokens: 30 } } }),
      JSON.stringify({ timestamp: "2026-11-21T11:35:00Z", type: "assistant", message: { id: "m3", usage: { input_tokens: 5, output_tokens: 10 } } })
    ];
    fs.writeFileSync(path.join(projDir, "session.jsonl"), logLines.join("\n"));

    const activeFromLog = collectActiveTime({ runDir, agent: "claude", claudeDir });
    // 3m + 5m (90m capped) + 2m = 10m
    assert.equal(activeFromLog, 10);

    // 2. Fallback to file mtimes when no session logs exist
    const fallbackDir = path.join(tmpBase, "runs", "aurora__fallback-mtime");
    fs.mkdirSync(path.join(fallbackDir, "room"), { recursive: true });
    const f1 = path.join(fallbackDir, "room", "a.html");
    const f2 = path.join(fallbackDir, "room", "b.js");
    const f3 = path.join(fallbackDir, "report.json");
    fs.writeFileSync(f1, "a");
    fs.writeFileSync(f2, "b");
    fs.writeFileSync(f3, "{}");

    const t0 = new Date("2026-11-21T10:00:00Z");
    const t1 = new Date("2026-11-21T10:02:00Z"); // +2m
    const t2 = new Date("2026-11-21T11:02:00Z"); // +60m -> capped at 5m
    fs.utimesSync(f1, t0, t0);
    fs.utimesSync(f2, t1, t1);
    fs.utimesSync(f3, t2, t2);

    const activeFromMtime = collectActiveTime({ runDir: fallbackDir, agent: "claude", claudeDir });
    assert.equal(activeFromMtime, 7);
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
});

test("collectAgyTokens parses cache_read_tokens, reasoning tokens, and neon/hydrogen/flash model names", () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "mol-agy-tokens-test-"));
  try {
    const geminiDir = path.join(tmpBase, ".gemini");
    const brainLogDir = path.join(geminiDir, "antigravity-cli", "brain", "sess-1", ".system_generated", "logs");
    fs.mkdirSync(brainLogDir, { recursive: true });
    const runDir = path.join(tmpBase, "runs", "restoration__v2-neon");
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, ".run.json"), JSON.stringify({ model: "Gemini 4 Neon (XHigh)" }));

    const runDirForLog = process.platform === "win32" ? runDir.toLowerCase() : runDir;
    fs.writeFileSync(
      path.join(brainLogDir, "transcript_full.jsonl"),
      [
        JSON.stringify({ step_index: 0, type: "USER_INPUT", content: `Workspace is ${runDirForLog}` }),
        JSON.stringify({ step_index: 1, type: "PLANNER_RESPONSE", input_tokens: 1000, cache_read_tokens: 4000, output_tokens: 250, thinking_tokens: 50 }),
        JSON.stringify({ step_index: 2, type: "PLANNER_RESPONSE", input_tokens: 500, cache_read_tokens: 1000, output_tokens: 100 })
      ].join("\n")
    );

    assert.equal(resolveAgent({ runDir: path.join(tmpBase, "runs", "x") }), "claude");
    const neonRun = path.join(tmpBase, "runs", "v2__neon-xhigh");
    fs.mkdirSync(neonRun, { recursive: true });
    fs.writeFileSync(path.join(neonRun, ".run.json"), JSON.stringify({ model: "Neon XHigh" }));
    assert.equal(resolveAgent({ runDir: neonRun }), "agy");

    const tokens = collectAgyTokens({ runDir, geminiDir });
    assert.ok(tokens);
    assert.equal(tokens.source, "agy");
    assert.equal(tokens.input, 1500);
    assert.equal(tokens.output, 350);
    assert.equal(tokens.cache_read, 5000);
    assert.equal(tokens.reasoning, 50);
    assert.equal(tokens.total, 1900);
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
});

test("collectAgyTokens and collectActiveTime filter by startedAt/endedAt window and path boundary", () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "mol-agy-window-test-"));
  try {
    const geminiDir = path.join(tmpBase, ".gemini");
    const runDir = path.join(tmpBase, "runs", "v2-restoration__gemini-4-neon-xhigh");
    fs.mkdirSync(runDir, { recursive: true });
    const runDirForLog = process.platform === "win32" ? runDir.toLowerCase() : runDir;

    const writeSess = (id, lines) => {
      const dir = path.join(geminiDir, "antigravity-cli", "brain", id, ".system_generated", "logs");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "transcript_full.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n"));
    };

    const startedAt = "2026-11-24T03:35:53.220Z";
    const endedAt = "2026-11-24T04:59:27.499Z";

    // 1. Earlier session (prehard run that reused the same runDir) -> MUST be excluded
    writeSess("sess-old-prehard", [
      { step_index: 0, type: "USER_INPUT", created_at: "2026-11-23T14:26:15Z", content: `Workspace is ${runDirForLog}` },
      { step_index: 1, type: "PLANNER_RESPONSE", created_at: "2026-11-23T14:30:00Z", input_tokens: 900000, output_tokens: 50000 }
    ]);

    // 2. Pre-existing conductor session that started BEFORE startedAt even if an event mentions runDir during the window -> MUST be excluded
    writeSess("sess-conductor-pre", [
      { step_index: 0, type: "USER_INPUT", created_at: "2026-11-24T03:00:00Z", content: "Conductor init" },
      { step_index: 1, type: "PLANNER_RESPONSE", created_at: "2026-11-24T04:00:00Z", input_tokens: 80000, output_tokens: 4000, content: `Inspect ${runDirForLog}` }
    ]);

    // 3. Later debugging session after endedAt + 5m -> MUST be excluded
    writeSess("sess-later-debug", [
      { step_index: 0, type: "USER_INPUT", created_at: "2026-11-24T13:00:49Z", content: `Fix bug for ${runDirForLog}` },
      { step_index: 1, type: "PLANNER_RESPONSE", created_at: "2026-11-24T13:05:00Z", input_tokens: 600000, output_tokens: 60000 }
    ]);

    // 4. Different run sharing a prefix (or trailing '.2' version suffix) -> MUST NOT match
    writeSess("sess-prefix-other", [
      { step_index: 0, type: "USER_INPUT", created_at: "2026-11-24T03:40:00Z", content: `Workspace is ${runDirForLog}-retry` },
      { step_index: 1, type: "PLANNER_RESPONSE", created_at: "2026-11-24T03:45:00Z", input_tokens: 77777, output_tokens: 777 }
    ]);
    writeSess("sess-dot-suffix", [
      { step_index: 0, type: "USER_INPUT", created_at: "2026-11-24T03:42:00Z", content: `Workspace is ${runDirForLog}.2` },
      { step_index: 1, type: "PLANNER_RESPONSE", created_at: "2026-11-24T03:46:00Z", input_tokens: 66666, output_tokens: 666 }
    ]);

    // 5. Actual in-window session (starts at whole-second truncation 220ms before created_at; includes a final reply 10m after endedAt within 30m end tolerance; ignores a resumed event hours later; matches trailing '.' punctuation)
    writeSess("sess-actual-run", [
      { step_index: 0, type: "USER_INPUT", created_at: "2026-11-24T03:35:53Z", content: `Workspace is ${runDirForLog}.` },
      { step_index: 1, type: "PLANNER_RESPONSE", created_at: "2026-11-24T03:38:53Z", input_tokens: 1000, cache_read_tokens: 4000, output_tokens: 200 },
      { step_index: 2, type: "PLANNER_RESPONSE", created_at: "2026-11-24T05:09:27Z", input_tokens: 500, cache_read_tokens: 1000, output_tokens: 100 },
      { step_index: 3, type: "PLANNER_RESPONSE", created_at: "2026-11-24T10:00:00Z", input_tokens: 99999, output_tokens: 9999 }
    ]);

    // 6. Session with no event timestamps whose mtime is >5m after endedAt must not be dropped whole on endMs
    writeSess("sess-no-ts", [
      { step_index: 0, type: "USER_INPUT", content: `Inspect ${runDirForLog}` },
      { step_index: 1, type: "PLANNER_RESPONSE", input_tokens: 50, output_tokens: 10 }
    ]);
    const noTsFile = path.join(geminiDir, "antigravity-cli", "brain", "sess-no-ts", ".system_generated", "logs", "transcript_full.jsonl");
    const lateMtime = new Date("2026-11-24T05:15:00Z");
    fs.utimesSync(noTsFile, lateMtime, lateMtime);

    const tokens = collectAgyTokens({ runDir, geminiDir, startedAt, endedAt });
    assert.ok(tokens);
    assert.equal(tokens.sessions, 2);
    assert.equal(tokens.input, 1550);
    assert.equal(tokens.output, 310);
    assert.equal(tokens.cache_read, 5000);
    assert.equal(tokens.total, 1860);

    // Active time spans 03:35:53Z -> 03:38:53Z (+3m) -> 05:09:27Z (+90m34s capped at 5m) = 8m (excluding old, late, and resumed events)
    const activeMin = collectActiveTime({ runDir, agent: "agy", geminiDir, startedAt, endedAt });
    assert.equal(activeMin, 8);
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
});

test("collectOrchestraTokens retains pre-existing conductor agy session and clips events to run window", () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "mol-orch-agy-window-"));
  try {
    const geminiDir = path.join(tmpBase, ".gemini");
    const claudeDir = path.join(tmpBase, ".claude");
    const codexDir = path.join(tmpBase, ".codex");
    const runsRoot = path.join(tmpBase, "runs");
    const runDir = path.join(runsRoot, "v2-restoration__orchestra-high");
    fs.mkdirSync(runDir, { recursive: true });

    const startedAt = "2026-11-24T04:00:00Z";
    const endedAt = "2026-11-24T04:45:00Z";

    const logDir = path.join(geminiDir, "antigravity-cli", "brain", "orch-conductor-agy", ".system_generated", "logs");
    fs.mkdirSync(logDir, { recursive: true });
    const logPath = path.join(logDir, "transcript_full.jsonl");
    fs.writeFileSync(
      logPath,
      [
        // Conductor started 2 hours earlier for a prior task, then ran this run inside the window
        JSON.stringify({ step_index: 0, type: "USER_INPUT", created_at: "2026-11-24T02:00:00Z", content: "Conductor booted" }),
        JSON.stringify({ step_index: 1, type: "PLANNER_RESPONSE", created_at: "2026-11-24T02:05:00Z", input_tokens: 90000, output_tokens: 5000 }),
        JSON.stringify({ step_index: 2, type: "USER_INPUT", created_at: "2026-11-24T04:01:00Z", workspace: runDir, content: `Run ${runDir}` }),
        JSON.stringify({ step_index: 3, type: "PLANNER_RESPONSE", created_at: "2026-11-24T04:15:00Z", input_tokens: 1200, output_tokens: 300 }),
        JSON.stringify({ step_index: 4, type: "PLANNER_RESPONSE", created_at: "2026-11-24T06:00:00Z", input_tokens: 70000, output_tokens: 2000 })
      ].join("\n")
    );
    const mtimeInWin = new Date("2026-11-24T04:50:00Z");
    fs.utimesSync(logPath, mtimeInWin, mtimeInWin);

    const tokens = collectOrchestraTokens({
      runDir,
      runsRoot,
      startedAt,
      endedAt,
      claudeDir,
      codexDir,
      geminiDir
    });
    assert.ok(tokens, "orchestra must not drop pre-existing conductor agy session");
    assert.equal(tokens.by_agent.agy.sessions, 1);
    assert.equal(tokens.by_agent.agy.input, 1200);
    assert.equal(tokens.by_agent.agy.output, 300);
    assert.equal(tokens.by_agent.agy.total, 1500);
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
});
