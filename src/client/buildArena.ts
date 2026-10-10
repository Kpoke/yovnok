/**
 * Builds renderable geometry from the shared arena description.
 *
 * The arena is authored once in `shared/arena.ts` and interpreted here — the
 * simulation queries the data, the renderer draws it. Neither knows about the
 * other, which is what lets the server reuse the same arena definition at M2.
 *
 * M2 note: DESIGN.md §13.6 plans arenas as data files with a mod loader. The
 * Solid list is already that format in all but name.
 */

import * as THREE from 'three';
import { SOLIDS, type Solid } from '../shared/arena';
import { surfaceOf } from './arenaSurfaces';
import { buildContainers, isContainerBlock } from './buildContainers';

/** Expand one solid into triangles. */
function rampGeometry(s: Solid): THREE.BufferGeometry {
  const { min, max } = s;
  const along = s.along!;
  const hStart = s.hStart!;
  const hEnd = s.hEnd!;
  const baseY = min.y;

  // Corner order is consistent between the base and the top: 0,1,2,3 walk the
  // footprint anticlockwise.
  const b: number[][] = [
    [min.x, baseY, min.z],
    [max.x, baseY, min.z],
    [max.x, baseY, max.z],
    [min.x, baseY, max.z],
  ];
  const t: number[][] =
    along === 'x'
      ? [
          [min.x, hStart, min.z],
          [max.x, hEnd, min.z],
          [max.x, hEnd, max.z],
          [min.x, hStart, max.z],
        ]
      : [
          [min.x, hStart, min.z],
          [max.x, hStart, min.z],
          [max.x, hEnd, max.z],
          [min.x, hEnd, max.z],
        ];

  const positions: number[] = [];
  const push = (p: number[]) => positions.push(p[0], p[1], p[2]);
  const quad = (a: number[], c: number[], d: number[], e: number[]) => {
    push(a);
    push(c);
    push(d);
    push(a);
    push(d);
    push(e);
  };

  quad(b[3], b[2], b[1], b[0]); // underside
  quad(t[0], t[1], t[2], t[3]); // slope
  quad(b[0], b[1], t[1], t[0]);
  quad(b[1], b[2], t[2], t[1]);
  quad(b[2], b[3], t[3], t[2]);
  quad(b[3], b[0], t[0], t[3]);

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  return geometry;
}

function solidGeometry(s: Solid): THREE.BufferGeometry {
  if (s.kind === 'ramp') return rampGeometry(s);

  const w = s.max.x - s.min.x;
  const h = s.max.y - s.min.y;
  const d = s.max.z - s.min.z;
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate((s.min.x + s.max.x) / 2, (s.min.y + s.max.y) / 2, (s.min.z + s.max.z) / 2);
  return g;
}

/**
 * A tiled grid for the floor. This is not decoration — without surface detail
 * a flat arena gives almost no sense of speed, which makes handling impossible
 * to judge.
 */
function gridTexture(): THREE.Texture {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;

  ctx.fillStyle = '#4a515c';
  ctx.fillRect(0, 0, size, size);

  ctx.strokeStyle = '#5f6774';
  ctx.lineWidth = 3;
  ctx.strokeRect(0, 0, size, size);

  ctx.strokeStyle = '#545b67';
  ctx.lineWidth = 1;
  for (let i = 1; i < 4; i++) {
    const p = (size / 4) * i;
    ctx.beginPath();
    ctx.moveTo(p, 0);
    ctx.lineTo(p, size);
    ctx.moveTo(0, p);
    ctx.lineTo(size, p);
    ctx.stroke();
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(40, 40);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  return texture;
}

/**
 * Append one geometry's triangles onto flat arrays, with WORLD-SPACE UVs.
 *
 * Each triangle is projected along the axis its face looks down (a "box"
 * projection), in units of `tile` metres per texture repeat. That is what lets
 * one material cover a 2 m kerb and a 400 m ground ring at the same texel
 * density, with no stretching and no per-solid UV authoring.
 *
 * Deliberately hand-rolled rather than pulling in a merge utility: it needs to
 * do exactly this, and nothing else in the project should depend on how it is
 * spelled.
 */
export function appendGeometry(
  positions: number[],
  normals: number[],
  uvs: number[],
  geometry: THREE.BufferGeometry,
  tile: number,
): void {
  const flat = geometry.index ? geometry.toNonIndexed() : geometry;
  const position = flat.getAttribute('position');
  const normal = flat.getAttribute('normal');
  for (let i = 0; i < position.count; i += 3) {
    // Face normal from the first vertex of the triangle (flat solids).
    const nx = Math.abs(normal.getX(i));
    const ny = Math.abs(normal.getY(i));
    const nz = Math.abs(normal.getZ(i));
    for (let k = i; k < i + 3; k++) {
      const x = position.getX(k);
      const y = position.getY(k);
      const z = position.getZ(k);
      positions.push(x, y, z);
      normals.push(normal.getX(k), normal.getY(k), normal.getZ(k));
      if (ny >= nx && ny >= nz) uvs.push(x / tile, z / tile);
      else if (nx >= nz) uvs.push(z / tile, y / tile);
      else uvs.push(x / tile, y / tile);
    }
  }
  if (flat !== geometry) flat.dispose();
  geometry.dispose();
}

/** A mesh from flat arrays, tagged with the surface it should become. */
export function batchMesh(
  positions: number[],
  normals: number[],
  uvs: number[],
  material: THREE.Material,
  colour: number,
): THREE.Mesh {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  const mesh = new THREE.Mesh(geometry, material);
  // Picked up by `applyArenaSurfaces` once the real materials have loaded.
  mesh.userData.surface = surfaceOf(colour);
  return mesh;
}

/**
 * Pull a ground layer toward the camera in depth by its rank, so a higher layer
 * always draws over a lower one it overlaps, however far away.
 */
export function applyGroundBias(material: THREE.Material, layer: number): void {
  if (layer <= 0) return;
  material.polygonOffset = true;
  material.polygonOffsetFactor = -layer;
  material.polygonOffsetUnits = -layer * 4;
}

/** Default tile size for a solid with no surface (it keeps its flat colour). */
const DEFAULT_TILE = 4;

/**
 * Build the map as ONE mesh per (colour, kind).
 *
 * The arena is static, so batching it is free — and it is what keeps the map
 * from competing with the cars for draw calls. At one mesh per solid a 340 m
 * arena cost ~50 calls before a single vehicle was drawn; merged, it is a
 * handful no matter how much map is added. Cars are the budget that matters.
 */
export function buildArena(options: { containers?: boolean; skip?: ReadonlySet<number> } = {}): THREE.Group {
  const containers = options.containers ?? true;
  // Palette roles the map's scenery draws itself (rocks, tree trunks…).
  const skip = options.skip ?? new Set<number>();
  const group = new THREE.Group();
  group.name = 'arena';

  const floorTexture = gridTexture();

  // Ground: one mesh per zone ring and road strip (M10/M11). Each becomes its
  // zone's material; until then it shows the old grid, tinted by zone.
  //
  // The rings are NESTED boxes whose tops differ by millimetres (so the inner
  // one wins the ground query). Depth precision cannot separate 7 mm at a
  // distance, which showed as striped z-fighting once the ground had real
  // texture. Each layer gets a depth bias ranked by its height instead.
  const groundTops = [...new Set(SOLIDS.filter((s) => s.ground).map((s) => s.max.y))].sort((a, b) => a - b);
  for (const solid of SOLIDS) {
    if (!solid.ground) continue;
    const material = new THREE.MeshStandardMaterial({
      color: solid.color,
      roughness: 0.92,
      metalness: 0.04,
      map: floorTexture,
    });
    const positions: number[] = [];
    const normals: number[] = [];
    const uvs: number[] = [];
    const tile = surfaceOf(solid.color)?.tile ?? DEFAULT_TILE;
    appendGeometry(positions, normals, uvs, solidGeometry(solid), tile);
    const mesh = batchMesh(positions, normals, uvs, material, solid.color);
    mesh.userData.groundLayer = groundTops.indexOf(solid.max.y);
    applyGroundBias(material, mesh.userData.groundLayer);
    mesh.receiveShadow = true;
    group.add(mesh);
  }

  // Everything else, grouped so that a batch never mixes a box with a ramp —
  // ramps need DoubleSide and boxes do not.
  const batches = new Map<string, { color: number; kind: Solid['kind']; solids: Solid[] }>();
  for (const solid of SOLIDS) {
    // Cover blocks are drawn as container stacks instead (one mesh, below).
    // …and props by buildProps (models inside the same collision box).
    if (solid.ground || (containers && isContainerBlock(solid)) || solid.prop || skip.has(solid.color)) continue;
    const key = `${solid.color}:${solid.kind}`;
    const batch = batches.get(key) ?? { color: solid.color, kind: solid.kind, solids: [] };
    batch.solids.push(solid);
    batches.set(key, batch);
  }

  for (const batch of batches.values()) {
    const positions: number[] = [];
    const normals: number[] = [];
    const uvs: number[] = [];
    const tile = surfaceOf(batch.color)?.tile ?? DEFAULT_TILE;
    let casts = false;
    for (const solid of batch.solids) {
      if (solid.kind === 'box' && solid.max.y > 1) casts = true;
      appendGeometry(positions, normals, uvs, solidGeometry(solid), tile);
    }

    const material = new THREE.MeshStandardMaterial({
      color: batch.color,
      roughness: 0.92,
      metalness: 0.04,
      flatShading: true,
      // Ramps are hand-built geometry; DoubleSide sidesteps winding concerns
      // and costs nothing at this triangle count.
      side: batch.kind === 'ramp' ? THREE.DoubleSide : THREE.FrontSide,
    });

    const mesh = batchMesh(positions, normals, uvs, material, batch.color);
    mesh.userData.doubleSided = batch.kind === 'ramp';
    mesh.castShadow = casts;
    mesh.receiveShadow = true;
    group.add(mesh);
  }

  if (containers) group.add(buildContainers());

  return group;
}
