"""
YOVNOK's crew: original realistic people, generated with MPFB (MakeHuman for
Blender) from its CC0 assets, wearing gear modelled here.

    blender -b --python scripts/blender/people.py -- <out dir> [id ...]

Writes <out dir>/<id>.glb for each character: one skinned figure on MPFB's
Mixamo-named skeleton (the game poses it itself; no animation). Needs Blender
4.2+ with the MPFB extension enabled and the makehuman_system_assets (CC0)
pack loaded (see scripts/blender/README.md).

MPFB's code is GPL-3.0; its assets are CC0, and the MakeHuman team claims
nothing over what it produces, so the people (and the gear, made here) are
YOVNOK's own.

The gear is plain modelled geometry bound rigidly to one bone each (a helmet
to the head, a plate carrier to the chest), so it moves with the body. Two
materials are named for the game: "Team" (painted the car's colour) and
"Gear" (dark, fixed).
"""

import importlib
import math
import os
import sys

import bpy
from mathutils import Matrix, Vector


def mpfb(module, name):
    """MPFB is an extension: its modules are imported by their loaded name."""
    for loaded in list(sys.modules):
        if loaded.endswith(module):
            return getattr(importlib.import_module(loaded), name)
    raise ImportError(f"MPFB module {module} is not loaded; enable the extension")


HumanService = mpfb("mpfb.services.humanservice", "HumanService")
AssetService = mpfb("mpfb.services.assetservice", "AssetService")
TargetService = mpfb("mpfb.services.targetservice", "TargetService")
ExportService = mpfb("mpfb.services.exportservice", "ExportService")
ObjectService = mpfb("mpfb.services.objectservice", "ObjectService")
HumanObjectProperties = mpfb("mpfb.entities.objectproperties", "HumanObjectProperties")

# Who they are. Macro values are MakeHuman's 0..1 sliders (age 0.5 is 25 years).
CHARACTERS = {
    # Tactical: combat shirt and trousers, plate carrier, helmet, goggles,
    # gloves and kneepads.
    "raider": {
        "macro": {"gender": 1.0, "age": 0.55, "muscle": 0.75, "weight": 0.55, "height": 0.6,
                  "african": 0.15, "asian": 0.1, "caucasian": 0.75},
        "skin": "young_caucasian_male2",
        "hair": "short04",
        "eyebrows": "eyebrow002",
        "clothes": [],
        "gear": ["combat_shirt", "combat_trousers", "boots", "plate_carrier", "helmet", "goggles", "gloves", "kneepads"],
    },
    # Plain: a t-shirt (the team colour) and plain dark trousers.
    "drifter": {
        "macro": {"gender": 0.0, "age": 0.45, "muscle": 0.6, "weight": 0.45, "height": 0.55,
                  "african": 0.1, "asian": 0.65, "caucasian": 0.25},
        "skin": "young_asian_female",
        "hair": "short03",
        "eyebrows": "eyebrow010",
        "clothes": ["shoes02"],
        "gear": ["tshirt", "trousers"],
    },
    # Shirtless, in boxer shorts (the team colour), barefoot.
    "bruiser": {
        "macro": {"gender": 1.0, "age": 0.6, "muscle": 0.92, "weight": 0.62, "height": 0.62,
                  "african": 0.85, "asian": 0.05, "caucasian": 0.1},
        "skin": "young_african_male",
        "hair": "short02",
        "eyebrows": "eyebrow004",
        "clothes": [],
        "gear": ["boxers"],
    },
}


def material(name, colour, roughness, metallic=0.0):
    mat = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = (*colour, 1.0)
    bsdf.inputs["Roughness"].default_value = roughness
    bsdf.inputs["Metallic"].default_value = metallic
    return mat


def team():
    # Light, so the game's paint colour multiplies to the true colour.
    return material("Team", (0.85, 0.85, 0.85), 0.7)


def gear():
    return material("Gear", (0.05, 0.055, 0.06), 0.65)


def lens():
    return material("Lens", (0.02, 0.025, 0.03), 0.08, 0.4)


def bone_world(rig, name):
    """A bone's head and tail in world space (rest pose)."""
    bone = rig.data.bones[f"mixamorig:{name}"]
    return rig.matrix_world @ bone.head_local, rig.matrix_world @ bone.tail_local


def finish(obj, rig, bone, mat, bevel=0.0):
    """Material, an optional bevel, and a rigid bind to `bone`."""
    obj.data.materials.clear()
    obj.data.materials.append(mat)
    if bevel:
        mod = obj.modifiers.new("Bevel", "BEVEL")
        mod.width = bevel
        mod.segments = 2
        bpy.context.view_layer.objects.active = obj
        bpy.ops.object.modifier_apply(modifier=mod.name)
    for poly in obj.data.polygons:
        poly.use_smooth = True
    group = obj.vertex_groups.new(name=f"mixamorig:{bone}")
    group.add(range(len(obj.data.vertices)), 1.0, "REPLACE")
    world = obj.matrix_world.copy()
    obj.parent = rig
    obj.matrix_world = world
    obj.modifiers.new("Armature", "ARMATURE").object = rig
    return obj


def body_points(body, bones):
    """World positions of the body's vertices that `bones` mostly drive, with
    MPFB's shape (age, build…) applied but none of its helper modifiers."""
    shown = [(m, m.show_viewport) for m in body.modifiers]
    for m, _ in shown:
        m.show_viewport = False
    depsgraph = bpy.context.evaluated_depsgraph_get()
    evaluated = body.evaluated_get(depsgraph)
    mesh = evaluated.to_mesh()
    wanted = {body.vertex_groups[f"mixamorig:{b}"].index for b in bones if f"mixamorig:{b}" in body.vertex_groups}
    # Only the skeleton's groups count (MPFB also keeps helper and region groups).
    skeleton = {g.index for g in body.vertex_groups if g.name.startswith("mixamorig:")}
    points = []
    for v in mesh.vertices:
        best = max((g for g in v.groups if g.group in skeleton), key=lambda g: g.weight, default=None)
        if best is not None and best.group in wanted and best.weight > 0.5:
            points.append(body.matrix_world @ v.co)
    evaluated.to_mesh_clear()
    for m, was in shown:
        m.show_viewport = was
    return points


def box(name, size, location, rotation=(0, 0, 0)):
    bpy.ops.mesh.primitive_cube_add(size=1, location=location, rotation=rotation)
    obj = bpy.context.active_object
    obj.name = name
    obj.scale = size
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
    return obj


def shell(name, body, bones, mat, bind, offset, thickness, keep=None, smooth=12, exclude=(), hide_body=False):
    """Gear cut from the body's own surface: the faces mostly driven by `bones`
    (and passing `keep(centre)`), lifted `offset` off the skin along its
    normals and given `thickness`. It hugs the body like real kit does, which
    a modelled box never will. Bound rigidly to `bind`."""
    import bmesh
    shown = [(m, m.show_viewport) for m in body.modifiers]
    for m, _ in shown:
        m.show_viewport = False
    depsgraph = bpy.context.evaluated_depsgraph_get()
    evaluated = body.evaluated_get(depsgraph)
    mesh = evaluated.to_mesh()
    wanted = {body.vertex_groups[f"mixamorig:{b}"].index for b in bones if f"mixamorig:{b}" in body.vertex_groups}
    skeleton = {g.index for g in body.vertex_groups if g.name.startswith("mixamorig:")}
    owned = set()
    for v in mesh.vertices:
        best = max((g for g in v.groups if g.group in skeleton), key=lambda g: g.weight, default=None)
        if best is not None and best.group in wanted:
            owned.add(v.index)
    # Body regions MPFB marks (e.g. "body"), so eyes/teeth/helpers are left out.
    body_group = body.vertex_groups.get("body")
    if body_group is not None:
        skin = {v.index for v in mesh.vertices if any(g.group == body_group.index and g.weight > 0.5 for g in v.groups)}
        owned &= skin
    bm = bmesh.new()
    bm.from_mesh(mesh)  # keeps the vertex-group weights (the deform layer)
    groups = [g.name for g in body.vertex_groups]
    evaluated.to_mesh_clear()
    for m, was in shown:
        m.show_viewport = was
    bm.verts.ensure_lookup_table()
    world = body.matrix_world
    drop = []
    for f in bm.faces:
        inside = sum(v.index in owned for v in f.verts) >= len(f.verts) - 1
        centre = world @ f.calc_center_median()
        if not inside or (keep is not None and not keep(centre)):
            drop.append(f)
    dropped = set(drop)
    covered = {f.index for f in bm.faces if f not in dropped}
    bmesh.ops.delete(bm, geom=drop, context="FACES")
    loose = [v for v in bm.verts if not v.link_faces]
    bmesh.ops.delete(bm, geom=loose, context="VERTS")
    bm.normal_update()
    for v in bm.verts:
        v.co += v.normal * offset
    out = bpy.data.meshes.new(name)
    bm.to_mesh(out)
    bm.free()
    obj = bpy.data.objects.new(name, out)
    bpy.context.collection.objects.link(obj)
    obj.matrix_world = world.copy()
    # The skeleton's groups, by the body's index order, so the copied weights
    # (deform layer) mean the same bones here.
    for g in groups:
        obj.vertex_groups.new(name=g)
    # Smoothed into one clean surface: lifted off the skin it shows every
    # crease of the body as a rib.
    if smooth:
        mod = obj.modifiers.new("Smooth", "SMOOTH")
        mod.factor = 0.9
        mod.iterations = smooth
        bpy.context.view_layer.objects.active = obj
        bpy.ops.object.modifier_apply(modifier=mod.name)
    if thickness:
        mod = obj.modifiers.new("Solidify", "SOLIDIFY")
        mod.thickness = thickness
        mod.offset = 1.0
        bpy.context.view_layer.objects.active = obj
        bpy.ops.object.modifier_apply(modifier=mod.name)
    # Smooth the cut edge a touch.
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    bpy.ops.object.shade_smooth()
    if bind is None:
        # Skinned like the body under it: bends with it.
        for g in list(obj.vertex_groups):
            if not g.name.startswith("mixamorig:"):
                obj.vertex_groups.remove(g)
        obj.data.materials.clear()
        obj.data.materials.append(mat)
        for poly in obj.data.polygons:
            poly.use_smooth = True
        parent = RIG["rig"]
        w = obj.matrix_world.copy()
        obj.parent = parent
        obj.matrix_world = w
        obj.modifiers.new("Armature", "ARMATURE").object = parent
        if hide_body:
            RIG.setdefault("hide", set()).update(covered)
        return obj
    for g in list(obj.vertex_groups):
        obj.vertex_groups.remove(g)
    return bind_to(obj, bind, mat)


RIG = {}


def bind_to(obj, bone, mat):
    return finish(obj, RIG["rig"], bone, mat)


def cloth():
    return material("Cloth", (0.6, 0.6, 0.6), 0.95)


def make_gear(kind, rig, body):
    """Model one piece of gear, fitted to the body it goes on (measured from
    the skin: the head's crown and width, the chest's front, back and sides)."""
    RIG["rig"] = rig
    RIG.setdefault("headgear", 0.02)
    head, head_tail = bone_world(rig, "Head")
    chest, chest_tail = bone_world(rig, "Spine2")
    belly, _ = bone_world(rig, "Spine1")
    neck, _ = bone_world(rig, "Neck")
    fwd = Vector((0, -1, 0))  # the figure faces -Y in Blender
    skull = body_points(body, ["Head"])
    top = max(p.z for p in skull)
    brow = [p for p in skull if p.z > top - 0.09]
    cx = sum(p.x for p in brow) / len(brow)
    cy = sum(p.y for p in brow) / len(brow)
    skull_r = max(max(abs(p.x - cx) for p in brow), max(abs(p.y - cy) for p in brow))
    crown = Vector((cx, cy, top - skull_r * 0.98))
    torso = [p for p in body_points(body, ["Spine1", "Spine2"]) if belly.z - 0.02 < p.z < chest_tail.z]
    front_y = min(p.y for p in torso)
    half_w = max(abs(p.x - chest.x) for p in torso)
    parts = []

    if kind in ("plate_carrier", "chest_rig"):
        heavy = kind == "plate_carrier"
        low = belly.z - (0.07 if heavy else 0.0)
        high = chest_tail.z - (0.04 if heavy else 0.07)
        # Front and back (or only the front for a chest rig), clear of the armpits.
        keep = lambda c: low < c.z < high and abs(c.x - chest.x) < half_w * (0.86 if heavy else 0.7) and (heavy or c.y < chest.y)
        parts.append(shell("Carrier", body, ["Spine", "Spine1", "Spine2"], team(), None, 0.028, 0.03 if heavy else 0.018, keep))
        # Shoulder straps over the top.
        straps = lambda c: c.z > high - 0.02 and abs(abs(c.x - chest.x) - half_w * 0.42) < 0.045
        parts.append(shell("Straps", body, ["Spine2", "LeftShoulder", "RightShoulder"], gear(), None, 0.03, 0.012, straps))
        # Pouches across the front.
        count = 3 if heavy else 2
        w = half_w * 2 * (0.82 if heavy else 0.7)
        for k in range(count):
            x = (k - (count - 1) / 2) * w * 0.32
            z = low + (high - low) * 0.3
            pouch = box("Pouch", (w * 0.26, 0.055, (high - low) * 0.34), Vector((chest.x + x, front_y - 0.028 - 0.03 - 0.027, z)))
            parts.append(finish(pouch, rig, "Spine2", gear(), 0.01))
    elif kind in ("tshirt", "combat_shirt", "trousers", "combat_trousers", "boxers"):
        # Clothes cut from the body itself: they fit it exactly and bend with
        # it; the skin under them is removed so it never shows through.
        hips, _ = bone_world(rig, "Hips")
        ankle, _ = bone_world(rig, "LeftFoot")
        arms = {side: bone_world(rig, f"{side}Arm") for side in ("Left", "Right")}

        def along_arm(c, side):
            a, t = arms[side]
            return (c - a).dot((t - a).normalized()) / (t - a).length

        if kind in ("tshirt", "combat_shirt"):
            sleeve = 0.5 if kind == "tshirt" else 9.0  # short sleeve, or to the wrist
            bones = ["Hips", "Spine", "Spine1", "Spine2", "LeftShoulder", "RightShoulder", "LeftArm", "RightArm"]
            if kind == "combat_shirt":
                bones += ["LeftForeArm", "RightForeArm"]

            def keep(c):
                side = "Left" if c.x > hips.x else "Right"
                t = along_arm(c, side)
                # On the arm (outside the torso's width, past the shoulder):
                # down to the sleeve's end. The belly also lies "along" an arm
                # held down at 45 degrees, so width decides, not direction.
                if t > 0.05 and abs(c.x - hips.x) > abs(arms[side][0].x - hips.x) * 0.9:
                    return t < sleeve
                return hips.z - 0.045 < c.z < neck.z - 0.012

            colour = team() if kind == "tshirt" else material("Fatigues", (0.2, 0.22, 0.17), 0.9)
            # Worn loose over the trousers' waistband: lifted further off the
            # skin, and smoothed so it drapes rather than clinging.
            loose = 0.016 if kind == "tshirt" else 0.026
            parts.append(shell("Shirt", body, bones, colour, None, loose, 0.004, keep, smooth=6 if kind == "tshirt" else 10, hide_body=True))
        else:
            bones = ["Hips", "Spine", "LeftUpLeg", "RightUpLeg", "LeftLeg", "RightLeg"]
            if kind == "boxers":
                keep = lambda c: hips.z - 0.17 < c.z < hips.z + 0.06
                colour = team()
            else:
                keep = lambda c: ankle.z + 0.035 < c.z < hips.z + 0.1
                colour = material("Trousers", (0.11, 0.115, 0.12), 0.9) if kind == "trousers" else material("FatiguesDark", (0.16, 0.17, 0.13), 0.9)
            loose = 0.006 if kind == "boxers" else 0.012 if kind == "trousers" else 0.022
            parts.append(shell("Legs", body, bones, colour, None, loose, 0.004, keep, smooth=5 if kind != "combat_trousers" else 9, hide_body=True))
            if kind == "combat_trousers":
                # A belt, and cargo pockets on the thighs.
                belt = lambda c: hips.z + 0.055 < c.z < hips.z + 0.1
                parts.append(shell("Belt", body, ["Hips", "Spine"], gear(), None, 0.03, 0.012, belt, smooth=6))
                for side, sgn in (("Left", 1), ("Right", -1)):
                    thigh, thigh_tail = bone_world(rig, f"{side}UpLeg")
                    mid = thigh + (thigh_tail - thigh) * 0.5
                    pocket = box("Cargo", (0.035, 0.13, 0.16), mid + Vector((sgn * 0.095, 0.0, 0.0)))
                    parts.append(finish(pocket, rig, f"{side}UpLeg", material("FatiguesDark", (0.16, 0.17, 0.13), 0.9), 0.012))
    elif kind == "racing_suit":
        # A close-fitting one-piece suit cut from the body: everything but the
        # head, hands and feet. Charcoal, with team-colour panels down the
        # sides (the material split is by position).
        bones = ["Hips", "Spine", "Spine1", "Spine2", "Neck"] + [f"{s}{b}" for s in ("Left", "Right") for b in ("Shoulder", "Arm", "ForeArm", "UpLeg", "Leg")]
        keep = lambda c: c.z < neck.z + 0.02
        suit = shell("Suit", body, bones, material("Suit", (0.09, 0.1, 0.11), 0.85), "Spine1", 0.012, 0.006, keep, smooth=2)
        parts.append(suit)
    elif kind == "boots":
        # Laced combat boots: the foot and the ankle, cut from the body.
        for side in ("Left", "Right"):
            foot, _ = bone_world(rig, f"{side}Foot")
            keep = lambda c, f=foot: c.z < f.z + 0.11
            parts.append(shell(f"Boot{side}", body, [f"{side}Foot", f"{side}ToeBase", f"{side}Leg"], material("Leather", (0.06, 0.055, 0.05), 0.6), None, 0.012, 0.01, keep, smooth=6, hide_body=True))
    elif kind == "gloves":
        for side in ("Left", "Right"):
            fingers = [f"{side}Hand{d}{i}" for d in ("Thumb", "Index", "Middle", "Ring", "Pinky") for i in (1, 2, 3)]
            parts.append(shell(f"Glove{side}", body, [f"{side}Hand", *fingers], gear(), None, 0.004, 0.004))
    elif kind == "kneepads":
        for side in ("Left", "Right"):
            knee, _ = bone_world(rig, f"{side}Leg")
            keep = lambda c, k=knee: abs(c.z - k.z) < 0.055 and c.y < k.y - 0.015
            parts.append(shell(f"Knee{side}", body, [f"{side}UpLeg", f"{side}Leg"], gear(), None, 0.018, 0.016, keep, smooth=6))
    elif kind == "scarf":
        keep = lambda c: neck.z - 0.03 < c.z < neck.z + 0.075
        # In the team colour: the wasteland crew's colours are their cloth.
        parts.append(shell("Scarf", body, ["Neck", "Spine2"], team(), None, 0.022, 0.02, keep, smooth=16))
    elif kind == "shoulder_plate":
        arm, arm_tail = bone_world(rig, "LeftArm")
        keep = lambda c: (c - arm).dot((arm_tail - arm).normalized()) < (arm_tail - arm).length * 0.42 and c.z > arm.z - 0.06
        parts.append(shell("Pauldron", body, ["LeftArm", "LeftShoulder"], team(), None, 0.035, 0.016, keep))
    elif kind in ("helmet", "racing_helmet", "beanie"):
        # Cut from the head's own surface, so it fits the skull: a helmet down
        # to the brow and over the ears, a racing helmet round the whole head
        # with the face open, a beanie low on the crown.
        face_y = min(p.y for p in skull if abs(p.x - cx) < 0.03 and abs(p.z - (top - skull_r * 1.1)) < 0.03)
        brow_z = top - skull_r * 0.95
        ear_z = top - skull_r * 1.45
        if kind == "helmet":
            keep = lambda c: c.z > (brow_z if c.y < cy - skull_r * 0.4 else ear_z + 0.01)
            obj = shell("Helmet", body, ["Head"], gear(), None, 0.032, 0.014, keep, smooth=20)
            RIG["headgear"] = 0.046
        elif kind == "racing_helmet":
            jaw_z = top - skull_r * 2.05
            face = lambda c: c.y < cy - skull_r * 0.35 and abs(c.x - cx) < skull_r * 0.75 and jaw_z + 0.02 < c.z < brow_z - 0.005
            keep = lambda c: c.z > jaw_z and not face(c)
            obj = shell("RacingHelmet", body, ["Head", "Neck"], gear(), None, 0.04, 0.014, keep, smooth=24)
        else:
            keep = lambda c: c.z > top - skull_r * 0.85
            obj = shell("Beanie", body, ["Head"], material("Knit", (0.12, 0.11, 0.1), 1.0), None, 0.016, 0.012, keep, smooth=16)
            RIG["headgear"] = 0.028
        if kind != "beanie":
            # Two-tone: team colour round the lower edge, or a stripe over the top.
            obj.data.materials.append(team())
            for poly in obj.data.polygons:
                c = obj.matrix_world @ poly.center
                stripe = kind == "racing_helmet" and abs(c.x - cx) < skull_r * 0.18 and c.z > top - skull_r * 0.6
                rim = kind == "helmet" and c.z < brow_z + 0.03
                poly.material_index = 1 if (stripe or rim) else 0
        parts.append(obj)
        if kind == "racing_helmet":
            # The visor, flush in the top of the opening.
            visor = box("Visor", (skull_r * 1.35, 0.01, skull_r * 0.38), Vector((cx, face_y - 0.045, brow_z - skull_r * 0.12)), (math.radians(-6), 0, 0))
            parts.append(finish(visor, rig, "Head", lens(), 0.005))
    elif kind == "goggles":
        # Pushed up on the brow of the headgear: a curved frame and lens that
        # follow the head's curve, and a strap round the back.
        lift = RIG.get("headgear", 0.02)
        brow_z = top - skull_r * 0.72
        # Sized from the measured front of the head at the brow (the head is
        # longer than it is wide; the arcs are stretched 1.1 front to back).
        front = min(p.y for p in skull if abs(p.x - cx) < 0.04 and abs(p.z - brow_z) < 0.03)
        ring = (cy - front + lift + 0.006) / 1.1

        def arc(name, radius, height, depth, span, mat, z):
            bpy.ops.mesh.primitive_cylinder_add(vertices=48, radius=radius, depth=height, end_fill_type="NOTHING", location=Vector((cx, cy, z)))
            obj = bpy.context.active_object
            obj.name = name
            bpy.ops.object.mode_set(mode="EDIT")
            bpy.ops.mesh.select_all(action="DESELECT")
            bpy.ops.object.mode_set(mode="OBJECT")
            for v in obj.data.vertices:
                angle = math.degrees(math.atan2(v.co.x, -v.co.y))  # 0 = straight ahead
                v.select = abs(angle) > span
            bpy.ops.object.mode_set(mode="EDIT")
            bpy.ops.mesh.delete(type="VERT")
            bpy.ops.object.mode_set(mode="OBJECT")
            obj.scale = (1.0, 1.1, 1.0)
            bpy.ops.object.transform_apply(scale=True)
            mod = obj.modifiers.new("Solidify", "SOLIDIFY")
            mod.thickness = depth
            bpy.context.view_layer.objects.active = obj
            bpy.ops.object.modifier_apply(modifier=mod.name)
            return finish(obj, rig, "Head", mat, 0.003)

        parts.append(arc("GoggleFrame", ring, 0.05, 0.016, 62, gear(), brow_z))
        parts.append(arc("GoggleLens", ring + 0.017, 0.036, 0.004, 52, lens(), brow_z))
    elif kind == "headset":
        ear = Vector((cx, cy + skull_r * 0.1, top - skull_r * 1.35))
        for sgn in (-1, 1):
            bpy.ops.mesh.primitive_cylinder_add(vertices=16, radius=0.04, depth=0.034, location=ear + Vector((sgn * (skull_r + 0.012), 0.0, 0.0)), rotation=(0, math.radians(90), 0))
            parts.append(finish(bpy.context.active_object, rig, "Head", gear(), 0.006))
        mic = box("Mic", (0.01, 0.1, 0.01), ear + Vector((skull_r * 0.85, -0.06, -0.035)), (0, 0, math.radians(-25)))
        parts.append(finish(mic, rig, "Head", gear()))
    return parts


def finish_keep(obj, rig, bone):
    """`finish` for an object that already has its materials."""
    for poly in obj.data.polygons:
        poly.use_smooth = True
    group = obj.vertex_groups.new(name=f"mixamorig:{bone}")
    group.add(range(len(obj.data.vertices)), 1.0, "REPLACE")
    world = obj.matrix_world.copy()
    obj.parent = rig
    obj.matrix_world = world
    obj.modifiers.new("Armature", "ARMATURE").object = rig
    return obj


def asset(subdir, name):
    path = AssetService.find_asset_absolute_path(f"{name}.mhclo" if subdir != "skins" else f"{name}.mhmat", asset_subdir=subdir)
    if path is None:
        raise FileNotFoundError(f"{subdir}/{name} not found: load the makehuman_system_assets pack")
    return path


def build(char_id, spec, out_dir):
    bpy.ops.wm.read_homefile(use_empty=True)
    RIG.clear()
    human = HumanService.create_human()
    for key, value in spec["macro"].items():
        HumanObjectProperties.set_value(key, value, entity_reference=human)
    TargetService.reapply_macro_details(human)
    HumanService.set_character_skin(asset("skins", spec["skin"]), human, skin_type="GAMEENGINE")
    rig = HumanService.add_builtin_rig(human, "mixamo")
    extras = [("eyes", "low-poly", "Eyes"), ("eyebrows", spec["eyebrows"], "Eyebrows"), ("eyelashes", "eyelashes01", "Eyelashes")]
    if spec.get("hair"):
        extras.append(("hair", spec["hair"], "Hair"))
    extras += [("clothes", c, "Clothes") for c in spec["clothes"]]
    for subdir, name, kind in extras:
        HumanService.add_mhclo_asset(asset(subdir, name), human, asset_type=kind, material_type="GAMEENGINE")
    for kind in spec["gear"]:
        make_gear(kind, rig, human)

    hide = RIG.get("hide")
    if hide:
        # The skin under the clothes, removed: it would show through at bends.
        import bmesh
        bm = bmesh.new()
        bm.from_mesh(human.data)
        bm.faces.ensure_lookup_table()
        bmesh.ops.delete(bm, geom=[bm.faces[i] for i in hide if i < len(bm.faces)], context="FACES_ONLY")
        bm.to_mesh(human.data)
        bm.free()
    copy = ExportService.create_character_copy(human, name_suffix="_export")
    body = ObjectService.find_object_of_type_amongst_nearest_relatives(copy, "Basemesh")
    ExportService.bake_modifiers_remove_helpers(body, bake_masks=True, bake_subdiv=False, remove_helpers=True, also_proxy=True)
    bpy.ops.object.select_all(action="DESELECT")
    copy.select_set(True)
    for child in ObjectService.get_list_of_children(copy):
        child.select_set(True)
    bpy.context.view_layer.objects.active = copy
    out = os.path.join(out_dir, f"{char_id}.glb")
    bpy.ops.export_scene.gltf(
        filepath=out,
        use_selection=True,
        export_format="GLB",
        export_skins=True,
        export_animations=False,
        export_apply=True,
        export_yup=True,
        # JPEG keeps the source small; the game's asset build recompresses anyway.
        export_image_format="JPEG",
        export_image_quality=88,
    )
    print(f"[people] wrote {out}")


def main():
    args = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    out_dir = os.path.abspath(args[0] if args else ".")
    os.makedirs(out_dir, exist_ok=True)
    for char_id in args[1:] or list(CHARACTERS):
        build(char_id, CHARACTERS[char_id], out_dir)


main()
