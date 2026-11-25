#!/usr/bin/env node
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { prepareRun } from "./prepare.mjs";
import { collectRun, buildV2Efficiency } from "./collect.mjs";
import { execFileSync } from "node:child_process";
import { parseVersion, resolveVersionPaths, loadSpec } from "../harness/src/spec.mjs";
import { gradeSubmission } from "../harness/src/cli.mjs";
import { round1 } from "../harness/src/score.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = path.resolve(__dirname, "..");
const DEFAULT_RUNS_ROOT = path.join(os.homedir(), "molbench-runs");
const DEFAULT_CHAIN_WEIGHTS = [0.25, 0.35, 0.40];

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  const booleanFlags = new Set(["hidden", "no-hidden", "no-capture", "no-python", "calibrate", "force", "help", "h"]);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      if (booleanFlags.has(key)) {
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

/**
 * Load a chained renovation manifest from `<roomsDir>/<room>/renovation/<chainName>/<chainName>.json`.
 */
export function loadChainConfig(room, { version = 2, chainName = "chain", repoRoot = DEFAULT_REPO_ROOT } = {}) {
  const v = parseVersion(version);
  const { roomsDir } = resolveVersionPaths(v, repoRoot);
  const chainDir = path.join(roomsDir, room, "renovation", chainName);
  const chainJsonPath = path.join(chainDir, `${chainName}.json`);
  if (!fs.existsSync(chainJsonPath)) {
    throw new Error(`Chain config not found: ${chainJsonPath}`);
  }
  const raw = JSON.parse(fs.readFileSync(chainJsonPath, "utf8"));
  const rawRounds = Array.isArray(raw.rounds) && raw.rounds.length > 0 ? raw.rounds : ["r1", "r2", "r3"];
  const rounds = rawRounds.map((r, idx) => {
    if (typeof r === "string") {
      return {
        id: r,
        renovation: r,
        weight: Array.isArray(raw.weights) ? Number(raw.weights[idx]) : (DEFAULT_CHAIN_WEIGHTS[idx] ?? 1 / rawRounds.length),
      };
    }
    return {
      id: r.id || r.renovation || `r${idx + 1}`,
      renovation: r.renovation || r.id || `r${idx + 1}`,
      weight: typeof r.weight === "number" ? r.weight : (Array.isArray(raw.weights) ? Number(raw.weights[idx]) : (DEFAULT_CHAIN_WEIGHTS[idx] ?? 1 / rawRounds.length)),
    };
  });
  const weightSum = rounds.reduce((a, b) => a + b.weight, 0);
  const normalizedWeights = weightSum > 0 ? rounds.map((r) => r.weight / weightSum) : rounds.map(() => 1 / rounds.length);

  return {
    ...raw,
    room: raw.room || room,
    chain: chainName,
    chainDir,
    chainJsonPath,
    startAnchor: raw.start_anchor || "a5",
    rounds: rounds.map((r, i) => ({ ...r, weight: normalizedWeights[i] })),
    weights: normalizedWeights,
  };
}

/**
 * Determine whether a chain can advance from round `k` to round `k + 1` (V02-DESIGN §4.6).
 * Stops on no-submission / collect-error, null composite, or any failed hard non-report gate.
 */
export function shouldAdvanceChain(roundResult) {
  if (!roundResult || typeof roundResult !== "object") {
    return { advance: false, failedNonReportGates: [], reason: "missing_round_result" };
  }
  if (roundResult.leakage?.flagged) {
    return { advance: false, failedNonReportGates: [], reason: "leakage_flagged" };
  }
  if (roundResult.invalid) {
    return { advance: false, failedNonReportGates: [], reason: roundResult.invalid_reason || "invalid_round" };
  }
  if (roundResult.status === "no-submission" || roundResult.status === "collect-error") {
    return { advance: false, failedNonReportGates: [], reason: roundResult.status };
  }
  if (roundResult.composite === null || roundResult.composite === undefined || !Number.isFinite(roundResult.composite)) {
    return { advance: false, failedNonReportGates: [], reason: "null_composite" };
  }
  const failedNonReportGates = [];
  for (const [gateId, gateVal] of Object.entries(roundResult.gates || {})) {
    if (gateId === "G-report") continue;
    if (gateVal && gateVal.pass === false) {
      failedNonReportGates.push(gateId);
    }
  }
  if (failedNonReportGates.length > 0) {
    return {
      advance: false,
      failedNonReportGates,
      reason: `failed_non_report_gates:${failedNonReportGates.join(",")}`,
    };
  }
  return { advance: true, failedNonReportGates: [], reason: null };
}

function sumTokensAcrossRounds(roundResults) {
  const validToks = (roundResults || []).map((r) => r?.efficiency?.tokens).filter(Boolean);
  if (validToks.length === 0) return null;
  const out = {
    input: 0,
    output: 0,
    reasoning: 0,
    cache_read: 0,
    cache_write: 0,
    total: 0,
    sessions: 0,
  };
  let source = null;
  for (const t of validToks) {
    out.input += t.input || 0;
    out.output += t.output || 0;
    out.reasoning += t.reasoning || 0;
    out.cache_read += t.cache_read || 0;
    out.cache_write += t.cache_write || 0;
    out.total += t.total || 0;
    out.sessions += t.sessions || 0;
    if (!source && t.source) source = t.source;
  }
  if (source) out.source = source;
  return out;
}

/**
 * Partial-chain scorer (V02-DESIGN §4.6):
 *   composite_chain = sum(w_i * S_i), where unlaunched/stopped rounds score 0.0.
 */
export function scoreChain(roundResults = [], { weights = DEFAULT_CHAIN_WEIGHTS, totalRounds = null } = {}) {
  const n = totalRounds ?? Math.max(weights.length, roundResults.length);
  const wArr = [];
  for (let i = 0; i < n; i++) {
    wArr.push(typeof weights[i] === "number" ? weights[i] : (DEFAULT_CHAIN_WEIGHTS[i] ?? 1 / n));
  }
  const wSum = wArr.reduce((a, b) => a + b, 0) || 1;
  const normWeights = wArr.map((w) => w / wSum);

  let compositeChain = 0;
  let completedCount = 0;
  let attemptedCount = 0;
  const axesSums = { craft: 0, visual_quality: 0, revision: 0, reliability: 0 };
  const axesHasVal = { craft: false, visual_quality: false, revision: false, reliability: false };
  const perRound = [];

  for (let i = 0; i < n; i++) {
    const w = normWeights[i];
    const r = roundResults[i] || null;
    if (!r) {
      perRound.push({
        round: `r${i + 1}`,
        weight: Number(w.toFixed(4)),
        composite: 0,
        status: "not-run",
        gates_failed: [],
        advance: false,
      });
      continue;
    }

    attemptedCount += 1;
    const adv = shouldAdvanceChain(r);
    const isFailedSub = r.status === "no-submission" || r.status === "collect-error";
    const s = !isFailedSub && typeof r.composite === "number" && Number.isFinite(r.composite) ? r.composite : 0;
    compositeChain += w * s;

    if (adv.advance) {
      completedCount += 1;
    }

    for (const ax of Object.keys(axesSums)) {
      const val = !isFailedSub && typeof r.axes?.[ax] === "number" && Number.isFinite(r.axes[ax]) ? r.axes[ax] : 0;
      if (typeof r.axes?.[ax] === "number" && Number.isFinite(r.axes[ax])) {
        axesHasVal[ax] = true;
      }
      axesSums[ax] += w * val;
    }

    const gatesFailed = Object.entries(r.gates || {})
      .filter(([, g]) => g && g.pass === false)
      .map(([id]) => id);

    perRound.push({
      round: r.renovation || `r${i + 1}`,
      run_id: r.run_id || null,
      weight: Number(w.toFixed(4)),
      composite: s,
      status: r.status || (adv.advance ? "completed" : "stopped"),
      reason: adv.reason || r.reason || null,
      gates_failed: gatesFailed,
      advance: adv.advance,
    });
  }

  const axes = {};
  for (const ax of Object.keys(axesSums)) {
    axes[ax] = axesHasVal[ax] ? Number(axesSums[ax].toFixed(4)) : null;
  }

  return {
    composite_chain: Number(compositeChain.toFixed(4)),
    composite: Number(compositeChain.toFixed(4)),
    composite_rounded: round1(compositeChain),
    rounds_completed: `${completedCount}/${n}`,
    completed_count: completedCount,
    attempted_count: attemptedCount,
    total_rounds: n,
    axes,
    per_round: perRound,
  };
}

/**
 * Execute a full 3-round chained renovation run with automatic handoff and early stop on gate failure.
 */
export async function runChain({
  room,
  chainName = "chain",
  runId,
  model,
  version = 2,
  root = process.env.MOLBENCH_RUNS || DEFAULT_RUNS_ROOT,
  resultsDir = null,
  repoRoot = DEFAULT_REPO_ROOT,
  hidden = true,
  noCapture = false,
  noPython = false,
  force = false,
  runnerFn = null,
  agentCmd = null,
} = {}) {
  if (!room) throw new Error("Missing required <room> argument.");
  if (!runId) throw new Error("Missing required --run-id <id> argument.");
  if (!model) throw new Error("Missing required --model \"<label>\" argument.");
  if (typeof runnerFn !== "function" && (!agentCmd || typeof agentCmd !== "string")) {
    throw new Error("runChain requires a runnerFn callback (or --agent-cmd \"<command>\" when invoked from CLI)");
  }

  const v = parseVersion(version);
  const resolvedRepoRoot = path.resolve(repoRoot);
  const versionPaths = resolveVersionPaths(v, resolvedRepoRoot);
  const resolvedResultsDir = resultsDir ? path.resolve(resultsDir) : versionPaths.resultsDir;
  const chainResultPath = path.join(resolvedResultsDir, `${runId}.json`);
  if (!force && fs.existsSync(chainResultPath)) {
    throw new Error(
      `Refusing to reuse run-id "${runId}": result already exists: ${chainResultPath} (use a new --run-id or pass --force)`
    );
  }
  const chainCfg = loadChainConfig(room, { version: v, chainName, repoRoot: resolvedRepoRoot });

  const roundResults = [];
  let prevStartDir = path.join(versionPaths.roomsDir, room, "anchors", chainCfg.startAnchor);
  let stoppedReason = null;
  const createdAt = new Date().toISOString();

  for (let i = 0; i < chainCfg.rounds.length; i++) {
    const rInfo = chainCfg.rounds[i];
    const roundRunId = `${runId}__${rInfo.id}`;
    const roundWorkStartDir = i === 0 ? null : prevStartDir;

    const { runDir, runMeta } = prepareRun({
      room,
      runId: roundRunId,
      renovation: rInfo.renovation,
      version: v,
      startDir: roundWorkStartDir,
      chainRound: i + 1,
      parentRunId: runId,
      root,
      repoRoot: resolvedRepoRoot,
      resultsDir: path.join(resolvedResultsDir, "chain-rounds"),
      force,
    });

    if (typeof runnerFn === "function") {
      await runnerFn({
        round: rInfo.id,
        renovation: rInfo.renovation,
        roundIndex: i,
        runId: roundRunId,
        runDir,
        runMeta,
      });
    } else if (agentCmd) {
      execFileSync(agentCmd, {
        cwd: runDir,
        shell: true,
        stdio: "inherit",
        env: {
          ...process.env,
          MOLBENCH_RUN_DIR: runDir,
          MOLBENCH_RUN_ID: roundRunId,
          MOLBENCH_ROUND: rInfo.id,
          MOLBENCH_ROOM: room,
        },
      });
    }

    const collected = collectRun({
      runId: roundRunId,
      model,
      renovation: rInfo.renovation,
      version: v,
      hidden,
      noCapture,
      noPython,
      root,
      resultsDir: path.join(resolvedResultsDir, "chain-rounds"),
      repoRoot: resolvedRepoRoot,
    });
    roundResults.push(collected.result);

    if (collected.result?.leakage?.flagged) {
      stoppedReason = `Stopped after ${rInfo.id}: leakage_flagged`;
      break;
    }

    const adv = shouldAdvanceChain(collected.result);
    if (!adv.advance) {
      stoppedReason = `Stopped after ${rInfo.id}: ${adv.reason}`;
      break;
    }

    prevStartDir = collected.subCopyDir || runDir;
  }

  const scored = scoreChain(roundResults, {
    weights: chainCfg.weights,
    totalRounds: chainCfg.rounds.length,
  });

  const activeSum = roundResults.reduce((acc, r) => acc + (typeof r?.efficiency?.active_min === "number" ? r.efficiency.active_min : 0), 0);
  const hasActive = roundResults.some((r) => typeof r?.efficiency?.active_min === "number");
  const wallSum = roundResults.reduce((acc, r) => acc + (typeof r?.efficiency?.wall_min === "number" ? r.efficiency.wall_min : 0), 0);
  const hasWall = roundResults.some((r) => typeof r?.efficiency?.wall_min === "number");
  const tokens = sumTokensAcrossRounds(roundResults);
  const firstEff = roundResults.find((r) => r?.efficiency)?.efficiency || {};

  const rollupGates = {};
  for (const r of roundResults) {
    for (const [gid, g] of Object.entries(r?.gates || {})) {
      if (!(gid in rollupGates)) {
        rollupGates[gid] = { ...g };
      } else if (g?.pass === false) {
        rollupGates[gid] = { pass: false, detail: `${r.renovation || "round"}: ${g.detail || "failed"}` };
      }
    }
  }

  const endedAt = roundResults[roundResults.length - 1]?.ended_at || new Date().toISOString();
  const chainResult = {
    run_id: runId,
    model,
    room,
    renovation: chainName,
    track: "chain",
    bench_version: versionPaths.benchVersion,
    seeds: hidden ? "hidden" : "public",
    created_at: createdAt,
    ended_at: endedAt,
    composite: scored.composite_chain,
    composite_chain: scored.composite_chain,
    rounds_completed: scored.rounds_completed,
    completed_count: scored.completed_count,
    attempted_count: scored.attempted_count,
    total_rounds: scored.total_rounds,
    axes: scored.axes,
    gates: rollupGates,
    rounds: scored.per_round,
    round_results: roundResults,
    taste: null,
    efficiency: buildV2Efficiency({
      tokens,
      model,
      cliSource: firstEff.cli_source || null,
      activeMin: hasActive ? Number(activeSum.toFixed(4)) : null,
      wallMin: hasWall ? Number(wallSum.toFixed(4)) : null,
      timeLimitActiveMin: chainCfg.time_limit_active_min ?? null,
      timedOut: roundResults.some((r) => Boolean(r?.efficiency?.timed_out_active)),
      resultsDir: resolvedResultsDir,
      trackKey: `${room}/${chainName}`,
    }),
    ...(stoppedReason ? { stopped_reason: stoppedReason } : {}),
  };

  fs.mkdirSync(resolvedResultsDir, { recursive: true });
  const resultPath = path.join(resolvedResultsDir, `${runId}.json`);
  fs.writeFileSync(resultPath, JSON.stringify(chainResult, null, 2) + "\n", "utf8");

  return {
    resultPath,
    result: chainResult,
  };
}

/**
 * Calibrate chain anchors (`a5/{r1,r2,r3}`, `a8/{r1,r2,r3}`, `null`).
 */
export async function calibrateChain({
  room,
  chainName = "chain",
  version = 2,
  hidden = false,
  noCapture = false,
  noPython = false,
  repoRoot = DEFAULT_REPO_ROOT,
} = {}) {
  const v = parseVersion(version);
  const resolvedRepoRoot = path.resolve(repoRoot);
  const { roomsDir } = resolveVersionPaths(v, resolvedRepoRoot);
  const chainCfg = loadChainConfig(room, { version: v, chainName, repoRoot: resolvedRepoRoot });

  async function gradeAnchorSequence(anchorName) {
    const anchorRoot = path.join(roomsDir, room, "renovation", chainName, "anchors", anchorName);
    const fallbackRoot = path.join(roomsDir, room, "anchors", anchorName);
    const roundResults = [];
    let prevStart = path.join(roomsDir, room, "anchors", chainCfg.startAnchor);

    for (let i = 0; i < chainCfg.rounds.length; i++) {
      const rInfo = chainCfg.rounds[i];
      const subDir = path.join(anchorRoot, rInfo.id);
      if (!fs.existsSync(subDir)) {
        if (i === 0 && anchorName === "null" && fs.existsSync(fallbackRoot)) {
          const res = await gradeSubmission({
            room,
            submissionDir: fallbackRoot,
            renovation: rInfo.renovation,
            version: v,
            hidden,
            noCapture,
            noPython,
            start: prevStart,
            repoRoot: resolvedRepoRoot,
          });
          roundResults.push(res);
          break;
        }
        break;
      }
      const res = await gradeSubmission({
        room,
        submissionDir: subDir,
        renovation: rInfo.renovation,
        version: v,
        hidden,
        noCapture,
        noPython,
        start: prevStart,
        repoRoot: resolvedRepoRoot,
      });
      roundResults.push(res);
      if (!shouldAdvanceChain(res).advance) break;
      prevStart = subDir;
    }

    return scoreChain(roundResults, {
      weights: chainCfg.weights,
      totalRounds: chainCfg.rounds.length,
    });
  }

  const a5 = await gradeAnchorSequence("a5");
  const a8 = await gradeAnchorSequence("a8");
  const nullRes = await gradeAnchorSequence("null");
  return { room, chain: chainName, a5, a8, null: nullRes };
}

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  if (flags.help || flags.h || positional.length === 0) {
    console.log(
      "Usage:\n" +
        "  node runner/chain.mjs <room> --run-id <id> --model \"<label>\" [--version 2] [--chain chain] [--root <dir>]\n" +
        "  node runner/chain.mjs --calibrate <room> [--version 2] [--hidden] [--no-capture] [--no-python]"
    );
    return;
  }

  const version = flags.version ?? 2;
  const repoRoot = flags["repo-root"] || DEFAULT_REPO_ROOT;

  if (flags.calibrate) {
    const room = positional[0];
    const out = await calibrateChain({
      room,
      chainName: flags.chain || "chain",
      version,
      hidden: Boolean(flags.hidden),
      noCapture: Boolean(flags["no-capture"]),
      noPython: Boolean(flags["no-python"]),
      repoRoot,
    });
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  const room = positional[0];
  const agentCmd = flags["agent-cmd"] || flags["runner-cmd"] || null;
  if (!agentCmd) {
    throw new Error("CLI chain run requires --agent-cmd \"<command>\" (or use runChain({ runnerFn }) programmatically, or --calibrate)");
  }
  const out = await runChain({
    room,
    chainName: flags.chain || "chain",
    runId: flags["run-id"],
    model: flags.model,
    version,
    root: flags.root || process.env.MOLBENCH_RUNS || DEFAULT_RUNS_ROOT,
    resultsDir: flags["results-dir"] || null,
    repoRoot,
    hidden: !flags["no-hidden"],
    noCapture: Boolean(flags["no-capture"]),
    noPython: Boolean(flags["no-python"]),
    force: Boolean(flags.force),
    agentCmd,
  });
  console.log(JSON.stringify({ resultPath: out.resultPath, composite_chain: out.result.composite_chain, rounds_completed: out.result.rounds_completed }, null, 2));
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  });
}
