"""Tests for v0.2 GLSL static op-counter & GPU budget metrics (`budget_glsl.py`)."""

from __future__ import annotations

import json
from pathlib import Path

from molmetrics import budget_glsl, cli

GOOD_VS = """#version 300 es
in vec2 a_pos;
out vec2 v_uv;
void main() {
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}
"""

GOOD_FS = """#version 300 es
precision highp float;
in vec2 v_uv;
uniform float u_time;
out vec4 outColor;
void main() {
  vec2 p = v_uv * 2.0 - 1.0;
  float wave = sin(p.x * 4.0 + u_time) * 0.5 + 0.5;
  float glow = exp(-abs(p.y) * 3.0) * wave;
  outColor = vec4(0.1 * glow, 0.8 * glow, 0.5 * glow, 1.0);
}
"""

BAD_BLOATED_FS = """#version 300 es
precision highp float;
in vec2 v_uv;
uniform float u_time;
out vec4 outColor;
#define STEPS 20
float fbmLayer(vec2 x) {
  float s = 0.0;
  for (int i = 0; i < 4; i++) {
    s += sin(x.x * 3.1 + float(i)) * cos(x.y * 2.7 - u_time) + sqrt(abs(x.x) + 0.1);
  }
  return s;
}
void main() {
  float acc = 0.0;
  for (int i = 0; i < STEPS; i++) {
    acc += fbmLayer(v_uv + float(i) * 0.05);
  }
  outColor = vec4(acc, acc * 0.5, 0.2, 1.0);
}
"""

ATTACK_LUT_FS = """#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_lut;
uniform int u_steps;
out vec4 outColor;
void main() {
  vec4 acc = vec4(0.0);
  // Dynamic uniform-bound loop (counts as 32 iters) with 2 texture fetches (16x each) per iter
  for (int i = 0; i < u_steps; i++) {
    acc += texture(u_lut, v_uv + vec2(float(i) * 0.01, 0.0));
    acc += texture(u_lut, v_uv - vec2(float(i) * 0.01, 0.0));
  }
  outColor = acc;
}
"""


def test_glsl_op_counter_weights_and_loop_expansion():
    good_ops = budget_glsl.count_program_ops(GOOD_VS, GOOD_FS)
    bad_ops = budget_glsl.count_program_ops(GOOD_VS, BAD_BLOATED_FS)
    atk_ops = budget_glsl.count_program_ops(GOOD_VS, ATTACK_LUT_FS)

    assert good_ops["total"] < 120
    # 20 outer iters * 4 inner iters * ~25 weighted ops -> well over 1400
    assert 1000 <= bad_ops["total"] <= 2600
    # 32 dynamic iters * 2 textures * 16 weight -> > 1024 just from textures
    assert atk_ops["fragment"]["texture"] == 64
    assert atk_ops["total"] > 1200

    # Verify transcendental = 4 and texture = 16 weights explicitly
    only_tex = budget_glsl.count_shader_ops("void main() { vec4 c = texture(u_t, vec2(0.0)); }")
    only_sin = budget_glsl.count_shader_ops("void main() { float x = sin(1.0); }")
    assert only_tex["texture"] == 1
    assert only_tex["total"] >= 16
    assert only_sin["transcendental"] == 1
    assert only_sin["total"] >= 4


def test_gpu_work_profile_anti_gaming_channels_and_separation():
    # Good: clean analytic aurora shader within all 4 channels -> 10.0 pts
    good = budget_glsl.compute_gpu_work_profile({
        "programs": [{"vertex": GOOD_VS, "fragment": GOOD_FS, "draw_calls": 1}],
        "vertices_drawn_per_frame": 3,
        "tex_upload_kb": 0.0,
        "gl_calls_per_frame": 14,
        "bundle_gz_kb": 4.2,
    })
    assert good["value"] == 1.0

    # Bad: ~1350 ops -> ~0.55 profile (~5.5 score pts)
    bad = budget_glsl.compute_gpu_work_profile({
        "shader_ops": 1350,
        "vertices_drawn_per_frame": 6,
        "tex_upload_kb": 0.0,
        "gl_calls_per_frame": 18,
        "bundle_gz_kb": 6.0,
    })
    assert 0.45 <= bad["value"] <= 0.65

    # Attack A: LUT texture upload (256 KB >= 128 KB) -> 0.0 even if shader ops tiny
    atk_tex_upload = budget_glsl.compute_gpu_work_profile({
        "programs": [{"vertex": GOOD_VS, "fragment": GOOD_FS, "draw_calls": 1}],
        "vertices_drawn_per_frame": 3,
        "tex_upload_kb": 256.0,
        "gl_calls_per_frame": 14,
        "bundle_gz_kb": 4.2,
    })
    assert atk_tex_upload["value"] == 0.0

    # Attack B: Vertex tessellation offload (2500 vertices >= 2000) -> 0.0
    atk_verts = budget_glsl.compute_gpu_work_profile({
        "programs": [{"vertex": GOOD_VS, "fragment": GOOD_FS, "draw_calls": 1}],
        "vertices_drawn_per_frame": 2500,
        "tex_upload_kb": 0.0,
        "gl_calls_per_frame": 14,
        "bundle_gz_kb": 4.2,
    })
    assert atk_verts["value"] == 0.0

    # Attack C: Giant JS lookup table embedded in bundle (100 KB gz >= 96 KB) -> 0.0
    atk_bundle = budget_glsl.compute_gpu_work_profile({
        "programs": [{"vertex": GOOD_VS, "fragment": GOOD_FS, "draw_calls": 1}],
        "vertices_drawn_per_frame": 3,
        "tex_upload_kb": 0.0,
        "gl_calls_per_frame": 14,
        "bundle_gz_kb": 100.0,
    })
    assert atk_bundle["value"] == 0.0

    # Attack D: Texture LUT sampling in dynamic loop -> 0.0 (or < 0.2)
    atk_lut_shader = budget_glsl.compute_gpu_work_profile({
        "programs": [{"vertex": GOOD_VS, "fragment": ATTACK_LUT_FS, "draw_calls": 1}],
        "vertices_drawn_per_frame": 3,
        "tex_upload_kb": 200.0,
        "gl_calls_per_frame": 14,
        "bundle_gz_kb": 4.2,
    })
    assert atk_lut_shader["value"] == 0.0

    # >= 4 score point separation (scale 0..1 -> 0..10)
    assert (good["value"] - bad["value"]) * 10.0 >= 4.0
    assert (bad["value"] - atk_tex_upload["value"]) * 10.0 >= 4.0


def test_budget_glsl_cli_integration_and_repeatability(tmp_path: Path):
    manifest = {
        "room": "aurora",
        "viewport_default": "1440x900",
        "bundle_gz_kb": 5.0,
        "webgl": {
            "programs": [{"vertex": GOOD_VS, "fragment": GOOD_FS, "draw_calls": 1}],
            "draw_calls_per_frame": 1,
            "fbo_switches": 1,
            "pixel_fill_ratio": 1.0,
            "vertices_drawn_per_frame": 3,
            "triangles_per_frame": 1,
            "tex_upload_kb": 0.0,
            "gl_calls_per_frame": 12,
            "reference": {"draw_calls": 2, "triangles": 4, "render_passes": 2.0},
        },
        "samples": [],
    }
    spec = {
        "room": "aurora",
        "spec_version": "0.2.0",
        "metrics": [
            {"id": "budget.gpu_work_profile"},
            {"id": "budget.render_passes"},
            {"id": "budget.draw_calls"},
            {"id": "budget.render_work"},
        ],
    }
    m_path = tmp_path / "manifest.json"
    s_path = tmp_path / "spec.json"
    m_path.write_text(json.dumps(manifest), encoding="utf-8")
    s_path.write_text(json.dumps(spec), encoding="utf-8")

    r1 = cli.compute_metrics(m_path, s_path)
    r2 = cli.compute_metrics(m_path, s_path)
    assert r1 == r2
    assert r1["budget.gpu_work_profile"]["raw"] == 1.0
    assert r1["budget.render_passes"]["raw"] == 2.0
    assert r1["budget.draw_calls"]["raw"] == 1.0
    assert r1["budget.render_work"]["raw"] == 1.0


def test_glsl_macros_overloads_const_loops_and_mat_widths():
    # 1. Function-like macro & expression macro
    macro_fs = """#version 300 es
precision highp float;
#define COSTLY_WAVE(v) (sin(v) * cos(v) + exp(-abs(v)))
in vec2 v_uv;
out vec4 o;
void main() {
  float x = COSTLY_WAVE(v_uv.x);
  o = vec4(x, 0.0, 0.0, 1.0);
}
"""
    m_ops = budget_glsl.count_shader_ops(macro_fs)
    assert m_ops["transcendental"] >= 3
    assert m_ops["total"] >= 16

    # 2. const / struct return types & overload resolution (cheap float overload must not hide vec4 overload)
    overload_fs = """#version 300 es
precision highp float;
struct Ray { vec4 col; };
const int K = 2 * 3;
float helper(float x) { return x; }
vec4 helper(vec4 v) {
  return vec4(sin(v.x), cos(v.y), exp(v.z), pow(v.w, 2.0));
}
const Ray shade(vec4 p) {
  Ray r;
  r.col = helper(p);
  return r;
}
out vec4 o;
void main() {
  vec4 acc = vec4(0.0);
  for (int i = 0; i < K; i++) {
    acc += shade(vec4(float(i))).col;
    if (i == 2) continue;
    if (i > 4) break;
  }
  o = acc;
}
"""
    ov_ops = budget_glsl.count_shader_ops(overload_fs)
    # 6 const iterations * (4 transcendentals in vec4 overload + branch ops from if/continue/break)
    assert ov_ops["transcendental"] >= 24
    assert ov_ops["branch"] >= 6 * 5

    # 3. Matrix & vector widths vs scalar
    mat_ops = budget_glsl.count_shader_ops("void main() { mat4 a = mat4(1.0); mat4 b = mat4(2.0); mat4 c = a * b; }")
    scalar_ops = budget_glsl.count_shader_ops("void main() { float a = 1.0; float b = 2.0; float c = a * b; }")
    assert mat_ops["alu"] >= scalar_ops["alu"] + 15

    # 4. Program draw_calls multiplier & dynamic uniform bound maxing
    uni_fs = """void main() {
  vec4 s = vec4(0.0);
  for (int i = 0; i < u_steps; i++) { s += texture(u_t, vec2(0.0)); }
}"""
    u64 = budget_glsl.count_shader_ops(uni_fs, uniforms={"u_steps": 64})
    assert u64["texture"] == 64

    p1 = budget_glsl.compute_gpu_work_profile({"programs": [{"vertex": GOOD_VS, "fragment": GOOD_FS, "draw_calls": 1}]})
    p5 = budget_glsl.compute_gpu_work_profile({"programs": [{"vertex": GOOD_VS, "fragment": GOOD_FS, "draw_calls": 5}]})
    assert p5["shader_ops"] == p1["shader_ops"] * 5

