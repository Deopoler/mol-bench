# Metric definitions (v0.1 draft)

Exact algorithms for every metric id used in `rooms/*/spec.json`. Implementations live in
`harness/metrics/` (Python) and `harness/capture/probes/` (in-page JS). Any change to an algorithm is a
major-version change.

## Conventions

- **Color.** Frames are 8-bit sRGB PNG. Convert sRGB → linear (IEC 61966-2-1) → OKLab (Ottosson 2020).
  `L` below always means OKLab lightness in [0, 1]. OKLCH chroma `C = sqrt(a² + b²)`, hue `h = atan2(b, a)`.
- **ΔE_OK** = Euclidean distance in OKLab.
- **Y8** = 8-bit luma `round(255 × (0.2126 R' + 0.7152 G' + 0.0722 B'))` on gamma-encoded values (for banding only).
- **FLIP** = NVIDIA ꟻLIP (LDR, Andersson et al. 2020), mean over pixels. Implemented in numpy as `molmetrics.flip` (a port of the reference algorithm; validated against published reference values).
- **SSIM** = scikit-image `structural_similarity` on L, `data_range=1`, `gaussian_weights=True`, `sigma=1.5`.
- **Chromatic pixels** = pixels with `C > 0.04` and `L > 0.25`.
- Viewports are written `WxH`. Frame time `t` is ms on the bench clock.

---

## color.*

**color.palette_fidelity** — fraction of chromatic pixels whose nearest spec palette color (OKLab) is within
ΔE_OK < 0.10. If < 1 % of pixels are chromatic, the value is 0.

**color.palette_coverage** — fraction of palette colors that are the nearest palette color for ≥ 5 % of
chromatic pixels.

**color.chroma_mean** — mean `C` over chromatic pixels.

**color.hue_shift** — circular distance (degrees) between the chroma-weighted mean hue of the chromatic pixels
in the start frame and in the submission frame (Renovation).

**color.patch_delta** — mean ΔE_OK between the 12 color-chart patches (sampled 8×8 px at the patch centers
given by `state().chartPatches`) and their reference values.

## lum.*

**lum.mean** — mean `L` over the frame.

**lum.highlight_frac** — fraction of pixels with `L > 0.80`.

**lum.floor** — `pass` if `lum.mean ≥ 0.08` (the scene stays visible).

## time.*

**time.motion** — mean over 10 evenly spaced `t` of `mean |L(t + 16.667) − L(t)|`.

**time.flicker** — render 120 frames at Δt = 16.667 ms starting at `t0`. For each pixel, FFT of its `L` time
series (mean removed). Value = Σ energy above 10 Hz / Σ AC energy, averaged over pixels whose AC energy is above
1e-6. Static frames give 0.

**time.flicker_region** — same as `time.flicker`, restricted to a mask (given in the spec), with the camera
following the spec's micro-motion path (`state().camera` is driven by `params.cameraPath`).

## render.*

**render.banding** — smooth mask = pixels where the Gaussian-blurred (σ = 2) gradient magnitude of Y8 < 1.5.
A *band step* is a pixel inside the smooth mask where |Y8(x) − Y8(x+1)| = 1 (horizontal or vertical) and the 8
pixels on each side along that direction are constant. Value = band-step pixels / smooth-mask pixels.
Dithered gradients produce short runs and are not counted. If the smooth mask covers < 2 % of the frame the
value is 0.

**render.aliasing** — render the frame at DPR 1 (A) and DPR 2, box-downsampled 2× (B). Edge mask = Canny on L
of B (thresholds 0.05 / 0.15), dilated 1 px. Value = mean FLIP(A, B) inside the edge mask.

**render.stripe_energy** — inside the spec mask, ratio of the 2-D FFT energy in the band 0.25–0.5 cycles/px to
total AC energy, divided by the same ratio for the reference render. 1.0 = same as reference.

## scene.*

**scene.star_count** — in the top 60 % of the frame: pixels with `L > 0.6` and `L − mean(L over the 7×7 ring
excluding the center 3×3) > 0.25` are seeds; connected components with area 1–25 px are stars. Value = count.

**scene.star_roundness** — rendered at DPR 2: for stars with area ≥ 4 px, ratio of second-moment eigenvalues
`sqrt(λmax/λmin)`. Value = median. Evaluated after the resize sequence `1440x900 → 768x1024 → 1440x900` in the
same page (catches stale aspect ratios).

**scene.silhouette** — `pass` if both hold: (1) mean `L` of the bottom 6 % rows ≤ mean `L` of the rows at
30–40 % from the bottom − 0.05; (2) per-column horizon height (lowest row from top where `L` drops below
0.6 × sky mean of that column, searched in the bottom 30 %) has standard deviation ≥ 4 px.

**scene.silhouette_iou** — IoU between silhouette masks (pixels below the per-column horizon height) of start
and submission (Renovation).

## interact.*

**interact.pointer_response** — FLIP between frames at the same `t` with the pointer at (0.2W, 0.5H) and at
(0.8W, 0.5H).

## shape.* / anim.* / mem.*

**shape.circularity** — the focused planet's silhouette (mask from `state().focusedMaskColor` render pass, or
by flood fill from its projected center given in `state()`): `4π·area / perimeter²` (perimeter via
marching squares). 1.0 = perfect circle.

**anim.clock_independence** — the harness replaces `requestAnimationFrame` with a scheduler firing at 30 Hz,
then at 144 Hz, while the bench clock advances in real-time-equivalent virtual time. After 5000 ms of clock,
read `state().orbitAngleDeg` for the reference planet. Value = |angle₃₀ − angle₁₄₄| (degrees, wrapped).

**mem.resource_baseline** — `pass` if after 30 `unmount()`/`mount()` cycles, `stats().geometries`,
`stats().textures` and `stats().programs` equal their values after the first mount.

**mem.heap_growth_mb** — `performance.memory.usedJSHeapSize` (after forced GC via CDP
`HeapProfiler.collectGarbage`) after 30 cycles minus after the first cycle, in MB.

**mem.listener_baseline** — `pass` if, after 30 cycles, the harness's own count of listeners registered by room
code (via patched `EventTarget.prototype.addEventListener`/`removeEventListener`) equals the first-cycle value.

**interact.single_step** — `pass` if after 30 cycles, one click on the "next planet" control changes
`state().focusedIndex` by exactly 1.

## ref.*

**ref.flip** — mean FLIP between the submission frame and the room's reference render at the same
(seed, t, viewport).

**ref.lum_delta** — |mean `L`(submission) − mean `L`(reference)|.

## perf.* (performance class, tolerance ±5 %)

**perf.frame_p95_norm_ms** — headed Chromium on a real GPU, `--disable-gpu-vsync --disable-frame-rate-limit`,
at the stated viewport, DPR 1. After 2 s warm-up, record 10 s of rAF deltas → p95 = `P`. Before each batch, run
the calibration scene → p95 = `Cnow`. `Cref` is the calibration scene's p95 on the reference machine (stored in
`harness/perf/reference.json`). Value = `P × Cref / Cnow`. Median of 5 runs.

## lh.* (performance class)

Lighthouse (pinned), desktop preset, simulated throttling, served from the local origin.
**lh.lcp_ms** — Largest Contentful Paint. **lh.cls** — Cumulative Layout Shift. Median of 5 runs.

## budget.*

**budget.bundle_gz_kb** — gzip -9 size of all served JS + CSS + HTML + shader files.
**budget.transfer_kb** — total bytes transferred on first load (uncompressed is not used; served with gzip).
**budget.draw_calls** — `stats().drawCalls` at the median sampled frame.

## layout.* / text.* / type.* / space.* / align.* (DOM probes, computed in-page)

Visible = has a non-empty client rect intersecting the viewport (for page-level metrics, the full scroll
height is evaluated by scrolling in viewport-height steps), `visibility != hidden`, `opacity > 0`.

**layout.overflow_count** — (1 if `scrollingElement.scrollWidth > innerWidth`) + number of visible elements
whose right edge > `innerWidth + 1` and that are not inside an ancestor with `overflow-x: auto|scroll|hidden`.

**text.clipped_count** — visible text elements where `scrollWidth > clientWidth + 1` or
`scrollHeight > clientHeight + 1` with `overflow != visible`, **except** single-line ellipsis elements that
carry the full text in a `title` attribute or `aria-label`.

**text.hangul_midword_breaks** — for every visible text node, for each adjacent pair of Hangul syllables
(U+AC00–U+D7A3) not separated by whitespace, compare the client rects of the two characters (via `Range`).
A pair whose rects are on different lines counts as one break.

**text.line_length** — for visible block elements marked `data-bench="body"` (or `<p>` if none are marked)
with ≥ 2 rendered lines: characters per rendered line (excluding the last line), median over lines. The
script is Hangul-dominant if > 50 % of letters are Hangul. Scored with the spec's per-script band.

**text.line_height** — computed `line-height / font-size` of the same elements, median.

**type.size_steps** — number of distinct computed `font-size` values (rounded to 0.5 px) among visible text
at the stated viewport.

**type.scale_ratio_min** — minimum ratio between consecutive distinct font sizes (sorted ascending).

**space.grid4_frac** — collect (a) vertical gaps between consecutive visible block siblings, (b) non-zero
paddings and `gap` values of visible containers. Value = fraction within ±0.5 px of a multiple of 4 px.

**align.column_count** — left edges of visible text-block boxes at the stated viewport, merged when within
2 px. Value = number of distinct edges.

**layout.tap_targets** — fraction of visible interactive elements (`a, button, input, select, [role=button],
[tabindex="0"]`) whose client rect is ≥ 44×44 CSS px, or whose 44×44 box centered on them does not overlap
another target.

**layout.shift_px** — Renovation: median displacement (px) of protected elements' bounding boxes between start
and submission.

## a11y.*

**a11y.axe_violations** — axe-core (pinned), count of violations with impact `serious` or `critical`, summed
over the stated viewports and both color schemes.

**a11y.keyboard_reach** — Tab from document start for up to 200 stops. Fraction of required targets
(spec-defined, e.g. every room card) that receive focus; and pressing Enter on each navigates correctly.

**a11y.focus_visible** — for each required target: screenshot of its bbox + 8 px when focused vs blurred.
Passes if changed pixels ≥ 2 × the bbox perimeter and the changed pixels have contrast ≥ 3:1 against their
unfocused values. Value = passing fraction.

**a11y.reduced_motion** — `time.motion` with `prefers-reduced-motion: reduce` emulated.

**a11y.reduced_motion_transition_ms** — `nav.transition_ms` with `prefers-reduced-motion: reduce` emulated.

## nav.* / theme.* / data.*

**nav.routes** — for each room card: activating it changes `location.hash` / path to the room's route and
`state().route` matches; browser Back returns to the lobby with the scroll position within 50 px. Fraction.

**nav.transition_ms** — CDP virtual time. Activate a card at t0; capture frames every 16 ms; the transition
ends at the first frame after which 5 consecutive frames have FLIP < 0.002 against each other. Value = end − t0.

**theme.both_valid** — `pass` if renders under `prefers-color-scheme: dark` and `light` differ (SHA-256) and
both have 0 axe `color-contrast` violations.

**data.rooms_rendered** — fraction of rooms in the generated `rooms.json` whose title (current language) appears
as exact visible, unclipped text inside an element linking to the room's route.

**data.long_title** — `pass` if the hidden 38-syllable Hangul title is fully visible (not clipped, no ellipsis)
at 360x780.

**data.empty_state** — with `rooms: []`: a visible element `[data-bench="empty-state"]` with ≥ 4 characters of
text exists, and gate `G-console` still holds.

## visual.*

**visual.congestion** — Feature Congestion (Rosenholtz, Li & Nakano 2007): local covariance volume of color
(OKLab), luminance contrast (DoG) and orientation (structure tensor) at 3 scales, combined as in the paper.
Computed on the first viewport at 1440x900. Reference port in `harness/metrics/congestion.py`.

**visual.edge_density** — fraction of pixels on Canny edges of L (thresholds 0.05 / 0.15) in the first viewport.

## mask.* (Renovation)

**mask.element_ssim** — for each protected element (selectors in the request spec): crop its bounding box in
start and submission (each at its own position, so pure displacement does not count), resize the submission crop
to the start crop size if they differ by ≤ 4 px, else score that element 0. SSIM per element. Value = minimum
over elements, viewports and color schemes.

**mask.silhouette_delta** — mean ΔE_OK over the start silhouette mask between start and submission.

## tests.* / diff.* / rootcause.* / decision.*

**tests.hidden** — fraction of the room's hidden functional tests passing.

**tests.preservation** — Renovation: fraction of hidden Build tests that passed on the start version and still
pass (minus tests listed in `preservation_exclude`).

**tests.redgreen** — for each bug the agent claims (`report.json → room.bugs[].test`): apply only the agent's
test files onto the seed → the test must fail; run on the submission → it must pass; the test name must contain
the `report_id`. Value = fraction of the room's planted bugs with a valid red-green test.

**rootcause.accuracy** — fraction of planted bugs whose `report.json → room.bugs[]` entry has the correct
`root_cause` code.

**diff.change_ratio** — (added + removed lines in non-test source files) / (lines in the reference minimal fix).

**diff.rewrite** — `pass` (good) if < 60 % of the start version's source lines were changed or removed.

**diff.out_of_scope_files** — number of changed files outside the spec's `scope` globs.

**decision.correct** — per request with an `expected_decision`: `status` and `reason` must be in the expected
sets, **or** `status: done` with all of that request's metrics scoring ≥ 7 (genuinely achieved). Fraction.

**request.<id>** — Renovation fulfillment score for one request: the weighted mean of the metrics listed under
that request in the renovation spec.

## Room-specific and composite ids

**bugs.fixed** — Restoration: for each of the 4 planted bugs, the weighted mean of that bug's metrics from
`bug_pool`; value = mean over the 4 bugs (0–10).

**lang.toggle** — Lobby r1: fraction of the checks listed under request `L-R2` that pass.

**type.hero_serif** — Lobby r1: `pass` if the computed `font-family` of `[data-bench="hero-title"]` resolves
(via `document.fonts` and the used font reported by CDP `CSS.getPlatformFontsForNode`) to a local font whose
OS/2 `sFamilyClass` is a serif class (1–5, 7), or to the generic `serif` family.

**reduced_motion.not_blank** — Aurora r1: `pass` if, with `prefers-reduced-motion: reduce`, `lum.mean` is within
±20 % and `scene.star_count` within ±30 % of the normal-mode values at the same (seed, t).

**report.honesty**, **report.autonomy** — see `docs/SCORING.md` §5.

## 3D (Blender rooms) — computed from out/*.blend (bpy, pinned Blender) and harness renders

Units are millimetres unless stated. "Part" = a required object from `parts.json`. Silhouettes are rendered by
the harness as orthographic holdout masks (object = 1, background = 0) at 2048×2048, 0.25 mm/px, framed by the
**reference** bounding box so that scale and position errors count.

**shape.iou_public** — IoU of submission vs reference silhouette for the front, side and top views.

**shape.iou_hidden** — same for the 12 hidden views (8 oblique at elevation +25°, 4 from below at −30°).

**shape.iou_vs_start** — Renovation: IoU vs the start model (with documented request changes applied to the start
reference), hidden views.

**dims.bbox_error** — max over x, y, z of |submission bbox size − sheet size| / sheet size (Lantern hierarchy,
evaluated in rest pose).

**dims.key_measurements** — fraction of the sheet's key measurements met: handle ring inner diameter (±2 %,
measured by ray casting in the ring plane), frame bar section (±10 %), pane count (exact, = number of Glass
pane islands), door on the specified face and hinge side.

**dims.part_scale** — Renovation: ratio of a part's bbox size vs start, worst axis.

**geo.others_hausdorff_mm** / **geo.frame_unchanged** — max one-sided Hausdorff distance (start → submission
surface, 20k area-weighted samples with a fixed seed) for the named parts.

**scene.hierarchy** — fraction of required (name, parent) pairs present. Names match exactly, case-sensitive.

**scene.units_origin** — fraction of: scene unit = metres and scale 1.0; all object scales (1,1,1) ± 1e-4;
Lantern origin at bottom center (|x|,|y| ≤ 1 mm from bbox center, lowest vertex z within ±1 mm of 0).

**rig.hinge** — fraction of: action `door_open` exists on Door; Door rotation at its last frame is 90° ± 5°;
the rotation axis (from the evaluated world matrices at the first and last frames) is parallel to the hinge bar
within 2° and passes within 2 mm of the hinge line from the sheet; no other part's world matrix changes
during the action (except Door children).

**rig.no_collision** — at every frame of `door_open`, BVH-tree overlap (mathutils.bvhtree) between Door +
Door_Glass and Frame/Roof/Base is empty (0.1 mm tolerance via a shrunken test mesh).

**rig.open_angle** — final opening angle of Door in degrees.

**topo.manifold** — number of non-manifold edges (bmesh: edges with ≠ 2 linked faces) on parts flagged
watertight.

**topo.normals_outward** — fraction of watertight parts whose signed volume is positive and whose faces agree
in winding (bmesh `normal_update` + consistency check).

**topo.degenerate** — faces with area < 1e-4 mm² plus edges with length < 1e-3 mm.

**budget.triangles** — triangles in the exported .glb / budget. **budget.triangles_abs** — triangle count.

**mat.assignment** — fraction of parts whose glTF primitives use exactly the material role named in
`materials.json` (matched by material name prefix: `brass_`, `glass_`, `wax_`, `flame_`, …).

**mat.pbr_plausible** — fraction of: metal parts metallic ≥ 0.9; dielectric base color L in [0.15, 0.95];
glass transmission ≥ 0.9 and IOR in [1.4, 1.6]; flame emissive strength within the sheet range; roughness inside
the sheet range (texture-sampled when textured).

**mat.color_delta** — mean ΔE_OK between each part's base color (texture mean if textured) and its swatch.

**mat.roughness_mean** — mean roughness over metal surfaces (10k area-weighted samples, texture-sampled).

**mat.variation** — std of base-color L plus std of roughness over the same samples.

**uv.overlap** — for textured parts: overlapping UV area / total UV area (rasterized at 2048²).

**vq.texel_density_cv** — coefficient of variation of (UV area / world area)^½ across faces of textured parts.

**vq.bevel_ratio** — on metal parts: among edges with dihedral angle > 45° in the *unbeveled sense* (detected
on the evaluated mesh as chains of faces whose normals turn > 45° within a width ≤ 3 % of the part's smallest
bbox dimension), fraction whose turn is spread over ≥ 2 face strips or uses split/custom normals with a
weighted transition. Reference port in `harness/metrics3d/bevel.py`.

**vq.shading_artifacts** — render a world-space normal pass of the turntable; detect normal discontinuities
(> 20° between neighboring pixels) that do not coincide with geometric silhouette edges or edges marked sharp
by an angle > 60°. Value = artifact pixels / object pixels.

**vq.exposure** — mean L of object pixels in the 8 turntable renders.

**vq.highlight_metal** — fraction of metal-material pixels (material index pass) with L > 0.85.

**vq.detail_scale** — silhouette perimeter at 1024 px divided by perimeter at 128 px (upscaled coordinates),
averaged over the 8 turntable silhouettes. Too simple → low, noisy → high; band set around the reference.

**render.flip_vs_start** — mean FLIP between submission and start turntable renders.

**web.three_load** — the .glb loads in the lobby's three.js pedestal scene (SwiftShader) with ≤ 12 draw calls and
no console errors.
