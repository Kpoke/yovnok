/**
 * Prep the "armored" hero vehicle from its downloaded originals.
 *
 *   npx tsx scripts/prep/armored.ts      # then: npm run assetbuild
 *
 * Inputs (unmodified downloads, kept as the preferred form for modification):
 *   assets-src/vehicles/armored/original/armored-police-vehicle.glb  (Roam_Man, CC BY 4.0)
 *   assets-src/vehicles/armored/original/textures/*.png              (the same model's 2048 px maps)
 *   assets-src/vehicles/turret/original/oshkosh-matv.glb            (42manako, CC BY 4.0)
 *   assets-src/weapons/m2/original/m2-50cal.glb                     (britdawgmasterfunk, CC BY 4.0)
 *   assets-src/weapons/rpg7/original/rpg-7.glb                      (javadbayat, CC BY 4.0)
 *
 * Outputs, in game convention (metres, +Y up, -Z forward, part-local origins —
 * see ASSET_SPEC.md), ready for `npm run assetbuild`:
 *   assets-src/vehicles/armored/chassis.glb  body, wheel wells, axles; no wheels
 *   assets-src/vehicles/armored/wheel.glb    one wheel, axle along X, hub facing -X
 *                                            (the rig mirrors it for the right side)
 *   assets-src/vehicles/armored/turret.glb   roof weapon station: the M-ATV's ring and shield
 *                                            carrying an RPG-7, `muzzle` at the warhead
 *   assets-src/vehicles/armored/gun.glb      one bumper M2, origin at its pintle, `muzzle` at the tip
 *
 * What changes versus the originals: the truck is scaled to 80% (so its track
 * and wheelbase match an SUV's handling), turned to face -Z, split into parts,
 * its roof antennas removed (they broke the collision silhouette), and its 1024 px
 * textures replaced by the source 2048 px maps — flipped to glTF's texture
 * convention — with AO/roughness/metal packed into one ORM texture.
 */

import { join } from 'node:path';
import type { Document } from '@gltf-transform/core';
import {
  clearNodeTransform,
  cloneDocument,
  flatten,
  getBounds,
  mergeDocuments,
  prune,
  unpartition,
} from '@gltf-transform/functions';
import { bake, byMaterial, io, keepOnly, removeNodes, ROOT, textureKit, yaw } from './lib';

const ARMORED = join(ROOT, 'assets-src', 'vehicles', 'armored');
const TURRET = join(ROOT, 'assets-src', 'vehicles', 'turret');
const WEAPONS = join(ROOT, 'assets-src', 'weapons');
const TEX = join(ARMORED, 'original', 'textures');

/** Uniform scale applied to the truck. Matches `VEHICLE_CLASSES.solo`. */
export const SCALE = 0.8;
/** Ground-to-chassis-centre height in the ORIGINAL model (m). */
const MODEL_CENTRE_Y = 1.6;
/** Midpoint of the two axles along the original model's Z. */
const MODEL_AXLE_MID_Z = 0.09;
/** Turret scale from the M-ATV's centimetre units. */
const TURRET_SCALE = 0.01 * 0.7;

const tex = textureKit(TEX);

async function upgradeTextures(doc: Document): Promise<void> {
  for (const material of doc.getRoot().listMaterials()) {
    switch (material.getName()) {
      case 'exterior':
        await tex.upgrade(doc, material, { base: 'exterior_basecolor.png', normal: 'exterior_normal.png', orm: ['exterior_ao.png', 'exterior_roughness.png', null] });
        break;
      case 'wheel':
        await tex.upgrade(doc, material, { base: 'wheel_basecolor.png', normal: 'wheel_normal.png', orm: ['wheel_ao.png', 'wheel_roughness.png', 'wheel_metallic.png'] });
        break;
      case 'interior':
        await tex.upgrade(doc, material, { base: 'interior_basecolor.png', normal: 'interior_normal.png', orm: ['interior_ao.png', 'interior_roughnes.png', null] });
        break;
      case 'lights':
        await tex.upgrade(doc, material, { base: 'lights_basecolor.png' });
        break;
      // `windows` keeps the original glb's maps: there is no larger source.
    }
  }
}

// ------------------------------------------------------------------- parts

const isWheel = (name: string): boolean => /^wheel_(FL|FR|RL|RR)$/.test(name);

async function chassis(source: Document): Promise<Document> {
  const doc = cloneDocument(source);
  removeNodes(doc, (n) => isWheel(n.getName()) || n.getName() === 'body_rear_antennas');
  // Model point p → R(π)·S·(p − (0, centreY, axleMidZ)).
  const t: [number, number, number] = [0, -MODEL_CENTRE_Y * SCALE, MODEL_AXLE_MID_Z * SCALE];
  await bake(doc, t, yaw(Math.PI), SCALE);
  await upgradeTextures(doc);
  await doc.transform(prune());
  return doc;
}

async function wheel(source: Document): Promise<Document> {
  const doc = cloneDocument(source);
  keepOnly(doc, (n) => n.getName() === 'wheel_FL');
  const node = doc.getRoot().listNodes().find((n) => n.getName() === 'wheel_FL');
  if (!node) throw new Error('wheel_FL not found');
  const b = getBounds(node);
  const c = b.min.map((v, i) => (v + b.max[i]) / 2);
  // Centre on the axle, then the same turn and scale as the chassis. FL sits
  // on the model's +X, which the half-turn puts on the game's left (-X).
  const t: [number, number, number] = [c[0] * SCALE, -c[1] * SCALE, c[2] * SCALE];
  await bake(doc, t, yaw(Math.PI), SCALE);
  await upgradeTextures(doc);
  await doc.transform(prune());
  return doc;
}

/** The M2's scale from its source units (80.4 long) to 1.3 m — 80% of a real M2, like the truck. */
const M2_SCALE = 1.3 / 80.407;
/** RPG-7 scale (source is metres); with its rocket seated it is 1.8 m long. */
const RPG_SCALE = 0.7;
/** Where the RPG's tube centre sits on the roof station (turret-local). */
const RPG_PLACE: [number, number, number] = [0.07, 0.42, -0.75];

/**
 * One bumper machine gun: the M2, origin at the foot of its pintle mount (the
 * pivot it turns about), barrel along -Z (as authored), `muzzle` at the tip.
 */
async function gun(source: Document): Promise<{ doc: Document; muzzle: [number, number, number] }> {
  const doc = cloneDocument(source);
  await bake(doc, [0, 0, 0], [0, 0, 0, 1], 1);
  const pintle = byMaterial(doc, 'pintlemount1');
  const barrel = byMaterial(doc, 'barrel1');
  if (!pintle || !barrel) throw new Error('M2 parts not found');
  const pb = getBounds(pintle);
  const bb = getBounds(barrel);
  const origin = [(pb.min[0] + pb.max[0]) / 2, pb.min[1], (pb.min[2] + pb.max[2]) / 2];
  const t: [number, number, number] = [-origin[0] * M2_SCALE, -origin[1] * M2_SCALE, -origin[2] * M2_SCALE];
  const muzzle: [number, number, number] = [
    ((bb.min[0] + bb.max[0]) / 2 - origin[0]) * M2_SCALE,
    ((bb.min[1] + bb.max[1]) / 2 - origin[1]) * M2_SCALE,
    (bb.min[2] - origin[2]) * M2_SCALE,
  ];
  await bake(doc, t, [0, 0, 0, 1], M2_SCALE);
  doc.getRoot().getDefaultScene()!.addChild(doc.createNode('muzzle').setTranslation(muzzle).setExtras({ socket: true }));
  return { doc, muzzle };
}

/**
 * The roof weapon station: the M-ATV's armoured ring and gun shield with its own
 * machine gun taken out, and an RPG-7 — rocket loaded, warhead proud of the
 * tube — seated where that gun was. Origin at the ring's base; `muzzle` at the
 * warhead tip.
 */
async function turret(matvSource: Document, rpgSource: Document): Promise<{ doc: Document; muzzle: [number, number, number] }> {
  const doc = cloneDocument(matvSource);
  keepOnly(doc, (n) => n.getName() === 'vehicle_matv_static_LOD_0.001');
  const ring = byMaterial(doc, 'mtl_vehicle_matv');
  const lynx = byMaterial(doc, 'mtl_iveco_lynx_turret');
  if (!ring || !lynx) throw new Error('turret parts not found');
  lynx.dispose();
  const rb = getBounds(ring);
  // Origin: centre of the ring's base, so the part sits ON the roof.
  const origin = [(rb.min[0] + rb.max[0]) / 2, rb.min[1], (rb.min[2] + rb.max[2]) / 2];
  // The station faces the M-ATV's +X; a +90° yaw turns +X into -Z.
  // Point p → rotate (p - origin)·s by +90° about Y: (x, z) → (z, -x).
  const t: [number, number, number] = [-origin[2] * TURRET_SCALE, -origin[1] * TURRET_SCALE, origin[0] * TURRET_SCALE];
  await bake(doc, t, yaw(Math.PI / 2), TURRET_SCALE);
  await doc.transform(prune());

  // The RPG: seat the separate display rocket in the tube (on the tube's axis,
  // warhead 0.5 m proud of the muzzle), then scale and place it on the station.
  const rpg = cloneDocument(rpgSource);
  await bake(rpg, [0, 0, 0], [0, 0, 0, 1], 1);
  const rocket = byMaterial(rpg, 'rocket');
  if (!rocket) throw new Error('RPG rocket not found');
  const kb = getBounds(rocket);
  rocket.setTranslation([-(kb.min[0] + kb.max[0]) / 2, -(kb.min[1] + kb.max[1]) / 2, -0.5]);
  clearNodeTransform(rocket);
  const all = getBounds(rpg.getRoot().getDefaultScene()!);
  const centreZ = (all.min[2] + all.max[2]) / 2;
  await bake(rpg, [RPG_PLACE[0], RPG_PLACE[1], RPG_PLACE[2] - centreZ * RPG_SCALE], [0, 0, 0, 1], RPG_SCALE);
  const tip = getBounds(byMaterial(rpg, 'rocket')!);
  const muzzle: [number, number, number] = [(tip.min[0] + tip.max[0]) / 2, (tip.min[1] + tip.max[1]) / 2, tip.min[2]];

  // Fold the RPG into the station's document as a sibling of the ring.
  mergeDocuments(doc, rpg);
  const scenes = doc.getRoot().listScenes();
  const main = scenes[0];
  for (const extra of scenes.slice(1)) {
    for (const child of extra.listChildren()) {
      extra.removeChild(child);
      main.addChild(child);
    }
    extra.dispose();
  }
  doc.getRoot().setDefaultScene(main);
  main.addChild(doc.createNode('muzzle').setTranslation(muzzle).setExtras({ socket: true }));
  await doc.transform(unpartition(), prune({ keepLeaves: true }));
  return { doc, muzzle };
}

// -------------------------------------------------------------------- main

async function main(): Promise<void> {
  const truck = await io.read(join(ARMORED, 'original', 'armored-police-vehicle.glb'));
  const matv = await io.read(join(TURRET, 'original', 'oshkosh-matv.glb'));
  const m2 = await io.read(join(WEAPONS, 'm2', 'original', 'm2-50cal.glb'));
  const rpg = await io.read(join(WEAPONS, 'rpg7', 'original', 'rpg-7.glb'));

  const parts: Array<[string, Document]> = [
    [join(ARMORED, 'chassis.glb'), await chassis(truck)],
    [join(ARMORED, 'wheel.glb'), await wheel(truck)],
  ];
  const station = await turret(matv, rpg);
  parts.push([join(ARMORED, 'turret.glb'), station.doc]);
  const mg = await gun(m2);
  parts.push([join(ARMORED, 'gun.glb'), mg.doc]);

  for (const [path, doc] of parts) {
    await io.write(path, doc);
    const b = getBounds(doc.getRoot().getDefaultScene()!);
    const size = b.max.map((v, i) => (v - b.min[i]).toFixed(2)).join(' × ');
    const centre = b.max.map((v, i) => ((v + b.min[i]) / 2).toFixed(2)).join(', ');
    console.log(`✓ ${path.slice(ROOT.length + 1)}: ${size} m, centre (${centre}), min y ${b.min[1].toFixed(2)}`);
  }
  // These feed SOLO_RPG_MUZZLE and SOLO_MG_MUZZLE in src/shared/crews.ts.
  console.log(`  turret (RPG) muzzle, part-local: ${station.muzzle.map((v) => v.toFixed(3)).join(', ')}`);
  console.log(`  gun (M2) muzzle, part-local:     ${mg.muzzle.map((v) => v.toFixed(3)).join(', ')}`);
}

await main();
