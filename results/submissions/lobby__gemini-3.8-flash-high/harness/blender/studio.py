"""
Procedural Cycles CPU studio scene builder for MoL-Bench 3D rooms (`harness/blender/studio.py`).
Builds a deterministic 3-point lighting setup + procedural studio sky world (no external HDRI),
and provides camera helpers for orthographic silhouette passes, turntable beauty passes,
world-space normal passes, and metal material-index mask passes.
"""

from __future__ import annotations

import math
import bpy
from mathutils import Matrix, Vector


# Modest sample counts to keep full submission grading well under 10 minutes on 4 CPU threads:
# - Orthographic silhouettes / normal pass / material mask pass: 1 sample, 0 bounces
# - Turntable beauty renders (512x512 DPR1 and 1024x1024 DPR2): 16 samples, 3 max bounces
STUDIO_BEAUTY_SAMPLES = 16
STUDIO_TURNTABLE_RES_DPR1 = 512
STUDIO_TURNTABLE_RES_DPR2 = 1024
STUDIO_ORTHO_RES = 2048
STUDIO_ORTHO_SCALE_M = 0.512  # 2048 px * 0.25 mm/px = 512 mm = 0.512 m


def look_at_matrix(cam_pos: Vector, target: Vector, up_hint: Vector = Vector((0.0, 0.0, 1.0))) -> Matrix:
    """Return a 4x4 camera transformation matrix looking from cam_pos at target."""
    forward = (target - cam_pos).normalized()
    if abs(forward.dot(up_hint)) > 0.999:
        up_hint = Vector((0.0, 1.0, 0.0))
    right = forward.cross(up_hint).normalized()
    cam_up = right.cross(forward).normalized()
    rot = Matrix((
        (right.x, cam_up.x, -forward.x),
        (right.y, cam_up.y, -forward.y),
        (right.z, cam_up.z, -forward.z),
    )).to_4x4()
    rot.translation = cam_pos
    return rot


def position_camera(
    cam_obj: bpy.types.Object,
    target: Vector,
    az_deg: float,
    el_deg: float,
    dist: float,
) -> None:
    az = math.radians(az_deg)
    el = math.radians(el_deg)
    offset = Vector((
        math.cos(el) * math.sin(az),
        -math.cos(el) * math.cos(az),
        math.sin(el),
    )) * dist
    cam_pos = target + offset
    cam_obj.matrix_world = look_at_matrix(cam_pos, target)


def build_procedural_studio_world() -> bpy.types.World:
    """Create a procedural gradient studio environment world (no external HDRI needed).
    Provides bright softbox bands in the upper hemisphere so metallic brass shows natural specular highlights.
    """
    world = bpy.data.worlds.new("MoLStudioWorld")
    nt = world.node_tree
    nt.nodes.clear()

    out_node = nt.nodes.new("ShaderNodeOutputWorld")
    bg_node = nt.nodes.new("ShaderNodeBackground")
    bg_node.inputs["Strength"].default_value = 0.42

    tex_coord = nt.nodes.new("ShaderNodeTexCoord")
    sep_xyz = nt.nodes.new("ShaderNodeSeparateXYZ")
    nt.links.new(tex_coord.outputs["Generated"], sep_xyz.inputs["Vector"])

    # Map Z from [-1, 1] to [0, 1] via ColorRamp for studio softbox horizon + zenith
    map_range = nt.nodes.new("ShaderNodeMapRange")
    map_range.inputs["From Min"].default_value = -0.4
    map_range.inputs["From Max"].default_value = 0.8
    map_range.inputs["To Min"].default_value = 0.0
    map_range.inputs["To Max"].default_value = 1.0
    nt.links.new(sep_xyz.outputs["Z"], map_range.inputs["Value"])

    ramp = nt.nodes.new("ShaderNodeValToRGB")
    elems = ramp.color_ramp.elements
    elems[0].position = 0.0
    elems[0].color = (0.10, 0.10, 0.11, 1.0)
    elems[1].position = 0.55
    elems[1].color = (0.34, 0.33, 0.31, 1.0)
    e_hi = elems.new(0.85)
    e_hi.color = (0.95, 0.90, 0.80, 1.0)

    nt.links.new(map_range.outputs["Result"], ramp.inputs["Fac"])
    nt.links.new(ramp.outputs["Color"], bg_node.inputs["Color"])
    nt.links.new(bg_node.outputs["Background"], out_node.inputs["Surface"])
    return world


def create_studio_lights(target: Vector) -> list[bpy.types.Object]:
    """Create a 3-point area lighting rig around `target`."""
    specs = [
        # (name, az_deg, el_deg, dist_m, energy_w, size_m, color_rgb)
        ("Studio_Key", -38.0, 34.0, 1.15, 12.0, 0.55, (1.0, 0.96, 0.90)),
        ("Studio_Fill", 58.0, 18.0, 1.30, 5.5, 0.75, (0.90, 0.94, 1.0)),
        ("Studio_Rim", 155.0, 40.0, 1.20, 8.5, 0.50, (1.0, 0.97, 0.92)),
    ]
    lights: list[bpy.types.Object] = []
    for name, az, el, dist, energy, size, col in specs:
        ldata = bpy.data.lights.new(name=name, type="AREA")
        ldata.energy = energy
        ldata.shape = "SQUARE"
        ldata.size = size
        ldata.color = col
        lobj = bpy.data.objects.new(name=name, object_data=ldata)
        bpy.context.collection.objects.link(lobj)
        position_camera(lobj, target, az, el, dist)
        lights.append(lobj)
    return lights


def configure_cycles_base(samples: int = STUDIO_BEAUTY_SAMPLES, max_bounces: int = 3) -> None:
    """Configure deterministic Cycles CPU rendering (denoiser off, fixed seed)."""
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = samples
    scene.cycles.use_denoising = False
    scene.cycles.seed = 1
    scene.cycles.max_bounces = max_bounces
    scene.cycles.diffuse_bounces = 1
    scene.cycles.glossy_bounces = 2
    scene.cycles.transmission_bounces = 2
    scene.cycles.transparent_max_bounces = 2
    scene.cycles.sample_clamp_indirect = 5.0
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_depth = "8"
    scene.view_settings.view_transform = "Standard"
    scene.view_settings.look = "None"
