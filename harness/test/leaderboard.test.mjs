import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { generateLeaderboard } from "../src/leaderboard.mjs";
import { buildGallery } from "../src/gallery.mjs";

test("leaderboard uses active_min with wall_min fallback, handles no-submission, and is deterministic", async () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "mol-lb-awake-"));
  try {
    const resultsDir = path.join(tmpBase, "results");
    const siteDir = path.join(tmpBase, "site", "leaderboard");
    const galleryDir = path.join(tmpBase, "site", "gallery");
    fs.mkdirSync(resultsDir, { recursive: true });

    const fixtures = [
      {
        run_id: "aurora__model-a",
        room: "aurora",
        track: "build",
        model: "Model A",
        created_at: "2026-11-21T10:00:00Z",
        ended_at: "2026-11-21T12:00:00Z",
        gates: { "G-load": { pass: true }, "G-report": { pass: true } },
        axes: { craft: 9.0, visual_quality: 8.0, reliability: 10 },
        composite: 8.7,
        efficiency: { wall_min: 120.0, active_min: 6.0 }
      },
      {
        run_id: "lobby__model-a",
        room: "lobby",
        track: "build",
        model: "Model A",
        created_at: "2026-11-20T10:00:00Z",
        ended_at: "2026-11-20T10:14:00Z",
        gates: { "G-load": { pass: true }, "G-report": { pass: true } },
        axes: { craft: 8.0, visual_quality: 8.0, reliability: 10 },
        composite: 8.3,
        // Old result without active_min -> falls back to wall_min (14.0)
        efficiency: { wall_min: 14.0 }
      },
      {
        run_id: "aurora__empty-model",
        room: "aurora",
        track: "build",
        model: "Empty Model",
        created_at: "2026-11-21T15:00:00Z",
        ended_at: "2026-11-21T15:01:00Z",
        status: "no-submission",
        reason: "No files changed vs start commit",
        gates: {},
        axes: {},
        composite: null,
        taste: null,
        efficiency: { wall_min: 1.0, active_min: 0.0, tokens: null }
      }
    ];

    for (const f of fixtures) {
      fs.writeFileSync(path.join(resultsDir, `${f.run_id}.json`), JSON.stringify(f, null, 2));
    }

    const out1 = generateLeaderboard({ resultsDir, siteDir });
    const md1 = fs.readFileSync(out1.markdownPath, "utf8");
    const data1 = fs.readFileSync(out1.dataJsonPath, "utf8");
    const html1 = fs.readFileSync(out1.indexHtmlPath, "utf8");

    // Active (min) shown instead of Wall (min); Model A avg = (6.0 + 14.0) / 2 = 10.0
    assert.match(md1, /Avg Active \(min\)/);
    assert.match(md1, /Active \(min\)/);
    assert.doesNotMatch(md1, /Avg Wall \(min\)/);
    assert.equal(out1.data.overall[0].model, "Model A");
    assert.equal(out1.data.overall[0].avg_active_min, 10);

    // Empty Model is unranked at bottom with composite null and no-submission flag
    const emptyOverall = out1.data.overall.find((m) => m.model === "Empty Model");
    assert.ok(emptyOverall);
    assert.equal(emptyOverall.composite, null);
    assert.equal(emptyOverall.runs_count, 0);
    assert.equal(emptyOverall.failed_count, 1);

    assert.match(md1, /\| — \| Empty Model \| — \|/);
    assert.match(md1, /\| — \| aurora__empty-model \| Empty Model \| — \|.*\| failed \| — \| no-submission:No files changed vs start commit \|/);
    assert.match(html1, /Active \(min\)/);
    assert.match(html1, /no-submission/);

    // Deterministic regeneration (no timestamp churn)
    await new Promise((r) => setTimeout(r, 20));
    const out2 = generateLeaderboard({ resultsDir, siteDir });
    assert.equal(fs.readFileSync(out2.markdownPath, "utf8"), md1);
    assert.equal(fs.readFileSync(out2.dataJsonPath, "utf8"), data1);
    assert.equal(fs.readFileSync(out2.indexHtmlPath, "utf8"), html1);

    // Gallery skips no-submission runs gracefully without crashing
    const gal = await buildGallery({ resultsDir, siteDir: galleryDir });
    assert.equal(gal.runsCount, 2);
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
});
