/**
 * Cover blocks, dressed as stacks of shipping containers.
 *
 * The cover in the arena is plain boxes in the shared map (collision is a box,
 * and should stay one). Drawn as boxes they read as placeholder geometry; drawn
 * as containers — the staple of a staged military checkpoint — they read as a
 * set. Each block's footprint and height are filled EXACTLY by a grid of
 * containers, so what you see is precisely what you collide with.
 *
 * Containers are textured boxes, not models: a realistic container model is
 * 11–17k triangles and the arena needs ~200 of them. A box with a corrugated
 * metal normal map, a paint colour and a seam between neighbours reads the same
 * at driving distance for 12 triangles. All of them are one mesh.
 */

import * as THREE from 'three';
import { SOLIDS, type Solid } from '../shared/arena';
import { PALETTE } from '../shared/config';
import { appendGeometry } from './buildArena';
import { CONTAINER_SURFACE } from './arenaSurfaces';

/** ISO 20/40 ft container: length, width, height (m). */
const CONTAINER = { length: 12.19, width: 2.44, height: 2.59 };
/** Gap left between neighbouring containers, so a stack reads as units. */
const SEAM = 0.08;
/** Weathered container paints. */
const PAINTS = [0xc0482f, 0x3f7fb0, 0x5f9150, 0xa3a39d, 0xdd7b2c, 0xa33d50, 0xc8b278, 0x4f6a7a];

/** Is this solid drawn as containers rather than as a plain block? */
export function isContainerBlock(solid: Solid): boolean {
  return solid.kind === 'box' && solid.color === PALETTE.block && !solid.ground && !solid.prop;
}

export function buildContainers(): THREE.Mesh {
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const colours: number[] = [];
  const colour = new THREE.Color();
  let count = 0;

  for (const solid of SOLIDS) {
    if (!isContainerBlock(solid)) continue;
    const sx = solid.max.x - solid.min.x;
    const sz = solid.max.z - solid.min.z;
    const sy = solid.max.y - solid.min.y;
    // Lay the containers' length along the block's longer side.
    const alongX = sx >= sz;
    const long = alongX ? sx : sz;
    const short = alongX ? sz : sx;
    const nLong = Math.max(1, Math.round(long / CONTAINER.length));
    const nShort = Math.max(1, Math.round(short / CONTAINER.width));
    const nUp = Math.max(1, Math.round(sy / CONTAINER.height));
    // Stretch a little so the grid fills the box exactly.
    const cl = long / nLong;
    const cw = short / nShort;
    const ch = sy / nUp;

    for (let i = 0; i < nLong; i++) {
      for (let j = 0; j < nShort; j++) {
        for (let k = 0; k < nUp; k++) {
          const a = (i + 0.5) * cl;
          const b = (j + 0.5) * cw;
          const cx = solid.min.x + (alongX ? a : b);
          const cz = solid.min.z + (alongX ? b : a);
          const cy = solid.min.y + (k + 0.5) * ch;
          const w = (alongX ? cl : cw) - SEAM;
          const d = (alongX ? cw : cl) - SEAM;
          const h = ch - (k === nUp - 1 ? 0 : SEAM);
          const box = new THREE.BoxGeometry(w, h, d);
          box.translate(cx, cy, cz);
          const before = positions.length;
          appendGeometry(positions, normals, uvs, box, CONTAINER_SURFACE.tile);
          // A paint per container, chosen from its position so it is stable.
          const pick = Math.abs(Math.floor(cx * 7.3 + cz * 3.1 + cy * 11.7)) % PAINTS.length;
          colour.setHex(PAINTS[pick]).convertSRGBToLinear();
          for (let v = before; v < positions.length; v += 3) colours.push(colour.r, colour.g, colour.b);
          count++;
        }
      }
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colours, 3));
  const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7, metalness: 0.3 });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = `containers (${count})`;
  mesh.userData.surface = CONTAINER_SURFACE;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}
