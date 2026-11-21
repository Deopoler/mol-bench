"""
Procedural Museum Lantern (`lantern`) for MoL-Bench room `atelier`.

Run:  blender -b --factory-startup --python build.py -- --blueprint blueprint/ --out out/

Everything is built from code (bmesh primitives); only `blueprint/*.json` is read.
Internal modelling units are millimetres; meshes are scaled to metres (x0.001) when written.

Hierarchy:  Lantern > {Frame > Door > Door_Glass, Roof, Base, Handle, Glass, Candle, Flame}
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path

import bmesh
import bpy
from mathutils import Matrix, Vector

MM = 0.001  # mm -> m


# --------------------------------------------------------------------------------------
# CLI / blueprint
# --------------------------------------------------------------------------------------
def parse_args() -> argparse.Namespace:
    argv = sys.argv
    argv = argv[argv.index("--") + 1:] if "--" in argv else []
    parser = argparse.ArgumentParser()
    parser.add_argument("--blueprint", default="blueprint")
    parser.add_argument("--out", default="out")
    return parser.parse_args(argv)


def load_json(path: Path, default: dict | None = None) -> dict:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return dict(default or {})


# --------------------------------------------------------------------------------------
# Colour helpers (OKLCH swatch -> linear sRGB for Principled "Base Color")
# --------------------------------------------------------------------------------------
def oklch_to_linear_srgb(L: float, C: float, h_deg: float) -> tuple[float, float, float]:
    a = C * math.cos(math.radians(h_deg))
    b = C * math.sin(math.radians(h_deg))
    l_ = L + 0.3963377774 * a + 0.2158037573 * b
    m_ = L - 0.1055613458 * a - 0.0638541728 * b
    s_ = L - 0.0894841775 * a - 1.2914855480 * b
    l, m, s = l_ ** 3, m_ ** 3, s_ ** 3
    r = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s
    g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s
    bl = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s
    return (r, g, bl)


def srgb_to_linear(c: float) -> float:
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def role_linear_color(role: dict) -> tuple[float, float, float, float]:
    """Linear base colour for a role: OKLCH swatch if it is inside the sRGB gamut, else the sRGB swatch."""
    lch = role.get("base_color_oklch")
    if lch:
        rgb = oklch_to_linear_srgb(*lch)
        if all(-1e-4 <= c <= 1.0001 for c in rgb):
            return (max(0.0, rgb[0]), max(0.0, rgb[1]), max(0.0, rgb[2]), 1.0)
    srgb = role.get("base_color_srgb", [0.5, 0.5, 0.5])
    return (srgb_to_linear(srgb[0]), srgb_to_linear(srgb[1]), srgb_to_linear(srgb[2]), 1.0)


# --------------------------------------------------------------------------------------
# bmesh primitive builders (all in millimetres)
# --------------------------------------------------------------------------------------
def add_box(bm, center, size, rot_deg=0.0):
    """Axis box (size = x,y,z) centred at `center`, rotated about Z by rot_deg."""
    res = bmesh.ops.create_cube(bm, size=1.0)
    rot = Matrix.Rotation(math.radians(rot_deg), 4, "Z")
    for v in res["verts"]:
        p = Vector((v.co.x * size[0], v.co.y * size[1], v.co.z * size[2]))
        v.co = rot @ p + Vector(center)
    return res["verts"]


def add_hex_frustum(bm, z0, z1, r0, r1, sides=6):
    """Closed hexagonal frustum, vertices at angles k*60deg (a vertex on +X)."""
    bot = [bm.verts.new((r0 * math.cos(2 * math.pi * k / sides), r0 * math.sin(2 * math.pi * k / sides), z0))
           for k in range(sides)]
    top = [bm.verts.new((r1 * math.cos(2 * math.pi * k / sides), r1 * math.sin(2 * math.pi * k / sides), z1))
           for k in range(sides)]
    bm.faces.new(list(reversed(bot)))
    bm.faces.new(top)
    for k in range(sides):
        k2 = (k + 1) % sides
        bm.faces.new((bot[k], bot[k2], top[k2], top[k]))
    return bot + top


def add_cylinder(bm, cx, cy, z0, z1, radius, segments=48):
    res = bmesh.ops.create_cone(bm, cap_ends=True, cap_tris=False, segments=segments,
                                radius1=radius, radius2=radius, depth=(z1 - z0))
    for v in res["verts"]:
        v.co += Vector((cx, cy, 0.5 * (z0 + z1)))
    return res["verts"]


def add_torus_xz(bm, center, major_r, minor_r, major_seg=72, minor_seg=20):
    """Torus lying in the XZ plane (ring axis = Y)."""
    cx, cy, cz = center
    ring = []
    for i in range(major_seg):
        u = 2 * math.pi * i / major_seg
        row = []
        for j in range(minor_seg):
            v = 2 * math.pi * j / minor_seg
            rr = major_r + minor_r * math.cos(v)
            row.append(bm.verts.new((cx + rr * math.cos(u), cy + minor_r * math.sin(v), cz + rr * math.sin(u))))
        ring.append(row)
    for i in range(major_seg):
        i2 = (i + 1) % major_seg
        for j in range(minor_seg):
            j2 = (j + 1) % minor_seg
            bm.faces.new((ring[i][j], ring[i2][j], ring[i2][j2], ring[i][j2]))


def add_flame(bm, cx, cy, z0, z1, radius, u_seg=24, v_seg=14):
    """Teardrop flame (lathe): round belly low, long taper to a tip."""
    height = z1 - z0
    bottom = bm.verts.new((cx, cy, z0))
    top = bm.verts.new((cx, cy, z1))
    rings = []
    for k in range(1, v_seg):
        t = k / v_seg  # 0..1 bottom -> top
        r = radius * max(0.0, math.sin(math.pi * t ** 0.72)) ** 0.9
        z = z0 + height * t
        rings.append([bm.verts.new((cx + r * math.cos(2 * math.pi * i / u_seg),
                                    cy + r * math.sin(2 * math.pi * i / u_seg), z)) for i in range(u_seg)])
    for i in range(u_seg):
        i2 = (i + 1) % u_seg
        bm.faces.new((bottom, rings[0][i2], rings[0][i]))
        bm.faces.new((top, rings[-1][i], rings[-1][i2]))
        for k in range(len(rings) - 1):
            bm.faces.new((rings[k][i], rings[k][i2], rings[k + 1][i2], rings[k + 1][i]))


def add_hex_tier(bm, z0, z1, r0, r1, chamfer=0.8, lip=1.6, top_chamfer=False, sides=6):
    """Closed hexagonal frustum built ring by ring, with real chamfer strips on its rims.

    A short vertical lip at the bottom turns the acute bottom rim into two gentle turns so the chamfer strips stay
    narrow, well-shaped bands. Rings are hexagons (vertex on +X) so every band is planar.
    (z0, r0) bottom rim corner radius, (z1, r1) top rim corner radius. Returns the chamfer-strip faces.
    """
    c30 = math.cos(math.pi / sides)
    a0, a1 = r0 * c30, r1 * c30                       # apothems
    corner_b = Vector((a0, z0))
    lip_top = Vector((a0, z0 + lip))
    corner_t = Vector((a1, z1))
    side_dir = (corner_t - lip_top).normalized()

    def arc(prev_dir, corner, next_dir, w, k):
        t0 = corner - prev_dir * w
        t1 = corner + next_dir * w
        pts = [t0]
        for j in range(1, k + 1):
            t = j / (k + 1)
            pts.append((1 - t) ** 2 * t0 + 2 * t * (1 - t) * corner + t * t * t1)
        pts.append(t1)
        return pts

    seg = 2
    bottom_pts = arc(Vector((1.0, 0.0)), corner_b, Vector((0.0, 1.0)), chamfer, seg)
    top_pts = arc(side_dir, corner_t, Vector((-1.0, 0.0)), chamfer, seg) if top_chamfer else [corner_t]
    profile = bottom_pts + [lip_top] + top_pts
    flags = [True] * (len(bottom_pts) - 1) + [False, False] + [True] * (len(top_pts) - 1)
    rings = []
    for p in profile:
        r = p.x / c30
        rings.append([bm.verts.new((r * math.cos(2 * math.pi * k / sides), r * math.sin(2 * math.pi * k / sides), p.y))
                      for k in range(sides)])
    strips = []
    bm.faces.new(list(reversed(rings[0])))
    bm.faces.new(rings[-1])
    for i in range(len(rings) - 1):
        for k in range(sides):
            k2 = (k + 1) % sides
            f = bm.faces.new((rings[i][k], rings[i][k2], rings[i + 1][k2], rings[i + 1][k]))
            if flags[i]:
                strips.append(f)
    return strips


def add_rect_frame(bm, x0, x1, z0, z1, hx0, hx1, hz0, hz1, y0, y1):
    """Rectangular picture-frame prism (outer rect minus inner rect) extruded along Y from y0 to y1."""
    def ring(y):
        return [
            bm.verts.new((x0, y, z0)), bm.verts.new((x1, y, z0)), bm.verts.new((x1, y, z1)), bm.verts.new((x0, y, z1)),
            bm.verts.new((hx0, y, hz0)), bm.verts.new((hx1, y, hz0)), bm.verts.new((hx1, y, hz1)), bm.verts.new((hx0, y, hz1)),
        ]
    a = ring(y0)
    b = ring(y1)
    for k in range(4):
        k2 = (k + 1) % 4
        bm.faces.new((a[k], a[k2], a[4 + k2], a[4 + k]))          # front annulus
        bm.faces.new((b[k], b[4 + k], b[4 + k2], b[k2]))          # back annulus
        bm.faces.new((a[k], b[k], b[k2], a[k2]))                  # outer wall
        bm.faces.new((a[4 + k], a[4 + k2], b[4 + k2], b[4 + k]))  # inner wall


# --------------------------------------------------------------------------------------
# Mesh finishing: bevel, normals, mesh creation
# --------------------------------------------------------------------------------------
def bevel_sharp_edges(bm, width, segments=2, min_angle_deg=30.0):
    """Bevel every edge turning more than min_angle_deg. Returns the new bevel faces (strips + corner patches)."""
    bm.edges.ensure_lookup_table()
    edges = []
    lim = math.radians(min_angle_deg)
    for e in bm.edges:
        if len(e.link_faces) == 2 and e.calc_face_angle(0.0) > lim:
            edges.append(e)
    res = bmesh.ops.bevel(bm, geom=edges, offset=width, offset_type="OFFSET", segments=segments,
                          profile=0.5, affect="EDGES", clamp_overlap=True, loop_slide=True)
    return list(res.get("faces", []))


def compute_loop_normals(bm, strips, smooth_deg=56.0):
    """Per-loop (custom split) normals.

    * Structural faces are smoothed with their neighbours only across gentle edges (<= smooth_deg).
    * Bevel/chamfer strip faces are "hardened": they take the normal of the nearest structural face, so a
      beveled edge renders as a crisp (but geometrically rounded) edge without intermediate normals.
    Returns a flat list of normals in mesh loop order (face order, then loop order).
    """
    lim = math.radians(smooth_deg)
    strip_ids = {f.index for f in strips if f.is_valid}
    faces = list(bm.faces)
    loop_normal = {}  # (face index, vert index) -> Vector

    for v in bm.verts:
        fl = [f for f in v.link_faces if f.index not in strip_ids]
        if not fl:
            continue
        parent = {f.index: f.index for f in fl}

        def find(x):
            while parent[x] != x:
                parent[x] = parent[parent[x]]
                x = parent[x]
            return x

        for e in v.link_edges:
            lf = [f for f in e.link_faces if f.index not in strip_ids]
            if len(lf) == 2 and lf[0].normal.angle(lf[1].normal, 0.0) <= lim:
                ra, rb = find(lf[0].index), find(lf[1].index)
                if ra != rb:
                    parent[max(ra, rb)] = min(ra, rb)
        acc = {}
        for f in fl:
            ang = 1.0
            for lp in f.loops:
                if lp.vert == v:
                    ang = lp.calc_angle()
                    break
            key = find(f.index)
            acc[key] = acc.get(key, Vector((0.0, 0.0, 0.0))) + f.normal * ang
        for f in fl:
            n = acc[find(f.index)]
            loop_normal[(f.index, v.index)] = n.normalized() if n.length > 1e-9 else f.normal.copy()

    # nearest structural face for every strip face (multi-source BFS, deterministic index order)
    dominant = {f.index: f for f in faces if f.index not in strip_ids}
    queue = [f for f in faces if f.index not in strip_ids]
    head = 0
    while head < len(queue):
        cur = queue[head]
        head += 1
        for e in cur.edges:
            for nb in e.link_faces:
                if nb.index in strip_ids and nb.index not in dominant:
                    dominant[nb.index] = dominant[cur.index]
                    queue.append(nb)

    out = []
    for f in faces:
        for lp in f.loops:
            if f.index in strip_ids:
                d = dominant.get(f.index, f)
                n = loop_normal.get((d.index, lp.vert.index), d.normal)
            else:
                n = loop_normal.get((f.index, lp.vert.index), f.normal)
            out.append(n.copy())
    return out


def finish_mesh(name, bm, material, bevel=None, strips=None, smooth_deg=56.0):
    """Recompute outward normals, optional bevel, custom normals, scale mm->m, build mesh object (not linked)."""
    strips = list(strips or [])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    if bevel:
        strips += bevel_sharp_edges(bm, **bevel)
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    bm.normal_update()
    bm.faces.index_update()
    bm.verts.index_update()
    normals = compute_loop_normals(bm, strips, smooth_deg)
    for v in bm.verts:
        v.co = v.co * MM
    mesh = bpy.data.meshes.new(name)
    bm.to_mesh(mesh)
    bm.free()
    for p in mesh.polygons:
        p.use_smooth = True
    mesh.normals_split_custom_set(normals)
    mesh.materials.append(material)
    mesh.update()
    return bpy.data.objects.new(name, mesh)


# --------------------------------------------------------------------------------------
# Materials
# --------------------------------------------------------------------------------------
def set_input(bsdf, names, value):
    for n in names:
        sock = bsdf.inputs.get(n)
        if sock is not None:
            sock.default_value = value
            return True
    return False


def make_material(name, color, metallic=0.0, roughness=0.5, transmission=None, ior=None,
                  emission=None, emission_strength=0.0):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = next(n for n in mat.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
    set_input(bsdf, ["Base Color"], color)
    set_input(bsdf, ["Metallic"], metallic)
    set_input(bsdf, ["Roughness"], roughness)
    if transmission is not None:
        set_input(bsdf, ["Transmission Weight", "Transmission"], transmission)
    if ior is not None:
        set_input(bsdf, ["IOR"], ior)
    if emission is not None:
        set_input(bsdf, ["Emission Color", "Emission"], emission)
        set_input(bsdf, ["Emission Strength"], emission_strength)
    mat.diffuse_color = color
    mat.metallic = metallic
    mat.roughness = roughness
    return mat


# --------------------------------------------------------------------------------------
# Main build
# --------------------------------------------------------------------------------------
def main() -> int:
    args = parse_args()
    bp_dir = Path(args.blueprint)
    out_dir = Path(args.out).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)

    dims = load_json(bp_dir / "dimensions.json")
    mats = load_json(bp_dir / "materials.json").get("roles", {})

    # ---- clean scene --------------------------------------------------------------
    for obj in list(bpy.data.objects):
        bpy.data.objects.remove(obj, do_unlink=True)
    for coll in (bpy.data.meshes, bpy.data.materials, bpy.data.actions, bpy.data.cameras, bpy.data.lights):
        for item in list(coll):
            coll.remove(item)

    scene = bpy.context.scene
    scene.unit_settings.system = "METRIC"
    scene.unit_settings.length_unit = "METERS"
    scene.unit_settings.scale_length = 1.0
    scene.frame_start = 1
    scene.frame_end = 30

    # ---- parameters (mm) -----------------------------------------------------------
    sides = int(dims.get("sides", 6))
    r_in = float(dims.get("r_in_mm", 80.0))              # body apothem
    r_out = float(dims.get("r_out_mm", 92.376))          # body circumradius (post centres)
    bar = float(dims.get("frame_bar_mm", 8.0))
    z_base_top = float(dims.get("base_top_z_mm", 40.0))
    z_body_top = float(dims.get("body_top_z_mm", 280.0))
    foot_h = float(dims.get("foot_height_mm", 12.0))
    plinth_top = z_base_top
    base_r_out = float(dims.get("base_r_out_mm", 101.6136))
    roof_r_out = float(dims.get("roof_r_out_mm", 103.923))
    roof_top = float(dims.get("roof_top_z_mm", 350.0))
    pane_t = float(dims.get("glass_pane_thickness_mm", 2.0))
    hinge_xy = dims.get("door_hinge_line_xy_mm", [-38.0, -80.0])
    pivot = Vector((float(hinge_xy[0]), float(hinge_xy[1]), 0.5 * (z_base_top + z_body_top)))
    ring_c = dims.get("handle_ring_center_mm", [0.0, 0.0, 382.0])
    ring_inner_d = float(dims.get("handle_ring_inner_d_mm", 56.0))
    ring_wire_d = float(dims.get("handle_ring_wire_d_mm", 8.0))

    bevel_metal = dict(width=0.55, segments=2, min_angle_deg=30.0)

    # ---- materials -------------------------------------------------------------------
    brass_role = mats.get("brass", {})
    glass_role = mats.get("glass", {})
    wax_role = mats.get("wax", {})
    flame_role = mats.get("flame", {})
    m_brass = make_material("brass_aged", role_linear_color(brass_role) if brass_role else (0.54, 0.34, 0.09, 1),
                            metallic=brass_role.get("metallic_target", 0.95),
                            roughness=brass_role.get("roughness_target", 0.34))
    m_glass = make_material("glass_clear", role_linear_color(glass_role) if glass_role else (0.75, 0.82, 0.83, 1),
                            metallic=0.0, roughness=glass_role.get("roughness_target", 0.05),
                            transmission=glass_role.get("transmission_target", 0.95),
                            ior=glass_role.get("ior_target", 1.5))
    m_wax = make_material("wax_candle", role_linear_color(wax_role) if wax_role else (0.75, 0.66, 0.49, 1),
                          metallic=0.0, roughness=wax_role.get("roughness_target", 0.5))
    flame_col = role_linear_color(flame_role) if flame_role else (0.98, 0.49, 0.05, 1)
    m_flame = make_material("flame_ember", flame_col, metallic=0.0,
                            roughness=flame_role.get("roughness_target", 0.4),
                            emission=flame_col, emission_strength=flame_role.get("emission_strength_target", 8.0))

    objects: dict[str, bpy.types.Object] = {}

    # ---- Roof (3 stepped hexagonal tiers with chamfered rims, closed) --------------------------------
    bm = bmesh.new()
    scale = roof_r_out / 103.923
    t1_z0, t1_z1 = z_body_top, z_body_top + float(dims.get("roof_tier1_height_mm", 28.0))
    t2_z1 = t1_z1 + float(dims.get("roof_tier2_height_mm", 26.0))
    t3_z1 = roof_top
    roof_strips = []
    roof_strips += add_hex_tier(bm, t1_z0, t1_z1, roof_r_out, 74.7 * scale, top_chamfer=False, sides=sides)
    roof_strips += add_hex_tier(bm, t1_z1, t2_z1, 79.0 * scale, 37.6 * scale, top_chamfer=True, sides=sides)
    roof_strips += add_hex_tier(bm, t2_z1, t3_z1, 38.9 * scale, 22.3 * scale, top_chamfer=False, sides=sides)
    objects["Roof"] = finish_mesh("Roof", bm, m_brass, strips=roof_strips)

    # ---- Base (footed plinth: 2 tapered tiers + 6 feet) --------------------------------
    bm = bmesh.new()
    mid = z_base_top - 12.0  # 28
    add_hex_frustum(bm, foot_h, mid, base_r_out, 99.5 * base_r_out / 101.6136, sides)
    add_hex_frustum(bm, mid, plinth_top, 97.4 * base_r_out / 101.6136, 95.15 * base_r_out / 101.6136, sides)
    foot_r = 95.65 * base_r_out / 101.6136
    for k in range(sides):
        a = 2 * math.pi * k / sides
        add_box(bm, (foot_r * math.cos(a), foot_r * math.sin(a), 0.5 * (foot_h + 1.0)), (11.6, 11.6, foot_h + 1.0))
    objects["Base"] = finish_mesh("Base", bm, m_brass, bevel=dict(width=0.55, segments=2, min_angle_deg=30.0))

    # ---- Frame (6 corner posts + top/bottom rails on the 5 non-door faces) ------------------
    bm = bmesh.new()
    body_h = z_body_top - z_base_top
    for k in range(sides):
        a = 2 * math.pi * k / sides
        add_box(bm, (r_out * math.cos(a), r_out * math.sin(a), z_base_top + 0.5 * body_h), (bar, bar, body_h))
    open_w = 80.0
    face_angles = [(-90.0 + 60.0 * i) for i in range(sides)]  # face 0 = door (-Y)
    for fa in face_angles[1:]:
        a = math.radians(fa)
        cx, cy = r_in * math.cos(a), r_in * math.sin(a)
        for z0 in (z_base_top, z_body_top - bar):
            add_box(bm, (cx, cy, z0 + 0.5 * bar), (open_w, bar, bar), rot_deg=fa + 90.0)
    objects["Frame"] = finish_mesh("Frame", bm, m_brass, bevel=bevel_metal)

    # ---- Glass (5 physical panes) ------------------------------------------------------------
    bm = bmesh.new()
    gz0, gz1 = z_base_top + bar + 1.0, z_body_top - bar - 1.0
    for fa in face_angles[1:]:
        a = math.radians(fa)
        add_box(bm, (r_in * math.cos(a), r_in * math.sin(a), 0.5 * (gz0 + gz1)), (open_w, pane_t, gz1 - gz0),
                rot_deg=fa + 90.0)
    objects["Glass"] = finish_mesh("Glass", bm, m_glass)

    # ---- Door (rail+stile frame, origin at the hinge) and Door_Glass --------------------------------
    door_w = open_w
    door_d = 6.0
    dz0, dz1 = z_base_top + 0.3, z_body_top - 0.3
    bm = bmesh.new()
    px, py, pz = pivot
    add_rect_frame(bm, -door_w / 2 - px, door_w / 2 - px, dz0 - pz, dz1 - pz,
                   -door_w / 2 + bar - px, door_w / 2 - bar - px, z_base_top + bar - pz, z_body_top - bar - pz,
                   -r_in - door_d / 2 - py, -r_in + door_d / 2 - py)
    objects["Door"] = finish_mesh("Door", bm, m_brass, bevel=dict(width=0.5, segments=2, min_angle_deg=30.0))

    bm = bmesh.new()
    add_box(bm, (0.0 - px, -r_in - py, 0.5 * (gz0 + gz1) - pz),
            (door_w - 2 * bar - 0.4, pane_t, gz1 - gz0))
    objects["Door_Glass"] = finish_mesh("Door_Glass", bm, m_glass)

    # ---- Handle (ring in the XZ plane) ---------------------------------------------------------------
    bm = bmesh.new()
    major_r = 0.5 * ring_inner_d + 0.5 * ring_wire_d
    add_torus_xz(bm, ring_c, major_r, 0.5 * ring_wire_d)
    objects["Handle"] = finish_mesh("Handle", bm, m_brass)

    # ---- Candle & Flame -------------------------------------------------------------------------------
    cd = float(dims.get("candle_diameter_mm", 36.0))
    ch = float(dims.get("candle_height_mm", 95.0))
    cz = float(dims.get("candle_base_z_mm", 40.0))
    bm = bmesh.new()
    add_cylinder(bm, 0.0, 0.0, cz, cz + ch, 0.5 * cd, segments=48)
    objects["Candle"] = finish_mesh("Candle", bm, m_wax)

    fz = float(dims.get("flame_base_z_mm", 136.0))
    fh = float(dims.get("flame_height_mm", 16.0))
    fr = float(dims.get("flame_radius_mm", 4.5))
    bm = bmesh.new()
    add_flame(bm, 0.0, 0.0, fz, fz + fh, fr)
    objects["Flame"] = finish_mesh("Flame", bm, m_flame)
    objects["Flame"].visible_shadow = False
    objects["Glass"].visible_shadow = False
    objects["Door_Glass"].visible_shadow = False

    # ---- Hierarchy -------------------------------------------------------------------------------------
    root = bpy.data.objects.new("Lantern", None)
    root.empty_display_type = "PLAIN_AXES"
    root.empty_display_size = 0.05
    scene.collection.objects.link(root)
    for obj in objects.values():
        scene.collection.objects.link(obj)

    objects["Frame"].parent = root
    for name in ("Roof", "Base", "Handle", "Glass", "Candle", "Flame"):
        objects[name].parent = root
    objects["Door"].parent = objects["Frame"]
    objects["Door"].location = pivot * MM  # mesh vertices are stored relative to the hinge pivot
    objects["Door_Glass"].parent = objects["Door"]

    # ---- Hinge animation: action `door_open` on Door (frame 1 closed -> frame 30 open 90 deg outward) ----
    door = objects["Door"]
    door.rotation_mode = "XYZ"
    door.rotation_euler = (0.0, 0.0, 0.0)
    door.keyframe_insert(data_path="rotation_euler", frame=1, index=2)
    door.rotation_euler = (0.0, 0.0, math.radians(-90.0))
    door.keyframe_insert(data_path="rotation_euler", frame=30, index=2)
    action = door.animation_data.action
    action.name = "door_open"
    for fc in action.fcurves if hasattr(action, "fcurves") else []:
        for kp in fc.keyframe_points:
            kp.interpolation = "LINEAR"
    door.rotation_euler = (0.0, 0.0, 0.0)
    scene.frame_set(1)

    bpy.context.view_layer.update()

    # ---- Save + export -------------------------------------------------------------------------------------
    bpy.context.preferences.filepaths.save_version = 0  # no lantern.blend1 backup file
    bpy.ops.wm.save_as_mainfile(filepath=str(out_dir / "lantern.blend"), compress=False)
    bpy.ops.export_scene.gltf(
        filepath=str(out_dir / "lantern.glb"),
        export_format="GLB",
        export_yup=True,
        export_apply=False,
        export_animations=True,
        export_cameras=False,
        export_lights=False,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
