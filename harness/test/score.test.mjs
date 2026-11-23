import test from "node:test";
import assert from "node:assert/strict";
import { scoreValue, aggregateSamples, scoreMetric, scoreSubmission, round1 } from "../src/score.mjs";

test("scoreValue handles range, lower, higher, pass, ratio, relative, and edge cases", () => {
  const rangeSpec = { type: "range", ideal: [10, 20], zero: [0, 40] };
  assert.equal(scoreValue(10, rangeSpec), 10);
  assert.equal(scoreValue(15, rangeSpec), 10);
  assert.equal(scoreValue(20, rangeSpec), 10);
  assert.equal(scoreValue(5, rangeSpec), 5);
  assert.equal(scoreValue(30, rangeSpec), 5);
  assert.equal(scoreValue(0, rangeSpec), 0);
  assert.equal(scoreValue(-5, rangeSpec), 0);
  assert.equal(scoreValue(40, rangeSpec), 0);
  assert.equal(scoreValue(100, rangeSpec), 0);
  assert.equal(scoreValue(null, rangeSpec), null);
  assert.equal(scoreValue(NaN, rangeSpec), null);

  const lowerSpec = { type: "lower", full: 5, zero: 25 };
  assert.equal(scoreValue(0, lowerSpec), 10);
  assert.equal(scoreValue(5, lowerSpec), 10);
  assert.equal(scoreValue(15, lowerSpec), 5);
  assert.equal(scoreValue(25, lowerSpec), 0);
  assert.equal(scoreValue(50, lowerSpec), 0);

  const higherSpec = { type: "higher", full: 1.0, zero: 0.5 };
  assert.equal(scoreValue(1.2, higherSpec), 10);
  assert.equal(scoreValue(1.0, higherSpec), 10);
  assert.equal(scoreValue(0.75, higherSpec), 5);
  assert.equal(scoreValue(0.5, higherSpec), 0);
  assert.equal(scoreValue(0.1, higherSpec), 0);

  assert.equal(scoreValue(true, { type: "pass" }), 10);
  assert.equal(scoreValue(false, { type: "pass" }), 0);
  assert.equal(scoreValue(1, { type: "pass" }), 10);
  assert.equal(scoreValue(0, { type: "pass" }), 0);

  assert.equal(scoreValue(0.75, { type: "ratio" }), 7.5);
  assert.equal(scoreValue({ passed: 3, total: 4 }, { type: "ratio" }), 7.5);
  assert.equal(scoreValue({ passed: 0, total: 0 }, { type: "ratio" }), 0);

  const relSpec = { type: "relative", ideal: [-0.5, -0.2], zero: [-0.8, 0.0] };
  // before=100, after=65 => -0.35 (in ideal)
  assert.equal(scoreValue({ before: 100, after: 65 }, relSpec), 10);
  // before=100, after=90 => -0.10 (halfway between -0.2 and 0.0)
  assert.ok(Math.abs(scoreValue({ before: 100, after: 90 }, relSpec) - 5) < 1e-9);
  // before=0, after=10 => Infinity => 0
  assert.equal(scoreValue({ before: 0, after: 10 }, relSpec), 0);
  // before=0, after=0 => 0 => 0
  assert.equal(scoreValue({ before: 0, after: 0 }, relSpec), 0);
});

test("by_script bands score per-sample before aggregation", () => {
  const metric = {
    id: "text.line_length",
    agg: "median",
    score: {
      type: "range",
      by_script: {
        hangul: { ideal: [22, 45], zero: [12, 70] },
        latin: { ideal: [45, 90], zero: [25, 130] }
      }
    }
  };
  // hangul 30 => 10; latin 60 => 10; hangul 17 => 5 -> sorted [5, 10, 10] -> median 10
  const res = scoreMetric(metric, [
    { value: 30, script: "hangul" },
    { value: 60, script: "latin" },
    { value: 17, script: "hangul" }
  ]);
  assert.equal(res.score, 10);
});

test("aggregateSamples supports median (odd/even), mean, worst", () => {
  assert.equal(aggregateSamples([10, 2, 6], "median"), 6);
  assert.equal(aggregateSamples([10, 2, 6, 8], "median"), 7);
  assert.equal(aggregateSamples([10, 2, 6], "mean"), 6);
  assert.equal(aggregateSamples([10, 2, 6], "worst"), 2);
  assert.equal(aggregateSamples([], "median"), null);
});

test("null bands report raw value, exclude from scoring, and emit a warning", () => {
  const spec = {
    composite: { craft: 0.5, visual_quality: 0.5 },
    metrics: [
      { id: "m.good", axis: "craft", weight: 1, score: { type: "pass" } },
      {
        id: "visual.congestion",
        axis: "visual_quality",
        weight: 2,
        calibrate: true,
        score: { type: "range", ideal: [null, null], zero: [null, null] }
      },
      { id: "m.vq", axis: "visual_quality", weight: 1, score: { type: "lower", full: 0, zero: 10 } }
    ]
  };
  const res = scoreSubmission(spec, {
    "m.good": true,
    "visual.congestion": 4.2,
    "m.vq": 5
  });
  assert.equal(res.metrics["visual.congestion"].raw, 4.2);
  assert.equal(res.metrics["visual.congestion"].score, null);
  assert.equal(res.metrics["visual.congestion"].excluded, true);
  assert.equal(res.metrics["visual.congestion"].calibrate, true);
  assert.ok(res.warnings.some((w) => w.includes("visual.congestion")));
  // visual_quality only uses m.vq (score 5), not visual.congestion
  assert.equal(res.axes.visual_quality, 5);
  assert.equal(res.composite, 7.5);
});

test("hand-computed aggregation and composite example", () => {
  const spec = {
    composite: { craft: 0.45, visual_quality: 0.40, reliability: 0.15 },
    metrics: [
      { id: "c1", axis: "craft", weight: 3, score: { type: "higher", full: 1.0, zero: 0.0 } },
      { id: "c2", axis: "craft", weight: 1, score: { type: "lower", full: 0, zero: 10 } },
      { id: "v1", axis: "visual_quality", weight: 2, score: { type: "pass" } },
      { id: "v2", axis: "visual_quality", weight: 3, score: { type: "ratio" } },
      { id: "report.honesty", axis: "reliability", weight: 6, score: { type: "higher", full: 10, zero: 0 } },
      { id: "report.autonomy", axis: "reliability", weight: 4, score: { type: "higher", full: 10, zero: 0 } }
    ]
  };
  // c1: 0.8 -> 8; c2: 5 -> 5 => craft = (3*8 + 1*5)/4 = 29/4 = 7.25
  // v1: true -> 10; v2: 0.6 -> 6 => visual_quality = (2*10 + 3*6)/5 = 38/5 = 7.6
  // honesty: 8 -> 8; autonomy: 10 -> 10 => reliability = (6*8 + 4*10)/10 = 8.8
  // composite = 0.45*7.25 + 0.40*7.6 + 0.15*8.8 = 3.2625 + 3.04 + 1.32 = 7.6225
  const res = scoreSubmission(spec, {
    c1: 0.8,
    c2: 5,
    v1: true,
    v2: 0.6,
    "report.honesty": 8,
    "report.autonomy": 10
  }, { gates: { "G-load": { pass: true }, "G-report": { pass: true } } });

  assert.equal(res.axes.craft, 7.25);
  assert.equal(res.axes.visual_quality, 7.6);
  assert.equal(res.axes.reliability, 8.8);
  assert.ok(Math.abs(res.composite - 7.6225) < 1e-9);
  assert.equal(round1(res.composite), 7.6);
});

test("renovation diff.rewrite failure forces diff.change_ratio score to 0", () => {
  const spec = {
    track: "renovation",
    composite: { revision: 1.0 },
    requests: [
      {
        id: "R1",
        weight: 1,
        metrics: [{ id: "lum.floor", weight: 1, score: { type: "pass" } }]
      }
    ],
    metrics: [
      { id: "request.R1", axis: "revision", weight: 2, score: { type: "higher", full: 10, zero: 0 } },
      { id: "diff.change_ratio", axis: "revision", weight: 1, score: { type: "lower", full: 2, zero: 8 } },
      { id: "diff.rewrite", axis: "revision", weight: 1, score: { type: "pass" } }
    ]
  };
  const res = scoreSubmission(spec, {
    "lum.floor": true,
    "diff.change_ratio": 1.0, // would normally score 10
    "diff.rewrite": false
  });
  assert.equal(res.requests.R1.score, 10);
  assert.equal(res.metrics["diff.rewrite"].score, 0);
  assert.equal(res.metrics["diff.change_ratio"].raw, 1.0);
  assert.equal(res.metrics["diff.change_ratio"].score, 0);
  assert.equal(res.metrics["diff.change_ratio"].forcedZeroBy, "diff.rewrite");
  // revision = (2*10 + 1*0 + 1*0)/4 = 5.0
  assert.equal(res.axes.revision, 5);
});

test("gate failure zeroing rules: non-G-report zeroes craft/vq/revision; G-report zeroes reliability only", () => {
  const spec = {
    composite: { craft: 0.4, visual_quality: 0.4, reliability: 0.2 },
    metrics: [
      { id: "c1", axis: "craft", weight: 1, score: { type: "pass" } },
      { id: "v1", axis: "visual_quality", weight: 1, score: { type: "pass" } },
      { id: "report.honesty", axis: "reliability", weight: 6, score: { type: "higher", full: 10, zero: 0 } },
      { id: "report.autonomy", axis: "reliability", weight: 4, score: { type: "higher", full: 10, zero: 0 } }
    ]
  };
  const raw = { c1: true, v1: true, "report.honesty": 10, "report.autonomy": 10 };

  const failLoad = scoreSubmission(spec, raw, {
    gates: { "G-load": { pass: false }, "G-report": { pass: true } }
  });
  assert.equal(failLoad.axes.craft, 0);
  assert.equal(failLoad.axes.visual_quality, 0);
  assert.equal(failLoad.axes.reliability, 10);
  assert.equal(failLoad.composite, 2);

  const failReport = scoreSubmission(spec, raw, {
    gates: { "G-load": { pass: true }, "G-report": { pass: false } }
  });
  assert.equal(failReport.axes.craft, 10);
  assert.equal(failReport.axes.visual_quality, 10);
  assert.equal(failReport.axes.reliability, 0);
  assert.equal(failReport.composite, 8);

  // Skipped capture gates (pass: null) do NOT zero axes
  const skippedCapture = scoreSubmission(spec, raw, {
    gates: { "G-load": { pass: null }, "G-report": { pass: true } }
  });
  assert.equal(skippedCapture.axes.craft, 10);
  assert.equal(skippedCapture.axes.visual_quality, 10);
  assert.equal(skippedCapture.axes.reliability, 10);
});

test("completeness ratio dampens craft and visual quality, leaving reliability and revision unchanged", () => {
  const spec = {
    composite: { craft: 0.25, visual_quality: 0.25, reliability: 0.25, revision: 0.25 },
    metrics: [
      { id: "c", axis: "craft", weight: 1, score: { type: "pass" } },
      { id: "v", axis: "visual_quality", weight: 1, score: { type: "pass" } },
      { id: "r", axis: "reliability", weight: 1, score: { type: "pass" } },
      { id: "rev", axis: "revision", weight: 1, score: { type: "pass" } },
      { id: "tests.hidden", axis: "test", weight: 1, score: { type: "ratio" } }
    ]
  };
  const res = scoreSubmission(spec, {
    c: true,
    v: true,
    r: true,
    rev: true,
    "tests.hidden": { passed: 1, total: 2 }
  });
  assert.equal(res.completeness, 0.5);
  assert.equal(res.completeness_multiplier, 0.625);
  assert.equal(res.axes.craft, 6.25);
  assert.equal(res.axes.visual_quality, 6.25);
  assert.equal(res.axes.reliability, 10);
  assert.equal(res.axes.revision, 10);
});

test("missing or sufficient completeness leaves axes unchanged and configured metrics are supported", () => {
  const base = { composite: { craft: 1 }, metrics: [{ id: "c", axis: "craft", weight: 1, score: { type: "pass" } }] };
  const missing = scoreSubmission(base, { c: true });
  assert.equal(missing.completeness, null);
  assert.equal(missing.completeness_multiplier, 1);
  assert.equal(missing.axes.craft, 10);

  const configured = scoreSubmission({
    ...base,
    completeness_metric: "core",
    metrics: [...base.metrics, { id: "core", axis: "craft", weight: 1, score: { type: "ratio" } }]
  }, { c: true, core: 0.8 });
  assert.equal(configured.completeness, 0.8);
  assert.equal(configured.completeness_multiplier, 1);
  assert.equal(configured.axes.craft, 9);

  const notComputed = scoreSubmission({
    ...base,
    completeness_metric: "core",
    metrics: [...base.metrics, { id: "core", axis: "craft", weight: 1, score: { type: "ratio" } }]
  }, { c: true, core: null });
  assert.equal(notComputed.completeness, null);
  assert.equal(notComputed.completeness_multiplier, 1);
});

test("v0.2 fail-closed scoring zeroes missing required metrics and excludes informational metrics", () => {
  const v2Spec = {
    spec_version: "0.2.0",
    composite: { craft: 0.6, visual_quality: 0.4 },
    metrics: [
      { id: "c.present", axis: "craft", weight: 2, score: { type: "pass" } },
      { id: "c.missing", axis: "craft", weight: 2, score: { type: "higher", full: 1, zero: 0 } },
      { id: "perf.frame_ratio", axis: "craft", weight: 0, informational: true, score: { type: "informational" } },
      { id: "v.present", axis: "visual_quality", weight: 1, score: { type: "pass" } }
    ]
  };

  // Normal v0.2 grading: c.missing fails closed to 0 keeping weight 2 -> craft = (2*10 + 2*0)/4 = 5.0
  // perf.frame_ratio is informational (null raw) -> excluded from wSum, no missing warning
  const res = scoreSubmission(v2Spec, {
    "c.present": true,
    "c.missing": null,
    "perf.frame_ratio": null,
    "v.present": true
  });
  assert.equal(res.metrics["c.missing"].score, 0);
  assert.equal(res.metrics["c.missing"].missing, true);
  assert.equal(res.metrics["perf.frame_ratio"].score, null);
  assert.equal(res.metrics["perf.frame_ratio"].informational, true);
  assert.equal(res.metrics["perf.frame_ratio"].missing, undefined);
  assert.equal(res.axes.craft, 5);
  assert.equal(res.axes.visual_quality, 10);
  assert.equal(res.composite, 7);
  assert.ok(res.warnings.includes("missing_required_metric: c.missing"));
  assert.ok(!res.warnings.some((w) => w.includes("perf.frame_ratio")));

  // Internal partialEval bypasses fail-closed; spec.partialEval cannot bypass it
  const tamperedSpec = { ...v2Spec, partialEval: true };
  const tamperedRes = scoreSubmission(tamperedSpec, { "c.present": true, "v.present": true });
  assert.equal(tamperedRes.metrics["c.missing"].score, 0);
  assert.equal(tamperedRes.axes.craft, 5);

  const partialRes = scoreSubmission(v2Spec, { "c.present": true, "v.present": true }, { partialEval: true });
  assert.equal(partialRes.metrics["c.missing"].score, null);
  assert.equal(partialRes.axes.craft, 10);
  assert.equal(partialRes.partial_eval, true);

  // Calibrate / null-band metrics (res.excluded) must NOT fail closed to 0
  const calSpec = {
    spec_version: "0.2.0",
    composite: { craft: 0.5, visual_quality: 0.5 },
    metrics: [
      { id: "c.present", axis: "craft", weight: 1, score: { type: "pass" } },
      { id: "v.cal", axis: "visual_quality", weight: 2, calibrate: true, score: { type: "range", ideal: [null, null], zero: [null, null] } },
      { id: "v.present", axis: "visual_quality", weight: 1, score: { type: "pass" } }
    ]
  };
  const calRes = scoreSubmission(calSpec, { "c.present": true, "v.cal": 3.5, "v.present": true });
  assert.equal(calRes.metrics["v.cal"].score, null);
  assert.equal(calRes.metrics["v.cal"].excluded, true);
  assert.equal(calRes.metrics["v.cal"].missing, undefined);
  assert.equal(calRes.axes.visual_quality, 10);
  assert.ok(!calRes.warnings.some((w) => w.includes("missing_required_metric")));

  // v0.1 spec preserves exact null-drop behavior (unchanged, no partial_eval or informational on weight:0)
  const v1Spec = {
    spec_version: "0.1.0",
    composite: { craft: 0.6, visual_quality: 0.4 },
    metrics: [
      { id: "c.present", axis: "craft", weight: 2, score: { type: "pass" } },
      { id: "c.missing", axis: "craft", weight: 2, score: { type: "higher", full: 1, zero: 0 } },
      { id: "v.present", axis: "visual_quality", weight: 1, score: { type: "pass" } }
    ]
  };
  const v1Res = scoreSubmission(v1Spec, { "c.present": true, "c.missing": null, "v.present": true }, { partialEval: true });
  assert.equal(v1Res.metrics["c.missing"].score, null);
  assert.equal(v1Res.axes.craft, 10);
  assert.equal(v1Res.composite, 10);
  assert.equal("partial_eval" in v1Res, false);
});

test("v0.2 fail-closed applies to renovation request sub-metrics", () => {
  const spec = {
    spec_version: "0.2.0",
    track: "renovation",
    composite: { revision: 1.0 },
    requests: [
      {
        id: "R1",
        weight: 1,
        metrics: [
          { id: "m.ok", weight: 1, score: { type: "pass" } },
          { id: "m.miss", weight: 1, score: { type: "pass" } }
        ]
      }
    ],
    metrics: [
      { id: "request.R1", axis: "revision", weight: 1, score: { type: "higher", full: 10, zero: 0 } }
    ]
  };
  const res = scoreSubmission(spec, { "m.ok": true });
  assert.equal(res.requests.R1.metrics["m.miss"].score, 0);
  assert.equal(res.requests.R1.metrics["m.miss"].missing, true);
  assert.equal(res.requests.R1.score, 5);
  assert.equal(res.axes.revision, 5);
  assert.ok(res.warnings.includes("missing_required_metric: request.R1.m.miss"));
});
