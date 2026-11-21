import fs from "node:fs";
import { mulberry32 } from "./_template.mjs";

export const room = "aurora";

export const PALETTES_OKLCH = Object.freeze([
  [[0.78, 0.17, 160], [0.62, 0.15, 300], [0.70, 0.14, 350]],
  [[0.82, 0.16, 175], [0.70, 0.12, 220], [0.58, 0.16, 290]],
  [[0.76, 0.18, 145], [0.80, 0.12, 95],  [0.60, 0.15, 320]],
  [[0.74, 0.14, 195], [0.66, 0.17, 265], [0.72, 0.13, 10]],
  [[0.80, 0.15, 130], [0.64, 0.14, 180], [0.56, 0.17, 305]],
  [[0.72, 0.16, 210], [0.78, 0.10, 60],  [0.62, 0.16, 280]]
]);

export const STAR_DENSITIES = Object.freeze(["sparse", "normal", "dense"]);

export const STAR_DENSITY_FACTORS = Object.freeze({
  sparse: 0.5,
  normal: 1.0,
  dense: 1.8
});

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

/**
 * Deterministically generate aurora params from seed per rooms/aurora/spec.json.
 * Public seeds use PALETTES_OKLCH[seed % 6]; hidden seeds rotate every hue by a
 * seeded offset in [-10, +10] deg and jitter L by +-0.03.
 * @param {number} seed
 * @param {{ hidden?: boolean }} opts
 */
export function generate(seed, { hidden = false } = {}) {
  const rng = mulberry32(seed);
  const idx = ((seed % PALETTES_OKLCH.length) + PALETTES_OKLCH.length) % PALETTES_OKLCH.length;
  const palette = PALETTES_OKLCH[idx].map(([L, C, h]) => [L, C, h]);

  const skyBaseL = 0.06 + 0.04 * rng();
  const starDensity = STAR_DENSITIES[Math.floor(rng() * 3)];
  const motionScale = 0.8 + 0.4 * rng();

  if (hidden) {
    const hrng = mulberry32((seed ^ 0x9e3779b9) >>> 0);
    const hueOffset = (hrng() * 2 - 1) * 10;
    for (let i = 0; i < palette.length; i++) {
      const [L, C, h] = palette[i];
      const lJitter = (hrng() * 2 - 1) * 0.03;
      palette[i] = [
        Number(clamp(L + lJitter, 0.05, 0.95).toFixed(6)),
        C,
        Number((((h + hueOffset) % 360 + 360) % 360).toFixed(6))
      ];
    }
  }

  return {
    palette,
    skyBaseL,
    starDensity,
    motionScale
  };
}

export async function extraCapture(_ctx) {}

function extractSeedFromSample(sample, manifestSamplesByKey) {
  if (sample && typeof sample === "object") {
    if (sample.seed !== undefined && sample.seed !== null) return Number(sample.seed);
    const key = String(sample.key || "");
    const mSample = manifestSamplesByKey.get(key);
    if (mSample && mSample.seed !== undefined) return Number(mSample.seed);
    const match = key.match(/(?:^|_)s(-?\d+)(?:_|$)/);
    if (match) return Number(match[1]);
  }
  return null;
}

/**
 * Attach per-sample `bandScale` for `scene.star_count` (starDensity factor)
 * and `time.motion` (motionScale) per rooms/aurora/spec.json.
 */
export async function extraMetrics(ctx, metrics) {
  let manifest = null;
  if (ctx?.manifestPath && fs.existsSync(ctx.manifestPath)) {
    manifest = JSON.parse(fs.readFileSync(ctx.manifestPath, "utf8"));
  }
  const manifestSamplesByKey = new Map(
    (manifest?.samples || []).map((s) => [s.key, s])
  );
  const hidden = Boolean(ctx?.hidden);

  const getParams = (seed) => {
    const fromManifest = manifest?.params?.[String(seed)];
    if (fromManifest && typeof fromManifest === "object") return fromManifest;
    return generate(seed, { hidden });
  };

  const starCountMetric = metrics?.["scene.star_count"];
  if (starCountMetric && Array.isArray(starCountMetric.samples)) {
    for (const s of starCountMetric.samples) {
      const seed = extractSeedFromSample(s, manifestSamplesByKey);
      if (seed !== null && Number.isFinite(seed)) {
        const params = getParams(seed);
        const factor = STAR_DENSITY_FACTORS[params.starDensity] ?? 1.0;
        s.bandScale = factor;
      }
    }
  }

  const motionMetric = metrics?.["time.motion"];
  if (motionMetric && Array.isArray(motionMetric.samples)) {
    for (const s of motionMetric.samples) {
      const seed = extractSeedFromSample(s, manifestSamplesByKey);
      if (seed !== null && Number.isFinite(seed)) {
        const params = getParams(seed);
        if (typeof params.motionScale === "number" && Number.isFinite(params.motionScale)) {
          s.bandScale = params.motionScale;
        }
      }
    }
  }
}
