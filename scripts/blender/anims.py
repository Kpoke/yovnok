"""
YOVNOK's crew animations: keyframed here, on the crew's skeleton.

    blender -b --python scripts/blender/anims.py -- <out.glb>

Writes one .glb holding just the skeleton and its animation clips (no mesh).
Every crew member (scripts/blender/people.py) shares the skeleton's bone
names, so one set of clips drives them all; the game plays them through an
AnimationMixer and adds its own layer on top (where the gun points, the hands
on the gun, where the hips sit in each car).

Clips are posed the way an animator would: a control rig (two-bone IK for the
arms and legs, aimed by target empties with pole targets for elbows and
knees) plus direct rotations for the hips, spine, neck and head, at key
frames with eased (Bezier) timing; then baked to plain bone rotations.

Axes (Blender, the figure facing -Y, up +Z): pitch forward is +X rotation,
leaning to the figure's left is +Y, turning to its left is +Z.

Clips (30 fps):
  seated     loop   sat on a seat, breathing, small head movement
  ready      loop   sat forward and alert, head scanning (a tucked gunner)
  climb_left once   from the seat up and out of the window on the figure's
  climb_right       left (right): dip and lean in, the free hand up to the
                    frame, a knee up on the seat, rise through, overshoot, settle
                    (facing stays forward: the game turns the body to the window)
  out        loop   up out of the window: braced, breathing, a slow weight shift
  recoil     once   a shot: shoulders and head kick back and recover
  reload     once   head down to the gun, torso turned to it, and back
  down       once   knocked down: slumped forward, head dropped
"""

import importlib
import math
import sys

import bpy
from mathutils import Matrix, Vector

FPS = 30


def mpfb(module, name):
    for loaded in list(sys.modules):
        if loaded.endswith(module):
            return getattr(importlib.import_module(loaded), name)
    raise ImportError(f"MPFB module {module} is not loaded")


HumanService = mpfb("mpfb.services.humanservice", "HumanService")
HumanObjectProperties = mpfb("mpfb.entities.objectproperties", "HumanObjectProperties")
TargetService = mpfb("mpfb.services.targetservice", "TargetService")

P = "mixamorig:"
SPINE = ["Spine", "Spine1", "Spine2"]


def setup():
    bpy.ops.wm.read_homefile(use_empty=True)
    bpy.context.scene.render.fps = FPS
    human = HumanService.create_human()
    # An average build: the clips are rotations, retargeted onto each crew
    # member's own skeleton in the game.
    for key, value in {"gender": 1.0, "muscle": 0.6, "weight": 0.5}.items():
        HumanObjectProperties.set_value(key, value, entity_reference=human)
    TargetService.reapply_macro_details(human)
    rig = HumanService.add_builtin_rig(human, "mixamo")
    bpy.context.view_layer.objects.active = rig
    rig.select_set(True)
    for pb in rig.pose.bones:
        pb.rotation_mode = "QUATERNION"
    controls = {}

    def empty(name, at):
        obj = bpy.data.objects.new(name, None)
        bpy.context.collection.objects.link(obj)
        obj.location = at
        controls[name] = obj
        return obj

    world = lambda b: rig.matrix_world @ rig.data.bones[P + b].head_local
    for side in ("Left", "Right"):
        s = 1 if side == "Left" else -1
        hand = empty(f"hand{side}", world(f"{side}Hand"))
        elbow = empty(f"elbow{side}", world(f"{side}ForeArm") + Vector((s * 0.3, 0.3, 0)))
        foot = empty(f"foot{side}", world(f"{side}Foot"))
        knee = empty(f"knee{side}", world(f"{side}Leg") + Vector((0, -0.5, 0)))
        for bone, target, pole, angle in ((f"{side}ForeArm", hand, elbow, -90), (f"{side}Leg", foot, knee, 90)):
            ik = rig.pose.bones[P + bone].constraints.new("IK")
            ik.target = target
            ik.pole_target = pole
            # The bones' roll differs between arms and legs: the angle that
            # bends each toward its pole (a leg's -90 folded the knee backwards).
            ik.pole_angle = math.radians(angle)
            ik.chain_count = 2
    return human, rig, controls


def rest(rig):
    for pb in rig.pose.bones:
        pb.rotation_quaternion = (1, 0, 0, 0)
        pb.location = (0, 0, 0)
    bpy.context.view_layer.update()


def turn(rig, bone, axis, degrees):
    """Rotate a pose bone about a WORLD axis through its head (on top of its pose)."""
    pb = rig.pose.bones[P + bone]
    head = pb.head.copy()
    r = Matrix.Translation(head) @ Matrix.Rotation(math.radians(degrees), 4, axis) @ Matrix.Translation(-head)
    pb.matrix = r @ pb.matrix
    bpy.context.view_layer.update()


X, Y, Z = Vector((1, 0, 0)), Vector((0, 1, 0)), Vector((0, 0, 1))


MIRROR = [1]


def pose(rig, c, *, hips=(0, 0, 0), pelvis=(0, 0, 0), spine=(0, 0, 0), neck=(0, 0), head=(0, 0, 0), shrug=(0, 0),
         hands=None, feet=None, elbows=None, knees=None):
    """One key pose, built from rest.

    hips: offset (x, y, z) m · pelvis/spine/head: (pitch fwd, lean left, turn left)
    degrees, the spine's spread over its three bones · neck: (pitch, turn) ·
    shrug: shoulders up (left, right) degrees · hands/feet: world positions
    relative to the hips' rest (left, right) · elbows/knees: pole offsets.
    """
    m = MIRROR[0]
    if m < 0:
        # The other side: x offsets and the sideways and turning angles flip.
        # Hands keep their roles (the support hand still reaches for the frame).
        flip = lambda v: (-v[0], v[1], v[2])
        hips = flip(hips)
        pelvis, spine, head = (pelvis[0], -pelvis[1], -pelvis[2]), (spine[0], -spine[1], -spine[2]), (head[0], -head[1], -head[2])
        neck = (neck[0], -neck[1])
        hands = hands and tuple(flip(v) for v in hands)
        feet = feet and tuple(flip(v) for v in feet)[::-1]
        elbows = elbows and tuple(flip(v) for v in elbows)
        knees = knees and tuple(flip(v) for v in knees)[::-1]
    rest(rig)
    pb = rig.pose.bones[P + "Hips"]
    pb.location = rig.data.bones[P + "Hips"].matrix_local.inverted().to_3x3() @ Vector(hips)
    bpy.context.view_layer.update()
    for axis, amount in zip((X, Y, Z), pelvis):
        if amount:
            turn(rig, "Hips", axis, amount)
    for bone in SPINE:
        for axis, amount in zip((X, Y, Z), spine):
            if amount:
                turn(rig, bone, axis, amount / 3)
    for axis, amount in zip((X, Z), neck):
        if amount:
            turn(rig, "Neck", axis, amount)
    for axis, amount in zip((X, Y, Z), head):
        if amount:
            turn(rig, "Head", axis, amount)
    for side, amount in zip(("Left", "Right"), shrug):
        if amount:
            turn(rig, f"{side}Shoulder", Y if side == "Left" else -Y, amount)
    # Limb targets are relative to the hips where this pose PUTS them.
    base = rig.matrix_world @ rig.data.bones[P + "Hips"].head_local + Vector(hips)
    for kind, values in (("hand", hands), ("foot", feet), ("elbow", elbows), ("knee", knees)):
        if values is None:
            continue
        for side, v in zip(("Left", "Right"), values):
            c[f"{kind}{side}"].location = base + Vector(v) if kind in ("hand", "foot") else c[f"{kind}{side}"].location
            if kind in ("elbow", "knee"):
                c[f"{kind}{side}"].location = base + Vector(v)


def key(rig, c, frame):
    for pb in rig.pose.bones:
        pb.keyframe_insert("rotation_quaternion", frame=frame)
    rig.pose.bones[P + "Hips"].keyframe_insert("location", frame=frame)
    for obj in c.values():
        obj.keyframe_insert("location", frame=frame)


# Common limb placements, relative to the hips' rest position (m).
SEAT_FEET = ((0.13, -0.42, -0.46), (-0.13, -0.42, -0.46))
SEAT_KNEES = ((0.15, -1.0, 0.0), (-0.15, -1.0, 0.0))
LAP_HANDS = ((0.16, -0.32, -0.04), (-0.16, -0.32, -0.04))
OUT_ELBOWS = ((0.6, 0.0, 0.3), (-0.6, 0.0, 0.3))
KNEEL_FEET = ((0.14, 0.38, -0.3), (-0.14, 0.38, -0.3))
KNEEL_KNEES = ((0.15, -0.9, -0.2), (-0.15, -0.9, -0.2))
READY_HANDS = ((0.12, -0.36, 0.22), (-0.1, -0.3, 0.12))


def seated(rig, c, alert=False):
    """Sitting. Alert: forward on the seat, head scanning (a gunner, tucked)."""
    lean = 10 if alert else -8
    hands = READY_HANDS if alert else LAP_HANDS
    frames = 180 if alert else 120
    look = [0, 28, 0, -24, 0] if alert else [0, 6, 0, -5, 0]
    for k, f in enumerate(range(0, frames + 1, frames // 4)):
        breath = (1.2 if k % 2 else -0.6)
        pose(rig, c, hips=(0, 0, -0.42), pelvis=(-80, 0, 0), spine=(80 + lean + breath, 0, 0), neck=(-6 if alert else 0, look[k] * 0.4),
             head=(-4 + (2 if k % 2 else 0), 0, look[k] * 0.6), shrug=(breath * 1.5, breath * 1.5), hands=hands, feet=SEAT_FEET,
             elbows=((0.4, 0.2, 0.0), (-0.4, 0.2, 0.0)), knees=SEAT_KNEES)
        key(rig, c, f)
    return frames


def climb(rig, c):
    """From the seat, up and out of the window on the figure's left (mirrored in the game for the right)."""
    seat = dict(hips=(0, 0, -0.42), pelvis=(-80, 0, 0), feet=SEAT_FEET, knees=SEAT_KNEES, elbows=((0.4, 0.2, 0), (-0.4, 0.2, 0)))
    # 0: alert in the seat.
    pose(rig, c, spine=(90, 0, 0), neck=(-6, 0), hands=READY_HANDS, **seat)
    key(rig, c, 0)
    # 4: anticipation, a dip: shoulders down and in, head ducking the frame.
    pose(rig, c, spine=(102, -6, 8), neck=(10, 10), head=(6, 0, 10), shrug=(-4, 0), hands=((0.3, -0.25, 0.25), (-0.1, -0.3, 0.12)), **seat)
    key(rig, c, 4)
    # 9: turning to the window, the lead hand up on the frame, a knee up on the seat.
    pose(rig, c, hips=(0.06, 0, -0.18), pelvis=(-40, 0, 12), spine=(55, 12, 10), neck=(4, 12), head=(0, 0, 8), shrug=(8, 0),
         hands=((0.42, -0.1, 0.7), (-0.05, -0.32, 0.25)), feet=((0.13, 0.1, -0.34), (-0.13, -0.38, -0.44)), knees=KNEEL_KNEES,
         elbows=((0.7, 0.2, 0.4), (-0.5, 0.2, 0.0)))
    key(rig, c, 9)
    # 14: up and out, past upright: overshoot, leaning out.
    pose(rig, c, hips=(0.0, 0, 0.05), pelvis=(-6, -4, 0), spine=(-6, -10, 0), neck=(-4, 0), head=(-4, 4, 0), shrug=(4, 2),
         hands=((0.3, -0.35, 0.6), (0.1, -0.3, 0.45)), feet=KNEEL_FEET, knees=KNEEL_KNEES, elbows=OUT_ELBOWS)
    key(rig, c, 14)
    # 19: settled out, braced.
    pose(rig, c, hips=(0.0, 0, 0.02), pelvis=(-2, -2, 0), spine=(4, -4, 0), neck=(0, 0), head=(0, 0, 0),
         hands=((0.12, -0.45, 0.5), (-0.08, -0.3, 0.48)), feet=KNEEL_FEET, knees=KNEEL_KNEES, elbows=OUT_ELBOWS)
    key(rig, c, 19)
    return 19


def out(rig, c):
    """Out of the window, braced: breathing and a slow weight shift (the game aims the torso)."""
    frames = 120
    for k, f in enumerate(range(0, frames + 1, 30)):
        sway = [0, 2.2, 0, -2.2, 0][k]
        breath = 1.0 if k % 2 else -0.5
        pose(rig, c, hips=(0.0, 0, 0.02), pelvis=(-2, sway * 0.6, 0), spine=(4 + breath, -4 - sway, 0), neck=(0, 0), head=(0, -sway * 0.5, 0),
             shrug=(breath, breath), hands=((0.12, -0.45, 0.5), (-0.08, -0.3, 0.48)), feet=KNEEL_FEET, knees=KNEEL_KNEES, elbows=OUT_ELBOWS)
        key(rig, c, f)
    return frames


def recoil(rig, c):
    base = dict(hips=(0.0, 0, 0.02), pelvis=(-2, -2, 0), feet=KNEEL_FEET, knees=KNEEL_KNEES, elbows=OUT_ELBOWS,
                hands=((0.12, -0.45, 0.5), (-0.08, -0.3, 0.48)))
    for f, (back, head) in ((0, (4, 0)), (1, (-3, -5)), (3, (-1, -2)), (7, (4, 0))):
        pose(rig, c, spine=(back, -4, 0), head=(head, 0, 0), shrug=(-2 if f in (1, 3) else 0, -4 if f in (1, 3) else 0), **base)
        key(rig, c, f)
    return 7


def reload(rig, c):
    base = dict(hips=(0.0, 0, 0.02), pelvis=(-2, -2, 0), feet=KNEEL_FEET, knees=KNEEL_KNEES, elbows=OUT_ELBOWS,
                hands=((0.12, -0.45, 0.5), (-0.08, -0.3, 0.48)))
    for f, (bend, twist, look) in ((0, (4, 0, 0)), (6, (14, -14, 24)), (26, (16, -16, 26)), (36, (4, 0, 0))):
        pose(rig, c, spine=(bend, -4, twist), neck=(look * 0.5, -6 if look else 0), head=(look * 0.5, 0, -8 if look else 0), **base)
        key(rig, c, f)
    return 36


def down(rig, c):
    seat = dict(hips=(0, 0, -0.42), pelvis=(-80, 0, 0), feet=SEAT_FEET, knees=SEAT_KNEES, elbows=((0.4, 0.2, 0), (-0.4, 0.2, 0)))
    pose(rig, c, spine=(90, 0, 0), hands=READY_HANDS, **seat)
    key(rig, c, 0)
    pose(rig, c, spine=(128, 8, -6), neck=(18, 0), head=(14, 6, 0), shrug=(-6, -6), hands=((0.2, -0.2, -0.18), (-0.22, -0.18, -0.2)), **seat)
    key(rig, c, 8)
    pose(rig, c, spine=(132, 10, -8), neck=(24, 0), head=(18, 8, 0), shrug=(-8, -8), hands=((0.22, -0.18, -0.22), (-0.24, -0.16, -0.24)), **seat)
    key(rig, c, 24)
    return 24


def mirrored(build):
    """The same clip for the figure's right side."""
    def run(r, c):
        MIRROR[0] = -1
        try:
            return build(r, c)
        finally:
            MIRROR[0] = 1
    return run


CLIPS = [("seated", lambda r, c: seated(r, c, False)), ("ready", lambda r, c: seated(r, c, True)), ("climb_left", climb),
         ("climb_right", mirrored(climb)), ("out", out), ("recoil", recoil), ("reload", reload), ("down", down)]


def main():
    out_path = sys.argv[sys.argv.index("--") + 1]
    human, rig, controls = setup()
    rig.animation_data_create()
    baked = []
    for name, build in CLIPS:
        action = bpy.data.actions.new(f"{name}_ctl")
        rig.animation_data.action = action
        for obj in controls.values():
            obj.animation_data_create()
            obj.animation_data.action = bpy.data.actions.new(f"{name}_{obj.name}")
        end = build(rig, controls)
        # Bake what the control rig produces into plain bone rotations.
        bpy.ops.object.select_all(action="DESELECT")
        rig.select_set(True)
        bpy.context.view_layer.objects.active = rig
        bpy.ops.object.mode_set(mode="POSE")
        bpy.ops.pose.select_all(action="SELECT")
        bpy.ops.nla.bake(frame_start=0, frame_end=end, only_selected=True, visual_keying=True, clear_constraints=False, use_current_action=False, bake_types={"POSE"})
        bpy.ops.object.mode_set(mode="OBJECT")
        clip = rig.animation_data.action
        clip.name = name
        clip.use_fake_user = True
        baked.append(clip)
        print(f"[anims] baked {name}: {end + 1} frames")
    # Push each clip to its own NLA track, so the exporter writes one animation per clip.
    rig.animation_data.action = None
    for clip in baked:
        track = rig.animation_data.nla_tracks.new()
        track.name = clip.name
        track.strips.new(clip.name, 0, clip)
    for pb in rig.pose.bones:
        for con in list(pb.constraints):
            pb.constraints.remove(con)
    rest(rig)
    # Plain bone names, as the game's figures have them.
    for bone in rig.data.bones:
        bone.name = bone.name.replace(P, "")
    bpy.ops.object.select_all(action="DESELECT")
    rig.select_set(True)
    bpy.context.view_layer.objects.active = rig
    bpy.ops.export_scene.gltf(filepath=out_path, use_selection=True, export_format="GLB", export_animations=True, export_animation_mode="NLA_TRACKS",
                              export_force_sampling=True, export_frame_step=1, export_def_bones=False, export_yup=True)
    print(f"[anims] wrote {out_path}")


main()
