/**
 * Building blocks for map scenery: rock that looks like rock, pine trees,
 * cliffs around the arena, lamp posts, water. All batched or instanced.
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Solid } from '../../shared/arena';
import { STADIUM_HALF } from '../../shared/arena';
import { appendGeometry, batchMesh } from '../buildArena';
import { surfaceOf } from '../arenaSurfaces';
import { softTexture } from '../explosions';

/** Deterministic pseudo-random numbers, so every page builds the same scenery. */
export function seeded(seed: number): () => number {
  let s = seed;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

/** Smooth 3D value noise in -1..1 (cheap, deterministic). */
function noise(x: number, y: number, z: number): number {
  const h = (a: number, b: number, c: number): number => {
    const n = Math.sin(a * 127.1 + b * 311.7 + c * 74.7) * 43758.5453;
    return n - Math.floor(n);
  };
  const fx = Math.floor(x);
  const fy = Math.floor(y);
  const fz = Math.floor(z);
  const tx = x - fx;
  const ty = y - fy;
  const tz = z - fz;
  const s = (t: number): number => t * t * (3 - 2 * t);
  const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
  let v = 0;
  const c = [0, 1];
  const vals: number[] = [];
  for (const i of c) for (const j of c) for (const k of c) vals.push(h(fx + i, fy + j, fz + k));
  v = lerp(
    lerp(lerp(vals[0], vals[1], s(tz)), lerp(vals[2], vals[3], s(tz)), s(ty)),
    lerp(lerp(vals[4], vals[5], s(tz)), lerp(vals[6], vals[7], s(tz)), s(ty)),
    s(tx),
  );
  return v * 2 - 1;
}

/**
 * A box as weathered rock: subdivided, its sides pushed in and out by noise and
 * its top edge rounded, so a mesa or boulder reads as stone. The bumps are
 * within ~0.6 m of the collision box, so what you hit is what you see.
 */
export function rockGeometry(min: THREE.Vector3Like, max: THREE.Vector3Like, roughness = 0.6): THREE.BufferGeometry {
  const sx = max.x - min.x;
  const sy = max.y - min.y;
  const sz = max.z - min.z;
  const seg = (d: number): number => Math.max(2, Math.min(14, Math.round(d / 2.5)));
  const g = new THREE.BoxGeometry(sx, sy, sz, seg(sx), seg(sy), seg(sz));
  const p = g.getAttribute('position');
  const v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    const bottom = v.y < -sy / 2 + 0.01;
    const top = v.y > sy / 2 - 0.01;
    const wx = v.x + (min.x + max.x) / 2;
    const wz = v.z + (min.z + max.z) / 2;
    const wy = v.y + (min.y + max.y) / 2;
    const n = noise(wx * 0.12, wy * 0.16, wz * 0.12) * 0.6 + noise(wx * 0.45, wy * 0.45, wz * 0.45) * 0.4;
    // Rock strata: horizontal bands that stand out and recede.
    const strata = Math.sin(wy * 1.3 + noise(wx * 0.05, 0, wz * 0.05) * 3) * 0.35;
    // Taller rock tapers toward its top.
    const height = (v.y + sy / 2) / sy;
    const taper = sy > 6 ? height * Math.min(sx, sz) * 0.06 : 0;
    const ox = Math.abs(v.x) > sx / 2 - 0.01 ? Math.sign(v.x) : 0;
    const oz = Math.abs(v.z) > sz / 2 - 0.01 ? Math.sign(v.z) : 0;
    // Outward only (0..roughness), so the rock is never smaller than what you hit.
    const push = bottom ? 0 : (n * 0.5 + 0.5 + strata * 0.5) * roughness - taper;
    v.x += ox * push;
    v.z += oz * push;
    if (!bottom && top) {
      // Round the rim; a little relief on the top.
      if (ox !== 0 || oz !== 0) v.y -= Math.min(sy * 0.12, 0.3 + Math.abs(n) * 0.9);
      else v.y += n * 0.3;
    }
    p.setXYZ(i, v.x, v.y, v.z);
  }
  g.translate((min.x + max.x) / 2, (min.y + max.y) / 2, (min.z + max.z) / 2);
  g.computeVertexNormals();
  return g;
}

/** Every solid of one palette role, as rock, in one mesh with that role's surface. */
export function rocks(solids: readonly Solid[], colour: number, roughness = 0.6): THREE.Mesh {
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const tile = surfaceOf(colour)?.tile ?? 8;
  for (const s of solids) {
    if (s.color !== colour) continue;
    appendGeometry(positions, normals, uvs, rockGeometry(s.min, s.max, roughness), tile);
  }
  const mesh = batchMesh(positions, normals, uvs, new THREE.MeshStandardMaterial({ color: colour, roughness: 0.95 }), colour);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.name = 'rocks';
  return mesh;
}

/** Big rock shapes in a ring OUTSIDE the arena: the canyon walls, the quarry face. */
export function outerRock(
  colour: number,
  options: { inner: number; outer: number; height: [number, number]; count: number; seed: number; steps?: boolean },
): THREE.Mesh {
  const rand = seeded(options.seed);
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const tile = surfaceOf(colour)?.tile ?? 9;
  for (let i = 0; i < options.count; i++) {
    // Along the square ring, on a random side.
    const side = i % 4;
    const along = (rand() * 2 - 1) * (options.outer + 20);
    const depth = options.inner + rand() * (options.outer - options.inner);
    const w = 18 + rand() * 30;
    const d = 14 + rand() * 24;
    const h = options.height[0] + rand() * (options.height[1] - options.height[0]);
    // Quarry: further out is higher (benches climbing out of the pit).
    const height = options.steps ? h * (0.5 + (depth - options.inner) / (options.outer - options.inner)) : h;
    const [nx, nz] = [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ][side];
    const cx = nx * depth - nz * along;
    const cz = nz * depth + nx * along;
    const [sx, sz] = nx !== 0 ? [d, w] : [w, d];
    appendGeometry(
      positions,
      normals,
      uvs,
      rockGeometry({ x: cx - sx / 2, y: -2, z: cz - sz / 2 }, { x: cx + sx / 2, y: height, z: cz + sz / 2 }, 6),
      tile,
    );
  }
  const mesh = batchMesh(positions, normals, uvs, new THREE.MeshStandardMaterial({ color: colour, roughness: 0.95 }), colour);
  mesh.receiveShadow = true;
  mesh.name = 'outer-rock';
  mesh.raycast = () => {};
  return mesh;
}

/** A canvas of pine needles: dark, mottled green. */
function needleTexture(snowy: boolean): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = snowy ? '#b9c4c4' : '#2c4a2a';
  ctx.fillRect(0, 0, 128, 128);
  const rand = seeded(snowy ? 77 : 78);
  for (let i = 0; i < 900; i++) {
    const g = snowy ? 200 + rand() * 55 : 40 + rand() * 60;
    ctx.fillStyle = snowy
      ? rand() < 0.5
        ? `rgb(${g},${g},${g})`
        : `rgb(${40 + rand() * 30},${70 + rand() * 30},${50 + rand() * 20})`
      : `rgb(${g * 0.45},${g},${g * 0.45})`;
    ctx.fillRect(rand() * 128, rand() * 128, 2 + rand() * 3, 1 + rand() * 2);
  }
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  return t;
}

/**
 * Pine trees, instanced: a trunk and three stacked cones of needles. `points`
 * give each tree's base and height. Two draw calls however many trees.
 */
export function pines(points: Array<{ x: number; z: number; y?: number; h: number }>, options: { snowy?: boolean; trunks?: boolean; seed?: number } = {}): THREE.Group {
  const group = new THREE.Group();
  group.name = 'pines';
  const cones: THREE.BufferGeometry[] = [];
  // Unit tree, 1 m tall: cones from 0.25 up.
  for (const [y0, y1, r] of [
    [0.22, 0.62, 0.3],
    [0.42, 0.85, 0.23],
    [0.65, 1.0, 0.15],
  ] as const) {
    const c = new THREE.ConeGeometry(r, y1 - y0, 9, 1, true);
    c.translate(0, (y0 + y1) / 2, 0);
    cones.push(c);
  }
  const canopy = mergeGeometries(cones)!;
  const canopyMaterial = new THREE.MeshStandardMaterial({
    map: needleTexture(options.snowy ?? false),
    roughness: 0.95,
    side: THREE.DoubleSide,
    flatShading: true,
  });
  const trunk = new THREE.CylinderGeometry(0.018, 0.03, 0.4, 6);
  trunk.translate(0, 0.2, 0);
  const trunkMaterial = new THREE.MeshStandardMaterial({ color: 0x3a2b20, roughness: 1 });
  const canopyMesh = new THREE.InstancedMesh(canopy, canopyMaterial, points.length);
  const trunkMesh = new THREE.InstancedMesh(trunk, trunkMaterial, points.length);
  const rand = seeded(options.seed ?? 9);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const colour = new THREE.Color();
  points.forEach((p, i) => {
    q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rand() * Math.PI * 2);
    const width = p.h * (0.85 + rand() * 0.3);
    m.compose(new THREE.Vector3(p.x, p.y ?? 0, p.z), q, new THREE.Vector3(width, p.h, width));
    canopyMesh.setMatrixAt(i, m);
    trunkMesh.setMatrixAt(i, m);
    const shade = 0.75 + rand() * 0.4;
    canopyMesh.setColorAt(i, colour.setRGB(shade, shade * (0.95 + rand() * 0.1), shade));
  });
  for (const mesh of [canopyMesh, trunkMesh]) {
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.raycast = () => {};
  }
  if (options.trunks !== false) group.add(trunkMesh);
  group.add(canopyMesh);
  return group;
}

/** Points scattered in the square ring between two half-extents. */
export function ringPoints(rand: () => number, inner: number, outer: number, count: number): Array<{ x: number; z: number }> {
  const out: Array<{ x: number; z: number }> = [];
  while (out.length < count) {
    const x = (rand() * 2 - 1) * outer;
    const z = (rand() * 2 - 1) * outer;
    if (Math.max(Math.abs(x), Math.abs(z)) < inner) continue;
    out.push({ x, z });
  }
  return out;
}

/** Tall lamp posts with a glowing head and a halo: harbour and base lighting. */
export function lampPosts(points: Array<{ x: number; z: number }>, colour: number, height = 14): THREE.Group {
  const group = new THREE.Group();
  group.name = 'lamp-posts';
  const poles: THREE.BufferGeometry[] = [];
  const heads: THREE.BufferGeometry[] = [];
  const halo = new THREE.SpriteMaterial({ map: softTexture(), color: colour, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.7 });
  for (const p of points) {
    poles.push(new THREE.CylinderGeometry(0.15, 0.22, height, 6).translate(p.x, height / 2, p.z));
    heads.push(new THREE.BoxGeometry(1.4, 0.35, 0.7).translate(p.x, height + 0.1, p.z));
    const sprite = new THREE.Sprite(halo);
    sprite.position.set(p.x, height - 0.2, p.z);
    sprite.scale.setScalar(9);
    sprite.raycast = () => {};
    group.add(sprite);
  }
  const pole = new THREE.Mesh(mergeGeometries(poles)!, new THREE.MeshStandardMaterial({ color: 0x3a3f46, metalness: 0.6, roughness: 0.5 }));
  pole.castShadow = true;
  const head = new THREE.Mesh(mergeGeometries(heads)!, new THREE.MeshStandardMaterial({ color: 0x111111, emissive: colour, emissiveIntensity: 2.2 }));
  group.add(pole, head);
  return group;
}

/** Dark harbour water around the arena, smooth enough to mirror the lamps. */
export function water(level = -1.2): THREE.Mesh {
  const geometry = new THREE.PlaneGeometry(2000, 2000);
  geometry.rotateX(-Math.PI / 2);
  const mesh = new THREE.Mesh(
    geometry,
    new THREE.MeshStandardMaterial({ color: 0x08131b, roughness: 0.08, metalness: 0.3, envMapIntensity: 1.4 }),
  );
  mesh.position.y = level;
  mesh.name = 'water';
  mesh.receiveShadow = true;
  mesh.raycast = () => {};
  return mesh;
}

/** A plain batch of boxes in one material (scenery, no collision). */
export function boxes(list: Array<[number, number, number, number, number, number]>, material: THREE.Material, name: string): THREE.Mesh {
  const geometry = mergeGeometries(list.map(([cx, cy, cz, sx, sy, sz]) => new THREE.BoxGeometry(sx, sy, sz).translate(cx, cy, cz)))!;
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = name;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

/** Each solid of a role, replicated as its quarter turns already are: the solids themselves. */
export function solidsOf(solids: readonly Solid[], colour: number): Solid[] {
  return solids.filter((s) => s.color === colour);
}

/** The arena's half-extent, for scenery placed just outside it. */
export const EDGE = STADIUM_HALF;
