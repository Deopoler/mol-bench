"""Deterministic WebGL2 GLSL shader op-counter and GPU work-budget metrics (v0.2)."""

from __future__ import annotations

import re
from typing import Any

# Weights per docs/V02-DESIGN.md §3.1A
W_ALU = 1
W_BRANCH = 2
W_TRANSCENDENTAL = 4
W_TEXTURE = 16
DYNAMIC_LOOP_ITERS = 32

TEXTURE_FUNCS = frozenset({
    "texture",
    "texture2D",
    "textureCube",
    "texture3D",
    "textureLod",
    "textureGrad",
    "textureOffset",
    "texelFetch",
    "texelFetchOffset",
    "textureProj",
    "textureProjLod",
    "texture2DLod",
    "texture2DProj",
    "textureSize",
})

TRANSCENDENTAL_FUNCS = frozenset({
    "sin",
    "cos",
    "tan",
    "asin",
    "acos",
    "atan",
    "sinh",
    "cosh",
    "tanh",
    "asinh",
    "acosh",
    "atanh",
    "exp",
    "exp2",
    "log",
    "log2",
    "pow",
    "sqrt",
    "inversesqrt",
    "radians",
    "degrees",
})

ALU_BUILTIN_FUNCS = frozenset({
    "abs",
    "sign",
    "floor",
    "trunc",
    "round",
    "roundEven",
    "ceil",
    "fract",
    "mod",
    "modf",
    "min",
    "max",
    "clamp",
    "mix",
    "step",
    "smoothstep",
    "dot",
    "cross",
    "length",
    "distance",
    "normalize",
    "faceforward",
    "reflect",
    "refract",
    "matrixCompMult",
    "outerProduct",
    "transpose",
    "determinant",
    "inverse",
    "dFdx",
    "dFdy",
    "fwidth",
    "lessThan",
    "lessThanEqual",
    "greaterThan",
    "greaterThanEqual",
    "equal",
    "notEqual",
    "any",
    "all",
    "not",
})

_GLSL_RETURN_TYPES = (
    r"(?:void|bool|int|uint|float|double|"
    r"[biu]?vec[234]|dvec[234]|mat[234](?:x[234])?|"
    r"highp\s+\w+|mediump\s+\w+|lowp\s+\w+)"
)
_RE_FUNC_HEAD = re.compile(
    rf"\b{_GLSL_RETURN_TYPES}\s+([A-Za-z_]\w*)\s*\(([^)]*)\)\s*\{{"
)
_RE_DEFINE = re.compile(r"^\s*#\s*define\s+([A-Za-z_]\w*)\s+([^\r\n]+)", re.MULTILINE)
_RE_PREPROC_LINE = re.compile(r"^\s*#[^\r\n]*", re.MULTILINE)
_RE_CALL = re.compile(r"\b([A-Za-z_]\w*)\s*\(")
_RE_BRANCH = re.compile(r"\b(?:if|discard)\b|\?")
_RE_NUMBER_EXP = re.compile(r"\b\d+(?:\.\d+)?[eE][+-]?\d+[fFuU]?\b")
_RE_OPS = re.compile(
    r"\+\+|--|\+=|-=|\*=|/=|%=|<<=|>>=|&=|\^=|\|=|"
    r"==|!=|<=|>=|&&|\|\||<<|>>|[+\-*/%<>!&|^]"
)
_RE_FOR_HEAD = re.compile(r"\bfor\s*\(")
_RE_WHILE_HEAD = re.compile(r"\bwhile\s*\(")


def _strip_comments(source: str) -> str:
    """Remove GLSL /* ... */ and // ... comments while preserving line count."""
    out: list[str] = []
    i = 0
    n = len(source)
    while i < n:
        ch = source[i]
        nxt = source[i + 1] if i + 1 < n else ""
        if ch == "/" and nxt == "*":
            i += 2
            while i < n and not (source[i] == "*" and (i + 1 < n and source[i + 1] == "/")):
                if source[i] == "\n":
                    out.append("\n")
                i += 1
            i += 2
        elif ch == "/" and nxt == "/":
            i += 2
            while i < n and source[i] != "\n":
                i += 1
        else:
            out.append(ch)
            i += 1
    return "".join(out)


def _extract_defines(clean_src: str) -> dict[str, int]:
    """Extract constant integer #define macros."""
    macros: dict[str, int] = {}
    for m in _RE_DEFINE.finditer(clean_src):
        name = m.group(1)
        expr = m.group(2).strip()
        if re.fullmatch(r"[+-]?\d+", expr):
            macros[name] = int(expr)
    return macros


def _substitute_defines(src: str, macros: dict[str, int]) -> str:
    if not macros:
        return src
    pattern = re.compile(r"\b(" + "|".join(re.escape(k) for k in macros) + r")\b")
    return pattern.sub(lambda m: str(macros[m.group(1)]), src)


def _find_matching(text: str, open_idx: int, open_ch: str, close_ch: str) -> int:
    depth = 0
    for i in range(open_idx, len(text)):
        c = text[i]
        if c == open_ch:
            depth += 1
        elif c == close_ch:
            depth -= 1
            if depth == 0:
                return i
    return len(text) - 1


def _eval_num(tok: str) -> float | None:
    s = tok.strip().rstrip("fFuU")
    try:
        return float(s)
    except ValueError:
        return None


def _parse_for_iterations(header: str) -> int:
    """Estimate trip count of a GLSL `for (init; cond; step)` header.

    Returns exact trip count when constant-bounded, else DYNAMIC_LOOP_ITERS (32).
    """
    parts = header.split(";")
    if len(parts) != 3:
        return DYNAMIC_LOOP_ITERS
    init_s, cond_s, step_s = [p.strip() for p in parts]

    m_init = re.search(r"\b([A-Za-z_]\w*)\s*=\s*([+-]?\d+(?:\.\d+)?[fFuU]?)", init_s)
    if not m_init:
        return DYNAMIC_LOOP_ITERS
    var = m_init.group(1)
    start_val = _eval_num(m_init.group(2))
    if start_val is None:
        return DYNAMIC_LOOP_ITERS

    m_cond = re.search(
        rf"\b{re.escape(var)}\s*(<=|>=|<|>)\s*([+-]?\d+(?:\.\d+)?[fFuU]?)\b",
        cond_s,
    )
    if not m_cond:
        # Also handle `BOUND > i`
        m_rev = re.search(
            rf"\b([+-]?\d+(?:\.\d+)?[fFuU]?)\s*(<=|>=|<|>)\s*{re.escape(var)}\b",
            cond_s,
        )
        if not m_rev:
            return DYNAMIC_LOOP_ITERS
        end_val = _eval_num(m_rev.group(1))
        flip = {"<": ">", "<=": ">=", ">": "<", ">=": "<="}
        op = flip[m_rev.group(2)]
    else:
        op = m_cond.group(1)
        end_val = _eval_num(m_cond.group(2))

    if end_val is None:
        return DYNAMIC_LOOP_ITERS

    # Determine step delta
    step_val: float | None = None
    if re.search(rf"\+\+\s*{re.escape(var)}\b|\b{re.escape(var)}\s*\+\+", step_s):
        step_val = 1.0
    elif re.search(rf"--\s*{re.escape(var)}\b|\b{re.escape(var)}\s*--", step_s):
        step_val = -1.0
    elif m_inc := re.search(rf"\b{re.escape(var)}\s*\+=\s*([+-]?\d+(?:\.\d+)?[fFuU]?)", step_s):
        step_val = _eval_num(m_inc.group(1))
    elif m_dec := re.search(rf"\b{re.escape(var)}\s*-=\s*([+-]?\d+(?:\.\d+)?[fFuU]?)", step_s):
        v = _eval_num(m_dec.group(1))
        step_val = -v if v is not None else None
    elif m_asg := re.search(
        rf"\b{re.escape(var)}\s*=\s*{re.escape(var)}\s*([+-])\s*([+-]?\d+(?:\.\d+)?[fFuU]?)",
        step_s,
    ):
        v = _eval_num(m_asg.group(2))
        if v is not None:
            step_val = v if m_asg.group(1) == "+" else -v

    if step_val is None or step_val == 0.0:
        return DYNAMIC_LOOP_ITERS

    # Simulate exact trip count (capped safely at 10000 to avoid pathological bounds)
    count = 0
    cur = start_val
    eps = 1e-9
    for _ in range(10000):
        cond_ok = (
            (cur < end_val - eps) if op == "<"
            else (cur <= end_val + eps) if op == "<="
            else (cur > end_val + eps) if op == ">"
            else (cur >= end_val - eps)
        )
        if not cond_ok:
            break
        count += 1
        cur += step_val
    return count


def _count_flat_ops(
    snippet: str,
    user_funcs: dict[str, str],
    call_stack: frozenset[str],
) -> dict[str, int]:
    """Count weighted ops in a loop-free GLSL snippet, expanding user function calls."""
    counts = {"alu": 0, "transcendental": 0, "branch": 0, "texture": 0, "total": 0}
    if not snippet.strip():
        return counts

    # Remove scientific notation exponents before scanning +/- operators
    scrubbed = _RE_NUMBER_EXP.sub("0", snippet)

    # 1. Function calls
    for m in _RE_CALL.finditer(scrubbed):
        fname = m.group(1)
        if fname in {"if", "for", "while", "switch", "return"}:
            continue
        if fname in TEXTURE_FUNCS:
            counts["texture"] += 1
        elif fname in TRANSCENDENTAL_FUNCS:
            counts["transcendental"] += 1
        elif fname in ALU_BUILTIN_FUNCS:
            counts["alu"] += 1
        elif fname in user_funcs and fname not in call_stack:
            sub = _count_block_ops(user_funcs[fname], user_funcs, call_stack | {fname})
            counts["alu"] += sub["alu"]
            counts["transcendental"] += sub["transcendental"]
            counts["branch"] += sub["branch"]
            counts["texture"] += sub["texture"]

    # 2. Branches (`if`, ternary `?`, `discard`)
    counts["branch"] += len(_RE_BRANCH.findall(scrubbed))

    # 3. Arithmetic / logical / bitwise operators (outside `else if` keyword)
    counts["alu"] += len(_RE_OPS.findall(scrubbed))

    counts["total"] = (
        W_ALU * counts["alu"]
        + W_TRANSCENDENTAL * counts["transcendental"]
        + W_BRANCH * counts["branch"]
        + W_TEXTURE * counts["texture"]
    )
    return counts


def _count_block_ops(
    code: str,
    user_funcs: dict[str, str],
    call_stack: frozenset[str],
) -> dict[str, int]:
    """Count weighted ops in a GLSL block, expanding for/while loops recursively."""
    counts = {"alu": 0, "transcendental": 0, "branch": 0, "texture": 0, "total": 0}
    non_loop_chunks: list[str] = []
    pos = 0
    n = len(code)

    while pos < n:
        m_for = _RE_FOR_HEAD.search(code, pos)
        m_while = _RE_WHILE_HEAD.search(code, pos)
        if m_for is None and m_while is None:
            non_loop_chunks.append(code[pos:])
            break

        if m_for is not None and (m_while is None or m_for.start() <= m_while.start()):
            is_for = True
            m = m_for
        else:
            is_for = False
            m = m_while  # type: ignore[assignment]

        non_loop_chunks.append(code[pos : m.start()])
        paren_open = m.end() - 1
        paren_close = _find_matching(code, paren_open, "(", ")")
        header = code[paren_open + 1 : paren_close]
        iters = _parse_for_iterations(header) if is_for else DYNAMIC_LOOP_ITERS

        # Find loop body (`{ ... }` or single statement ending at `;`)
        j = paren_close + 1
        while j < n and code[j].isspace():
            j += 1
        if j < n and code[j] == "{":
            body_end = _find_matching(code, j, "{", "}")
            body = code[j + 1 : body_end]
            pos = body_end + 1
        else:
            semi = code.find(";", j)
            end_stmt = semi + 1 if semi != -1 else n
            body = code[j:end_stmt]
            pos = end_stmt

        # Header condition/increment executes each iteration (~1 branch + 1 alu per step)
        body_counts = _count_block_ops(body, user_funcs, call_stack)
        counts["alu"] += iters * (body_counts["alu"] + (1 if is_for else 0))
        counts["transcendental"] += iters * body_counts["transcendental"]
        counts["branch"] += iters * (body_counts["branch"] + 1)
        counts["texture"] += iters * body_counts["texture"]

    flat = _count_flat_ops("".join(non_loop_chunks), user_funcs, call_stack)
    counts["alu"] += flat["alu"]
    counts["transcendental"] += flat["transcendental"]
    counts["branch"] += flat["branch"]
    counts["texture"] += flat["texture"]
    counts["total"] = (
        W_ALU * counts["alu"]
        + W_TRANSCENDENTAL * counts["transcendental"]
        + W_BRANCH * counts["branch"]
        + W_TEXTURE * counts["texture"]
    )
    return counts


def count_shader_ops(source: str) -> dict[str, int]:
    """Parse a single GLSL vertex or fragment shader and return weighted operation counts.

    Returns dict with keys: `alu`, `transcendental`, `branch`, `texture`, `total`.
    """
    if not source or not isinstance(source, str):
        return {"alu": 0, "transcendental": 0, "branch": 0, "texture": 0, "total": 0}

    cleaned = _strip_comments(source)
    macros = _extract_defines(cleaned)
    no_preproc = _RE_PREPROC_LINE.sub("", cleaned)
    expanded = _substitute_defines(no_preproc, macros)

    user_funcs: dict[str, str] = {}
    top_spans: list[tuple[int, int]] = []
    scan_pos = 0
    while True:
        m = _RE_FUNC_HEAD.search(expanded, scan_pos)
        if not m:
            break
        fname = m.group(1)
        brace_open = m.end() - 1
        brace_close = _find_matching(expanded, brace_open, "{", "}")
        user_funcs[fname] = expanded[brace_open + 1 : brace_close]
        top_spans.append((m.start(), brace_close + 1))
        scan_pos = brace_close + 1

    if "main" in user_funcs:
        return _count_block_ops(user_funcs["main"], user_funcs, frozenset({"main"}))

    # Fallback if snippet has no explicit `main()`
    return _count_block_ops(expanded, user_funcs, frozenset())


def count_program_ops(vertex_src: str, fragment_src: str) -> dict[str, Any]:
    """Count unified vertex + fragment shader ops for a linked WebGL program."""
    vs = count_shader_ops(vertex_src)
    fs = count_shader_ops(fragment_src)
    return {
        "vertex": vs,
        "fragment": fs,
        "total": vs["total"] + fs["total"],
    }


def _lower_ramp(val: float, full: float, zero: float) -> float:
    if val <= full:
        return 1.0
    if val >= zero:
        return 0.0
    return float((zero - val) / (zero - full))


DEFAULT_GPU_BUDGET_THRESHOLDS: dict[str, dict[str, float]] = {
    "shader_ops": {"full": 650.0, "zero": 2200.0},
    "vertices_drawn": {"full": 12.0, "zero": 2000.0},
    "tex_upload_kb": {"full": 16.0, "zero": 128.0},
    "gl_calls_per_frame": {"full": 35.0, "zero": 150.0},
    "bundle_gz_kb": {"full": 24.0, "zero": 96.0},
}


def compute_gpu_work_profile(
    webgl_stats: dict[str, Any],
    *,
    bundle_gz_kb: float | None = None,
    thresholds: dict[str, dict[str, float]] | None = None,
) -> dict[str, Any]:
    """Compute worst-of-4-channels `budget.gpu_work_profile` in [0, 1].

    Channels (per docs/V02-DESIGN.md §3.1A & §4.2):
      1. Unified vertex + fragment shader op-count
      2. Total vertices drawn per frame
      3. Runtime texture + buffer upload KB
      4. Per-frame GL API calls + gzipped bundle KB
    """
    th = {**DEFAULT_GPU_BUDGET_THRESHOLDS, **(thresholds or {})}

    programs = webgl_stats.get("programs") or []
    shader_ops_total = 0
    if programs:
        for p in programs:
            if p.get("draw_calls") == 0:
                continue
            vs_src = p.get("vertex") or p.get("vs") or p.get("vertexShader") or ""
            fs_src = p.get("fragment") or p.get("fs") or p.get("fragmentShader") or ""
            shader_ops_total += count_program_ops(vs_src, fs_src)["total"]
    elif "shader_ops" in webgl_stats:
        shader_ops_total = int(webgl_stats["shader_ops"])

    vertices_drawn = float(webgl_stats.get("vertices_drawn_per_frame", webgl_stats.get("vertices_drawn", 0)))
    tex_upload_kb = float(webgl_stats.get("tex_upload_kb", 0.0))
    gl_calls = float(webgl_stats.get("gl_calls_per_frame", 0.0))
    gz_kb = float(bundle_gz_kb if bundle_gz_kb is not None else webgl_stats.get("bundle_gz_kb", 0.0))

    ch1 = _lower_ramp(float(shader_ops_total), th["shader_ops"]["full"], th["shader_ops"]["zero"])
    ch2 = _lower_ramp(vertices_drawn, th["vertices_drawn"]["full"], th["vertices_drawn"]["zero"])
    ch3 = _lower_ramp(tex_upload_kb, th["tex_upload_kb"]["full"], th["tex_upload_kb"]["zero"])
    ch4_gl = _lower_ramp(gl_calls, th["gl_calls_per_frame"]["full"], th["gl_calls_per_frame"]["zero"])
    ch4_gz = _lower_ramp(gz_kb, th["bundle_gz_kb"]["full"], th["bundle_gz_kb"]["zero"])
    ch4 = min(ch4_gl, ch4_gz)

    overall = min(ch1, ch2, ch3, ch4)
    return {
        "value": float(overall),
        "shader_ops": int(shader_ops_total),
        "vertices_drawn": vertices_drawn,
        "tex_upload_kb": tex_upload_kb,
        "gl_calls_per_frame": gl_calls,
        "bundle_gz_kb": gz_kb,
        "channels": {
            "shader_ops": ch1,
            "vertices_drawn": ch2,
            "tex_upload_kb": ch3,
            "gl_calls_and_bundle": ch4,
        },
    }


def compute_render_passes(webgl_stats: dict[str, Any]) -> float:
    """Compute `budget.render_passes`: FBO target switches + viewport-normalized pixel fill."""
    if "render_passes" in webgl_stats and "fbo_switches" not in webgl_stats and "pixel_fill_ratio" not in webgl_stats:
        return float(webgl_stats["render_passes"])
    switches = float(webgl_stats.get("fbo_switches", webgl_stats.get("render_passes_per_frame", 0.0)))
    fill_ratio = float(webgl_stats.get("pixel_fill_ratio", 1.0))
    return float(switches + fill_ratio)


def compute_render_work(webgl_stats: dict[str, Any]) -> float:
    """Compute `budget.render_work` for `restoration` v0.2 in [0, 1].

    Caps against reference: `draw_calls <= ref + 2`, `triangles <= ref * 1.15`,
    `render_passes <= ref + 1`. Linearly decays if exceeded (full 1.0, zero 0.0).
    """
    ref = webgl_stats.get("reference") or {}
    ref_dc = float(ref.get("draw_calls", webgl_stats.get("ref_draw_calls", 0.0)))
    ref_tris = float(ref.get("triangles", webgl_stats.get("ref_triangles", 0.0)))
    ref_passes = float(ref.get("render_passes", webgl_stats.get("ref_render_passes", 0.0)))

    dc = float(webgl_stats.get("draw_calls_per_frame", webgl_stats.get("draw_calls", 0.0)))
    tris = float(webgl_stats.get("triangles_per_frame", webgl_stats.get("triangles", 0.0)))
    passes = compute_render_passes(webgl_stats)

    s_dc = _lower_ramp(dc, ref_dc + 2.0, max(ref_dc + 10.0, (ref_dc + 2.0) * 2.0)) if ref_dc > 0 else 1.0
    s_tri = _lower_ramp(tris, ref_tris * 1.15, max(ref_tris * 2.0, ref_tris * 1.15 + 100.0)) if ref_tris > 0 else 1.0
    s_pass = _lower_ramp(passes, ref_passes + 1.0, max(ref_passes + 5.0, (ref_passes + 1.0) * 2.0)) if ref_passes > 0 else 1.0
    return float(min(s_dc, s_tri, s_pass))


def _extract_webgl_entries(ctx: dict[str, Any]) -> list[tuple[str, dict[str, Any]]]:
    manifest = ctx["manifest"]
    samples = ctx["select_samples"](
        manifest.get("samples", []),
        ctx["at_filter"],
        default_variant="normal",
        viewport_default=manifest.get("viewport_default"),
    )
    entries: list[tuple[str, dict[str, Any]]] = []
    for s in samples:
        wg = s.get("webgl")
        if isinstance(wg, dict):
            entries.append((s["key"], wg))
    if not entries and isinstance(manifest.get("webgl"), dict):
        entries.append(("manifest_webgl", manifest["webgl"]))
    return entries


def _compute_gpu_work_profile_metric(ctx: dict[str, Any]) -> dict[str, Any] | None:
    entries = _extract_webgl_entries(ctx)
    if not entries:
        return None
    manifest = ctx["manifest"]
    spec = ctx["spec"]
    cfg = ctx["metric_cfg"]
    thresholds = cfg.get("thresholds") or (spec.get("budget_thresholds") or {}).get("gpu_work_profile")
    bundle_gz_kb = manifest.get("bundle_gz_kb")

    sample_results: list[dict[str, Any]] = []
    details: dict[str, Any] = {}
    for key, wg in entries:
        res = compute_gpu_work_profile(wg, bundle_gz_kb=bundle_gz_kb, thresholds=thresholds)
        sample_results.append({"key": key, "value": res["value"]})
        details[key] = res

    raw_val = ctx["aggregate_values"](
        [r["value"] for r in sample_results],
        agg=ctx["agg"],
        score_spec=ctx["score_spec"],
    )
    return {
        "raw": raw_val,
        "samples": sample_results,
        "detail": {"agg": ctx["agg"], "count": len(sample_results), "breakdown": details},
    }


def _compute_shader_ops_metric(ctx: dict[str, Any]) -> list[dict[str, Any]] | None:
    entries = _extract_webgl_entries(ctx)
    if not entries:
        return None
    out: list[dict[str, Any]] = []
    for key, wg in entries:
        res = compute_gpu_work_profile(wg)
        out.append({"key": key, "value": float(res["shader_ops"])})
    return out or None


def _compute_render_passes_metric(ctx: dict[str, Any]) -> list[dict[str, Any]] | None:
    entries = _extract_webgl_entries(ctx)
    if not entries:
        return None
    out: list[dict[str, Any]] = []
    for key, wg in entries:
        if "render_passes" in wg or "fbo_switches" in wg or "render_passes_per_frame" in wg or "pixel_fill_ratio" in wg:
            out.append({"key": key, "value": compute_render_passes(wg)})
    return out or None


def _compute_draw_calls_metric(ctx: dict[str, Any]) -> list[dict[str, Any]] | None:
    entries = _extract_webgl_entries(ctx)
    if not entries:
        return None
    out: list[dict[str, Any]] = []
    for key, wg in entries:
        if "draw_calls_per_frame" in wg or "draw_calls" in wg:
            val = float(wg.get("draw_calls_per_frame", wg.get("draw_calls", 0)))
            out.append({"key": key, "value": val})
    return out or None


def _compute_render_work_metric(ctx: dict[str, Any]) -> list[dict[str, Any]] | None:
    entries = _extract_webgl_entries(ctx)
    if not entries:
        return None
    out: list[dict[str, Any]] = []
    for key, wg in entries:
        if "reference" in wg or "ref_draw_calls" in wg or "ref_triangles" in wg:
            out.append({"key": key, "value": compute_render_work(wg)})
    return out or None


def register(METRICS: dict[str, Any]) -> None:
    """Register WebGL / GLSL work-budget metrics with molmetrics CLI."""
    METRICS["budget.gpu_work_profile"] = _compute_gpu_work_profile_metric
    METRICS["budget.shader_ops"] = _compute_shader_ops_metric
    METRICS["budget.render_passes"] = _compute_render_passes_metric
    METRICS["budget.draw_calls"] = _compute_draw_calls_metric
    METRICS["budget.render_work"] = _compute_render_work_metric
