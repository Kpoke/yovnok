/**
 * The stadium around the arena floor: what makes the map a televised arena
 * rather than a field of blocks.
 *
 * Purely visual and entirely OUTSIDE the barrier (`STADIUM_HALF` in
 * shared/arena.ts), so the simulation never sees it:
 *
 *   - stands: ten concrete tiers on every side, rising to ~18 m;
 *   - a crowd on every tier (a generated texture of figures in mixed shirt
 *     colours — read at a distance, under floodlights, as people);
 *   - LED sponsor boards along the inside face of the barrier, glowing, with
 *     fictional brands only;
 *   - eight floodlight masts with glowing lamp banks (their actual light comes
 *     with the lighting pass).
 *
 * Merged by material: the whole stadium is a handful of draw calls.
 */

import * as THREE from 'three';
import { STADIUM_HALF, STADIUM_WALL } from '../shared/arena';
import { PALETTE } from '../shared/config';
import { appendGeometry, batchMesh } from './buildArena';
import { surfaceOf } from './arenaSurfaces';
import { softTexture } from './explosions';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

const TIERS = 10;
const TIER_DEPTH = 2.6;
const TIER_RISE = 1.4;
/** The barrier's thickness; the stands start right behind it. */
const BARRIER = 1.5;
/** The four sides, as the outward normal of each. */
const SIDES: Array<[number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

/** Fictional sponsors only — no real brand appears in the arena. */
const SPONSORS = ['YovNok TV', 'IRONHIDE TYRES', 'SCORCH FUEL', 'BULWARK ARMOUR', 'GRITLINE OIL', 'CONVOY LIVE'];

export function buildStadium(): THREE.Group {
  const group = new THREE.Group();
  group.name = 'stadium';
  group.add(stands(), crowd(), boards(), masts());
  return group;
}

/** A box from its centre and size, as a geometry. */
function boxAt(cx: number, cy: number, cz: number, sx: number, sy: number, sz: number): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(sx, sy, sz);
  g.translate(cx, cy, cz);
  return g;
}

/**
 * Stands: each tier is one long box per side, stepping up and back. The sides
 * run long enough to meet at the corners.
 */
function stands(): THREE.Mesh {
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const tile = surfaceOf(PALETTE.wall)?.tile ?? 5;
  for (const [nx, nz] of SIDES) {
    for (let t = 0; t < TIERS; t++) {
      const inner = STADIUM_HALF + BARRIER + t * TIER_DEPTH;
      const top = STADIUM_WALL + (t + 1) * TIER_RISE;
      const centre = inner + TIER_DEPTH / 2;
      const length = 2 * (STADIUM_HALF + BARRIER + TIERS * TIER_DEPTH);
      const [sx, sz] = nx !== 0 ? [TIER_DEPTH, length] : [length, TIER_DEPTH];
      appendGeometry(positions, normals, uvs, boxAt(nx * centre, top / 2, nz * centre, sx, top, sz), tile);
    }
  }
  const material = new THREE.MeshStandardMaterial({ color: PALETTE.wall, roughness: 0.9 });
  const mesh = batchMesh(positions, normals, uvs, material, PALETTE.wall);
  mesh.receiveShadow = true;
  return mesh;
}

/** A strip of crowd: rows of figures, transparent between them. */
function crowdTexture(): THREE.CanvasTexture {
  const w = 1024;
  const h = 128;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  const shirts = ['#c0392b', '#e67e22', '#f1c40f', '#ecf0f1', '#2c3e50', '#16a085', '#8e44ad', '#d35400', '#7f8c8d', '#2980b9'];
  const skin = ['#f1c27d', '#e0ac69', '#c68642', '#8d5524', '#ffdbac'];
  let seed = 7;
  const rand = (): number => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let row = 0; row < 2; row++) {
    for (let x = 6 + row * 9; x < w; x += 15 + rand() * 6) {
      const base = h - 4 - row * 30;
      const height = 50 + rand() * 18;
      const shoulders = 11 + rand() * 4;
      ctx.fillStyle = shirts[Math.floor(rand() * shirts.length)];
      ctx.beginPath();
      ctx.roundRect(x - shoulders / 2, base - height * 0.62, shoulders, height * 0.62, 4);
      ctx.fill();
      ctx.fillStyle = skin[Math.floor(rand() * skin.length)];
      ctx.beginPath();
      ctx.arc(x, base - height * 0.62 - 6, 6, 0, Math.PI * 2);
      ctx.fill();
      // Some arms up: it is a show.
      if (rand() < 0.25) ctx.fillRect(x + shoulders / 2 - 2, base - height * 0.95, 3, height * 0.35);
    }
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.anisotropy = 4;
  return texture;
}

/** One vertical strip of crowd on the front of every tier, facing the arena. */
function crowd(): THREE.Mesh {
  const positions: number[] = [];
  const uvs: number[] = [];
  const height = 1.7;
  const repeat = 12; // metres of crowd per texture width
  for (const [nx, nz] of SIDES) {
    for (let t = 0; t < TIERS; t++) {
      const d = STADIUM_HALF + BARRIER + t * TIER_DEPTH + 0.6;
      const y0 = STADIUM_WALL + (t + 1) * TIER_RISE;
      const half = STADIUM_HALF + BARRIER + t * TIER_DEPTH;
      // Strip endpoints along the side; winding chosen so it faces inward.
      const a = nx !== 0 ? [nx * d, -half * nx] : [-half * nz, nz * d];
      const b = nx !== 0 ? [nx * d, half * nx] : [half * nz, nz * d];
      const len = (2 * half) / repeat;
      const quad = [
        [a[0], y0, a[1], 0, 0],
        [b[0], y0, b[1], len, 0],
        [b[0], y0 + height, b[1], len, 1],
        [a[0], y0 + height, a[1], 0, 1],
      ];
      for (const i of [0, 1, 2, 0, 2, 3]) {
        positions.push(quad[i][0], quad[i][1], quad[i][2]);
        uvs.push(quad[i][3], quad[i][4]);
      }
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.computeVertexNormals();
  const texture = crowdTexture();
  const material = new THREE.MeshStandardMaterial({
    map: texture,
    alphaTest: 0.5,
    side: THREE.DoubleSide,
    roughness: 0.95,
    // Lit enough to read in the dark stands, as the floodlights spill on them.
    emissive: 0xffffff,
    emissiveMap: texture,
    emissiveIntensity: 0.25,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'crowd';
  return mesh;
}

/** The LED advertising strip: fictional sponsors, bright on dark. */
function boardTexture(): THREE.CanvasTexture {
  const panel = 512;
  const canvas = document.createElement('canvas');
  canvas.width = panel * SPONSORS.length;
  canvas.height = 96;
  const ctx = canvas.getContext('2d')!;
  const colours = [
    ['#0b0d12', '#ff6a2b'],
    ['#ff6a2b', '#0b0d12'],
    ['#101820', '#f2c94c'],
    ['#1b2a3a', '#ffffff'],
    ['#0b0d12', '#56ccf2'],
    ['#c0392b', '#ffffff'],
  ];
  SPONSORS.forEach((name, i) => {
    const [bg, fg] = colours[i % colours.length];
    ctx.fillStyle = bg;
    ctx.fillRect(i * panel, 0, panel, canvas.height);
    ctx.fillStyle = fg;
    ctx.font = 'bold 54px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(name, i * panel + panel / 2, canvas.height / 2 + 2, panel - 40);
  });
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.anisotropy = 8;
  return texture;
}

function boards(): THREE.Mesh {
  const positions: number[] = [];
  const uvs: number[] = [];
  const y0 = 1.1;
  const y1 = STADIUM_WALL - 0.5;
  const perRepeat = 60; // metres per full run of sponsors
  for (const [nx, nz] of SIDES) {
    const d = STADIUM_HALF - 0.05; // just inside the barrier's inner face
    const half = STADIUM_HALF - 0.1;
    // Run the text left-to-right as seen from INSIDE, looking out along the
    // side's normal: "right" is (-nz, nx). Getting this backwards mirrors it.
    const [rx, rz] = [-nz, nx];
    const a = [nx * d - rx * half, nz * d - rz * half];
    const b = [nx * d + rx * half, nz * d + rz * half];
    const len = (2 * half) / perRepeat;
    const quad = [
      [a[0], y0, a[1], 0, 0],
      [b[0], y0, b[1], len, 0],
      [b[0], y1, b[1], len, 1],
      [a[0], y1, a[1], 0, 1],
    ];
    for (const i of [0, 1, 2, 0, 2, 3]) {
      positions.push(quad[i][0], quad[i][1], quad[i][2]);
      uvs.push(quad[i][3], quad[i][4]);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.computeVertexNormals();
  const texture = boardTexture();
  const material = new THREE.MeshStandardMaterial({
    map: texture,
    emissive: 0xffffff,
    emissiveMap: texture,
    emissiveIntensity: 0.9,
    side: THREE.DoubleSide,
    roughness: 0.4,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'sponsor-boards';
  return mesh;
}

/** Floodlight masts at the corners and mid-sides, with glowing lamp banks. */
function masts(): THREE.Group {
  const group = new THREE.Group();
  group.name = 'floodlights';
  const back = STADIUM_HALF + BARRIER + TIERS * TIER_DEPTH + 3;
  const height = 45;
  const spots: Array<[number, number]> = [
    [back, back],
    [-back, back],
    [back, -back],
    [-back, -back],
    [back, 0],
    [-back, 0],
    [0, back],
    [0, -back],
  ];

  const poles: number[] = [];
  const poleNormals: number[] = [];
  const poleUvs: number[] = [];
  const tile = surfaceOf(PALETTE.landmark)?.tile ?? 3;
  const lamps = new THREE.Group();
  const lampMaterial = new THREE.MeshStandardMaterial({ color: 0x222222, emissive: 0xfff4dd, emissiveIntensity: 2.2 });
  // The glow round each lamp bank, as an additive halo rather than post-process
  // bloom: bloom cost ~4× the frame rate at retina resolution, a halo is a quad.
  const haloMaterial = new THREE.SpriteMaterial({
    map: softTexture(),
    color: 0xffe6c4,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    fog: false,
    opacity: 0.55,
  });
  for (const [x, z] of spots) {
    appendGeometry(poles, poleNormals, poleUvs, new THREE.CylinderGeometry(0.5, 0.8, height, 10).translate(x, height / 2, z), tile);
    // The lamp bank, tilted down toward the arena centre.
    const bank = new THREE.Mesh(new THREE.BoxGeometry(9, 4, 0.6), lampMaterial);
    bank.position.set(x, height + 1, z);
    bank.lookAt(0, 0, 0);
    lamps.add(bank);
    const halo = new THREE.Sprite(haloMaterial);
    halo.position.set(x * 0.985, height + 1, z * 0.985);
    halo.scale.setScalar(22);
    halo.renderOrder = 2;
    // Decoration only: aim and camera rays must pass straight through it (a
    // Sprite also throws when raycast without a camera set).
    halo.raycast = () => {};
    lamps.add(halo);
  }
  const poleMesh = batchMesh(poles, poleNormals, poleUvs, new THREE.MeshStandardMaterial({ color: PALETTE.landmark }), PALETTE.landmark);
  poleMesh.castShadow = true;
  group.add(poleMesh, lamps, beams(spots, height + 1));
  return group;
}

/**
 * The floodlight BEAMS: faint cones of light from each lamp bank down into the
 * arena — what a floodlit stadium looks like at night (light caught in the
 * haze). Fake volumetrics, not lights: additive cones that fade along their
 * length and toward their silhouette edges. All eight merged: one draw call,
 * no lighting cost.
 */
function beams(spots: Array<[number, number]>, lampY: number): THREE.Mesh {
  const pieces: THREE.BufferGeometry[] = [];
  const up = new THREE.Vector3(0, 1, 0);
  for (const [x, z] of spots) {
    const lamp = new THREE.Vector3(x, lampY, z);
    // Aimed at the arena floor a third of the way in from the mast.
    const target = new THREE.Vector3(x * 0.38, 0, z * 0.38);
    const axis = new THREE.Vector3().subVectors(lamp, target);
    const length = axis.length();
    // Open-ended cone, narrow at the lamp (top, uv.y = 1) and wide at the floor.
    const cone = new THREE.CylinderGeometry(3, 34, length, 28, 1, true);
    cone.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(up, axis.normalize()));
    cone.translate((lamp.x + target.x) / 2, (lamp.y + target.y) / 2, (lamp.z + target.z) / 2);
    pieces.push(cone);
  }
  const geometry = mergeGeometries(pieces)!;
  const material = new THREE.ShaderMaterial({
    uniforms: { uColour: { value: new THREE.Color(0xfff1d6) }, uStrength: { value: 0.32 } },
    vertexShader: `
      varying vec2 vUv;
      varying float vFacing;
      void main() {
        vUv = uv;
        vec4 world = modelMatrix * vec4(position, 1.0);
        vec3 n = normalize(mat3(modelMatrix) * normal);
        vec3 toCamera = normalize(cameraPosition - world.xyz);
        // 1 where the cone faces the camera, 0 at its silhouette: soft edges.
        vFacing = abs(dot(n, toCamera));
        gl_Position = projectionMatrix * viewMatrix * world;
      }`,
    fragmentShader: `
      uniform vec3 uColour;
      uniform float uStrength;
      varying vec2 vUv;
      varying float vFacing;
      void main() {
        // Brightest at the lamp, gone before the ground; soft at the edges.
        float along = pow(vUv.y, 1.1);
        float edge = pow(vFacing, 2.0);
        gl_FragColor = vec4(uColour * uStrength * along * edge, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
    blending: THREE.AdditiveBlending,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'floodlight-beams';
  mesh.renderOrder = 1;
  // Decoration: rays must pass straight through it.
  mesh.raycast = () => {};
  return mesh;
}
