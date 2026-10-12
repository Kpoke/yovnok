/**
 * Prep the SQUADS vehicle — a plain, unbranded SUV — from its download.
 *
 *   npx tsx scripts/prep/suv.ts      # then: npm run assetbuild
 *
 * Input (unmodified download, kept as the preferred form for modification):
 *   assets-src/vehicles/suv/original/generic-cars.glb
 *     "Generic passenger car pack" by comrade1280, CC BY 4.0 — nine generic
 *     vehicles designed to resemble no real car; this takes its SUV.
 *
 * Outputs, in game convention (metres, +Y up, -Z forward, part-local origins —
 * see ASSET_SPEC.md):
 *   assets-src/vehicles/suv/chassis.glb   the SUV body, without wheels
 *   assets-src/vehicles/suv/wheel.glb     one wheel, axle along X, hub facing -X
 *
 * The pack lays its cars out in a circle, each turned a different way, so the
 * car's frame is measured rather than assumed: its four wheel centres give
 * the axle line (length), the track (width) and the axle midpoint; the end
 * where the body is lower (the bonnet) is the front. It is turned to face -Z,
 * scaled so its wheelbase is the squad vehicle's, and set so its wheels stand
 * on the ground below a chassis origin `rideHeight` up.
 */

import { join } from 'node:path';
import type { Document, Node } from '@gltf-transform/core';
import { getBounds, prune } from '@gltf-transform/functions';
import { cloneDocument } from '@gltf-transform/functions';
import { VEHICLE_CLASSES } from '../../src/shared/config';
import { bake, io, keepOnly, ROOT, yaw } from './lib';

const DIR = join(ROOT, 'assets-src', 'vehicles', 'suv');
const SPEC = VEHICLE_CLASSES.suv;

/** The SUV's nodes: the body, and the wheels that carry its wheel mesh. */
const isBody = (n: Node): boolean => n.getName() === 'SUV Body';
const isSuvWheel = (n: Node): boolean =>
  /^Wheel_E/.test(n.getName()) && n.listChildren().some((c) => c.getMesh()?.listPrimitives()[0]?.getMaterial()?.getName() === 'Wheel_6');

const centre = (n: Node): [number, number, number] => {
  const b = getBounds(n);
  return [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];
};

/** Rotate a vector about +Y the way `yaw(θ)` does. */
const turn = (v: [number, number, number], θ: number): [number, number, number] => [
  v[0] * Math.cos(θ) + v[2] * Math.sin(θ),
  v[1],
  -v[0] * Math.sin(θ) + v[2] * Math.cos(θ),
];

/** Every vertex of a node subtree, in world space. */
function worldVertices(node: Node): Array<[number, number, number]> {
  const out: Array<[number, number, number]> = [];
  node.traverse((n) => {
    const mesh = n.getMesh();
    if (!mesh) return;
    const m = n.getWorldMatrix();
    for (const prim of mesh.listPrimitives()) {
      const pos = prim.getAttribute('POSITION');
      if (!pos) continue;
      const v = [0, 0, 0];
      for (let i = 0; i < pos.getCount(); i++) {
        pos.getElement(i, v);
        out.push([
          m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12],
          m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13],
          m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14],
        ]);
      }
    }
  });
  return out;
}

const source = await io.read(join(DIR, 'original', 'generic-cars.glb'));
const nodes = source.getRoot().listNodes();
const body = nodes.find(isBody);
const wheels = nodes.filter(isSuvWheel);
if (!body || wheels.length !== 4) throw new Error(`SUV not found (${wheels.length} wheels)`);

// ---- the car's frame, from its wheels ---------------------------------------
const w = wheels.map(centre);
const mid: [number, number, number] = [0, 1, 2].map((k) => w.reduce((s, p) => s + p[k], 0) / 4) as [number, number, number];
// Pair the wheels into axles: project on the diagonal-free principal axis.
const pairs: Array<{ d: number; axis: [number, number] }> = [];
for (let i = 0; i < 4; i++)
  for (let j = i + 1; j < 4; j++) {
    const dx = w[j][0] - w[i][0];
    const dz = w[j][2] - w[i][2];
    const d = Math.hypot(dx, dz);
    pairs.push({ d, axis: [dx / d, dz / d] });
  }
pairs.sort((a, b) => a.d - b.d);
// Sides: two shortest pairs are the axles (track), the next two the wheelbase.
const track = (pairs[0].d + pairs[1].d) / 2;
const wheelbase = (pairs[2].d + pairs[3].d) / 2;
let along = pairs[2].axis;

// Front: the end where the body is lower (the bonnet; the roof runs to the back).
const verts = worldVertices(body);
const proj = (p: [number, number, number]): number => (p[0] - mid[0]) * along[0] + (p[2] - mid[2]) * along[1];
const span = Math.max(...verts.map((p) => Math.abs(proj(p))));
const topAt = (sign: number): number => Math.max(...verts.filter((p) => sign * proj(p) > span * 0.55).map((p) => p[1]));
if (topAt(1) > topAt(-1)) along = [-along[0], -along[1]];
// `along` now points to the front. Turn it to -Z: φ' = φ + θ, target φ = π.
const φ = Math.atan2(along[0], along[1]);
const θ = Math.PI - φ;
const s = SPEC.wheelbase / wheelbase;

const wheelRadius = (getBounds(wheels[0]).max[1] - getBounds(wheels[0]).min[1]) / 2;
const ground = Math.min(...w.map((c) => c[1])) - wheelRadius;
console.log(
  `SUV: wheelbase ${wheelbase.toFixed(2)} track ${track.toFixed(2)} wheel r ${wheelRadius.toFixed(3)} → scale ${s.toFixed(3)}:` +
    ` track ${(track * s).toFixed(2)} m (spec ${SPEC.track}), wheel r ${(wheelRadius * s).toFixed(3)} m (spec ${SPEC.wheelRadius})`,
);

/** Keep one node (found again in the copy) and bake it around `origin`. */
async function part(find: (doc: Document) => Node, origin: [number, number, number], file: string): Promise<Document> {
  const doc = cloneDocument(source);
  const target = find(doc);
  keepOnly(doc, (n) => n === target);
  // p' = t + R(θ)·(s·p): put `origin` at the part's origin.
  const o = turn([origin[0] * s, origin[1] * s, origin[2] * s], θ);
  await bake(doc, [-o[0], -o[1], -o[2]], yaw(θ), s);
  await doc.transform(prune());
  await io.write(join(DIR, file), doc);
  return doc;
}

// Chassis: origin at the axle midpoint, `rideHeight` above the ground.
await part((doc) => doc.getRoot().listNodes().find(isBody)!, [mid[0], ground + SPEC.rideHeight / s, mid[2]], 'chassis.glb');

// Wheel: the front-left one (after the turn: -Z forward, -X left), on its axle.
const frontLeft = wheels.find((n) => {
  const p = turn([centre(n)[0] - mid[0], 0, centre(n)[2] - mid[2]], θ);
  return p[2] < 0 && p[0] < 0;
})!;
const flCentre = centre(frontLeft);
const near = (n: Node): number => Math.hypot(...centre(n).map((v, k) => v - flCentre[k]));
await part(
  (doc) =>
    doc
      .getRoot()
      .listNodes()
      .filter(isSuvWheel)
      .sort((a, b) => near(a) - near(b))[0],
  flCentre,
  'wheel.glb',
);
console.log('wrote chassis.glb and wheel.glb (front-left wheel:', frontLeft.getName(), ')');
