#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { round1 } from "./score.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = path.resolve(__dirname, "..", "..");

function parseArgs(argv) {
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
    }
  }
  return flags;
}

function meanOf(nums) {
  const valid = nums.filter((n) => typeof n === "number" && Number.isFinite(n));
  if (valid.length === 0) return null;
  return valid.reduce((a, b) => a + b, 0) / valid.length;
}

function formatNum(val) {
  if (val === null || val === undefined || Number.isNaN(val)) return "—";
  return Number(val).toFixed(1);
}

export function formatTok(val) {
  if (val === null || val === undefined || Number.isNaN(val)) return "—";
  const num = Number(val);
  if (num === 0) return "0";
  if (num >= 1e6) {
    const m = num / 1e6;
    return (m >= 100 ? m.toFixed(0) : m.toFixed(1)) + "M";
  }
  if (num >= 1e3) {
    const k = num / 1e3;
    return (k >= 100 ? k.toFixed(0) : k.toFixed(1)) + "k";
  }
  return String(num);
}

export function loadResultFiles(resultsDir) {
  if (!fs.existsSync(resultsDir)) return [];
  const entries = fs.readdirSync(resultsDir, { withFileTypes: true });
  const results = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    if (
      entry.name === "data.json" ||
      entry.name === "data-v2.json" ||
      entry.name === "leaderboard.json" ||
      entry.name === "efficiency-baselines.json"
    ) {
      continue;
    }
    const fullPath = path.join(resultsDir, entry.name);
    try {
      const parsed = JSON.parse(fs.readFileSync(fullPath, "utf8"));
      if (!parsed || typeof parsed !== "object" || !parsed.room) continue;
      results.push({
        file: entry.name,
        fullPath,
        data: parsed
      });
    } catch {
      // Skip malformed JSON files
    }
  }
  return results;
}

function discoverPreviewFiles(r, runId, resultsDir) {
  const found = [];
  const seen = new Set();

  function addIfExists(p) {
    const resolved = path.isAbsolute(p) ? p : path.resolve(resultsDir, p);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) return;
    if (seen.has(resolved)) return;
    seen.add(resolved);
    found.push(resolved);
  }

  if (Array.isArray(r.preview_sheets)) {
    for (const p of r.preview_sheets) addIfExists(p);
  }

  const candidateDirs = [
    path.join(resultsDir, "submissions", runId, "preview"),
    path.join(resultsDir, "previews", runId)
  ];
  for (const dir of candidateDirs) {
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) continue;
    for (const name of fs.readdirSync(dir).sort()) {
      if (name.toLowerCase().endsWith(".png")) {
        addIfExists(path.join(dir, name));
      }
    }
  }

  return found;
}

function summarizeGates(gates = {}) {
  const entries = Object.entries(gates || {});
  let passed = 0;
  let evaluated = 0;
  const failed = [];
  for (const [id, g] of entries) {
    if (!g || g.pass === null || g.pass === undefined) continue;
    evaluated++;
    if (g.pass === true) passed++;
    else failed.push(id);
  }
  return {
    passed,
    evaluated,
    total: entries.length,
    failed
  };
}

function inferProviderGroupFromRun(r) {
  if (r?.efficiency?.provider_group) return r.efficiency.provider_group;
  const m = String(r?.model || "").toLowerCase();
  const src = String(r?.efficiency?.cli_source || r?.efficiency?.tokens?.source || "").toLowerCase();
  if (m.includes("argon")) return "argon";
  if (m.includes("gemini") || m.includes("neon") || m.includes("hydrogen") || m.includes("flash") || src === "agy") {
    return "gemini";
  }
  if (m.includes("claude") || m.includes("haiku") || m.includes("sonnet") || m.includes("opus") || src === "claude") {
    return "claude";
  }
  if (m.includes("codex") || m.includes("gpt") || src === "codex") return "codex";
  return src || "unknown";
}

function medianNum(nums) {
  const valid = nums.filter((n) => typeof n === "number" && Number.isFinite(n)).sort((a, b) => a - b);
  if (valid.length === 0) return null;
  const mid = Math.floor(valid.length / 2);
  return valid.length % 2 === 1 ? valid[mid] : (valid[mid - 1] + valid[mid]) / 2;
}

function loadEfficiencyBaselines(resultsDir) {
  if (!resultsDir) return null;
  const p = path.join(resultsDir, "efficiency-baselines.json");
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

export function buildLeaderboardData(loadedResults, opts = {}) {
  const resultsDir = opts.resultsDir ? path.resolve(opts.resultsDir) : null;
  const siteDir = opts.siteDir ? path.resolve(opts.siteDir) : null;
  const copyPreviews = Boolean(opts.copyPreviews && siteDir);
  const version = opts.version === 2 || opts.version === "2" || opts.version === "0.2.0" ? 2 : 1;
  const baselines = version === 2 ? loadEfficiencyBaselines(resultsDir) : null;

  const runs = loadedResults.map(({ file, data: r }) => {
    const runId = r.run_id || path.basename(file, ".json");
    const roomKey = r.renovation ? `${r.room}/${r.renovation}` : r.room;
    const axesRaw = {
      craft: r.axes?.craft ?? null,
      visual_quality: r.axes?.visual_quality ?? null,
      revision: r.axes?.revision ?? null,
      reliability: r.axes?.reliability ?? null
    };
    const axes = {
      craft: round1(axesRaw.craft),
      visual_quality: round1(axesRaw.visual_quality),
      revision: round1(axesRaw.revision),
      reliability: round1(axesRaw.reliability)
    };

    const previewAbsPaths = resultsDir ? discoverPreviewFiles(r, runId, resultsDir) : [];
    const previews = previewAbsPaths.map((absPath, idx) => {
      const fileName = path.basename(absPath);
      const mdPath = path.relative(resultsDir, absPath).replace(/\\/g, "/");
      let sitePath = mdPath;
      if (siteDir) {
        if (copyPreviews) {
          const dstDir = path.join(siteDir, "previews", runId);
          try {
            fs.mkdirSync(dstDir, { recursive: true });
            const dstPath = path.join(dstDir, fileName);
            if (!fs.existsSync(dstPath)) {
              fs.copyFileSync(absPath, dstPath);
            }
            sitePath = path.relative(siteDir, dstPath).replace(/\\/g, "/");
          } catch {
            sitePath = path.join("previews", runId, fileName).replace(/\\/g, "/");
          }
        } else {
          sitePath = path.relative(siteDir, absPath).replace(/\\/g, "/");
        }
      }
      return {
        label: `sheet ${idx + 1}`,
        file: fileName,
        md_path: mdPath,
        site_path: sitePath
      };
    });

    const gateSummary = summarizeGates(r.gates);
    const activeMin = r.efficiency?.active_min ?? null;
    const wallMin = r.efficiency?.wall_min ?? null;
    const status = r.status || null;
    const reason = r.reason || null;
    const tokOut = r.efficiency?.tokens?.output ?? r.efficiency?.tokens_out ?? null;
    const tokReas = r.efficiency?.tokens?.reasoning ?? null;
    const tokOutReas = tokOut !== null || tokReas !== null ? (tokOut || 0) + (tokReas || 0) : null;
    const tokCacheRead = r.efficiency?.tokens?.cache_read ?? null;
    const providerGroup = inferProviderGroupFromRun(r);
    const cliSource = r.efficiency?.cli_source || r.efficiency?.tokens?.source || null;

    return {
      run_id: runId,
      model: r.model || "unknown",
      room: r.room,
      renovation: r.renovation || null,
      room_key: roomKey,
      track: r.track || (r.renovation ? "renovation" : "build"),
      bench_version: r.bench_version || (version === 2 ? "0.2.0" : "0.1.0"),
      seed: r.seed ?? null,
      seeds: r.seeds || "public",
      status,
      reason,
      composite: round1(r.composite ?? null),
      composite_raw: r.composite ?? null,
      axes,
      axes_raw: axesRaw,
      reliability: axes.reliability,
      taste: round1(r.taste ?? null),
      rounds_completed: r.rounds_completed || null,
      toolchain: r.toolchain || null,
      partial_eval: Boolean(r.partial_eval),
      efficiency: {
        provider_group: providerGroup,
        cli_source: cliSource,
        active_min: activeMin,
        wall_min: wallMin,
        time_limit_active_min: r.efficiency?.time_limit_active_min ?? null,
        timed_out_active: Boolean(r.efficiency?.timed_out_active),
        tokens_in: r.efficiency?.tokens?.input ?? r.efficiency?.tokens_in ?? null,
        tokens_out: tokOut,
        tokens_reasoning: tokReas,
        tokens_out_reas: tokOutReas,
        tokens_cache_read: tokCacheRead,
        tokens_total: r.efficiency?.tokens?.total ?? null,
        tokens: r.efficiency?.tokens ?? null,
        provider_tok_ratio: r.efficiency?.provider_tok_ratio ?? null,
        usd: r.efficiency?.usd ?? null
      },
      pareto_within_provider: false,
      gates: gateSummary,
      gates_detail: r.gates || {},
      leakage_flagged: Boolean(r.leakage?.flagged),
      leakage_matches: r.leakage?.matches || [],
      invalid: Boolean(r.invalid),
      invalid_reason: r.invalid_reason || null,
      created_at: r.created_at || null,
      ended_at: r.ended_at || null,
      diff_file: r.diff_file || null,
      previews
    };
  });

  const isFailedRun = (r) => r.status === "no-submission" || r.status === "collect-error";

  // For v2: compute empirical provider_tok_ratio fallback & within-provider Pareto frontier per (room_key, provider_group)
  if (version === 2) {
    const byRoomProvider = new Map();
    for (const r of runs) {
      if (r.invalid || isFailedRun(r) || r.composite_raw === null) continue;
      const key = `${r.room_key}::${r.efficiency.provider_group}`;
      if (!byRoomProvider.has(key)) byRoomProvider.set(key, []);
      byRoomProvider.get(key).push(r);
    }

    for (const r of runs) {
      if (r.efficiency.provider_tok_ratio === null && r.efficiency.tokens_out_reas !== null) {
        const bTrack = baselines?.tracks?.[r.room_key] ?? baselines?.[r.room_key];
        const bEntry = bTrack?.[r.efficiency.provider_group];
        let denom = typeof bEntry === "number" ? bEntry : bEntry?.out_reas_median ?? bEntry?.median_out_reas ?? bEntry?.out_reas ?? null;
        if (!(typeof denom === "number" && denom > 0)) {
          const peers = byRoomProvider.get(`${r.room_key}::${r.efficiency.provider_group}`) || [];
          denom = medianNum(peers.map((p) => p.efficiency.tokens_out_reas));
        }
        if (typeof denom === "number" && denom > 0) {
          r.efficiency.provider_tok_ratio = Number((r.efficiency.tokens_out_reas / denom).toFixed(4));
        }
      }
    }

    for (const peers of byRoomProvider.values()) {
      for (const a of peers) {
        if (a.efficiency.tokens_out_reas === null) continue;
        const dominated = peers.some(
          (b) =>
            b !== a &&
            b.efficiency.tokens_out_reas !== null &&
            b.composite_raw >= a.composite_raw &&
            b.efficiency.tokens_out_reas <= a.efficiency.tokens_out_reas &&
            (b.composite_raw > a.composite_raw || b.efficiency.tokens_out_reas < a.efficiency.tokens_out_reas)
        );
        if (!dominated) {
          a.pareto_within_provider = true;
        }
      }
    }
  }

  // Sort helper:
  // - v1: composite_raw desc, reliability desc, active_min asc, run_id asc (preserved verbatim)
  // - v2: strict weak ordering — quantize composite_raw into 0.05 buckets, then reliability desc ->
  //       within-provider normalized token ratio asc -> provider_group asc -> tokens_out_reas asc -> run_id asc.
  const v2Bucket = (val) => (val === null || val === undefined || !Number.isFinite(val))
    ? -Infinity
    : Math.floor((val + 1e-9) / 0.05);

  const compareRuns = (a, b) => {
    const ac = a.composite_raw;
    const bc = b.composite_raw;
    if (ac === null && bc !== null) return 1;
    if (ac !== null && bc === null) return -1;
    if (version === 2) {
      const ab = v2Bucket(ac);
      const bb = v2Bucket(bc);
      if (bb !== ab) return bb - ab;
      const ar = a.axes_raw.reliability ?? -1;
      const br = b.axes_raw.reliability ?? -1;
      if (br !== ar) return br - ar;
      const atr = a.efficiency.provider_tok_ratio ?? Infinity;
      const btr = b.efficiency.provider_tok_ratio ?? Infinity;
      if (atr !== btr) return atr - btr;
      const apg = a.efficiency.provider_group || "unknown";
      const bpg = b.efficiency.provider_group || "unknown";
      if (apg !== bpg) return apg.localeCompare(bpg);
      const at = a.efficiency.tokens_out_reas ?? Infinity;
      const bt = b.efficiency.tokens_out_reas ?? Infinity;
      if (at !== bt) return at - bt;
      return a.run_id.localeCompare(b.run_id);
    }
    if (ac !== null && bc !== null && bc !== ac) return bc - ac;
    const ar = a.axes_raw.reliability ?? -1;
    const br = b.axes_raw.reliability ?? -1;
    if (br !== ar) return br - ar;
    const aw = (a.efficiency.active_min ?? a.efficiency.wall_min) ?? Infinity;
    const bw = (b.efficiency.active_min ?? b.efficiency.wall_min) ?? Infinity;
    if (aw !== bw) return aw - bw;
    return a.run_id.localeCompare(b.run_id);
  };

  // Group runs by room_key
  const roomsMap = new Map();
  for (const run of runs) {
    if (!roomsMap.has(run.room_key)) {
      roomsMap.set(run.room_key, {
        room_key: run.room_key,
        room: run.room,
        renovation: run.renovation,
        track: run.track,
        runs: []
      });
    }
    roomsMap.get(run.room_key).runs.push(run);
  }
  const rooms = {};
  for (const key of [...roomsMap.keys()].sort()) {
    const entry = roomsMap.get(key);
    entry.runs.sort(compareRuns);
    rooms[key] = entry;
  }

  // Overall aggregation per model (non-invalid, non-failed runs; average per room first, then across rooms)
  const byModel = new Map();
  for (const run of runs) {
    if (!byModel.has(run.model)) byModel.set(run.model, []);
    byModel.get(run.model).push(run);
  }

  const overall = [];
  for (const [model, modelRuns] of byModel.entries()) {
    const validRuns = modelRuns.filter((r) => !r.invalid && !isFailedRun(r));
    const byRoom = new Map();
    for (const r of validRuns) {
      if (!byRoom.has(r.room_key)) byRoom.set(r.room_key, []);
      byRoom.get(r.room_key).push(r);
    }

    const roomComposites = [];
    const roomCrafts = [];
    const roomVqs = [];
    const roomRevs = [];
    const roomRels = [];
    const roomActives = [];
    const roomWalls = [];
    const roomOutReas = [];
    const roomTokRatios = [];
    const roomScores = {};

    for (const [roomKey, rList] of byRoom.entries()) {
      const cMean = meanOf(rList.map((x) => x.composite_raw));
      const crMean = meanOf(rList.map((x) => x.axes_raw.craft));
      const vqMean = meanOf(rList.map((x) => x.axes_raw.visual_quality));
      const rvMean = meanOf(rList.map((x) => x.axes_raw.revision));
      const rlMean = meanOf(rList.map((x) => x.axes_raw.reliability));
      const aMean = meanOf(rList.map((x) => x.efficiency.active_min ?? x.efficiency.wall_min));
      const wMean = meanOf(rList.map((x) => x.efficiency.wall_min));
      const orMean = meanOf(rList.map((x) => x.efficiency.tokens_out_reas));
      const trMean = meanOf(rList.map((x) => x.efficiency.provider_tok_ratio));

      if (cMean !== null) roomComposites.push(cMean);
      if (crMean !== null) roomCrafts.push(crMean);
      if (vqMean !== null) roomVqs.push(vqMean);
      if (rvMean !== null) roomRevs.push(rvMean);
      if (rlMean !== null) roomRels.push(rlMean);
      if (aMean !== null) roomActives.push(aMean);
      if (wMean !== null) roomWalls.push(wMean);
      if (orMean !== null) roomOutReas.push(orMean);
      if (trMean !== null) roomTokRatios.push(trMean);

      roomScores[roomKey] = {
        composite: round1(cMean),
        runs: rList.length
      };
    }

    const compRaw = meanOf(roomComposites);
    const craftRaw = meanOf(roomCrafts);
    const vqRaw = meanOf(roomVqs);
    const revRaw = meanOf(roomRevs);
    const relRaw = meanOf(roomRels);
    const activeMean = meanOf(roomActives);
    const wallMean = meanOf(roomWalls);
    const outReasMean = meanOf(roomOutReas);
    const tokRatioMean = meanOf(roomTokRatios);
    const repRun = validRuns[0] || modelRuns[0];

    overall.push({
      model,
      provider_group: repRun?.efficiency?.provider_group || inferProviderGroupFromRun({ model }),
      cli_source: repRun?.efficiency?.cli_source || null,
      composite: round1(compRaw),
      composite_raw: compRaw,
      axes: {
        craft: round1(craftRaw),
        visual_quality: round1(vqRaw),
        revision: round1(revRaw),
        reliability: round1(relRaw)
      },
      reliability: round1(relRaw),
      avg_active_min: activeMean !== null ? Number(activeMean.toFixed(2)) : null,
      avg_wall_min: wallMean !== null ? Number(wallMean.toFixed(2)) : null,
      avg_out_reas: outReasMean !== null ? Math.round(outReasMean) : null,
      avg_tok_ratio: tokRatioMean !== null ? Number(tokRatioMean.toFixed(2)) : null,
      pareto_count: validRuns.filter((r) => r.pareto_within_provider).length,
      rooms_count: byRoom.size,
      runs_count: validRuns.length,
      failed_count: modelRuns.filter(isFailedRun).length,
      invalid_count: modelRuns.length - validRuns.length,
      leakage_count: modelRuns.filter((r) => r.leakage_flagged).length,
      room_scores: roomScores
    });
  }

  overall.sort((a, b) => {
    if (a.composite_raw === null && b.composite_raw !== null) return 1;
    if (a.composite_raw !== null && b.composite_raw === null) return -1;
    if (version === 2) {
      const ab = v2Bucket(a.composite_raw);
      const bb = v2Bucket(b.composite_raw);
      if (bb !== ab) return bb - ab;
      const ar = a.axes.reliability ?? -1;
      const br = b.axes.reliability ?? -1;
      if (br !== ar) return br - ar;
      const atr = a.avg_tok_ratio ?? Infinity;
      const btr = b.avg_tok_ratio ?? Infinity;
      if (atr !== btr) return atr - btr;
      const apg = a.provider_group || "unknown";
      const bpg = b.provider_group || "unknown";
      if (apg !== bpg) return apg.localeCompare(bpg);
      const at = a.avg_out_reas ?? Infinity;
      const bt = b.avg_out_reas ?? Infinity;
      if (at !== bt) return at - bt;
      return a.model.localeCompare(b.model);
    }
    if (a.composite_raw !== null && b.composite_raw !== null && b.composite_raw !== a.composite_raw) {
      return b.composite_raw - a.composite_raw;
    }
    const ar = a.axes.reliability ?? -1;
    const br = b.axes.reliability ?? -1;
    if (br !== ar) return br - ar;
    return a.model.localeCompare(b.model);
  });

  // Deterministic timestamp derived from loaded runs so repeated builds do not churn git diffs.
  const runTimestamps = runs
    .flatMap((r) => [r.ended_at, r.created_at])
    .filter(Boolean)
    .map((s) => Date.parse(s))
    .filter(Number.isFinite);
  const generatedAt = runTimestamps.length > 0 ? new Date(Math.max(...runTimestamps)).toISOString() : "—";

  return {
    version: version === 2 ? "0.2.0" : "0.1.0",
    generated_at: generatedAt,
    summary: {
      total_runs: runs.length,
      valid_runs: runs.filter((r) => !r.invalid && !isFailedRun(r)).length,
      models_count: overall.length,
      rooms_count: Object.keys(rooms).length
    },
    overall,
    rooms,
    runs: [...runs].sort(compareRuns)
  };
}

export function formatLeaderboardMarkdown(data, opts = {}) {
  const isV2 = opts.version === 2 || data.version === "0.2.0";
  const lines = [];
  lines.push(isV2 ? "# MoL-Bench v0.2 Leaderboard" : "# MoL-Bench Leaderboard");
  lines.push("");
  lines.push(
    `Generated: ${data.generated_at} | Models: ${data.summary.models_count} | Rooms: ${data.summary.rooms_count} | Runs: ${data.summary.total_runs} | [Gallery](../site/gallery/)`
  );
  lines.push("");
  lines.push("## Overall (by Model)");
  lines.push("");

  if (data.overall.length === 0) {
    lines.push("_No graded results found._");
    lines.push("");
  } else if (isV2) {
    lines.push(
      "| Rank | Model | Provider | CLI | Composite | Craft | Visual Quality | Revision | Reliability | Active (min) | Avg Out+Reas | Tok Ratio | Rooms | Runs |"
    );
    lines.push("|---:|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
    data.overall.forEach((row, idx) => {
      const rank = row.composite === null ? "—" : idx + 1;
      const activeVal = row.avg_active_min ?? row.avg_wall_min;
      const active = activeVal === null || activeVal === undefined ? "—" : activeVal.toFixed(1);
      const outReas = formatTok(row.avg_out_reas);
      const tokRatio = row.avg_tok_ratio !== null && row.avg_tok_ratio !== undefined ? `${row.avg_tok_ratio.toFixed(2)}×` : "—";
      lines.push(
        `| ${rank} | ${row.model} | ${row.provider_group || "—"} | ${row.cli_source || "—"} | ${formatNum(row.composite)} | ${formatNum(row.axes.craft)} | ${formatNum(
          row.axes.visual_quality
        )} | ${formatNum(row.axes.revision)} | ${formatNum(row.reliability)} | ${active} | ${outReas} | ${tokRatio} | ${row.rooms_count} | ${
          row.runs_count
        } |`
      );
    });
    lines.push("");
  } else {
    lines.push(
      "| Rank | Model | Composite | Craft | Visual Quality | Revision | Reliability | Avg Active (min) | Rooms | Runs |"
    );
    lines.push("|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|");
    data.overall.forEach((row, idx) => {
      const rank = row.composite === null ? "—" : idx + 1;
      const activeVal = row.avg_active_min ?? row.avg_wall_min;
      const active = activeVal === null || activeVal === undefined ? "—" : activeVal.toFixed(1);
      lines.push(
        `| ${rank} | ${row.model} | ${formatNum(row.composite)} | ${formatNum(row.axes.craft)} | ${formatNum(
          row.axes.visual_quality
        )} | ${formatNum(row.axes.revision)} | ${formatNum(row.reliability)} | ${active} | ${row.rooms_count} | ${
          row.runs_count
        } |`
      );
    });
    lines.push("");
  }

  lines.push("## Per Room");
  lines.push("");

  const roomKeys = Object.keys(data.rooms);
  if (roomKeys.length === 0) {
    lines.push("_No room results found._");
    lines.push("");
  } else {
    for (const roomKey of roomKeys) {
      const roomObj = data.rooms[roomKey];
      lines.push(`### ${roomKey} (${roomObj.track})`);
      lines.push("");
      if (isV2) {
        lines.push(
          "| Rank | Run ID | Model | Provider | CLI | Composite | Craft | Visual Quality | Revision | Reliability | Active (min) | Out+Reas | Tok Ratio | Cache Read | Total tok | Pareto | Gates | Previews | Flags |"
        );
        lines.push("|---:|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---|---|---|");
      } else {
        lines.push(
          "| Rank | Run ID | Model | Composite | Craft | Visual Quality | Revision | Reliability | Active (min) | Output tok | Total tok | Gates | Previews | Flags |"
        );
        lines.push("|---:|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---|---|---|");
      }
      roomObj.runs.forEach((run, idx) => {
        const isFailed = run.status === "no-submission" || run.status === "collect-error";
        const rank = isFailed || run.composite === null ? "—" : idx + 1;
        const activeVal = run.efficiency.active_min ?? run.efficiency.wall_min;
        const active = activeVal === null || activeVal === undefined ? "—" : Number(activeVal).toFixed(1);
        const outTok = formatTok(run.efficiency.tokens_out);
        const outReas = formatTok(run.efficiency.tokens_out_reas);
        const cacheRead = formatTok(run.efficiency.tokens_cache_read);
        const totTok = formatTok(run.efficiency.tokens_total);
        const tokRatio =
          run.efficiency.provider_tok_ratio !== null && run.efficiency.provider_tok_ratio !== undefined
            ? `${Number(run.efficiency.provider_tok_ratio).toFixed(2)}×`
            : "—";
        const pareto = run.pareto_within_provider ? "Pareto" : "—";
        const gates = isFailed && run.gates.evaluated === 0 ? "failed" : `${run.gates.passed}/${run.gates.evaluated}`;
        const viewMd = `[View](../gallery/runs/${run.run_id}/)`;
        const previews =
          run.previews.length > 0
            ? `${viewMd}, ` + run.previews.map((p) => `[${p.label}](${p.md_path})`).join(", ")
            : isFailed
            ? "—"
            : viewMd;
        const flags = [];
        if (isFailed) flags.push(run.reason ? `${run.status}:${run.reason}` : run.status);
        if (run.invalid) flags.push(`invalid:${run.invalid_reason || "yes"}`);
        if (run.leakage_flagged) flags.push("possible_leakage");
        if (run.partial_eval) flags.push("partial_eval");
        if (run.rounds_completed) flags.push(`rounds:${run.rounds_completed}`);
        if (run.gates.failed.length > 0) flags.push(`fail:${run.gates.failed.join(",")}`);
        if (isV2) {
          lines.push(
            `| ${rank} | ${run.run_id} | ${run.model} | ${run.efficiency.provider_group || "—"} | ${
              run.efficiency.cli_source || "—"
            } | ${formatNum(run.composite)} | ${formatNum(run.axes.craft)} | ${formatNum(
              run.axes.visual_quality
            )} | ${formatNum(run.axes.revision)} | ${formatNum(
              run.reliability
            )} | ${active} | ${outReas} | ${tokRatio} | ${cacheRead} | ${totTok} | ${pareto} | ${gates} | ${previews} | ${
              flags.length > 0 ? flags.join("; ") : "—"
            } |`
          );
        } else {
          lines.push(
            `| ${rank} | ${run.run_id} | ${run.model} | ${formatNum(run.composite)} | ${formatNum(
              run.axes.craft
            )} | ${formatNum(run.axes.visual_quality)} | ${formatNum(run.axes.revision)} | ${formatNum(
              run.reliability
            )} | ${active} | ${outTok} | ${totTok} | ${gates} | ${previews} | ${flags.length > 0 ? flags.join("; ") : "—"} |`
          );
        }
      });
      lines.push("");
    }
  }

  return lines.join("\n");
}

export function buildLeaderboardHtml(dataOrDatasets, opts = {}) {
  const isBundle = Boolean(dataOrDatasets && (dataOrDatasets.v1 || dataOrDatasets.v2));
  const v1Data = isBundle ? (dataOrDatasets.v1 || null) : (dataOrDatasets?.version === "0.2.0" ? null : dataOrDatasets);
  const v2Data = isBundle ? (dataOrDatasets.v2 || null) : (dataOrDatasets?.version === "0.2.0" ? dataOrDatasets : null);
  const defaultVer = opts.defaultVersion || (isBundle ? (dataOrDatasets.defaultVersion || (v2Data?.runs?.length ? "v2" : "v1")) : (v2Data ? "v2" : "v1"));
  const activeData = defaultVer === "v2" ? (v2Data || v1Data) : (v1Data || v2Data);
  const safeJson = JSON.stringify(activeData).replace(/</g, "\\u003c");
  const safeDatasetsJson = JSON.stringify({ v1: v1Data, v2: v2Data, defaultVersion: defaultVer }).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>MoL-Bench Leaderboard — Museum of Light</title>
  <style>
    :root {
      --bg: #f6f4ef;
      --surface: #ffffff;
      --surface-alt: #f0ece3;
      --text: #161513;
      --muted: #5c574f;
      --border: #dfd8cb;
      --accent: #9a6b16;
      --accent-soft: rgba(154, 107, 22, 0.12);
      --ok: #157347;
      --ok-soft: rgba(21, 115, 71, 0.12);
      --warn: #b45309;
      --warn-soft: rgba(180, 83, 9, 0.12);
      --bad: #b42318;
      --bad-soft: rgba(180, 35, 24, 0.12);
      --shadow: 0 8px 28px rgba(22, 21, 19, 0.06);
      --radius: 12px;
      --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
      --sans: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    }
    html[data-theme="dark"] {
      --bg: #0e1014;
      --surface: #151921;
      --surface-alt: #1b212c;
      --text: #f3f1ec;
      --muted: #9da4b2;
      --border: #262e3d;
      --accent: #e5b75c;
      --accent-soft: rgba(229, 183, 92, 0.14);
      --ok: #34d399;
      --ok-soft: rgba(52, 211, 153, 0.14);
      --warn: #fbbf24;
      --warn-soft: rgba(251, 191, 36, 0.14);
      --bad: #f87171;
      --bad-soft: rgba(248, 113, 113, 0.14);
      --shadow: 0 12px 32px rgba(0, 0, 0, 0.35);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: var(--sans);
      background:
        radial-gradient(1200px 420px at 15% -10%, var(--accent-soft), transparent 60%),
        var(--bg);
      color: var(--text);
      line-height: 1.5;
      min-height: 100vh;
    }
    .container {
      max-width: 1240px;
      margin: 0 auto;
      padding: 28px 20px 64px;
    }
    header.hero {
      display: flex;
      flex-wrap: wrap;
      align-items: flex-end;
      justify-content: space-between;
      gap: 16px;
      padding-bottom: 20px;
      border-bottom: 1px solid var(--border);
      margin-bottom: 24px;
    }
    .eyebrow {
      font-size: 12px;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      color: var(--accent);
      font-weight: 700;
      margin-bottom: 6px;
    }
    h1 {
      margin: 0;
      font-size: clamp(1.6rem, 3vw, 2.25rem);
      letter-spacing: -0.02em;
      font-weight: 700;
    }
    .subtitle {
      margin: 6px 0 0;
      color: var(--muted);
      font-size: 0.95rem;
    }
    .controls {
      display: flex;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
    }
    .btn {
      appearance: none;
      border: 1px solid var(--border);
      background: var(--surface);
      color: var(--text);
      padding: 8px 14px;
      border-radius: 999px;
      font-size: 0.875rem;
      font-weight: 600;
      cursor: pointer;
      transition: border-color 0.15s ease, background 0.15s ease;
    }
    .btn:hover { border-color: var(--accent); }
    .version-switch {
      display: inline-flex;
      border: 1px solid var(--border);
      background: var(--surface);
      border-radius: 999px;
      padding: 3px;
      gap: 2px;
    }
    .ver-btn {
      appearance: none;
      border: none;
      background: transparent;
      color: var(--muted);
      padding: 5px 12px;
      border-radius: 999px;
      font-size: 0.82rem;
      font-weight: 700;
      cursor: pointer;
    }
    .ver-btn.active {
      background: var(--accent);
      color: #ffffff;
    }
    html[data-theme="dark"] .ver-btn.active {
      color: #101216;
    }
    .kpis {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(170px, 1fr));
      gap: 14px;
      margin-bottom: 28px;
    }
    .kpi {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 16px 18px;
      box-shadow: var(--shadow);
    }
    .kpi-label {
      font-size: 0.78rem;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--muted);
      margin-bottom: 4px;
    }
    .kpi-value {
      font-size: 1.65rem;
      font-weight: 700;
      font-variant-numeric: tabular-nums;
    }
    section.panel {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      box-shadow: var(--shadow);
      margin-bottom: 26px;
      overflow: hidden;
    }
    .panel-head {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 16px 20px;
      border-bottom: 1px solid var(--border);
      background: var(--surface-alt);
    }
    .panel-title {
      margin: 0;
      font-size: 1.05rem;
      font-weight: 700;
    }
    .tabs {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }
    .tab {
      border: 1px solid var(--border);
      background: var(--surface);
      color: var(--muted);
      padding: 6px 12px;
      border-radius: 999px;
      font-size: 0.82rem;
      font-weight: 600;
      cursor: pointer;
    }
    .tab.active {
      background: var(--accent);
      color: #ffffff;
      border-color: var(--accent);
    }
    html[data-theme="dark"] .tab.active {
      color: #101216;
    }
    .search {
      border: 1px solid var(--border);
      background: var(--surface);
      color: var(--text);
      padding: 7px 12px;
      border-radius: 8px;
      font-size: 0.875rem;
      min-width: 210px;
    }
    .table-wrap {
      width: 100%;
      overflow-x: auto;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.9rem;
    }
    th, td {
      padding: 11px 14px;
      border-bottom: 1px solid var(--border);
      text-align: left;
      white-space: nowrap;
    }
    th {
      font-size: 0.76rem;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--muted);
      background: var(--surface);
      user-select: none;
    }
    th.sortable { cursor: pointer; }
    th.sortable:hover { color: var(--text); }
    td.num, th.num {
      text-align: right;
      font-variant-numeric: tabular-nums;
    }
    tbody tr.main-row:hover {
      background: var(--surface-alt);
    }
    .rank {
      font-family: var(--mono);
      color: var(--muted);
      font-weight: 700;
    }
    .score-pill {
      display: inline-block;
      min-width: 44px;
      text-align: center;
      padding: 2px 8px;
      border-radius: 999px;
      font-family: var(--mono);
      font-weight: 700;
      font-size: 0.84rem;
      background: var(--accent-soft);
      color: var(--accent);
    }
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 2px 8px;
      border-radius: 999px;
      font-size: 0.76rem;
      font-weight: 600;
    }
    .badge.ok { background: var(--ok-soft); color: var(--ok); }
    .badge.warn { background: var(--warn-soft); color: var(--warn); }
    .badge.bad { background: var(--bad-soft); color: var(--bad); }
    .badge.neutral { background: var(--surface-alt); color: var(--muted); }
    .mono { font-family: var(--mono); font-size: 0.84rem; }
    .preview-links {
      display: inline-flex;
      gap: 6px;
      flex-wrap: wrap;
    }
    .preview-link {
      color: var(--accent);
      text-decoration: none;
      font-weight: 600;
      font-size: 0.82rem;
    }
    .preview-link:hover { text-decoration: underline; }
    .detail-row td {
      background: var(--surface-alt);
      white-space: normal;
      padding: 16px 20px;
    }
    .detail-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: 14px;
    }
    .detail-box {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 12px;
      font-size: 0.84rem;
    }
    .detail-box h4 {
      margin: 0 0 8px;
      font-size: 0.78rem;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--muted);
    }
    .thumbs {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      margin-top: 8px;
    }
    .thumbs img {
      max-width: 240px;
      border-radius: 8px;
      border: 1px solid var(--border);
      display: block;
    }
    .empty {
      padding: 36px 20px;
      text-align: center;
      color: var(--muted);
    }
    footer {
      margin-top: 24px;
      color: var(--muted);
      font-size: 0.82rem;
      display: flex;
      justify-content: space-between;
      flex-wrap: wrap;
      gap: 8px;
    }
  </style>
</head>
<body>
  <div class="container">
    <header class="hero">
      <div>
        <div class="eyebrow">Museum of Light · Deterministic Benchmark</div>
        <h1>MoL-Bench Leaderboard</h1>
        <p class="subtitle" id="meta-line">Loading results…</p>
      </div>
      <div class="controls">
        <div class="version-switch" id="version-switch" role="tablist" aria-label="Benchmark Version">
          <button class="ver-btn" id="ver-btn-v2" data-ver="v2" type="button">v0.2</button>
          <button class="ver-btn" id="ver-btn-v1" data-ver="v1" type="button">v0.1</button>
        </div>
        <a class="btn" href="../gallery/" style="text-decoration:none">Gallery</a>
        <button class="btn" id="theme-toggle" type="button">Toggle Theme</button>
      </div>
    </header>

    <div class="kpis" id="kpis"></div>

    <section class="panel">
      <div class="panel-head">
        <h2 class="panel-title">Overall Model Standings</h2>
      </div>
      <div class="table-wrap" id="overall-wrap"></div>
    </section>

    <section class="panel">
      <div class="panel-head">
        <h2 class="panel-title">Submissions by Room</h2>
        <div class="controls">
          <div class="tabs" id="room-tabs"></div>
          <input class="search" id="search-input" type="search" placeholder="Filter model or run ID…" aria-label="Filter model or run ID" />
        </div>
      </div>
      <div class="table-wrap" id="runs-wrap"></div>
    </section>

    <footer>
      <span>All programmatic metrics are deterministic; Taste is human-only and never estimated.</span>
      <span id="generated-at"></span>
    </footer>
  </div>

  <script>
    window.__LEADERBOARD_DATA__ = ${safeJson};
    window.__LEADERBOARD_DATASETS__ = ${safeDatasetsJson};
  </script>
  <script>
    (function () {
      const root = document.documentElement;
      const savedTheme = localStorage.getItem("mol-lb-theme");
      const prefersDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
      root.setAttribute("data-theme", savedTheme || (prefersDark ? "dark" : "light"));

      document.getElementById("theme-toggle").addEventListener("click", () => {
        const next = root.getAttribute("data-theme") === "dark" ? "light" : "dark";
        root.setAttribute("data-theme", next);
        localStorage.setItem("mol-lb-theme", next);
      });

      const esc = (s) =>
        String(s ?? "")
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")
          .replace(/"/g, "&quot;");

      const fmt = (v, digits = 1) =>
        v === null || v === undefined || Number.isNaN(Number(v)) ? "—" : Number(v).toFixed(digits);

      const fmtTok = (v) => {
        if (v === null || v === undefined || Number.isNaN(Number(v))) return "—";
        const n = Number(v);
        if (n === 0) return "0";
        if (n >= 1e6) {
          const m = n / 1e6;
          return (m >= 100 ? m.toFixed(0) : m.toFixed(1)) + "M";
        }
        if (n >= 1e3) {
          const k = n / 1e3;
          return (k >= 100 ? k.toFixed(0) : k.toFixed(1)) + "k";
        }
        return String(n);
      };

      const emptyDataset = (verLabel) => ({
        version: verLabel === "v2" ? "0.2.0" : "0.1.0",
        generated_at: "—",
        summary: { total_runs: 0, valid_runs: 0, models_count: 0, rooms_count: 0 },
        overall: [],
        rooms: {},
        runs: []
      });

      const datasets = window.__LEADERBOARD_DATASETS__ || {
        v1: window.__LEADERBOARD_DATA__,
        v2: null,
        defaultVersion: "v1"
      };

      let state = {
        activeVersion: datasets.defaultVersion === "v2" ? "v2" : "v1",
        data: (datasets.defaultVersion === "v2" ? datasets.v2 : datasets.v1) || window.__LEADERBOARD_DATA__ || emptyDataset("v1"),
        room: "ALL",
        query: "",
        sortBy: "composite_raw",
        sortDir: "desc",
        expanded: new Set()
      };

      function isV2View() {
        return state.activeVersion === "v2" || state.data?.version === "0.2.0";
      }

      function setVersion(ver) {
        state.activeVersion = ver === "v2" ? "v2" : "v1";
        state.data = datasets[state.activeVersion] || emptyDataset(state.activeVersion);
        state.room = "ALL";
        state.expanded.clear();
        renderAll();
      }

      function renderVersionSwitch() {
        const b2 = document.getElementById("ver-btn-v2");
        const b1 = document.getElementById("ver-btn-v1");
        if (b2) b2.classList.toggle("active", state.activeVersion === "v2");
        if (b1) b1.classList.toggle("active", state.activeVersion === "v1");
      }

      document.getElementById("ver-btn-v2")?.addEventListener("click", () => setVersion("v2"));
      document.getElementById("ver-btn-v1")?.addEventListener("click", () => setVersion("v1"));

      function renderAll() {
        renderVersionSwitch();
        const data = state.data;
        if (!data) return;

        const verTag = isV2View() ? "v0.2" : "v0.1";
        document.getElementById("meta-line").textContent =
          verTag + " · " + data.summary.models_count + " models · " + data.summary.rooms_count + " rooms · " + data.summary.total_runs + " runs";
        document.getElementById("generated-at").textContent = "Generated (" + verTag + "): " + data.generated_at;

        const topComposite = data.overall.length > 0 && data.overall[0].composite !== null ? fmt(data.overall[0].composite) : "—";
        document.getElementById("kpis").innerHTML = [
          ["Models", data.summary.models_count],
          ["Graded Runs", data.summary.total_runs],
          ["Rooms", data.summary.rooms_count],
          ["Top Composite", topComposite]
        ]
          .map(
            ([label, val]) =>
              '<div class="kpi"><div class="kpi-label">' + esc(label) + '</div><div class="kpi-value">' + esc(val) + "</div></div>"
          )
          .join("");

        renderOverall(data);
        renderTabs(data);
        renderRuns(data);
      }

      function renderOverall(data) {
        const wrap = document.getElementById("overall-wrap");
        if (!data.overall || data.overall.length === 0) {
          wrap.innerHTML = '<div class="empty">No graded ' + (isV2View() ? "v0.2" : "v0.1") + ' runs yet. Run <code>node runner/collect.mjs</code> and <code>node harness/src/leaderboard.mjs</code>.</div>';
          return;
        }
        const v2 = isV2View();
        const rows = data.overall
          .map((m, idx) => {
            const rankStr = m.composite === null ? "—" : "#" + (idx + 1);
            const activeVal = m.avg_active_min ?? m.avg_wall_min;
            const roomBadges = Object.entries(m.room_scores || {})
              .map(([rk, rs]) => '<span class="badge neutral">' + esc(rk) + ": " + esc(fmt(rs.composite)) + "</span>")
              .join(" ");
            const paretoBadge = v2 && m.pareto_count > 0 ? ' <span class="badge ok">Pareto×' + esc(m.pareto_count) + "</span>" : "";
            return (
              '<tr class="main-row">' +
              '<td class="rank">' + rankStr + "</td>" +
              "<td><strong>" + esc(m.model) + "</strong>" +
              paretoBadge +
              (m.failed_count > 0 && m.runs_count === 0 ? ' <span class="badge bad">failed:' + m.failed_count + "</span>" : "") +
              (m.leakage_count > 0 ? ' <span class="badge bad">leakage:' + m.leakage_count + "</span>" : "") +
              "</td>" +
              (v2 ? '<td><span class="badge neutral">' + esc(m.provider_group || "—") + '</span></td><td>' + esc(m.cli_source || "—") + "</td>" : "") +
              '<td class="num"><span class="score-pill">' + esc(fmt(m.composite)) + "</span></td>" +
              '<td class="num">' + esc(fmt(m.axes.craft)) + "</td>" +
              '<td class="num">' + esc(fmt(m.axes.visual_quality)) + "</td>" +
              '<td class="num">' + esc(fmt(m.axes.revision)) + "</td>" +
              '<td class="num">' + esc(fmt(m.reliability)) + "</td>" +
              '<td class="num">' + esc(fmt(activeVal)) + "</td>" +
              (v2 ? '<td class="num">' + esc(fmtTok(m.avg_out_reas)) + '</td><td class="num">' + esc(m.avg_tok_ratio !== null && m.avg_tok_ratio !== undefined ? m.avg_tok_ratio.toFixed(2) + "×" : "—") + "</td>" : "") +
              '<td class="num">' + esc(m.rooms_count) + "</td>" +
              '<td class="num">' + esc(m.runs_count) + "</td>" +
              "<td>" + (roomBadges || "—") + "</td>" +
              "</tr>"
            );
          })
          .join("");

        wrap.innerHTML =
          "<table><thead><tr>" +
          "<th>Rank</th><th>Model</th>" +
          (v2 ? "<th>Provider</th><th>CLI</th>" : "") +
          "<th class=num>Composite</th><th class=num>Craft</th><th class=num>Visual Quality</th><th class=num>Revision</th><th class=num>Reliability</th><th class=num>Avg Active (min)</th>" +
          (v2 ? "<th class=num>Out+Reas</th><th class=num>Tok Ratio</th>" : "") +
          "<th class=num>Rooms</th><th class=num>Runs</th><th>Room Breakdown</th>" +
          "</tr></thead><tbody>" +
          rows +
          "</tbody></table>";
      }

      function renderTabs(data) {
        const tabsEl = document.getElementById("room-tabs");
        const keys = ["ALL", ...Object.keys(data.rooms || {})];
        tabsEl.innerHTML = keys
          .map((k) => {
            const label = k === "ALL" ? "All Rooms" : k;
            const cls = state.room === k ? "tab active" : "tab";
            return '<button type="button" class="' + cls + '" data-room="' + esc(k) + '">' + esc(label) + "</button>";
          })
          .join("");
        tabsEl.querySelectorAll("button").forEach((btn) => {
          btn.addEventListener("click", () => {
            state.room = btn.getAttribute("data-room");
            renderTabs(state.data);
            renderRuns(state.data);
          });
        });
      }

      function getSortValue(run, key) {
        if (key === "composite_raw") return run.composite_raw;
        if (key === "craft") return run.axes_raw?.craft ?? null;
        if (key === "visual_quality") return run.axes_raw?.visual_quality ?? null;
        if (key === "revision") return run.axes_raw?.revision ?? null;
        if (key === "reliability") return run.axes_raw?.reliability ?? null;
        if (key === "active_min") return (run.efficiency?.active_min ?? run.efficiency?.wall_min) ?? null;
        if (key === "wall_min") return run.efficiency?.wall_min ?? null;
        if (key === "tokens_out") return run.efficiency?.tokens_out ?? null;
        if (key === "tokens_out_reas") return run.efficiency?.tokens_out_reas ?? null;
        if (key === "tokens_cache_read") return run.efficiency?.tokens_cache_read ?? null;
        if (key === "provider_tok_ratio") return run.efficiency?.provider_tok_ratio ?? null;
        if (key === "tokens_total") return run.efficiency?.tokens_total ?? null;
        return run[key] ?? null;
      }

      function renderRuns(data) {
        const wrap = document.getElementById("runs-wrap");
        const baseList = state.room === "ALL" ? data.runs || [] : data.rooms[state.room]?.runs || [];
        const q = state.query.trim().toLowerCase();
        const filtered = q
          ? baseList.filter(
              (r) =>
                r.model.toLowerCase().includes(q) ||
                r.run_id.toLowerCase().includes(q) ||
                r.room_key.toLowerCase().includes(q) ||
                String(r.efficiency?.provider_group || "").toLowerCase().includes(q)
            )
          : [...baseList];

        filtered.sort((a, b) => {
          const av = getSortValue(a, state.sortBy);
          const bv = getSortValue(b, state.sortBy);
          if (av === null && bv === null) return 0;
          if (av === null) return 1;
          if (bv === null) return -1;
          if (typeof av === "string" || typeof bv === "string") {
            return state.sortDir === "asc" ? String(av).localeCompare(String(bv)) : String(bv).localeCompare(String(av));
          }
          return state.sortDir === "asc" ? av - bv : bv - av;
        });

        if (filtered.length === 0) {
          wrap.innerHTML = '<div class="empty">No matching runs found.</div>';
          return;
        }

        const v2 = isV2View();
        const headers = v2
          ? [
              ["Rank", null, false],
              ["Run ID", "run_id", false],
              ["Room", "room_key", false],
              ["Model", "model", false],
              ["Provider", null, false],
              ["CLI", null, false],
              ["Composite", "composite_raw", true],
              ["Craft", "craft", true],
              ["VQ", "visual_quality", true],
              ["Revision", "revision", true],
              ["Reliability", "reliability", true],
              ["Active (min)", "active_min", true],
              ["Out+Reas", "tokens_out_reas", true],
              ["Tok Ratio", "provider_tok_ratio", true],
              ["Cache Read", "tokens_cache_read", true],
              ["Total tok", "tokens_total", true],
              ["Gates", null, false],
              ["Preview", null, false],
              ["Flags", null, false]
            ]
          : [
              ["Rank", null, false],
              ["Run ID", "run_id", false],
              ["Room", "room_key", false],
              ["Model", "model", false],
              ["Composite", "composite_raw", true],
              ["Craft", "craft", true],
              ["VQ", "visual_quality", true],
              ["Revision", "revision", true],
              ["Reliability", "reliability", true],
              ["Active (min)", "active_min", true],
              ["Output tok", "tokens_out", true],
              ["Total tok", "tokens_total", true],
              ["Gates", null, false],
              ["Preview", null, false],
              ["Flags", null, false]
            ];

        const thead =
          "<thead><tr>" +
          headers
            .map(([label, key, isNum]) => {
              const cls = [isNum ? "num" : "", key ? "sortable" : ""].filter(Boolean).join(" ");
              const arrow = key && state.sortBy === key ? (state.sortDir === "asc" ? " ▲" : " ▼") : "";
              return "<th" + (cls ? ' class="' + cls + '"' : "") + (key ? ' data-sort="' + key + '"' : "") + ">" + esc(label + arrow) + "</th>";
            })
            .join("") +
          "</tr></thead>";

        const tbody = filtered
          .map((run, idx) => {
            const isFailed = run.status === "no-submission" || run.status === "collect-error";
            const rankStr = isFailed || run.composite === null ? "—" : "#" + (idx + 1);
            const activeVal = run.efficiency?.active_min ?? run.efficiency?.wall_min;
            const gateBadge =
              isFailed && run.gates.evaluated === 0
                ? '<span class="badge bad">failed</span>'
                : run.gates.failed.length > 0
                ? '<span class="badge bad">' + run.gates.passed + "/" + run.gates.evaluated + " fail</span>"
                : run.gates.evaluated > 0
                ? '<span class="badge ok">' + run.gates.passed + "/" + run.gates.evaluated + " pass</span>"
                : '<span class="badge neutral">skip</span>';

            const viewLink = '<a class="preview-link" href="../gallery/runs/' + esc(run.run_id) + '/" target="_blank" rel="noopener">View ↗</a>';
            const previewHtml =
              isFailed && (!run.previews || run.previews.length === 0)
                ? "—"
                : '<div class="preview-links">' +
                  viewLink +
                  (run.previews && run.previews.length > 0
                    ? " " +
                      run.previews
                        .map(
                          (p) =>
                            '<a class="preview-link" href="' + esc(p.site_path) + '" target="_blank" rel="noopener">' + esc(p.label) + "</a>"
                        )
                        .join("")
                    : "") +
                  "</div>";

            const flags = [];
            if (v2 && run.pareto_within_provider) flags.push('<span class="badge ok">Pareto</span>');
            if (v2 && run.rounds_completed) flags.push('<span class="badge neutral">' + esc(run.rounds_completed) + "</span>");
            if (v2 && run.partial_eval) flags.push('<span class="badge warn">partial_eval</span>');
            if (isFailed) flags.push('<span class="badge bad">' + esc(run.status) + "</span>");
            if (run.invalid) flags.push('<span class="badge warn">invalid</span>');
            if (run.leakage_flagged) flags.push('<span class="badge bad">leakage</span>');
            if (flags.length === 0) flags.push('<span class="badge ok">clean</span>');

            const isExpanded = state.expanded.has(run.run_id);
            const tokRatioStr =
              run.efficiency?.provider_tok_ratio !== null && run.efficiency?.provider_tok_ratio !== undefined
                ? Number(run.efficiency.provider_tok_ratio).toFixed(2) + "×"
                : "—";

            let html =
              '<tr class="main-row" data-run="' + esc(run.run_id) + '" style="cursor:pointer">' +
              '<td class="rank">' + rankStr + "</td>" +
              '<td class="mono">' + esc(run.run_id) + "</td>" +
              '<td><span class="badge neutral">' + esc(run.room_key) + "</span></td>" +
              "<td>" + esc(run.model) + "</td>" +
              (v2
                ? '<td><span class="badge neutral">' + esc(run.efficiency?.provider_group || "—") + '</span></td>' +
                  '<td class="mono">' + esc(run.efficiency?.cli_source || "—") + "</td>"
                : "") +
              '<td class="num"><span class="score-pill">' + esc(fmt(run.composite)) + "</span></td>" +
              '<td class="num">' + esc(fmt(run.axes.craft)) + "</td>" +
              '<td class="num">' + esc(fmt(run.axes.visual_quality)) + "</td>" +
              '<td class="num">' + esc(fmt(run.axes.revision)) + "</td>" +
              '<td class="num">' + esc(fmt(run.reliability)) + "</td>" +
              '<td class="num">' + esc(fmt(activeVal)) + "</td>" +
              (v2
                ? '<td class="num">' + esc(fmtTok(run.efficiency?.tokens_out_reas)) + "</td>" +
                  '<td class="num">' + esc(tokRatioStr) + "</td>" +
                  '<td class="num">' + esc(fmtTok(run.efficiency?.tokens_cache_read)) + "</td>"
                : '<td class="num">' + esc(fmtTok(run.efficiency.tokens_out)) + "</td>") +
              '<td class="num">' + esc(fmtTok(run.efficiency.tokens_total)) + "</td>" +
              "<td>" + gateBadge + "</td>" +
              "<td>" + previewHtml + "</td>" +
              "<td>" + flags.join(" ") + "</td>" +
              "</tr>";

            if (isExpanded) {
              const gatesList = Object.entries(run.gates_detail || {})
                .map(([gid, g]) => {
                  const cls = g?.pass === true ? "ok" : g?.pass === false ? "bad" : "neutral";
                  const txt = g?.pass === true ? "PASS" : g?.pass === false ? "FAIL" : "SKIP";
                  return '<div><span class="badge ' + cls + '">' + esc(gid + ": " + txt) + "</span> " + esc(g?.detail || "") + "</div>";
                })
                .join("");

              const thumbs =
                run.previews && run.previews.length > 0
                  ? '<div class="thumbs">' +
                    run.previews
                      .map(
                        (p) =>
                          '<a href="' +
                          esc(p.site_path) +
                          '" target="_blank" rel="noopener"><img src="' +
                          esc(p.site_path) +
                          '" alt="' +
                          esc(run.run_id + " " + p.label) +
                          '" loading="lazy" /></a>'
                      )
                      .join("") +
                    "</div>"
                  : "<div>No preview contact sheets attached.</div>";

              const tcHtml = run.toolchain
                ? "<div>Toolchain: <span class=mono>" +
                  esc([run.toolchain.node_version, run.toolchain.python_version, run.toolchain.swiftshader_renderer].filter(Boolean).join(" · ")) +
                  "</span></div>"
                : "";

              html +=
                '<tr class="detail-row"><td colspan="' + (v2 ? "19" : "15") + '"><div class="detail-grid">' +
                '<div class="detail-box"><h4>Metadata & Efficiency</h4>' +
                "<div>Run ID: <span class=mono>" + esc(run.run_id) + "</span></div>" +
                (run.status ? "<div>Status: <span class=mono>" + esc(run.status) + "</span></div>" : "") +
                (run.reason ? "<div>Reason: " + esc(run.reason) + "</div>" : "") +
                (v2 ? "<div>Provider / CLI: " + esc((run.efficiency?.provider_group || "—") + " / " + (run.efficiency?.cli_source || "—")) + "</div>" : "") +
                (run.rounds_completed ? "<div>Chain Rounds: " + esc(run.rounds_completed) + "</div>" : "") +
                "<div>Seeds: " + esc(run.seeds) + (run.seed !== null ? " (seed=" + esc(run.seed) + ")" : "") + "</div>" +
                "<div>Active min: " + esc(fmt(activeVal, 2)) + "</div>" +
                "<div>Wall min: " + esc(fmt(run.efficiency.wall_min, 2)) + "</div>" +
                "<div>Output tok: " + esc(fmtTok(run.efficiency.tokens_out)) + "</div>" +
                (v2 ? "<div>Out+Reas tok: " + esc(fmtTok(run.efficiency.tokens_out_reas)) + " (" + esc(tokRatioStr) + ")</div>" : "") +
                (v2 ? "<div>Cache Read tok: " + esc(fmtTok(run.efficiency.tokens_cache_read)) + "</div>" : "") +
                "<div>Total tok: " + esc(fmtTok(run.efficiency.tokens_total)) + "</div>" +
                "<div>Taste: " + esc(run.taste === null ? "null (human only)" : fmt(run.taste)) + "</div>" +
                tcHtml +
                (isFailed ? "" : "<div>Live View: <a class='preview-link' href='../gallery/runs/" + esc(run.run_id) + "/' target='_blank' rel='noopener'>Open in Gallery ↗</a></div>") +
                (run.diff_file ? "<div>Diff: <span class=mono>" + esc(run.diff_file) + "</span></div>" : "") +
                "</div>" +
                '<div class="detail-box"><h4>Gates</h4>' + (gatesList || "—") + "</div>" +
                '<div class="detail-box"><h4>Preview Contact Sheets</h4>' + thumbs + "</div>" +
                "</div></td></tr>";
            }
            return html;
          })
          .join("");

        wrap.innerHTML = "<table>" + thead + "<tbody>" + tbody + "</tbody></table>";

        wrap.querySelectorAll("th.sortable").forEach((th) => {
          th.addEventListener("click", () => {
            const key = th.getAttribute("data-sort");
            if (state.sortBy === key) {
              state.sortDir = state.sortDir === "desc" ? "asc" : "desc";
            } else {
              state.sortBy = key;
              state.sortDir =
                key === "active_min" || key === "wall_min" || key === "model" || key === "run_id" || key === "provider_tok_ratio"
                  ? "asc"
                  : "desc";
            }
            renderRuns(state.data);
          });
        });

        wrap.querySelectorAll("tr.main-row").forEach((tr) => {
          tr.addEventListener("click", (ev) => {
            if (ev.target && ev.target.closest("a")) return;
            const id = tr.getAttribute("data-run");
            if (state.expanded.has(id)) state.expanded.delete(id);
            else state.expanded.add(id);
            renderRuns(state.data);
          });
        });
      }

      document.getElementById("search-input").addEventListener("input", (ev) => {
        state.query = ev.target.value;
        renderRuns(state.data);
      });

      renderAll();

      Promise.all([
        fetch("./data.json").then((r) => (r.ok ? r.json() : null)).catch(() => null),
        fetch("./data-v2.json").then((r) => (r.ok ? r.json() : null)).catch(() => null)
      ]).then(([freshV1, freshV2]) => {
        if (freshV1 && freshV1.runs) datasets.v1 = freshV1;
        if (freshV2 && freshV2.runs) datasets.v2 = freshV2;
        if (datasets[state.activeVersion]) {
          state.data = datasets[state.activeVersion];
          renderAll();
        }
      });
    })();
  </script>
</body>
</html>
`;
}

export function generateLeaderboard({
  resultsDir = path.join(DEFAULT_REPO_ROOT, "results"),
  resultsV2Dir = null,
  outMdPath = null,
  outV2MdPath = null,
  siteDir = path.join(DEFAULT_REPO_ROOT, "site", "leaderboard"),
  version = null,
  writeV1Md = true,
  writeV2Md = true
} = {}) {
  const resolvedResultsDir = path.resolve(resultsDir);
  const resolvedSiteDir = path.resolve(siteDir);
  const resolvedMdPath = outMdPath ? path.resolve(outMdPath) : path.join(resolvedResultsDir, "leaderboard.md");
  const effectiveVersion = version === 2 || version === "2" ? 2 : 1;

  const loadedV1 = loadResultFiles(resolvedResultsDir);
  const data = buildLeaderboardData(loadedV1, {
    resultsDir: resolvedResultsDir,
    siteDir: resolvedSiteDir,
    copyPreviews: true,
    version: effectiveVersion
  });

  if (writeV1Md) {
    const md = formatLeaderboardMarkdown(data, { version: effectiveVersion });
    try {
      fs.mkdirSync(path.dirname(resolvedMdPath), { recursive: true });
      fs.writeFileSync(resolvedMdPath, md, "utf8");
    } catch {
      // Read-only filesystem fallback
    }
  }

  let dataV2 = null;
  let resolvedV2MdPath = null;
  const resolvedResultsV2Dir = resultsV2Dir ? path.resolve(resultsV2Dir) : null;
  if (resolvedResultsV2Dir) {
    const loadedV2 = loadResultFiles(resolvedResultsV2Dir);
    dataV2 = buildLeaderboardData(loadedV2, {
      resultsDir: resolvedResultsV2Dir,
      siteDir: resolvedSiteDir,
      copyPreviews: true,
      version: 2
    });
    resolvedV2MdPath = outV2MdPath ? path.resolve(outV2MdPath) : path.join(resolvedResultsV2Dir, "leaderboard.md");
    if (writeV2Md && (fs.existsSync(resolvedResultsV2Dir) || loadedV2.length > 0)) {
      const mdV2 = formatLeaderboardMarkdown(dataV2, { version: 2 });
      try {
        fs.mkdirSync(path.dirname(resolvedV2MdPath), { recursive: true });
        fs.writeFileSync(resolvedV2MdPath, mdV2, "utf8");
      } catch {
        // Read-only filesystem fallback
      }
    }
  }

  const dataJsonPath = path.join(resolvedSiteDir, "data.json");
  const dataV2JsonPath = path.join(resolvedSiteDir, "data-v2.json");
  const indexHtmlPath = path.join(resolvedSiteDir, "index.html");
  const defaultHtmlVer =
    effectiveVersion === 2
      ? "v2"
      : (dataV2 && dataV2.runs.length > 0 && version === null ? "v2" : "v1");
  try {
    fs.mkdirSync(resolvedSiteDir, { recursive: true });
    fs.writeFileSync(dataJsonPath, JSON.stringify(data, null, 2) + "\n", "utf8");
    if (dataV2) {
      fs.writeFileSync(dataV2JsonPath, JSON.stringify(dataV2, null, 2) + "\n", "utf8");
      fs.writeFileSync(
        indexHtmlPath,
        buildLeaderboardHtml({ v1: data, v2: dataV2, defaultVersion: defaultHtmlVer }),
        "utf8"
      );
    } else {
      fs.writeFileSync(indexHtmlPath, buildLeaderboardHtml(data), "utf8");
    }
  } catch {
    // Read-only filesystem fallback
  }

  return {
    data,
    dataV2,
    markdownPath: resolvedMdPath,
    markdownV2Path: resolvedV2MdPath,
    dataJsonPath,
    dataV2JsonPath: dataV2 ? dataV2JsonPath : null,
    indexHtmlPath
  };
}

function main() {
  const flags = parseArgs(process.argv.slice(2));
  if (flags.help || flags.h) {
    console.log(
      "Usage: node harness/src/leaderboard.mjs [--version 1|2|all] [--results <dir>] [--results-v2 <dir>] [--out-md <file>] [--site-dir <dir>]"
    );
    return;
  }
  const vFlag = flags.version ? String(flags.version) : "default";
  const resultsDir = flags.results || path.join(DEFAULT_REPO_ROOT, "results");
  const resultsV2Dir = flags["results-v2"] || path.join(DEFAULT_REPO_ROOT, "results-v2");
  // Per V02-DESIGN §2.4: results/leaderboard.md stays untouched unless --version 1, --all, or explicit --results is passed.
  const writeV1Md = Boolean(flags.results || flags.all || vFlag === "1" || vFlag === "all");
  const writeV2Md = Boolean(flags["results-v2"] || flags.all || vFlag === "2" || vFlag === "all" || vFlag === "default");

  const out = generateLeaderboard({
    resultsDir,
    resultsV2Dir: vFlag === "1" ? null : resultsV2Dir,
    outMdPath: flags["out-md"] || null,
    siteDir: flags["site-dir"] || path.join(DEFAULT_REPO_ROOT, "site", "leaderboard"),
    version: vFlag === "2" ? 2 : null,
    writeV1Md,
    writeV2Md
  });
  console.log(
    JSON.stringify(
      {
        runs: out.data.summary.total_runs,
        runs_v2: out.dataV2 ? out.dataV2.summary.total_runs : 0,
        models: out.data.summary.models_count,
        markdown: writeV1Md ? out.markdownPath : null,
        markdownV2: out.markdownV2Path,
        dataJson: out.dataJsonPath,
        dataV2Json: out.dataV2JsonPath,
        indexHtml: out.indexHtmlPath
      },
      null,
      2
    )
  );
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
