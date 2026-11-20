/**
 * Pure scoring engine (no I/O).
 * Implements score functions, sampling aggregation, axis weighting,
 * gate failure zeroing, and composite scoring per docs/SCORING.md.
 */

export function round1(val) {
  if (val === null || val === undefined || Number.isNaN(val)) return null;
  return Math.round(val * 10) / 10;
}

export function clamp(val, min, max) {
  return Math.min(max, Math.max(min, val));
}

export function isNullBand(scoreSpec) {
  if (!scoreSpec) return false;
  if (scoreSpec.type === "range" || scoreSpec.type === "relative") {
    if (scoreSpec.by_script) return false;
    const { ideal, zero } = scoreSpec;
    if (!Array.isArray(ideal) || !Array.isArray(zero)) return true;
    return ideal[0] === null || ideal[1] === null || zero[0] === null || zero[1] === null;
  }
  return false;
}

function scoreRangeBounds(v, ideal, zero, scale = 1) {
  if (
    !Array.isArray(ideal) ||
    !Array.isArray(zero) ||
    ideal[0] === null ||
    ideal[1] === null ||
    zero[0] === null ||
    zero[1] === null
  ) {
    return null;
  }
  const a = ideal[0] * scale;
  const b = ideal[1] * scale;
  const c = zero[0] * scale;
  const d = zero[1] * scale;

  if (v >= a && v <= b) return 10;
  if (v <= c || v >= d) return 0;
  if (v < a) {
    return a === c ? 0 : clamp((10 * (v - c)) / (a - c), 0, 10);
  }
  return d === b ? 0 : clamp((10 * (d - v)) / (d - b), 0, 10);
}

/**
 * Map a single raw value to [0, 10] according to a spec `score` definition.
 * Returns null if raw is null/undefined/NaN or if the score band is null.
 */
export function scoreValue(raw, scoreSpec, ctx = {}) {
  if (!scoreSpec) throw new Error("Missing score specification");
  if (raw === null || raw === undefined) return null;

  const scale = ctx.bandScale ?? 1;
  const { type } = scoreSpec;

  if (type === "pass") {
    if (typeof raw === "boolean") return raw ? 10 : 0;
    if (typeof raw === "number") {
      if (Number.isNaN(raw)) return null;
      return raw > 0 ? 10 : 0;
    }
    return raw ? 10 : 0;
  }

  if (type === "ratio") {
    if (typeof raw === "object" && raw !== null && "passed" in raw && "total" in raw) {
      if (raw.total <= 0) return 0;
      return clamp((raw.passed / raw.total) * 10, 0, 10);
    }
    const v = Number(raw);
    if (!Number.isFinite(v)) return null;
    return clamp(v * 10, 0, 10);
  }

  if (type === "lower") {
    const v = Number(raw);
    if (!Number.isFinite(v)) return null;
    const full = scoreSpec.full * scale;
    const zero = scoreSpec.zero * scale;
    if (v <= full) return 10;
    if (v >= zero) return 0;
    return clamp((10 * (zero - v)) / (zero - full), 0, 10);
  }

  if (type === "higher") {
    const v = Number(raw);
    if (!Number.isFinite(v)) return null;
    const full = scoreSpec.full * scale;
    const zero = scoreSpec.zero * scale;
    if (v >= full) return 10;
    if (v <= zero) return 0;
    return clamp((10 * (v - zero)) / (full - zero), 0, 10);
  }

  if (type === "range" || type === "relative") {
    let band = scoreSpec;
    if (scoreSpec.by_script) {
      const script = ctx.script || "latin";
      band = scoreSpec.by_script[script];
      if (!band) {
        throw new Error(`Unknown script "${script}" for by_script score`);
      }
    }
    if (isNullBand(band)) return null;

    let v;
    if (type === "relative" && typeof raw === "object" && raw !== null && "before" in raw && "after" in raw) {
      const before = Number(raw.before);
      const after = Number(raw.after);
      if (!Number.isFinite(before) || !Number.isFinite(after)) return null;
      if (before === 0) {
        v = after === 0 ? 0 : after > 0 ? Infinity : -Infinity;
      } else {
        v = (after - before) / before;
      }
    } else {
      v = Number(raw);
    }

    if (Number.isNaN(v)) return null;
    if (!Number.isFinite(v)) return 0;
    return scoreRangeBounds(v, band.ideal, band.zero, scale);
  }

  throw new Error(`Unsupported score type: "${type}"`);
}

/**
 * Aggregate an array of per-sample numbers using median (default), mean, or worst (min).
 */
export function aggregateSamples(values, agg = "median") {
  const valid = (values || []).filter((v) => v !== null && v !== undefined && Number.isFinite(v));
  if (valid.length === 0) return null;

  if (agg === "worst") {
    return Math.min(...valid);
  }
  if (agg === "mean") {
    return valid.reduce((a, b) => a + b, 0) / valid.length;
  }
  if (agg === "median") {
    const sorted = [...valid].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }
  throw new Error(`Unsupported agg mode: "${agg}"`);
}

function extractRawScalar(rawInput) {
  if (rawInput === null || rawInput === undefined) return null;
  if (typeof rawInput === "number" || typeof rawInput === "boolean") return rawInput;
  if (typeof rawInput === "object") {
    if ("raw" in rawInput && rawInput.raw !== undefined) return rawInput.raw;
    if ("value" in rawInput && rawInput.value !== undefined) return rawInput.value;
    if ("before" in rawInput && "after" in rawInput) {
      return rawInput.before === 0
        ? rawInput.after === 0
          ? 0
          : null
        : (rawInput.after - rawInput.before) / rawInput.before;
    }
    if ("passed" in rawInput && "total" in rawInput) {
      return rawInput.total > 0 ? rawInput.passed / rawInput.total : 0;
    }
  }
  return null;
}

/**
 * Score a single metric given either a scalar raw value, an array of sample objects/values,
 * or `{ raw, samples }`.
 */
export function scoreMetric(metric, rawInput, ctx = {}) {
  const agg = metric.agg || "median";
  const nullBand = isNullBand(metric.score);

  if (rawInput === null || rawInput === undefined) {
    return {
      raw: null,
      samples: [],
      score: null,
      excluded: nullBand || undefined,
      calibrate: metric.calibrate || undefined,
      warning: nullBand ? `Metric "${metric.id}" has null bands and is excluded from scoring` : undefined
    };
  }

  let samples = [];
  let rawScalar = null;

  if (Array.isArray(rawInput)) {
    samples = rawInput;
  } else if (typeof rawInput === "object" && Array.isArray(rawInput.samples) && rawInput.samples.length > 0) {
    samples = rawInput.samples;
    rawScalar = extractRawScalar(rawInput);
  } else {
    rawScalar = extractRawScalar(rawInput);
    const valForScore =
      typeof rawInput === "object" && rawInput !== null && !("passed" in rawInput) && !("before" in rawInput)
        ? rawScalar
        : rawInput;
    const score = nullBand
      ? null
      : scoreValue(valForScore, metric.score, { ...ctx, ...(typeof rawInput === "object" ? rawInput : {}) });
    return {
      raw: rawScalar,
      samples: [],
      score,
      excluded: nullBand || undefined,
      calibrate: metric.calibrate || undefined,
      warning: nullBand ? `Metric "${metric.id}" has null bands and is excluded from scoring` : undefined
    };
  }

  // Sample-based scoring: score each sample first, then aggregate scores per SCORING.md §3.
  const sampleScores = [];
  const sampleRaws = [];

  for (const s of samples) {
    const isObj = typeof s === "object" && s !== null;
    const val = isObj ? ("value" in s ? s.value : s) : s;
    const sampleCtx = {
      ...ctx,
      script: isObj && s.script ? s.script : ctx.script,
      bandScale: isObj && s.bandScale ? s.bandScale : ctx.bandScale
    };
    const sc = nullBand ? null : scoreValue(val, metric.score, sampleCtx);
    if (sc !== null) sampleScores.push(sc);
    const r = extractRawScalar(val);
    if (typeof r === "number" && Number.isFinite(r)) sampleRaws.push(r);
    else if (typeof r === "boolean") sampleRaws.push(r ? 1 : 0);
  }

  if (rawScalar === null && sampleRaws.length > 0) {
    rawScalar = aggregateSamples(sampleRaws, agg);
  }

  const aggScore = nullBand ? null : aggregateSamples(sampleScores, agg);

  return {
    raw: rawScalar,
    samples,
    score: aggScore,
    excluded: nullBand || undefined,
    calibrate: metric.calibrate || undefined,
    warning: nullBand ? `Metric "${metric.id}" has null bands and is excluded from scoring` : undefined
  };
}

/**
 * Score a full submission against a loaded/expanded spec.
 * Pure function: accepts already-collected rawMetrics and static/capture gate results.
 */
export function scoreSubmission(spec, rawMetrics = {}, opts = {}) {
  const gates = opts.gates || {};
  const warnings = [];
  const metricsOut = {};
  const requestsOut = {};

  const effectiveRaw = { ...rawMetrics };

  // 1. Score renovation requests -> feeds into `request.<id>` metrics
  if (Array.isArray(spec.requests)) {
    for (const req of spec.requests) {
      const subResults = {};
      let weightSum = 0;
      let weightedScoreSum = 0;

      for (const sub of req.metrics || []) {
        const scopedKey = `request.${req.id}.${sub.id}`;
        const rawVal = scopedKey in effectiveRaw ? effectiveRaw[scopedKey] : effectiveRaw[sub.id];
        const res = scoreMetric(sub, rawVal, opts.ctx);
        if (res.warning) warnings.push(res.warning);
        subResults[sub.id] = {
          raw: res.raw,
          samples: res.samples,
          score: res.score,
          weight: sub.weight
        };
        if (res.score !== null) {
          weightSum += sub.weight;
          weightedScoreSum += sub.weight * res.score;
        }
      }

      const reqScore = weightSum > 0 ? weightedScoreSum / weightSum : null;
      requestsOut[req.id] = {
        id: req.id,
        weight: req.weight,
        score: reqScore,
        metrics: subResults
      };

      const topId = `request.${req.id}`;
      if (!(topId in effectiveRaw) && reqScore !== null) {
        effectiveRaw[topId] = reqScore;
      }
    }
  }

  // 2. Score top-level metrics
  for (const m of spec.metrics || []) {
    const res = scoreMetric(m, effectiveRaw[m.id], opts.ctx);
    if (res.warning) warnings.push(res.warning);

    const entry = {
      raw: res.raw,
      samples: res.samples,
      score: res.score,
      axis: m.axis,
      weight: m.weight
    };
    if (m.calibrate) entry.calibrate = true;
    if (res.excluded) entry.excluded = true;
    metricsOut[m.id] = entry;
  }

  // 3. Renovation rule: diff.rewrite failure forces diff.change_ratio score to 0
  if (metricsOut["diff.rewrite"] && metricsOut["diff.rewrite"].score === 0 && metricsOut["diff.change_ratio"]) {
    metricsOut["diff.change_ratio"].score = 0;
    metricsOut["diff.change_ratio"].forcedZeroBy = "diff.rewrite";
    warnings.push("diff.change_ratio forced to 0 because diff.rewrite failed");
  }

  // 4. Aggregate axes
  const axisNames = new Set(Object.keys(spec.composite || {}));
  for (const m of spec.metrics || []) {
    if (m.axis) axisNames.add(m.axis);
  }

  const axes = {};
  for (const axis of axisNames) {
    let wSum = 0;
    let wsSum = 0;
    for (const m of spec.metrics || []) {
      if (m.axis !== axis) continue;
      const out = metricsOut[m.id];
      if (!out || out.score === null || out.score === undefined) continue;
      wSum += m.weight;
      wsSum += m.weight * out.score;
    }
    axes[axis] = wSum > 0 ? wsSum / wSum : null;
  }

  // 5. Gate failure zeroing rules (SCORING.md §2)
  const failedNonReportGate = Object.entries(gates).some(
    ([id, g]) => id !== "G-report" && g && g.pass === false
  );
  const failedReportGate = gates["G-report"]?.pass === false;

  if (failedNonReportGate) {
    for (const axis of ["craft", "visual_quality", "revision"]) {
      if (axis in axes) axes[axis] = 0;
    }
  }
  if (failedReportGate && "reliability" in axes) {
    axes.reliability = 0;
  }

  // 6. Composite score
  let composite = null;
  const compEntries = Object.entries(spec.composite || {});
  if (compEntries.length > 0) {
    const allPresent = compEntries.every(([axis]) => axes[axis] !== null && axes[axis] !== undefined);
    if (allPresent) {
      let cWeightSum = 0;
      let cScoreSum = 0;
      for (const [axis, w] of compEntries) {
        cWeightSum += w;
        cScoreSum += w * axes[axis];
      }
      composite = cWeightSum > 0 ? cScoreSum / cWeightSum : null;
    }
  }

  return {
    gates,
    metrics: metricsOut,
    requests: Object.keys(requestsOut).length > 0 ? requestsOut : undefined,
    axes,
    composite,
    warnings
  };
}
