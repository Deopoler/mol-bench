/**
 * Template room adapter (`harness/src/rooms/<room>.mjs`).
 * Copy this file to `harness/src/rooms/<room>.mjs` and implement room-specific
 * deterministic parameter generation, extra captures, and extra metrics.
 */

export const room = "_template";

/**
 * Deterministic mulberry32 PRNG (mirrors host.js). Never use Math.random().
 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Deterministically generate room params from seed.
 * @param {number} seed
 * @param {{ hidden?: boolean }} opts
 */
export function generate(seed, { hidden = false } = {}) {
  const rng = mulberry32(seed);
  return {
    seed,
    hidden,
    sampleValue: rng()
  };
}

/**
 * Optional room-specific captures beyond the generic plan.
 * @param {object} _ctx
 */
export async function extraCapture(_ctx) {}

/**
 * Optional room-specific raw metric values merged into metrics.json.
 * @param {object} _ctx
 * @param {Record<string, unknown>} _metrics
 */
export async function extraMetrics(_ctx, _metrics) {}
