"""
The crew's clips from Quaternius' Universal Animation Library (CC0), retargeted
onto the crew's skeleton (Mixamo bone names), rotations only.

    blender -b --python scripts/blender/ual.py -- \
        assets-src/characters/ual/original/AnimationLibrary_Godot_Standard.glb \
        assets-src/characters/raider/figure.glb public/assets/characters/ual.glb

Method: both skeletons are brought to the same reference pose (the library's
A_TPose clip; each crew bone turned, shortest arc, to point the way its
library bone points there). Each frame, a crew bone's world rotation is the
library bone's world rotation times the fixed offset between them in that
reference pose. The world rotations are then turned back into local pose
rotations down the hierarchy, so nothing depends on how either rig's bones
are rolled.

Writes one .glb holding the crew skeleton (no mesh) and one animation per clip;
the game (client/vehicle/figures.ts) blends them: sat in the seat, leaning out
to aim (the pistol aim poses, by pitch), reloading, firing and hit reactions.
"""

import sys

import bpy
from mathutils import Quaternion

FPS = 30

CLIPS = [
    "Sitting_Idle_Loop", "Sitting_Enter", "Sitting_Exit", "Sitting_Talking_Loop", "Driving_Loop",
    "Pistol_Aim_Up", "Pistol_Aim_Neutral", "Pistol_Aim_Down", "Pistol_Idle_Loop", "Pistol_Shoot", "Pistol_Reload",
    "Hit_Chest", "Hit_Head", "Death01", "Idle_Loop",
]
REF = "A_TPose"

MAP = {
    "DEF-hips": "Hips", "DEF-spine.001": "Spine", "DEF-spine.002": "Spine1", "DEF-spine.003": "Spine2",
    "DEF-neck": "Neck", "DEF-head": "Head",
}
for s, side in (("L", "Left"), ("R", "Right")):
    MAP |= {
        f"DEF-shoulder.{s}": f"{side}Shoulder", f"DEF-upper_arm.{s}": f"{side}Arm",
        f"DEF-forearm.{s}": f"{side}ForeArm", f"DEF-hand.{s}": f"{side}Hand",
        f"DEF-thigh.{s}": f"{side}UpLeg", f"DEF-shin.{s}": f"{side}Leg",
        f"DEF-foot.{s}": f"{side}Foot", f"DEF-toe.{s}": f"{side}ToeBase",
    }
    for finger, name in (("index", "Index"), ("middle", "Middle"), ("ring", "Ring"), ("pinky", "Pinky")):
        for i in (1, 2, 3):
            MAP[f"DEF-f_{finger}.0{i}.{s}"] = f"{side}Hand{name}{i}"
    for i in (1, 2, 3):
        MAP[f"DEF-thumb.0{i}.{s}"] = f"{side}HandThumb{i}"


def armature_from(path):
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=path)
    new = [o for o in bpy.data.objects if o not in before]
    return next(o for o in new if o.type == "ARMATURE"), new


def play(obj, action):
    obj.animation_data_create()
    obj.animation_data.action = action
    if getattr(action, "slots", None) and len(action.slots):
        obj.animation_data.action_slot = action.slots[0]


def world_rots(obj):
    """Each pose bone's world rotation, as the scene is evaluated now."""
    mw = obj.matrix_world
    return {pb.name: (mw @ pb.matrix).to_quaternion() for pb in obj.pose.bones}


def ordered(bones):
    out = []
    def walk(b):
        out.append(b)
        for c in b.children:
            walk(c)
    for b in bones:
        if b.parent is None:
            walk(b)
    return out


def main():
    argv = sys.argv[sys.argv.index("--") + 1:]
    ual_path, crew_path, out_path = argv
    bpy.ops.wm.read_homefile(use_empty=True)
    scene = bpy.context.scene
    scene.render.fps = FPS
    src, _ = armature_from(ual_path)
    dst, dst_objs = armature_from(crew_path)
    actions = {a.name: a for a in bpy.data.actions}
    print("[ual] actions:", sorted(actions))
    # Imported clips may be named per armature ("Clip" or "Clip_Rig"): find by prefix.
    def find(name):
        return actions.get(name) or next(a for n, a in actions.items() if n.startswith(name))

    # The crew skeleton at rest, unanimated.
    if dst.animation_data:
        dst.animation_data.action = None
    for pb in dst.pose.bones:
        pb.rotation_mode = "QUATERNION"
        pb.rotation_quaternion = Quaternion()
        pb.location = (0, 0, 0)
        pb.scale = (1, 1, 1)
    obj_rot = dst.matrix_world.to_quaternion()
    rest_local = {b.name: b.matrix_local.to_quaternion() for b in dst.data.bones}
    bones = ordered(dst.data.bones)
    inv_map = {v: k for k, v in MAP.items()}

    # Reference pose: the library's A_TPose; the crew bones turned to match its directions.
    play(src, find(REF))
    scene.frame_set(int(find(REF).frame_range[0]))
    bpy.context.view_layer.update()
    s_ref = world_rots(src)
    # Which way each body faces (feet to toes, flattened): the library's
    # rotations are turned about the vertical into the crew's facing, or a bend
    # forward would come out as a bend back on a body facing the other way.
    from mathutils import Vector

    def facing(obj, foot, toe):
        mw = obj.matrix_world
        d = Vector((0, 0, 0))
        for s_ in ("L", "R"):
            d += (mw @ obj.pose.bones[toe.format(s_)].head) - (mw @ obj.pose.bones[foot.format(s_)].head)
        d.z = 0
        return d.normalized()

    f_src = facing(src, "DEF-foot.{}", "DEF-toe.{}")
    side = {"L": "Left", "R": "Right"}
    mw = dst.matrix_world
    d = Vector((0, 0, 0))
    for s_ in ("L", "R"):
        d += (mw @ dst.pose.bones[side[s_] + "ToeBase"].head) - (mw @ dst.pose.bones[side[s_] + "Foot"].head)
    d.z = 0
    f_dst = d.normalized()
    import math
    F = Quaternion((0, 0, 1), math.atan2(f_src.x * f_dst.y - f_src.y * f_dst.x, f_src.dot(f_dst)))
    print("[ual] facing src", tuple(round(v, 2) for v in f_src), "crew", tuple(round(v, 2) for v in f_dst))
    s_ref = {k: F @ q for k, q in s_ref.items()}
    dst_rest_world = {b.name: obj_rot @ rest_local[b.name] for b in bones}
    offset = {}
    y = lambda q: (q @ __import__("mathutils").Vector((0, 1, 0))).normalized()
    for b in bones:
        sname = inv_map.get(b.name)
        if not sname or sname not in s_ref:
            continue
        t_rest = dst_rest_world[b.name]
        turn = y(t_rest).rotation_difference(y(s_ref[sname]))
        t_ref = turn @ t_rest
        offset[b.name] = s_ref[sname].inverted() @ t_ref
    missing = [b.name for b in bones if b.name not in offset]
    print("[ual] unmapped crew bones:", missing)

    dst.animation_data_create()
    baked = []
    for clip in CLIPS:
        action = find(clip)
        play(src, action)
        f0, f1 = (int(round(v)) for v in action.frame_range)
        out = bpy.data.actions.new(clip)
        out.use_fake_user = True
        play(dst, out)
        prev = {}
        for f in range(f0, f1 + 1):
            scene.frame_set(f)
            s = {k: F @ q for k, q in world_rots(src).items()}
            world = {}
            for b in bones:
                if b.name in offset:
                    world[b.name] = s[inv_map[b.name]] @ offset[b.name]
                else:
                    parent_w = world[b.parent.name] if b.parent else obj_rot
                    parent_rest = rest_local[b.parent.name] if b.parent else Quaternion()
                    world[b.name] = parent_w @ (parent_rest.inverted() @ rest_local[b.name])
            for b in bones:
                if b.parent:
                    parent_w = world[b.parent.name]
                    rel = rest_local[b.parent.name].inverted() @ rest_local[b.name]
                else:
                    parent_w = obj_rot
                    rel = rest_local[b.name]
                q = (parent_w @ rel).inverted() @ world[b.name]
                q.normalize()
                if b.name in prev and prev[b.name].dot(q) < 0:
                    q.negate()
                prev[b.name] = q
                pb = dst.pose.bones[b.name]
                pb.rotation_quaternion = q
                pb.keyframe_insert("rotation_quaternion", frame=f - f0)
        baked.append(out)
        print(f"[ual] {clip}: {f1 - f0 + 1} frames")

    dst.animation_data.action = None
    for clip in baked:
        track = dst.animation_data.nla_tracks.new()
        track.name = clip.name
        track.strips.new(clip.name, 0, clip)
    for pb in dst.pose.bones:
        pb.rotation_quaternion = Quaternion()
    # Skeleton only: drop the library and the crew's meshes.
    for o in list(bpy.data.objects):
        if o is not dst:
            bpy.data.objects.remove(o)
    bpy.ops.object.select_all(action="DESELECT")
    dst.select_set(True)
    bpy.context.view_layer.objects.active = dst
    bpy.ops.export_scene.gltf(filepath=out_path, use_selection=True, export_format="GLB", export_animations=True,
                              export_animation_mode="NLA_TRACKS", export_force_sampling=True, export_frame_step=1,
                              export_def_bones=False, export_yup=True)
    print(f"[ual] wrote {out_path}")


main()
