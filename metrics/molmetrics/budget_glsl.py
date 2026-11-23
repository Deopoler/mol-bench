"""Deterministic WebGL2 GLSL shader op-counter and GPU work-budget metrics (v0.2)."""

from __future__ import annotations

import ast
import re
from dataclasses import dataclass
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

HEAVY_TEXTURE_FUNCS = frozenset({
    "texture3D",
    "textureGrad",
    "textureProjLod",
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

_CONTROL_KEYWORDS = frozenset({"if", "for", "while", "switch", "return", "else"})
_RE_PREPROC_LINE = re.compile(r"^\s*#[^\r\n]*", re.MULTILINE)
_RE_CALL = re.compile(r"\b([A-Za-z_]\w*)\s*\(")
_RE_BRANCH = re.compile(r"\b(?:if|discard|break|continue)\b|\?")
_RE_NUMBER_EXP = re.compile(r"\b\d+(?:\.\d+)?[eE][+-]?\d+[fFuU]?\b")
_RE_OPS = re.compile(
    r"\+\+|--|\+=|-=|\*=|/=|%=|<<=|>>=|&=|\^=|\|=|"
    r"==|!=|<=|>=|&&|\|\||<<|>>|[+\-*/%<>!&|^]"
)
_RE_FOR_HEAD = re.compile(r"\bfor\s*\(")
_RE_WHILE_HEAD = re.compile(r"\bwhile\s*\(")
_RE_CONST_DECL = re.compile(
    r"\bconst\s+(?:(?:highp|mediump|lowp)\s+)?(?:int|uint|float|double)\s+([A-Za-z_]\w*)\s*=\s*([^;]+);"
)
_RE_VAR_DECL = re.compile(
    r"(?:^|[;{}])\s*(?:(?:in|out|inout|uniform|const|flat|smooth|highp|mediump|lowp)\s+)*"
    r"([biu]?vec[234]|dvec[234]|mat[234](?:x[234])?|float|int|uint|bool|double|sampler\w*)\s+"
    r"([A-Za-z_]\w*(?:\s*(?:=\s*[^,;]+)?(?:\s*,\s*[A-Za-z_]\w*(?:\s*=\s*[^,;]+)?)*))\s*;",
    re.MULTILINE,
)

_TYPE_WIDTHS: dict[str, int] = {
    "bool": 1,
    "int": 1,
    "uint": 1,
    "float": 1,
    "double": 1,
    "vec2": 2,
    "ivec2": 2,
    "uvec2": 2,
    "bvec2": 2,
    "dvec2": 2,
    "vec3": 3,
    "ivec3": 3,
    "uvec3": 3,
    "bvec3": 3,
    "dvec3": 3,
    "vec4": 4,
    "ivec4": 4,
    "uvec4": 4,
    "bvec4": 4,
    "dvec4": 4,
    "mat2": 4,
    "mat2x2": 4,
    "mat2x3": 6,
    "mat3x2": 6,
    "mat2x4": 8,
    "mat4x2": 8,
    "mat3": 9,
    "mat3x3": 9,
    "mat3x4": 12,
    "mat4x3": 12,
    "mat4": 16,
    "mat4x4": 16,
}

_MAT_DIMS: dict[str, tuple[int, int]] = {
    "mat2": (2, 2),
    "mat2x2": (2, 2),
    "mat2x3": (2, 3),
    "mat3x2": (3, 2),
    "mat2x4": (2, 4),
    "mat4x2": (4, 2),
    "mat3": (3, 3),
    "mat3x3": (3, 3),
    "mat3x4": (3, 4),
    "mat4x3": (4, 3),
    "mat4": (4, 4),
    "mat4x4": (4, 4),
}


@dataclass(frozen=True)
class _FuncDef:
    name: str
    param_types: tuple[str, ...]
    body: str


def _strip_comments(source: str) -> str:
    """Remove GLSL /* ... */ and // ... comments while preserving line structure."""
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


def _split_top_level_args(arg_str: str) -> list[str]:
    if not arg_str.strip():
        return []
    args: list[str] = []
    depth = 0
    start = 0
    for i, ch in enumerate(arg_str):
        if ch in "([{":
            depth += 1
        elif ch in ")]}":
            depth = max(0, depth - 1)
        elif ch == "," and depth == 0:
            args.append(arg_str[start:i].strip())
            start = i + 1
    args.append(arg_str[start:].strip())
    return args


def _expand_preprocessor_macros(clean_src: str) -> str:
    """Expand object-like and function-like GLSL #define macros iteratively."""
    joined = re.sub(r"\\\r?\n", " ", clean_src)
    obj_macros: dict[str, str] = {}
    func_macros: dict[str, tuple[list[str], str]] = {}

    for line in joined.splitlines():
        s = line.lstrip()
        if not s.startswith("#"):
            continue
        m_undef = re.match(r"#\s*undef\s+([A-Za-z_]\w*)\b", s)
        if m_undef:
            name = m_undef.group(1)
            obj_macros.pop(name, None)
            func_macros.pop(name, None)
            continue
        m_fn = re.match(r"#\s*define\s+([A-Za-z_]\w*)\(([^)]*)\)\s*(.*)$", s)
        if m_fn:
            params = [p.strip() for p in m_fn.group(2).split(",") if p.strip()]
            func_macros[m_fn.group(1)] = (params, m_fn.group(3).strip())
            continue
        m_obj = re.match(r"#\s*define\s+([A-Za-z_]\w*)(?:\s+(.*))?$", s)
        if m_obj:
            obj_macros[m_obj.group(1)] = (m_obj.group(2) or "").strip()

    text = _RE_PREPROC_LINE.sub("", joined)
    if not obj_macros and not func_macros:
        return text

    obj_pattern = (
        re.compile(r"\b(" + "|".join(re.escape(k) for k in sorted(obj_macros, key=len, reverse=True)) + r")\b")
        if obj_macros
        else None
    )
    fn_pattern = (
        re.compile(r"\b(" + "|".join(re.escape(k) for k in sorted(func_macros, key=len, reverse=True)) + r")\s*\(")
        if func_macros
        else None
    )

    for _ in range(16):
        prev = text
        if fn_pattern is not None:
            out: list[str] = []
            pos = 0
            while pos < len(text):
                m = fn_pattern.search(text, pos)
                if not m:
                    out.append(text[pos:])
                    break
                out.append(text[pos : m.start()])
                open_paren = m.end() - 1
                close_paren = _find_matching(text, open_paren, "(", ")")
                raw_args = _split_top_level_args(text[open_paren + 1 : close_paren])
                params, body = func_macros[m.group(1)]
                sub_body = body
                for pname, aval in zip(params, raw_args):
                    sub_body = re.sub(rf"\b{re.escape(pname)}\b", lambda _m, v=aval: v, sub_body)
                out.append(f"({sub_body})" if sub_body else "")
                pos = close_paren + 1
            text = "".join(out)
        if obj_pattern is not None:
            text = obj_pattern.sub(lambda m: obj_macros[m.group(1)], text)
        if text == prev:
            break
    return text


def _safe_eval_const(expr: str, env: dict[str, float]) -> float | None:
    """Safely evaluate constant GLSL arithmetic expressions into float."""
    s = re.sub(r"\b(\d+(?:\.\d+)?)[fFuU]\b", r"\1", expr.strip())
    s = re.sub(r"\b(?:int|uint|float)\s*\(([^)]+)\)", r"(\1)", s)
    try:
        tree = ast.parse(s, mode="eval")
    except SyntaxError:
        return None

    def _ev(node: ast.AST) -> float:
        if isinstance(node, ast.Expression):
            return _ev(node.body)
        if isinstance(node, ast.Constant) and isinstance(node.value, (int, float)):
            return float(node.value)
        if isinstance(node, ast.Name):
            if node.id in env:
                return float(env[node.id])
            raise ValueError(node.id)
        if isinstance(node, ast.UnaryOp):
            v = _ev(node.operand)
            if isinstance(node.op, ast.UAdd):
                return +v
            if isinstance(node.op, ast.USub):
                return -v
            if isinstance(node.op, ast.Invert):
                return float(~int(v))
            raise ValueError("unary")
        if isinstance(node, ast.BinOp):
            l = _ev(node.left)
            r = _ev(node.right)
            if isinstance(node.op, ast.Add):
                return l + r
            if isinstance(node.op, ast.Sub):
                return l - r
            if isinstance(node.op, ast.Mult):
                return l * r
            if isinstance(node.op, ast.Div):
                if r == 0:
                    raise ValueError("div0")
                return l / r
            if isinstance(node.op, ast.FloorDiv):
                return float(int(l) // int(r))
            if isinstance(node.op, ast.Mod):
                return float(int(l) % int(r))
            if isinstance(node.op, ast.LShift):
                return float(int(l) << int(r))
            if isinstance(node.op, ast.RShift):
                return float(int(l) >> int(r))
            if isinstance(node.op, ast.BitAnd):
                return float(int(l) & int(r))
            if isinstance(node.op, ast.BitOr):
                return float(int(l) | int(r))
            if isinstance(node.op, ast.BitXor):
                return float(int(l) ^ int(r))
            raise ValueError("binop")
        raise ValueError("node")

    try:
        return _ev(tree)
    except Exception:
        return None


def _extract_consts(code: str, base_env: dict[str, float] | None = None) -> dict[str, float]:
    env = dict(base_env or {})
    for m in _RE_CONST_DECL.finditer(code):
        v = _safe_eval_const(m.group(2), env)
        if v is not None:
            env[m.group(1)] = v
    return env


def _extract_var_types(code: str, base_types: dict[str, str] | None = None) -> dict[str, str]:
    types = dict(base_types or {})
    for m in _RE_VAR_DECL.finditer(code):
        vtype = m.group(1)
        decl_list = m.group(2)
        for item in _split_top_level_args(decl_list):
            name_m = re.match(r"([A-Za-z_]\w*)", item.strip())
            if name_m:
                types[name_m.group(1)] = vtype
    return types


def _normalize_param_types(params_str: str) -> tuple[tuple[str, ...], dict[str, str]]:
    pstr = params_str.strip()
    if not pstr or pstr == "void":
        return (), {}
    ptypes: list[str] = []
    pmap: dict[str, str] = {}
    qualifiers = {"in", "out", "inout", "const", "highp", "mediump", "lowp", "struct"}
    for raw in _split_top_level_args(pstr):
        clean = re.sub(r"\[[^\]]*\]", "", raw).strip()
        toks = [t for t in clean.split() if t not in qualifiers]
        if not toks:
            continue
        tname = toks[0]
        ptypes.append(tname)
        if len(toks) >= 2:
            pmap[toks[-1]] = tname
    return tuple(ptypes), pmap


def _parse_functions(expanded: str) -> tuple[dict[str, list[_FuncDef]], dict[str, dict[str, str]]]:
    """Parse top-level GLSL function definitions (supporting const/struct/array returns and overloads)."""
    funcs_by_name: dict[str, list[_FuncDef]] = {}
    func_param_maps: dict[str, dict[str, str]] = {}
    re_head = re.compile(
        r"(?:^|[;{}])\s*"
        r"(?:(?:const|highp|mediump|lowp)\s+)*"
        r"(?:struct\s+)?[A-Za-z_]\w*(?:\s*\[\s*[^\]]*\s*\])?\s+"
        r"([A-Za-z_]\w*)\s*\(",
        re.MULTILINE,
    )

    n = len(expanded)
    brace_depth = 0
    pos = 0
    while pos < n:
        ch = expanded[pos]
        if ch == "{":
            brace_depth += 1
            pos += 1
            continue
        if ch == "}":
            brace_depth = max(0, brace_depth - 1)
            pos += 1
            continue
        if brace_depth == 0:
            m = re_head.match(expanded, pos)
            if m:
                fname = m.group(1)
                if fname not in _CONTROL_KEYWORDS:
                    open_p = m.end() - 1
                    close_p = _find_matching(expanded, open_p, "(", ")")
                    k = close_p + 1
                    while k < n and expanded[k].isspace():
                        k += 1
                    if k < n and expanded[k] == "{":
                        close_b = _find_matching(expanded, k, "{", "}")
                        params_raw = expanded[open_p + 1 : close_p]
                        ptypes, pmap = _normalize_param_types(params_raw)
                        body = expanded[k + 1 : close_b]
                        fdef = _FuncDef(name=fname, param_types=ptypes, body=body)
                        funcs_by_name.setdefault(fname, []).append(fdef)
                        func_param_maps[f"{fname}#{len(funcs_by_name[fname])}"] = pmap
                        pos = close_b + 1
                        continue
        pos += 1
    return funcs_by_name, func_param_maps


def _infer_expr_type(expr: str, var_types: dict[str, str]) -> str | None:
    s = expr.strip()
    if not s:
        return None
    while s.startswith("(") and s.endswith(")") and _find_matching(s, 0, "(", ")") == len(s) - 1:
        s = s[1:-1].strip()
    m_ctor = re.match(r"^([biu]?vec[234]|dvec[234]|mat[234](?:x[234])?|float|int|uint|bool)\s*\(", s)
    if m_ctor and _find_matching(s, m_ctor.end() - 1, "(", ")") == len(s) - 1:
        return m_ctor.group(1)
    if re.fullmatch(r"[A-Za-z_]\w*", s):
        return var_types.get(s)
    m_swiz = re.search(r"\.([xyzwrgba]{1,4})$", s)
    if m_swiz:
        sw = len(m_swiz.group(1))
        return "float" if sw == 1 else f"vec{sw}"
    m_vec_any = re.search(r"\b(mat[234](?:x[234])?|[biu]?vec[234])\b", s)
    if m_vec_any:
        return m_vec_any.group(1)
    for tok in re.findall(r"\b([A-Za-z_]\w*)\b", s):
        if tok in var_types and var_types[tok] in _TYPE_WIDTHS:
            return var_types[tok]
    if re.fullmatch(r"[+-]?\d+", s):
        return "int"
    if re.fullmatch(r"[+-]?(?:\d+\.\d*|\.\d+)[fF]?", s):
        return "float"
    return None


def _expr_width(expr: str, var_types: dict[str, str]) -> int:
    t = _infer_expr_type(expr, var_types)
    if t and t in _TYPE_WIDTHS:
        return _TYPE_WIDTHS[t]
    return 1


def _operator_alu_cost(lhs: str, op: str, rhs: str, var_types: dict[str, str]) -> int:
    lt = _infer_expr_type(lhs, var_types)
    rt = _infer_expr_type(rhs, var_types)
    if op in ("*", "*="):
        if lt in _MAT_DIMS and rt in _MAT_DIMS:
            c1, r1 = _MAT_DIMS[lt]
            _c2, _r2 = _MAT_DIMS[rt]
            return c1 * r1
        if lt in _MAT_DIMS and rt in _TYPE_WIDTHS:
            return _TYPE_WIDTHS[rt]
        if rt in _MAT_DIMS and lt in _TYPE_WIDTHS:
            return _TYPE_WIDTHS[lt]
    lw = _TYPE_WIDTHS.get(lt or "", 1)
    rw = _TYPE_WIDTHS.get(rt or "", 1)
    return max(1, lw, rw)


def _parse_for_iterations(
    header: str,
    const_env: dict[str, float],
    uniform_env: dict[str, float],
    var_types: dict[str, str],
) -> int:
    """Resolve constant-bounded loop trip counts; cap dynamic/uniform loops conservatively."""
    parts = header.split(";")
    if len(parts) != 3:
        return DYNAMIC_LOOP_ITERS
    init_s, cond_s, step_s = [p.strip() for p in parts]

    m_init = re.search(r"\b([A-Za-z_]\w*)\s*=\s*(.+)$", init_s)
    if not m_init:
        return DYNAMIC_LOOP_ITERS
    var = m_init.group(1)
    start_val = _safe_eval_const(m_init.group(2), const_env)
    if start_val is None:
        return DYNAMIC_LOOP_ITERS

    m_cond = re.search(rf"\b{re.escape(var)}\s*(<=|>=|<|>)\s*(.+)$", cond_s)
    if m_cond:
        op = m_cond.group(1)
        bound_expr = m_cond.group(2).strip()
    else:
        m_rev = re.search(rf"^(.+?)\s*(<=|>=|<|>)\s*{re.escape(var)}\b", cond_s)
        if not m_rev:
            return DYNAMIC_LOOP_ITERS
        flip = {"<": ">", "<=": ">=", ">": "<", ">=": "<="}
        op = flip[m_rev.group(2)]
        bound_expr = m_rev.group(1).strip()

    end_val = _safe_eval_const(bound_expr, const_env)
    if end_val is None:
        # Dynamic/uniform bound: honor reported runtime uniform value if higher than baseline
        u_val = _safe_eval_const(bound_expr, {**const_env, **uniform_env})
        if u_val is not None:
            return max(DYNAMIC_LOOP_ITERS, min(10000, int(round(abs(u_val)))))
        return DYNAMIC_LOOP_ITERS

    step_val: float | None = None
    if re.search(rf"\+\+\s*{re.escape(var)}\b|\b{re.escape(var)}\s*\+\+", step_s):
        step_val = 1.0
    elif re.search(rf"--\s*{re.escape(var)}\b|\b{re.escape(var)}\s*--", step_s):
        step_val = -1.0
    elif m_inc := re.search(rf"\b{re.escape(var)}\s*\+=\s*(.+)$", step_s):
        step_val = _safe_eval_const(m_inc.group(1), const_env)
    elif m_dec := re.search(rf"\b{re.escape(var)}\s*-=\s*(.+)$", step_s):
        v = _safe_eval_const(m_dec.group(1), const_env)
        step_val = -v if v is not None else None
    elif m_asg := re.search(rf"\b{re.escape(var)}\s*=\s*{re.escape(var)}\s*([+-])\s*(.+)$", step_s):
        v = _safe_eval_const(m_asg.group(2), const_env)
        if v is not None:
            step_val = v if m_asg.group(1) == "+" else -v

    if step_val is None or step_val == 0.0:
        return DYNAMIC_LOOP_ITERS

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
    funcs_by_name: dict[str, list[_FuncDef]],
    call_stack: frozenset[str],
    var_types: dict[str, str],
    const_env: dict[str, float],
    uniform_env: dict[str, float],
) -> dict[str, int]:
    """Count weighted ops in a loop-free GLSL snippet, expanding user function calls/overloads."""
    counts = {"alu": 0, "transcendental": 0, "branch": 0, "texture": 0, "total": 0}
    if not snippet.strip():
        return counts

    local_types = _extract_var_types(snippet, var_types)
    local_consts = _extract_consts(snippet, const_env)
    scrubbed = _RE_NUMBER_EXP.sub("0", snippet)

    # 1. Function calls with balanced argument parsing & type/overload resolution
    pos = 0
    while pos < len(scrubbed):
        m = _RE_CALL.search(scrubbed, pos)
        if not m:
            break
        fname = m.group(1)
        if fname in _CONTROL_KEYWORDS or fname in _TYPE_WIDTHS:
            pos = m.end()
            continue

        open_p = m.end() - 1
        close_p = _find_matching(scrubbed, open_p, "(", ")")
        raw_args = _split_top_level_args(scrubbed[open_p + 1 : close_p])
        pos = open_p + 1

        if fname in TEXTURE_FUNCS:
            tex_units = 1
            if fname in HEAVY_TEXTURE_FUNCS:
                tex_units = 2
            elif raw_args:
                stype = _infer_expr_type(raw_args[0], local_types) or ""
                if any(tag in stype for tag in ("3D", "Cube", "Array")):
                    tex_units = 2
            counts["texture"] += tex_units
        elif fname in TRANSCENDENTAL_FUNCS:
            w = max([_expr_width(a, local_types) for a in raw_args] or [1])
            counts["transcendental"] += w
        elif fname in ALU_BUILTIN_FUNCS:
            if fname == "cross":
                w = 3
            elif raw_args:
                w = max([_expr_width(a, local_types) for a in raw_args] or [1])
            else:
                w = 1
            counts["alu"] += w
        elif fname in funcs_by_name and fname not in call_stack:
            candidates = [f for f in funcs_by_name[fname] if len(f.param_types) == len(raw_args)]
            if not candidates:
                candidates = funcs_by_name[fname]
            arg_types = tuple(_infer_expr_type(a, local_types) for a in raw_args)
            exact = [
                f for f in candidates
                if len(f.param_types) == len(arg_types)
                and all(at is None or pt == at for pt, at in zip(f.param_types, arg_types))
            ]
            pool = exact if len(exact) == 1 else (exact or candidates)
            best_sub: dict[str, int] | None = None
            for fdef in pool:
                sub = _count_block_ops(
                    fdef.body,
                    funcs_by_name,
                    call_stack | {fname},
                    local_types,
                    local_consts,
                    uniform_env,
                )
                if best_sub is None or sub["total"] > best_sub["total"]:
                    best_sub = sub
            if best_sub is not None:
                counts["alu"] += best_sub["alu"]
                counts["transcendental"] += best_sub["transcendental"]
                counts["branch"] += best_sub["branch"]
                counts["texture"] += best_sub["texture"]

    # 2. Branches (`if`, ternary `?`, `discard`, `break`, `continue`)
    counts["branch"] += len(_RE_BRANCH.findall(scrubbed))

    # 3. Arithmetic / logical / bitwise operators scaled by vector/matrix operand width
    for m_op in _RE_OPS.finditer(scrubbed):
        op = m_op.group(0)
        if op in ("++", "--"):
            counts["alu"] += 1
            continue
        lhs = scrubbed[max(0, m_op.start() - 32) : m_op.start()].split(";")[-1].split(",")[-1]
        rhs = scrubbed[m_op.end() : min(len(scrubbed), m_op.end() + 32)].split(";")[0].split(",")[0]
        counts["alu"] += _operator_alu_cost(lhs, op, rhs, local_types)

    counts["total"] = (
        W_ALU * counts["alu"]
        + W_TRANSCENDENTAL * counts["transcendental"]
        + W_BRANCH * counts["branch"]
        + W_TEXTURE * counts["texture"]
    )
    return counts


def _count_block_ops(
    code: str,
    funcs_by_name: dict[str, list[_FuncDef]],
    call_stack: frozenset[str],
    var_types: dict[str, str],
    const_env: dict[str, float],
    uniform_env: dict[str, float],
) -> dict[str, int]:
    """Count weighted ops in a GLSL block, expanding for/while loops recursively."""
    counts = {"alu": 0, "transcendental": 0, "branch": 0, "texture": 0, "total": 0}
    local_consts = _extract_consts(code, const_env)
    local_types = _extract_var_types(code, var_types)
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
        iters = (
            _parse_for_iterations(header, local_consts, uniform_env, local_types)
            if is_for
            else max(DYNAMIC_LOOP_ITERS, 0)
        )

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

        loop_types = _extract_var_types(header, local_types)
        body_counts = _count_block_ops(body, funcs_by_name, call_stack, loop_types, local_consts, uniform_env)
        counts["alu"] += iters * (body_counts["alu"] + (1 if is_for else 0))
        counts["transcendental"] += iters * body_counts["transcendental"]
        counts["branch"] += iters * (body_counts["branch"] + 1)
        counts["texture"] += iters * body_counts["texture"]

    flat = _count_flat_ops(
        "".join(non_loop_chunks),
        funcs_by_name,
        call_stack,
        local_types,
        local_consts,
        uniform_env,
    )
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


def count_shader_ops(source: str, *, uniforms: dict[str, Any] | None = None) -> dict[str, int]:
    """Parse a single GLSL vertex or fragment shader and return weighted operation counts."""
    if not source or not isinstance(source, str):
        return {"alu": 0, "transcendental": 0, "branch": 0, "texture": 0, "total": 0}

    cleaned = _strip_comments(source)
    expanded = _expand_preprocessor_macros(cleaned)
    const_env = _extract_consts(expanded)
    var_types = _extract_var_types(expanded)
    uniform_env: dict[str, float] = {}
    if isinstance(uniforms, dict):
        for k, v in uniforms.items():
            if isinstance(v, (int, float)) and not isinstance(v, bool):
                uniform_env[str(k)] = float(v)

    funcs_by_name, _param_maps = _parse_functions(expanded)
    if "main" in funcs_by_name:
        main_def = funcs_by_name["main"][0]
        return _count_block_ops(main_def.body, funcs_by_name, frozenset({"main"}), var_types, const_env, uniform_env)

    return _count_block_ops(expanded, funcs_by_name, frozenset(), var_types, const_env, uniform_env)


def count_program_ops(
    vertex_src: str,
    fragment_src: str,
    *,
    uniforms: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Count unified vertex + fragment shader ops for a linked WebGL program."""
    vs = count_shader_ops(vertex_src, uniforms=uniforms)
    fs = count_shader_ops(fragment_src, uniforms=uniforms)
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
    """Compute worst-of-4-channels `budget.gpu_work_profile` in [0, 1]."""
    th = {**DEFAULT_GPU_BUDGET_THRESHOLDS, **(thresholds or {})}

    programs = webgl_stats.get("programs") or []
    global_uniforms = webgl_stats.get("uniforms") if isinstance(webgl_stats.get("uniforms"), dict) else None
    shader_ops_total = 0
    if programs:
        for p in programs:
            dc = p.get("draw_calls", 1)
            if dc == 0:
                continue
            dc_val = max(1, int(dc)) if isinstance(dc, (int, float)) else 1
            cov_raw = p.get("pixel_coverage", p.get("coverage", 1.0))
            cov = max(0.01, float(cov_raw)) if isinstance(cov_raw, (int, float)) else 1.0
            vs_src = p.get("vertex") or p.get("vs") or p.get("vertexShader") or ""
            fs_src = p.get("fragment") or p.get("fs") or p.get("fragmentShader") or ""
            p_uniforms = p.get("uniforms") if isinstance(p.get("uniforms"), dict) else global_uniforms
            pops = count_program_ops(vs_src, fs_src, uniforms=p_uniforms)
            shader_ops_total += int(round(pops["vertex"]["total"] * dc_val + pops["fragment"]["total"] * dc_val * cov))
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
    """Compute `budget.render_work` for `restoration` v0.2 in [0, 1]."""
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
