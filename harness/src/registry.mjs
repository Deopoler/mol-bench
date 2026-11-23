/**
 * Metric registry: maps every metric id to its source and capture-plan needs().
 * Sources: "python" | "probe" | "room" | "harness" | "test"
 */

export const VALID_VARIANTS = Object.freeze([
  "normal",
  "reduced_motion",
  "pointer_left",
  "pointer_right",
  "dpr2",
  "resize_seq",
  "lifecycle_30",
  "raf30",
  "raf144",
  "empty_rooms",
  "long_title",
  "lang_en",
  "lang_ko",
  "camera_drift",
  // v0.2 standard variants
  "lang_ja",
  "high_contrast",
  "zoom200",
  "many_48",
  "one_room",
  "empty_state",
  "prefers_contrast_more"
]);

const CUSTOM_VARIANTS = new Set();

export function registerVariants(names = []) {
  if (!Array.isArray(names)) {
    throw new Error("registerVariants expects an array of variant names");
  }
  for (const name of names) {
    if (typeof name !== "string" || !/^[a-z0-9_]+$/.test(name)) {
      throw new Error(`Invalid variant name: "${name}"`);
    }
    CUSTOM_VARIANTS.add(name);
  }
}

export function isValidVariant(name) {
  return VALID_VARIANTS.includes(name) || CUSTOM_VARIANTS.has(name);
}

export const VALID_SOURCES = Object.freeze(["python", "probe", "room", "harness", "test"]);

function resolveViewports(metric, ctx) {
  const parsed = metric.parsedAt;
  if (parsed?.viewports === "all") return ctx.viewports;
  if (Array.isArray(parsed?.viewports) && parsed.viewports.length > 0) return parsed.viewports;
  return [ctx.defaultViewport];
}

function resolveTimestamps(metric, ctx) {
  const parsed = metric.parsedAt;
  if (parsed?.timestamps === "all") return ctx.timestamps;
  if (Array.isArray(parsed?.timestamps) && parsed.timestamps.length > 0) return parsed.timestamps;
  return [ctx.defaultTimestamp];
}

function resolveSchemes(metric, ctx, forceBoth = false) {
  if (forceBoth) return ["light", "dark"];
  const parsed = metric.parsedAt;
  if (Array.isArray(parsed?.schemes) && parsed.schemes.length > 0) return parsed.schemes;
  return ["light"];
}

function resolveVariants(metric, defaultVariants = ["normal"]) {
  const parsed = metric.parsedAt;
  if (Array.isArray(parsed?.variants) && parsed.variants.length > 0) return parsed.variants;
  return defaultVariants;
}

function makeFrameKey({ seed, t, viewport, scheme, variant, dpr }) {
  const base = `s${seed}_t${t}_${viewport}_${scheme}_${variant}`;
  return dpr && dpr !== 1 ? `${base}_dpr${dpr}` : base;
}

export function emitFrames(metric, ctx, opts = {}) {
  const viewports = opts.viewports ?? resolveViewports(metric, ctx);
  const timestamps = opts.timestamps ?? resolveTimestamps(metric, ctx);
  const schemes = opts.schemes ?? resolveSchemes(metric, ctx, opts.bothSchemes);
  const variants = opts.variants ?? resolveVariants(metric, opts.defaultVariants);
  const dpr = opts.dpr ?? (ctx.spec?.capture?.dpr ?? 1);
  const pointer = opts.pointer ?? null;

  const out = [];
  for (const seed of ctx.seeds) {
    for (const viewport of viewports) {
      for (const t of timestamps) {
        for (const scheme of schemes) {
          for (const variant of variants) {
            out.push({
              kind: "frame",
              key: makeFrameKey({ seed, t, viewport, scheme, variant, dpr }),
              seed,
              t,
              viewport,
              scheme,
              variant,
              dpr,
              pointer
            });
          }
        }
      }
    }
  }
  return out;
}

export function emitProbes(probeName, metric, ctx, opts = {}) {
  const viewports = opts.viewports ?? resolveViewports(metric, ctx);
  const schemes = opts.schemes ?? resolveSchemes(metric, ctx, opts.bothSchemes);
  const variants = opts.variants ?? resolveVariants(metric, opts.defaultVariants);
  const args = opts.args ?? {};

  const out = [];
  for (const seed of ctx.seeds) {
    for (const viewport of viewports) {
      for (const scheme of schemes) {
        for (const variant of variants) {
          const suffix = variant === "normal" ? "" : `_${variant}`;
          out.push({
            kind: "probe",
            key: `p_${probeName}_${viewport}_${scheme}${suffix}_s${seed}`,
            probe: probeName,
            viewport,
            scheme,
            variant,
            seed,
            args
          });
        }
      }
    }
  }
  return out;
}

export function emitResizeSteps(metric, ctx, defaultDpr = 1) {
  const parsed = metric.parsedAt;
  const resizeStep = parsed?.steps?.find((s) => s.kind === "resize_sequence");
  const viewports = resizeStep?.viewports ?? ["1440x900", "768x1024", "1440x900"];
  const dpr = resizeStep?.viewports ? defaultDpr : 2;
  const out = [];
  for (const seed of ctx.seeds) {
    out.push({
      kind: "step",
      key: `resize_seq_s${seed}_${viewports.join("_")}_dpr${dpr}`,
      stepKind: "resize_sequence",
      seed,
      viewports,
      then: "frame",
      dpr
    });
  }
  return out;
}

export function emitSequence(tag, metric, ctx, opts = {}) {
  const viewports = resolveViewports(metric, ctx);
  const schemes = resolveSchemes(metric, ctx);
  const variants = opts.variants ?? resolveVariants(metric, opts.defaultVariants);
  const t0 = metric.parsedAt?.t0 ?? opts.defaultT0 ?? 2500;
  const dt = opts.dt ?? 16.667;
  const count = opts.count ?? 120;

  const out = [];
  for (const seed of ctx.seeds) {
    for (const viewport of viewports) {
      for (const scheme of schemes) {
        for (const variant of variants) {
          out.push({
            kind: "sequence",
            key: `seq_${tag}_s${seed}_t0_${t0}_${viewport}_${scheme}_${variant}`,
            seed,
            t0,
            dt,
            count,
            viewport,
            scheme,
            variant
          });
        }
      }
    }
  }
  return out;
}

function hasStep(metric, kind) {
  return Boolean(metric.parsedAt?.steps?.some((s) => s.kind === kind));
}

function emitBlenderSteps(metric, ctx) {
  const out = [];
  if (hasStep(metric, "ortho_views")) {
    out.push({ kind: "step", key: "step_ortho_views", stepKind: "ortho_views", views: ["front", "side", "top"] });
  }
  if (hasStep(metric, "hidden_views")) {
    out.push({ kind: "step", key: "step_hidden_views_12", stepKind: "hidden_views", count: 12 });
  }
  if (hasStep(metric, "turntable")) {
    out.push({ kind: "step", key: "step_turntable_8", stepKind: "turntable", count: 8 });
  }
  return out;
}

const none = () => [];

function motionFrames(metric, ctx, variant = "normal") {
  const viewports = resolveViewports(metric, ctx);
  const schemes = resolveSchemes(metric, ctx);
  const ts = ctx.timestamps.length > 1 ? ctx.timestamps : [0, 1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000, 9000];
  const sampleTs = ts.slice(0, 10);
  const out = [];
  for (const seed of ctx.seeds) {
    for (const viewport of viewports) {
      for (const scheme of schemes) {
        for (const t of sampleTs) {
          out.push({
            kind: "frame",
            key: makeFrameKey({ seed, t, viewport, scheme, variant, dpr: 1 }),
            seed, t, viewport, scheme, variant, dpr: 1, pointer: null
          });
          const tNext = Number((t + 16.667).toFixed(3));
          out.push({
            kind: "frame",
            key: makeFrameKey({ seed, t: tNext, viewport, scheme, variant, dpr: 1 }),
            seed, t: tNext, viewport, scheme, variant, dpr: 1, pointer: null
          });
        }
      }
    }
  }
  return out;
}

const DEFINITIONS = {
  // color.*
  "color.palette_fidelity": { source: "python", needs: (m, c) => emitFrames(m, c) },
  "color.palette_coverage": { source: "python", needs: (m, c) => emitFrames(m, c) },
  "color.chroma_mean": {
    source: "python",
    needs: (m, c) => (hasStep(m, "turntable") ? emitBlenderSteps(m, c) : emitFrames(m, c))
  },
  "color.hue_shift": {
    source: "python",
    needs: (m, c) => (hasStep(m, "turntable") ? emitBlenderSteps(m, c) : emitFrames(m, c))
  },
  "color.patch_delta": { source: "python", needs: (m, c) => emitFrames(m, c) },

  // lum.*
  "lum.mean": { source: "python", needs: (m, c) => emitFrames(m, c) },
  "lum.highlight_frac": { source: "python", needs: (m, c) => emitFrames(m, c) },
  "lum.floor": { source: "python", needs: (m, c) => emitFrames(m, c) },

  // time.*
  "time.motion": { source: "python", needs: (m, c) => motionFrames(m, c, "normal") },
  "time.flicker": { source: "python", needs: (m, c) => emitSequence("flicker", m, c, { defaultT0: 2500, count: 120 }) },
  "time.flicker_region": {
    source: "python",
    needs: (m, c) => emitSequence("flicker_region", m, c, { defaultT0: 2500, count: 120, defaultVariants: ["camera_drift"] })
  },

  // render.*
  "render.banding": { source: "python", needs: (m, c) => emitFrames(m, c) },
  "render.aliasing": {
    source: "python",
    needs: (m, c) => {
      if (hasStep(m, "turntable")) return emitBlenderSteps(m, c);
      return [...emitFrames(m, c, { dpr: 1 }), ...emitFrames(m, c, { dpr: 2, variants: ["dpr2"] })];
    }
  },
  "render.stripe_energy": { source: "python", needs: (m, c) => emitFrames(m, c) },
  "render.flip_vs_start": { source: "python", needs: (m, c) => emitBlenderSteps(m, c) },

  // scene.*
  "scene.star_count": { source: "python", needs: (m, c) => emitFrames(m, c) },
  "scene.star_roundness": { source: "python", needs: (m, c) => emitResizeSteps(m, c, 2) },
  "scene.silhouette": { source: "python", needs: (m, c) => emitFrames(m, c) },
  "scene.silhouette_iou": { source: "python", needs: (m, c) => emitFrames(m, c) },
  "scene.hierarchy": {
    source: "python",
    needs: () => [{ kind: "step", key: "step_blender_metrics3d", stepKind: "blender_metrics3d" }]
  },
  "scene.units_origin": {
    source: "python",
    needs: () => [{ kind: "step", key: "step_blender_metrics3d", stepKind: "blender_metrics3d" }]
  },

  // interact.*
  "interact.pointer_response": {
    source: "python",
    needs: (m, c) => [
      ...emitFrames(m, c, { variants: ["pointer_left"], pointer: [0.2, 0.5] }),
      ...emitFrames(m, c, { variants: ["pointer_right"], pointer: [0.8, 0.5] })
    ]
  },
  "interact.single_step": {
    source: "probe",
    needs: (m, c) => c.seeds.map((seed) => ({
      kind: "step", key: `lifecycle_30_s${seed}`, stepKind: "lifecycle", seed, cycles: 30, variant: "lifecycle_30"
    }))
  },

  // shape.* / anim.* / mem.* / ref.*
  "shape.circularity": { source: "python", needs: (m, c) => emitResizeSteps(m, c, 1) },
  "shape.iou_public": {
    source: "python",
    needs: () => [{ kind: "step", key: "step_ortho_views", stepKind: "ortho_views", views: ["front", "side", "top"] }]
  },
  "shape.iou_hidden": {
    source: "python",
    needs: () => [{ kind: "step", key: "step_hidden_views_12", stepKind: "hidden_views", count: 12 }]
  },
  "shape.iou_vs_start": {
    source: "python",
    needs: () => [{ kind: "step", key: "step_hidden_views_12", stepKind: "hidden_views", count: 12 }]
  },
  "anim.clock_independence": {
    source: "probe",
    needs: (m, c) => c.seeds.flatMap((seed) => [
      { kind: "step", key: `raf30_s${seed}_t5000`, stepKind: "raf_clock", seed, hz: 30, t: 5000, variant: "raf30" },
      { kind: "step", key: `raf144_s${seed}_t5000`, stepKind: "raf_clock", seed, hz: 144, t: 5000, variant: "raf144" }
    ])
  },
  "mem.resource_baseline": {
    source: "probe",
    needs: (m, c) => c.seeds.map((seed) => ({
      kind: "step", key: `lifecycle_30_s${seed}`, stepKind: "lifecycle", seed, cycles: 30, variant: "lifecycle_30"
    }))
  },
  "mem.heap_growth_mb": {
    source: "probe",
    needs: (m, c) => c.seeds.map((seed) => ({
      kind: "step", key: `lifecycle_30_s${seed}`, stepKind: "lifecycle", seed, cycles: 30, variant: "lifecycle_30"
    }))
  },
  "mem.listener_baseline": {
    source: "probe",
    needs: (m, c) => c.seeds.map((seed) => ({
      kind: "step", key: `lifecycle_30_s${seed}`, stepKind: "lifecycle", seed, cycles: 30, variant: "lifecycle_30"
    }))
  },
  "ref.flip": { source: "python", needs: (m, c) => emitFrames(m, c) },
  "ref.lum_delta": { source: "python", needs: (m, c) => emitFrames(m, c) },

  // perf.* / lh.* / budget.*
  "perf.frame_p95_norm_ms": {
    source: "harness",
    needs: (m, c) => [{ kind: "perf", viewport: resolveViewports(m, c)[0] }]
  },
  "lh.lcp_ms": { source: "harness", needs: () => [{ kind: "lighthouse" }] },
  "lh.cls": { source: "harness", needs: () => [{ kind: "lighthouse" }] },
  "budget.bundle_gz_kb": { source: "harness", needs: none },
  "budget.transfer_kb": { source: "harness", needs: none },
  "budget.draw_calls": { source: "harness", needs: (m, c) => emitFrames(m, c) },
  "budget.triangles": {
    source: "python",
    needs: () => [{ kind: "step", key: "step_blender_metrics3d", stepKind: "blender_metrics3d" }]
  },
  "budget.triangles_abs": {
    source: "python",
    needs: () => [{ kind: "step", key: "step_blender_metrics3d", stepKind: "blender_metrics3d" }]
  },

  // layout.* / text.* / type.* / space.* / align.*
  "layout.overflow_count": {
    source: "probe",
    needs: (m, c) => emitProbes("layout", m, c, c.spec?.protected?.elements ? { args: { selectors: c.spec.protected.elements } } : {})
  },
  "layout.tap_targets": {
    source: "probe",
    needs: (m, c) => emitProbes("layout", m, c, c.spec?.protected?.elements ? { args: { selectors: c.spec.protected.elements } } : {})
  },
  "layout.shift_px": {
    source: "probe",
    needs: (m, c) => emitProbes("layout", m, c, { args: { selectors: c.spec?.protected?.elements ?? [] } })
  },
  "text.clipped_count": { source: "probe", needs: (m, c) => emitProbes("text", m, c) },
  "text.hangul_midword_breaks": { source: "probe", needs: (m, c) => emitProbes("text", m, c) },
  "text.line_length": { source: "probe", needs: (m, c) => emitProbes("text", m, c) },
  "text.line_height": { source: "probe", needs: (m, c) => emitProbes("text", m, c) },
  "type.size_steps": { source: "probe", needs: (m, c) => emitProbes("type", m, c) },
  "type.scale_ratio_min": { source: "probe", needs: (m, c) => emitProbes("type", m, c) },
  "type.hero_serif": { source: "probe", needs: (m, c) => emitProbes("type_hero_serif", m, c) },
  "space.grid4_frac": { source: "probe", needs: (m, c) => emitProbes("space", m, c) },
  "align.column_count": { source: "probe", needs: (m, c) => emitProbes("align", m, c) },

  // a11y.* / nav.* / theme.* / data.* / lang.*
  "a11y.axe_violations": { source: "probe", needs: (m, c) => emitProbes("axe", m, c, { viewports: c.viewports, bothSchemes: true }) },
  "a11y.keyboard_reach": { source: "probe", needs: (m, c) => emitProbes("keyboard_reach", m, c) },
  "a11y.focus_visible": { source: "probe", needs: (m, c) => emitProbes("focus_visible", m, c) },
  "a11y.reduced_motion": { source: "python", needs: (m, c) => motionFrames(m, c, "reduced_motion") },
  "a11y.reduced_motion_transition_ms": {
    source: "probe",
    needs: (m, c) => c.seeds.map((seed) => ({
      kind: "step", key: `nav_transition_s${seed}_reduced_motion`, stepKind: "nav_transition", seed, variant: "reduced_motion"
    }))
  },
  "nav.routes": { source: "probe", needs: (m, c) => emitProbes("nav_routes", m, c) },
  "nav.transition_ms": {
    source: "probe",
    needs: (m, c) => c.seeds.map((seed) => ({
      kind: "step", key: `nav_transition_s${seed}_normal`, stepKind: "nav_transition", seed, variant: "normal"
    }))
  },
  "theme.both_valid": {
    source: "probe",
    needs: (m, c) => [
      ...emitFrames(m, c, { bothSchemes: true }),
      ...emitProbes("axe", m, c, { bothSchemes: true })
    ]
  },
  "data.rooms_rendered": { source: "probe", needs: (m, c) => emitProbes("data", m, c) },
  "data.long_title": {
    source: "probe",
    needs: (m, c) => emitProbes("data", m, c, { viewports: ["360x780"], defaultVariants: ["long_title"] })
  },
  "data.empty_state": {
    source: "probe",
    needs: (m, c) => emitProbes("data", m, c, { defaultVariants: ["empty_rooms"] })
  },
  "lang.toggle": {
    source: "probe",
    needs: (m, c) => emitProbes("lang_toggle", m, c, { viewports: ["320x640", "1440x900"] })
  },

  // visual.* / mask.* / room-specific
  "visual.congestion": { source: "python", needs: (m, c) => emitFrames(m, c) },
  "visual.edge_density": { source: "python", needs: (m, c) => emitFrames(m, c) },
  "mask.element_ssim": {
    source: "python",
    needs: (m, c) => {
      const viewports = c.spec?.protected?.compare_at ?? resolveViewports(m, c);
      const schemes = c.spec?.protected?.color_schemes ?? ["light", "dark"];
      const args = c.spec?.protected?.elements ? { selectors: c.spec.protected.elements } : {};
      return [
        ...emitFrames(m, c, { viewports, schemes }),
        ...emitProbes("layout", m, c, { viewports, schemes, args })
      ];
    }
  },
  "mask.silhouette_delta": { source: "python", needs: (m, c) => emitFrames(m, c) },
  "reduced_motion.not_blank": {
    source: "python",
    needs: (m, c) => emitFrames(m, c, { defaultVariants: ["normal", "reduced_motion"] })
  },

  // tests.* / diff.* / rootcause.* / decision.* / report.* / bugs.*
  "tests.hidden": {
    source: "test",
    needs: (m, c) => {
      const isV2 = c.version === 2 || String(c.spec?.spec_version || "").startsWith("0.2");
      const hiddenBase = isV2 ? "hidden-v2" : "hidden";
      const roomsBase = isV2 ? "rooms-v2" : "rooms";
      return [{
        kind: "test",
        path: c.hidden ? `${hiddenBase}/${c.spec.room}/tests` : `${roomsBase}/${c.spec.room}/seed/public-tests`
      }];
    }
  },
  "tests.preservation": {
    source: "test",
    needs: (m, c) => {
      const isV2 = c.version === 2 || String(c.spec?.spec_version || "").startsWith("0.2");
      const hiddenBase = isV2 ? "hidden-v2" : "hidden";
      const roomsBase = isV2 ? "rooms-v2" : "rooms";
      return [{
        kind: "test",
        path: c.hidden ? `${hiddenBase}/${c.spec.room}/tests` : `${roomsBase}/${c.spec.room}/seed/public-tests`
      }];
    }
  },
  "tests.redgreen": { source: "test", needs: none },
  "rootcause.accuracy": { source: "harness", needs: none },
  "diff.change_ratio": { source: "harness", needs: none },
  "diff.rewrite": { source: "harness", needs: none },
  "diff.out_of_scope_files": { source: "harness", needs: none },
  "decision.correct": { source: "harness", needs: none },
  "report.honesty": { source: "harness", needs: none },
  "report.autonomy": { source: "harness", needs: none },
  "bugs.fixed": { source: "room", needs: none },

  // 3D Blender metrics
  "dims.bbox_error": {
    source: "python",
    needs: () => [{ kind: "step", key: "step_blender_metrics3d", stepKind: "blender_metrics3d" }]
  },
  "dims.key_measurements": {
    source: "python",
    needs: () => [{ kind: "step", key: "step_blender_metrics3d", stepKind: "blender_metrics3d" }]
  },
  "dims.part_scale": {
    source: "python",
    needs: () => [{ kind: "step", key: "step_blender_metrics3d", stepKind: "blender_metrics3d" }]
  },
  "geo.others_hausdorff_mm": {
    source: "python",
    needs: () => [{ kind: "step", key: "step_blender_metrics3d", stepKind: "blender_metrics3d" }]
  },
  "geo.frame_unchanged": {
    source: "python",
    needs: () => [{ kind: "step", key: "step_blender_metrics3d", stepKind: "blender_metrics3d" }]
  },
  "rig.hinge": {
    source: "python",
    needs: () => [{ kind: "step", key: "step_blender_metrics3d", stepKind: "blender_metrics3d" }]
  },
  "rig.no_collision": {
    source: "python",
    needs: () => [{ kind: "step", key: "step_blender_metrics3d", stepKind: "blender_metrics3d" }]
  },
  "rig.open_angle": {
    source: "python",
    needs: () => [{ kind: "step", key: "step_blender_metrics3d", stepKind: "blender_metrics3d" }]
  },
  "topo.manifold": {
    source: "python",
    needs: () => [{ kind: "step", key: "step_blender_metrics3d", stepKind: "blender_metrics3d" }]
  },
  "topo.normals_outward": {
    source: "python",
    needs: () => [{ kind: "step", key: "step_blender_metrics3d", stepKind: "blender_metrics3d" }]
  },
  "topo.degenerate": {
    source: "python",
    needs: () => [{ kind: "step", key: "step_blender_metrics3d", stepKind: "blender_metrics3d" }]
  },
  "mat.assignment": {
    source: "python",
    needs: () => [{ kind: "step", key: "step_blender_metrics3d", stepKind: "blender_metrics3d" }]
  },
  "mat.pbr_plausible": {
    source: "python",
    needs: () => [{ kind: "step", key: "step_blender_metrics3d", stepKind: "blender_metrics3d" }]
  },
  "mat.color_delta": {
    source: "python",
    needs: () => [{ kind: "step", key: "step_blender_metrics3d", stepKind: "blender_metrics3d" }]
  },
  "mat.roughness_mean": {
    source: "python",
    needs: () => [{ kind: "step", key: "step_blender_metrics3d", stepKind: "blender_metrics3d" }]
  },
  "mat.variation": {
    source: "python",
    needs: () => [{ kind: "step", key: "step_blender_metrics3d", stepKind: "blender_metrics3d" }]
  },
  "uv.overlap": {
    source: "python",
    needs: () => [{ kind: "step", key: "step_blender_metrics3d", stepKind: "blender_metrics3d" }]
  },
  "vq.texel_density_cv": {
    source: "python",
    needs: () => [{ kind: "step", key: "step_blender_metrics3d", stepKind: "blender_metrics3d" }]
  },
  "vq.bevel_ratio": {
    source: "python",
    needs: () => [{ kind: "step", key: "step_blender_metrics3d", stepKind: "blender_metrics3d" }]
  },
  "vq.shading_artifacts": {
    source: "python",
    needs: () => [{ kind: "step", key: "step_turntable_8", stepKind: "turntable", count: 8 }]
  },
  "vq.exposure": {
    source: "python",
    needs: () => [{ kind: "step", key: "step_turntable_8", stepKind: "turntable", count: 8 }]
  },
  "vq.highlight_metal": {
    source: "python",
    needs: () => [{ kind: "step", key: "step_turntable_8", stepKind: "turntable", count: 8 }]
  },
  "vq.detail_scale": {
    source: "python",
    needs: () => [{ kind: "step", key: "step_turntable_8", stepKind: "turntable", count: 8 }]
  },
  "web.three_load": {
    source: "probe",
    needs: () => [{ kind: "step", key: "step_three_load", stepKind: "three_load" }]
  }
};

const PLUGIN_DEFINITIONS = new Map();

/**
 * Register custom metric descriptors (frozen M1 Extension Protocol).
 * Does not mutate built-in v0.1 DEFINITIONS.
 * @param {Record<string, { source: string, needs: (metric: object, ctx: object) => Array<object> }>} defs
 * @param {{ replace?: boolean }} opts
 */
export function registerMetrics(defs, { replace = false } = {}) {
  if (!defs || typeof defs !== "object") {
    throw new Error("registerMetrics expects an object mapping metricId -> { source, needs }");
  }
  const registered = [];
  for (const [id, def] of Object.entries(defs)) {
    if (typeof id !== "string" || id.length === 0) {
      throw new Error("Metric id must be a non-empty string");
    }
    if (!def || typeof def !== "object") {
      throw new Error(`Invalid metric definition for "${id}"`);
    }
    if (!VALID_SOURCES.includes(def.source)) {
      throw new Error(`Invalid metric source "${def.source}" for "${id}" (expected one of: ${VALID_SOURCES.join(", ")})`);
    }
    const needsFn = def.needs ?? none;
    if (typeof needsFn !== "function") {
      throw new Error(`Metric "${id}" needs must be a function`);
    }
    if (!replace && (Object.hasOwn(DEFINITIONS, id) || PLUGIN_DEFINITIONS.has(id))) {
      throw new Error(`Metric "${id}" is already registered (pass { replace: true } to override)`);
    }
    PLUGIN_DEFINITIONS.set(id, { source: def.source, needs: needsFn });
    registered.push(id);
  }
  return registered;
}

export function unregisterMetrics(ids = []) {
  for (const id of ids) {
    PLUGIN_DEFINITIONS.delete(id);
  }
}

export function hasMetric(id) {
  if (PLUGIN_DEFINITIONS.has(id)) return true;
  if (Object.hasOwn(DEFINITIONS, id)) return true;
  if (typeof id === "string" && id.startsWith("request.") && id.length > "request.".length) return true;
  return false;
}

export function getMetricDef(id) {
  if (PLUGIN_DEFINITIONS.has(id)) {
    return { id, ...PLUGIN_DEFINITIONS.get(id) };
  }
  if (Object.hasOwn(DEFINITIONS, id)) {
    return { id, ...DEFINITIONS[id] };
  }
  if (typeof id === "string" && id.startsWith("request.") && id.length > "request.".length) {
    return { id, source: "harness", needs: none };
  }
  throw new Error(`Unknown metric id: "${id}"`);
}

export function listMetricIds() {
  return [...new Set([...Object.keys(DEFINITIONS), ...PLUGIN_DEFINITIONS.keys()])];
}
