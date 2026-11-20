import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadSpec, buildPlan, parseAt, SpecError } from "../src/spec.mjs";
import { getMetricDef } from "../src/registry.mjs";
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
