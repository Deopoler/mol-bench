import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadSpec, buildPlan, parseAt, parseVersion, resolveVersionPaths, resolveSpecPath, validateSpec, registerAtToken, unregisterAtToken, SpecError } from "../src/spec.mjs";
import { getMetricDef, hasMetric, registerMetrics, unregisterMetrics, registerVariants } from "../src/registry.mjs";
import { generate } from "../src/rooms/_template.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");

const ALL_SPECS = [
  ["aurora", null],
  ["aurora", "r1"],
  ["lobby", null],
  ["lobby", "r1"],
  ["atelier", null],
  ["atelier", "r1"],
  ["restoration", null]
];

test("all 7 spec files load and validate cleanly in strict mode", () => {
  for (const [room, renovation] of ALL_SPECS) {
    const spec = loadSpec(room, { renovation, lenient: false, repoRoot: REPO_ROOT });
    assert.equal(spec.room, room);
    assert.deepEqual(spec.warnings, []);
    const plan = buildPlan(spec, { hidden: false, renovation });
    assert.equal(plan.room, room);
  }
});

test("parseAt parses all valid grammar tokens accurately", () => {
  const p1 = parseAt("1440x900, t in [1000, 4000, 9000], both schemes");
  assert.deepEqual(p1.viewports, ["1440x900"]);
  assert.deepEqual(p1.timestamps, [1000, 4000, 9000]);
  assert.deepEqual(p1.schemes, ["light", "dark"]);

  const p2 = parseAt("320x640 and 1440x900, variants=lang_ko|lang_en");
  assert.deepEqual(p2.viewports, ["320x640", "1440x900"]);
  assert.deepEqual(p2.variants, ["lang_ko", "lang_en"]);

  const p3 = parseAt("turntable, mask=metal");
  assert.equal(p3.mask, "metal");
  assert.deepEqual(p3.steps, [{ kind: "turntable" }]);

  const p4 = parseAt("after resize 1440x900 -> 768x1024 -> 1200x700");
  assert.deepEqual(p4.steps, [{ kind: "resize_sequence", viewports: ["1440x900", "768x1024", "1200x700"] }]);

  const p5 = parseAt("front, side, top");
  assert.deepEqual(p5.steps, [{ kind: "ortho_views", views: ["front", "side", "top"] }]);

  const p6 = parseAt("all viewports, all timestamps, t0=2500, 12 hidden views");
  assert.equal(p6.viewports, "all");
  assert.equal(p6.timestamps, "all");
  assert.equal(p6.t0, 2500);
  assert.deepEqual(p6.steps, [{ kind: "hidden_views", count: 12 }]);
});

test("parseAt throws in strict mode on unknown tokens/variants and warns in lenient mode", () => {
  assert.throws(() => parseAt("1440x900 first viewport"), SpecError);
  assert.throws(() => parseAt("1440x900, static camera"), SpecError);
  assert.throws(() => parseAt("variants=bogus_variant"), SpecError);

  const lenient1 = parseAt("1440x900 first viewport", { lenient: true, context: "test" });
  assert.equal(lenient1.warnings.length, 1);
  assert.deepEqual(lenient1.viewports, ["1440x900"]);

  const lenient2 = parseAt("1440x900, static camera", { lenient: true, context: "test" });
  assert.equal(lenient2.warnings.length, 1);
  assert.deepEqual(lenient2.viewports, ["1440x900"]);
});

test("registry throws on unknown metric id", () => {
  assert.throws(() => getMetricDef("unknown.metric"), /Unknown metric id/);
  assert.equal(getMetricDef("request.A-R1").source, "harness");
  assert.equal(getMetricDef("color.palette_fidelity").source, "python");
});

test("buildPlan deduplicates frames and includes perf/tests", () => {
  const spec = loadSpec("aurora", { repoRoot: REPO_ROOT });
  const plan = buildPlan(spec, { hidden: true });
  const keys = plan.frames.map((f) => f.key);
  assert.equal(keys.length, new Set(keys).size);
  assert.equal(plan.perf.enabled, true);
  assert.equal(plan.perf.viewport, "1440x900");
  assert.equal(plan.sequences.length, 6);
  assert.equal(plan.steps.length, 6);
});

test("_template room adapter generates deterministic params", () => {
  assert.deepEqual(generate(42), generate(42));
  assert.notEqual(generate(42).sampleValue, generate(43).sampleValue);
});

test("version resolution maps v1 and v2 paths cleanly", () => {
  assert.equal(parseVersion(undefined), 1);
  assert.equal(parseVersion("1"), 1);
  assert.equal(parseVersion("0.1.0"), 1);
  assert.equal(parseVersion(2), 2);
  assert.equal(parseVersion("0.2.0"), 2);
  assert.throws(() => parseVersion("3"), SpecError);

  const p1 = resolveVersionPaths(1, REPO_ROOT);
  const p2 = resolveVersionPaths(2, REPO_ROOT);
  assert.equal(p1.benchVersion, "0.1.0");
  assert.equal(p2.benchVersion, "0.2.0");
  assert.ok(p1.roomsDir.endsWith(path.join("rooms")));
  assert.ok(p2.roomsDir.endsWith(path.join("rooms-v2")));
  assert.ok(p2.hiddenDir.endsWith(path.join("hidden-v2")));
  assert.ok(p2.resultsDir.endsWith(path.join("results-v2")));
  assert.ok(p2.adaptersDir.endsWith(path.join("harness", "src", "rooms-v2")));

  const v2FixtureRoot = path.join(__dirname, "fixtures", "v2");
  assert.equal(
    resolveSpecPath("mockroom", { version: 2, repoRoot: v2FixtureRoot }),
    path.join(v2FixtureRoot, "rooms-v2", "mockroom", "spec.json")
  );
});

test("registerMetrics, registerVariants, v2 parseAt tokens, and v2 spec schema work cleanly", () => {
  registerMetrics({
    "v2.custom_metric": { source: "python", needs: () => [] }
  });
  registerVariants(["custom_v2_var"]);
  try {
    assert.equal(hasMetric("v2.custom_metric"), true);
    assert.equal(getMetricDef("v2.custom_metric").source, "python");

    const parsed = parseAt("1440x900@zoom200, all schemes, variants=lang_ja|custom_v2_var, dpr=2, section_a");
    assert.deepEqual(parsed.viewports, ["1440x900@zoom200"]);
    assert.deepEqual(parsed.schemes, ["light", "dark", "high_contrast"]);
    assert.deepEqual(parsed.variants, ["lang_ja", "custom_v2_var"]);
    assert.equal(parsed.dpr, 2);
    assert.deepEqual(parsed.steps, [{ kind: "ortho_views", views: ["section_a"] }]);

    const validV2Spec = {
      room: "demo",
      spec_version: "0.2.0",
      track: "build",
      title: "Demo v2",
      time_limit_min: 45,
      time_limit_active_min: 45,
      fail_closed: true,
      scope: ["room/**"],
      deliverables: ["room/index.html", "report.json"],
      capture: { viewports: ["1440x900", "1440x900@zoom200"], color_schemes: ["light", "dark", "high_contrast"] },
      gates: ["G-load", "G-report", "G-test-sandbox"],
      composite: { craft: 0.85, reliability: 0.15 },
      metrics: [
        { id: "tests.hidden", axis: "craft", weight: 2, score: { type: "ratio" } },
        { id: "v2.custom_metric", axis: "craft", weight: 0, informational: true, score: { type: "informational" } },
        { id: "report.honesty", axis: "reliability", weight: 6, score: { type: "higher", full: 10, zero: 0 } }
      ]
    };
    assert.equal(validateSpec(validV2Spec), true);

    // Submissions/specs must never be allowed to set partialEval
    assert.throws(() => validateSpec({ ...validV2Spec, partialEval: true }), SpecError);

    // buildPlan emits hidden-v2/<room>/tests for v2 specs
    const plan = buildPlan({ ...validV2Spec, _version: 2 }, { hidden: true });
    assert.deepEqual(plan.tests, ["hidden-v2/demo/tests"]);

    // Built-in metric shadowing is always rejected even with replace: true
    assert.throws(
      () => registerMetrics({ "lum.mean": { source: "room", needs: () => [] } }, { replace: true }),
      /Cannot override built-in metric/
    );

    // Custom at-token registration hook
    registerAtToken("custom_camera", (tok, res) => {
      if (tok === "cam=hero") {
        res.camera = "hero";
        return true;
      }
      return false;
    });
    try {
      const pCustom = parseAt("1440x900, cam=hero");
      assert.equal(pCustom.camera, "hero");
    } finally {
      unregisterAtToken("custom_camera");
    }
  } finally {
    unregisterMetrics(["v2.custom_metric"]);
  }
});
