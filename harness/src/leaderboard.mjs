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
    if (entry.name === "data.json" || entry.name === "leaderboard.json") continue;
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

export function buildLeaderboardData(loadedResults, opts = {}) {
  const resultsDir = opts.resultsDir ? path.resolve(opts.resultsDir) : null;
  const siteDir = opts.siteDir ? path.resolve(opts.siteDir) : null;
  const copyPreviews = Boolean(opts.copyPreviews && siteDir);

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

    return {
      run_id: runId,
      model: r.model || "unknown",
      room: r.room,
      renovation: r.renovation || null,
      room_key: roomKey,
      track: r.track || (r.renovation ? "renovation" : "build"),
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
      efficiency: {
        active_min: activeMin,
        wall_min: wallMin,
        tokens_in: r.efficiency?.tokens?.input ?? r.efficiency?.tokens_in ?? null,
        tokens_out: r.efficiency?.tokens?.output ?? r.efficiency?.tokens_out ?? null,
        tokens_total: r.efficiency?.tokens?.total ?? null,
        tokens: r.efficiency?.tokens ?? null,
        usd: r.efficiency?.usd ?? null
      },
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

  // Sort helper: composite_raw desc (nulls last), reliability desc, active_min (fallback wall_min) asc, run_id asc
  const compareRuns = (a, b) => {
    const ac = a.composite_raw;
    const bc = b.composite_raw;
    if (ac === null && bc !== null) return 1;
    if (ac !== null && bc === null) return -1;
    if (ac !== null && bc !== null && bc !== ac) return bc - ac;
    const ar = a.axes_raw.reliability ?? -1;
    const br = b.axes_raw.reliability ?? -1;
    if (br !== ar) return br - ar;
    const aw = (a.efficiency.active_min ?? a.efficiency.wall_min) ?? Infinity;
    const bw = (b.efficiency.active_min ?? b.efficiency.wall_min) ?? Infinity;
    if (aw !== bw) return aw - bw;
    return a.run_id.localeCompare(b.run_id);
  };

  const isFailedRun = (r) => r.status === "no-submission" || r.status === "collect-error";

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
    const roomScores = {};

    for (const [roomKey, rList] of byRoom.entries()) {
      const cMean = meanOf(rList.map((x) => x.composite_raw));
      const crMean = meanOf(rList.map((x) => x.axes_raw.craft));
      const vqMean = meanOf(rList.map((x) => x.axes_raw.visual_quality));
      const rvMean = meanOf(rList.map((x) => x.axes_raw.revision));
      const rlMean = meanOf(rList.map((x) => x.axes_raw.reliability));
      const aMean = meanOf(rList.map((x) => x.efficiency.active_min ?? x.efficiency.wall_min));
      const wMean = meanOf(rList.map((x) => x.efficiency.wall_min));

      if (cMean !== null) roomComposites.push(cMean);
      if (crMean !== null) roomCrafts.push(crMean);
      if (vqMean !== null) roomVqs.push(vqMean);
      if (rvMean !== null) roomRevs.push(rvMean);
      if (rlMean !== null) roomRels.push(rlMean);
      if (aMean !== null) roomActives.push(aMean);
      if (wMean !== null) roomWalls.push(wMean);

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

    overall.push({
      model,
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

export function formatLeaderboardMarkdown(data) {
  const lines = [];
  lines.push("# MoL-Bench Leaderboard");
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
      lines.push(
        "| Rank | Run ID | Model | Composite | Craft | Visual Quality | Revision | Reliability | Active (min) | Output tok | Total tok | Gates | Previews | Flags |"
      );
      lines.push("|---:|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---|---|---|");
      roomObj.runs.forEach((run, idx) => {
        const isFailed = run.status === "no-submission" || run.status === "collect-error";
        const rank = isFailed || run.composite === null ? "—" : idx + 1;
        const activeVal = run.efficiency.active_min ?? run.efficiency.wall_min;
        const active = activeVal === null || activeVal === undefined ? "—" : Number(activeVal).toFixed(1);
        const outTok = formatTok(run.efficiency.tokens_out);
        const totTok = formatTok(run.efficiency.tokens_total);
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
        if (run.gates.failed.length > 0) flags.push(`fail:${run.gates.failed.join(",")}`);
        lines.push(
          `| ${rank} | ${run.run_id} | ${run.model} | ${formatNum(run.composite)} | ${formatNum(
            run.axes.craft
          )} | ${formatNum(run.axes.visual_quality)} | ${formatNum(run.axes.revision)} | ${formatNum(
            run.reliability
          )} | ${active} | ${outTok} | ${totTok} | ${gates} | ${previews} | ${flags.length > 0 ? flags.join("; ") : "—"} |`
        );
      });
      lines.push("");
    }
  }

  return lines.join("\n");
}

export function buildLeaderboardHtml(data) {
  const safeJson = JSON.stringify(data).replace(/</g, "\\u003c");
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

      let state = {
        data: window.__LEADERBOARD_DATA__,
        room: "ALL",
        query: "",
        sortBy: "composite_raw",
        sortDir: "desc",
        expanded: new Set()
      };

      function renderAll() {
        const data = state.data;
        if (!data) return;

        document.getElementById("meta-line").textContent =
          data.summary.models_count + " models · " + data.summary.rooms_count + " rooms · " + data.summary.total_runs + " runs";
        document.getElementById("generated-at").textContent = "Generated: " + data.generated_at;

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
          wrap.innerHTML = '<div class="empty">No graded runs yet. Run <code>node runner/collect.mjs</code> and <code>node harness/src/leaderboard.mjs</code>.</div>';
          return;
        }
        const rows = data.overall
          .map((m, idx) => {
            const rankStr = m.composite === null ? "—" : "#" + (idx + 1);
            const activeVal = m.avg_active_min ?? m.avg_wall_min;
            const roomBadges = Object.entries(m.room_scores || {})
              .map(([rk, rs]) => '<span class="badge neutral">' + esc(rk) + ": " + esc(fmt(rs.composite)) + "</span>")
              .join(" ");
            return (
              '<tr class="main-row">' +
              '<td class="rank">' + rankStr + "</td>" +
              "<td><strong>" + esc(m.model) + "</strong>" +
              (m.failed_count > 0 && m.runs_count === 0 ? ' <span class="badge bad">failed:' + m.failed_count + "</span>" : "") +
              (m.leakage_count > 0 ? ' <span class="badge bad">leakage:' + m.leakage_count + "</span>" : "") +
              "</td>" +
              '<td class="num"><span class="score-pill">' + esc(fmt(m.composite)) + "</span></td>" +
              '<td class="num">' + esc(fmt(m.axes.craft)) + "</td>" +
              '<td class="num">' + esc(fmt(m.axes.visual_quality)) + "</td>" +
              '<td class="num">' + esc(fmt(m.axes.revision)) + "</td>" +
              '<td class="num">' + esc(fmt(m.reliability)) + "</td>" +
              '<td class="num">' + esc(fmt(activeVal)) + "</td>" +
              '<td class="num">' + esc(m.rooms_count) + "</td>" +
              '<td class="num">' + esc(m.runs_count) + "</td>" +
              "<td>" + (roomBadges || "—") + "</td>" +
              "</tr>"
            );
          })
          .join("");

        wrap.innerHTML =
          "<table><thead><tr>" +
          "<th>Rank</th><th>Model</th><th class=num>Composite</th><th class=num>Craft</th><th class=num>Visual Quality</th><th class=num>Revision</th><th class=num>Reliability</th><th class=num>Avg Active (min)</th><th class=num>Rooms</th><th class=num>Runs</th><th>Room Breakdown</th>" +
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
                r.room_key.toLowerCase().includes(q)
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

        const headers = [
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
            if (isFailed) flags.push('<span class="badge bad">' + esc(run.status) + "</span>");
            if (run.invalid) flags.push('<span class="badge warn">invalid</span>');
            if (run.leakage_flagged) flags.push('<span class="badge bad">leakage</span>');
            if (flags.length === 0) flags.push('<span class="badge ok">clean</span>');

            const isExpanded = state.expanded.has(run.run_id);
            let html =
              '<tr class="main-row" data-run="' + esc(run.run_id) + '" style="cursor:pointer">' +
              '<td class="rank">' + rankStr + "</td>" +
              '<td class="mono">' + esc(run.run_id) + "</td>" +
              '<td><span class="badge neutral">' + esc(run.room_key) + "</span></td>" +
              "<td>" + esc(run.model) + "</td>" +
              '<td class="num"><span class="score-pill">' + esc(fmt(run.composite)) + "</span></td>" +
              '<td class="num">' + esc(fmt(run.axes.craft)) + "</td>" +
              '<td class="num">' + esc(fmt(run.axes.visual_quality)) + "</td>" +
              '<td class="num">' + esc(fmt(run.axes.revision)) + "</td>" +
              '<td class="num">' + esc(fmt(run.reliability)) + "</td>" +
              '<td class="num">' + esc(fmt(activeVal)) + "</td>" +
              '<td class="num">' + esc(fmtTok(run.efficiency.tokens_out)) + "</td>" +
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

              html +=
                '<tr class="detail-row"><td colspan="15"><div class="detail-grid">' +
                '<div class="detail-box"><h4>Metadata & Efficiency</h4>' +
                "<div>Run ID: <span class=mono>" + esc(run.run_id) + "</span></div>" +
                (run.status ? "<div>Status: <span class=mono>" + esc(run.status) + "</span></div>" : "") +
                (run.reason ? "<div>Reason: " + esc(run.reason) + "</div>" : "") +
                "<div>Seeds: " + esc(run.seeds) + (run.seed !== null ? " (seed=" + esc(run.seed) + ")" : "") + "</div>" +
                "<div>Active min: " + esc(fmt(activeVal, 2)) + "</div>" +
                "<div>Wall min: " + esc(fmt(run.efficiency.wall_min, 2)) + "</div>" +
                "<div>Output tok: " + esc(fmtTok(run.efficiency.tokens_out)) + "</div>" +
                "<div>Total tok: " + esc(fmtTok(run.efficiency.tokens_total)) + "</div>" +
                "<div>Taste: " + esc(run.taste === null ? "null (human only)" : fmt(run.taste)) + "</div>" +
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
              state.sortDir = key === "active_min" || key === "wall_min" || key === "model" || key === "run_id" ? "asc" : "desc";
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

      fetch("./data.json")
        .then((res) => (res.ok ? res.json() : null))
        .then((fresh) => {
          if (fresh && fresh.runs) {
            state.data = fresh;
            renderAll();
          }
        })
        .catch(() => {
          // Offline / file:// fallback uses embedded window.__LEADERBOARD_DATA__
        });
    })();
  </script>
</body>
</html>
`;
}

export function generateLeaderboard({
  resultsDir = path.join(DEFAULT_REPO_ROOT, "results"),
  outMdPath = null,
  siteDir = path.join(DEFAULT_REPO_ROOT, "site", "leaderboard")
} = {}) {
  const resolvedResultsDir = path.resolve(resultsDir);
  const resolvedSiteDir = path.resolve(siteDir);
  const resolvedMdPath = outMdPath ? path.resolve(outMdPath) : path.join(resolvedResultsDir, "leaderboard.md");

  const loaded = loadResultFiles(resolvedResultsDir);
  const data = buildLeaderboardData(loaded, {
    resultsDir: resolvedResultsDir,
    siteDir: resolvedSiteDir,
    copyPreviews: true
  });

  const md = formatLeaderboardMarkdown(data);
  try {
    fs.mkdirSync(path.dirname(resolvedMdPath), { recursive: true });
    fs.writeFileSync(resolvedMdPath, md, "utf8");
  } catch {
    // Read-only filesystem fallback
  }

  const dataJsonPath = path.join(resolvedSiteDir, "data.json");
  const indexHtmlPath = path.join(resolvedSiteDir, "index.html");
  try {
    fs.mkdirSync(resolvedSiteDir, { recursive: true });
    fs.writeFileSync(dataJsonPath, JSON.stringify(data, null, 2) + "\n", "utf8");
    fs.writeFileSync(indexHtmlPath, buildLeaderboardHtml(data), "utf8");
  } catch {
    // Read-only filesystem fallback
  }

  return {
    data,
    markdownPath: resolvedMdPath,
    dataJsonPath,
    indexHtmlPath
  };
}

function main() {
  const flags = parseArgs(process.argv.slice(2));
  if (flags.help || flags.h) {
    console.log("Usage: node harness/src/leaderboard.mjs [--results <dir>] [--out-md <file>] [--site-dir <dir>]");
    return;
  }
  const out = generateLeaderboard({
    resultsDir: flags.results || path.join(DEFAULT_REPO_ROOT, "results"),
    outMdPath: flags["out-md"] || null,
    siteDir: flags["site-dir"] || path.join(DEFAULT_REPO_ROOT, "site", "leaderboard")
  });
  console.log(
    JSON.stringify(
      {
        runs: out.data.summary.total_runs,
        models: out.data.summary.models_count,
        markdown: out.markdownPath,
        dataJson: out.dataJsonPath,
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
