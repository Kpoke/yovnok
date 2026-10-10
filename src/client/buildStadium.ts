/**
 * The stadium around the arena floor: what makes the map a televised arena
 * rather than a field of blocks.
 *
 * Purely visual and entirely OUTSIDE the barrier (`STADIUM_HALF` in
 * shared/arena.ts), so the simulation never sees it:
 *
 *   - a two-deck bowl: seat rows with aisles and tunnels, VIP glazing between
 *     the decks, an LED ribbon on the upper deck, a roof canopy on rafters;
 *   - a crowd of individual fans (one instanced draw, animated on the GPU) who
 *     cheer — standing, arms up — near kills and blasts, and start a wave now
 *     and then;
 *   - broadcast dressing: two big screens calling the eliminations, camera
 *     platforms, a sweeping camera crane, flags on the roof, fans' banners,
 *     and flame jets on the barrier that fire on a kill;
 *   - LED sponsor boards on the barrier and four corner floodlight masts.
 *
 * Merged by material: the whole stadium is a handful of draw calls.
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { STADIUM_HALF, STADIUM_WALL } from '../shared/arena';
import { PALETTE } from '../shared/config';
import { surfaceOf } from './arenaSurfaces';
import { appendGeometry, batchMesh } from './buildArena';
import { ParticlePool, softTexture } from './explosions';
import type { Dressing, WorldEvent } from './maps/themes';

/** The barrier's thickness; the stands start right behind it. */
const BARRIER = 1.5;
/** The four sides, as the outward normal of each. */
const SIDES: Array<[number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

// ---- the bowl's section, as distances from the centre and heights ----------
const FRONT = STADIUM_HALF + BARRIER;
/** Walkway between the barrier and the first row, and the front wall's top. */
const LOWER_START = FRONT + 1.2;
const LOWER_BASE = STADIUM_WALL + 0.8;
const LOWER_ROWS = 16;
const LOWER_DEPTH = 0.9;
const LOWER_RISE = 0.42;
const LOWER_END = LOWER_START + LOWER_ROWS * LOWER_DEPTH;
const LOWER_TOP = LOWER_BASE + LOWER_ROWS * LOWER_RISE;
/** The VIP band between the decks, and the upper deck above it. */
const VIP_DEPTH = 1.5;
const UPPER_START = LOWER_END + VIP_DEPTH;
/** The VIP glass line: set back from the lower deck's top row, under the upper deck. */
const GLASS = UPPER_START - 0.35;
const UPPER_BASE = LOWER_TOP + 5;
const UPPER_ROWS = 14;
const UPPER_DEPTH = 0.9;
const UPPER_RISE = 0.6;
const UPPER_END = UPPER_START + UPPER_ROWS * UPPER_DEPTH;
const BACK = UPPER_END + 0.8;
/** The roof canopy: over the upper deck and half the lower one. */
const ROOF_FRONT = LOWER_START + LOWER_ROWS * LOWER_DEPTH * 0.6;
const ROOF_Y = UPPER_BASE + UPPER_ROWS * UPPER_RISE + 5;
/** Aisles: one every this many metres along each side, this wide. */
const AISLE_EVERY = 36;
const AISLE_WIDTH = 1.4;
/** Tunnels into the lower deck (vomitories), every this many metres. */
const TUNNEL_EVERY = 72;
const TUNNEL_WIDTH = 4;
const TUNNEL_ROWS = 5;

/** Fictional sponsors only — no real brand appears in the arena. */
const SPONSORS = ['IRONHIDE TYRES', 'SCORCH FUEL', 'BULWARK ARMOUR', 'GRITLINE OIL', 'YOVNOK LIVE'];
/** What the fans paint on their banners. */
const BANNERS = ['NO MERCY', 'LAST CAR STANDING', 'YOVNOK', 'FULL THROTTLE', 'RAM IT', 'WRECK THEM ALL', 'WE RIDE', 'BURN RUBBER'];

/** A box from its centre and size, as a geometry. */
function boxAt(cx: number, cy: number, cz: number, sx: number, sy: number, sz: number): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(sx, sy, sz);
  g.translate(cx, cy, cz);
  return g;
}

/**
 * A box on one side of the bowl, written in the side's frame: `d` is distance
 * out from the centre, `along` runs along the side, `y` is height.
 */
function sideBox(
  side: [number, number],
  d0: number,
  d1: number,
  a0: number,
  a1: number,
  y0: number,
  y1: number,
): THREE.BufferGeometry {
  const [nx, nz] = side;
  const d = (d0 + d1) / 2;
  const a = (a0 + a1) / 2;
  const sd = d1 - d0;
  const sa = a1 - a0;
  // "along" is the side's right-hand axis: (-nz, nx).
  const cx = nx * d - nz * a;
  const cz = nz * d + nx * a;
  return nx !== 0 ? boxAt(cx, (y0 + y1) / 2, cz, sd, y1 - y0, sa) : boxAt(cx, (y0 + y1) / 2, cz, sa, y1 - y0, sd);
}

/** Deterministic pseudo-random numbers, so every page builds the same crowd. */
function seeded(seed: number): () => number {
  let s = seed;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

/** Is this spot along a side in an aisle (or, in the lower deck, a tunnel)? */
function inAisle(along: number): boolean {
  const m = ((along % AISLE_EVERY) + AISLE_EVERY) % AISLE_EVERY;
  return m < AISLE_WIDTH / 2 || m > AISLE_EVERY - AISLE_WIDTH / 2;
}
function inTunnel(along: number, row: number): boolean {
  if (row >= TUNNEL_ROWS) return false;
  const m = (((along + TUNNEL_EVERY / 2) % TUNNEL_EVERY) + TUNNEL_EVERY) % TUNNEL_EVERY;
  return Math.abs(m - TUNNEL_EVERY / 2) < TUNNEL_WIDTH / 2 + 0.3;
}

// ============================================================================

export function buildStadium(): Dressing {
  const group = new THREE.Group();
  group.name = 'stadium';
  const crowdRig = crowd();
  const screens = bigScreens();
  const ribbon = ledRibbon();
  const jets = flameJets();
  const crane = cameraCrane();
  const flagRig = flags();
  group.add(
    concrete(),
    roof(),
    seats(),
    glazing(),
    crowdRig.mesh,
    screens.object,
    ribbon.mesh,
    boards(),
    banners(),
    cameraPlatforms(),
    crane.object,
    flagRig.mesh,
    jets.object,
    masts(),
  );

  let elapsed = 0;
  return {
    objects: [group],
    update(dt) {
      elapsed += dt;
      crowdRig.update(elapsed);
      screens.update(dt);
      ribbon.update(dt);
      jets.update(dt);
      crane.update(elapsed);
      flagRig.update(elapsed);
    },
    react(event) {
      crowdRig.react(event, elapsed);
      if (event.kind === 'kill') {
        jets.fire(event.x, event.z);
        screens.show(event.label ? `${event.label} IS OUT` : 'ELIMINATED');
      }
    },
  };
}

// ---------------------------------------------------------------- structure

/**
 * The concrete: every row's tread and riser, the front walls, the VIP floor,
 * the back wall and the aisles' steps. One mesh, the arena's wall concrete.
 */
function concrete(): THREE.Mesh {
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const tile = surfaceOf(PALETTE.wall)?.tile ?? 5;
  const add = (g: THREE.BufferGeometry): void => appendGeometry(positions, normals, uvs, g, tile);
  for (const side of SIDES) {
    // Each side runs past the corners so the four meet as one bowl.
    const reach = BACK + 1;
    // Front wall behind the walkway.
    add(sideBox(side, FRONT, LOWER_START, -reach, reach, 0, LOWER_BASE - 0.6));
    add(sideBox(side, LOWER_START - 0.25, LOWER_START, -reach, reach, LOWER_BASE - 0.6, LOWER_BASE + 0.4));
    for (let r = 0; r < LOWER_ROWS; r++) {
      const d0 = LOWER_START + r * LOWER_DEPTH;
      add(sideBox(side, d0, BACK, -reach, reach, 0, LOWER_BASE + (r + 1) * LOWER_RISE));
    }
    // The VIP floor and the upper deck.
    add(sideBox(side, GLASS + 0.05, BACK, -reach, reach, LOWER_TOP, UPPER_BASE));
    for (let r = 0; r < UPPER_ROWS; r++) {
      const d0 = UPPER_START + r * UPPER_DEPTH;
      add(sideBox(side, d0, BACK, -reach, reach, UPPER_BASE, UPPER_BASE + (r + 1) * UPPER_RISE));
    }
    // The back wall, up to the roof: nothing outside shows through.
    add(sideBox(side, BACK - 0.6, BACK + 0.6, -reach - 1, reach + 1, 0, ROOF_Y + 0.6));
    // Aisle steps: a lighter, half-row step up the middle of each aisle.
    for (let a = -Math.floor(reach / AISLE_EVERY) * AISLE_EVERY; a <= reach; a += AISLE_EVERY) {
      for (let r = 0; r < LOWER_ROWS; r++) {
        if (inTunnel(a, r)) continue;
        const d0 = LOWER_START + r * LOWER_DEPTH;
        const y = LOWER_BASE + (r + 1) * LOWER_RISE;
        add(sideBox(side, d0, d0 + LOWER_DEPTH / 2, a - AISLE_WIDTH / 2, a + AISLE_WIDTH / 2, y, y + LOWER_RISE / 2));
      }
      for (let r = 0; r < UPPER_ROWS; r++) {
        const d0 = UPPER_START + r * UPPER_DEPTH;
        const y = UPPER_BASE + (r + 1) * UPPER_RISE;
        add(sideBox(side, d0, d0 + UPPER_DEPTH / 2, a - AISLE_WIDTH / 2, a + AISLE_WIDTH / 2, y, y + UPPER_RISE / 2));
      }
    }
  }
  const material = new THREE.MeshStandardMaterial({ color: PALETTE.wall, roughness: 0.9 });
  const mesh = batchMesh(positions, normals, uvs, material, PALETTE.wall);
  mesh.receiveShadow = true;
  mesh.name = 'stands';

  // Tunnel mouths: dark openings in the front of the lower deck.
  const tunnelGeometry: THREE.BufferGeometry[] = [];
  for (const side of SIDES) {
    for (let a = -BACK + TUNNEL_EVERY / 2; a < BACK; a += TUNNEL_EVERY) {
      const top = LOWER_BASE + TUNNEL_ROWS * LOWER_RISE;
      tunnelGeometry.push(
        sideBox(side, LOWER_START - 0.02, LOWER_START + TUNNEL_ROWS * LOWER_DEPTH, a - TUNNEL_WIDTH / 2, a + TUNNEL_WIDTH / 2, LOWER_BASE - 2.4, top + 0.05),
      );
    }
  }
  const tunnels = new THREE.Mesh(mergeGeometries(tunnelGeometry)!, new THREE.MeshBasicMaterial({ color: 0x050608 }));
  tunnels.name = 'tunnels';
  mesh.add(tunnels);
  return mesh;
}

/** The roof canopy: a steel slab on rafters, with a light strip along its edge. */
function roof(): THREE.Group {
  const group = new THREE.Group();
  group.name = 'roof';
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const tile = surfaceOf(PALETTE.ramp)?.tile ?? 3;
  const add = (g: THREE.BufferGeometry): void => appendGeometry(positions, normals, uvs, g, tile);
  const strip: THREE.BufferGeometry[] = [];
  for (const side of SIDES) {
    const reach = BACK + 1;
    add(sideBox(side, ROOF_FRONT, BACK + 0.6, -reach, reach, ROOF_Y, ROOF_Y + 0.5));
    // Rafters under the slab, and the deep front beam.
    for (let a = -reach + 8; a < reach; a += 16) {
      add(sideBox(side, ROOF_FRONT, BACK, a - 0.3, a + 0.3, ROOF_Y - 1.4, ROOF_Y));
    }
    add(sideBox(side, ROOF_FRONT, ROOF_FRONT + 1, -reach, reach, ROOF_Y - 1.8, ROOF_Y + 0.5));
    // Back columns.
    for (let a = -reach + 16; a < reach; a += 32) add(sideBox(side, BACK + 0.6, BACK + 1.6, a - 0.6, a + 0.6, 0, ROOF_Y + 0.5));
    strip.push(sideBox(side, ROOF_FRONT + 0.2, ROOF_FRONT + 0.9, -reach, reach, ROOF_Y - 1.95, ROOF_Y - 1.8));
  }
  const material = new THREE.MeshStandardMaterial({ color: PALETTE.ramp, roughness: 0.6, metalness: 0.5 });
  const steel = batchMesh(positions, normals, uvs, material, PALETTE.ramp);
  steel.castShadow = false;
  steel.receiveShadow = true;
  // The light strip under the canopy's edge: lights the upper rows from above.
  const lights = new THREE.Mesh(
    mergeGeometries(strip)!,
    new THREE.MeshStandardMaterial({ color: 0x111111, emissive: 0xfff2dc, emissiveIntensity: 1.6 }),
  );
  group.add(steel, lights);
  return group;
}

/** Seat backs along every row: plastic in deck colours, in a repeating seat shape. */
function seatTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, 64, 64);
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.roundRect(6, 4, 52, 56, 10);
  ctx.fill();
  ctx.fillStyle = 'rgba(0,0,0,0.25)';
  ctx.fillRect(6, 44, 52, 16);
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function seats(): THREE.Mesh {
  const positions: number[] = [];
  const uvs: number[] = [];
  const colours: number[] = [];
  const colour = new THREE.Color();
  const SEAT = 0.55;
  const row = (side: [number, number], d: number, y: number, height: number, deckColour: (a: number) => number): void => {
    const [nx, nz] = side;
    const reach = BACK;
    // In aisle-sized pieces, so each section can take its own colour.
    for (let a0 = -reach; a0 < reach; a0 += AISLE_EVERY / 2) {
      const a1 = Math.min(reach, a0 + AISLE_EVERY / 2);
      const p = (a: number, h: number): number[] => [nx * d - nz * a, y + h, nz * d + nx * a];
      const quad = [p(a0, 0), p(a1, 0), p(a1, height), p(a0, height)];
      const u0 = a0 / SEAT;
      const u1 = a1 / SEAT;
      const uv = [
        [u0, 0],
        [u1, 0],
        [u1, 1],
        [u0, 1],
      ];
      colour.setHex(deckColour((a0 + a1) / 2));
      for (const i of [0, 1, 2, 0, 2, 3]) {
        positions.push(...quad[i]);
        uvs.push(uv[i][0], uv[i][1]);
        colours.push(colour.r, colour.g, colour.b);
      }
    }
  };
  // Lower deck: charcoal, every other section the broadcast orange. Upper: steel blue.
  const lower = (a: number): number => (Math.floor((a + 1000) / (AISLE_EVERY / 2)) % 4 === 1 ? 0xd2622a : 0x2b2f36);
  const upper = (): number => 0x2a3c55;
  for (const side of SIDES) {
    for (let r = 0; r < LOWER_ROWS; r++) {
      row(side, LOWER_START + (r + 1) * LOWER_DEPTH - 0.08, LOWER_BASE + (r + 1) * LOWER_RISE, 0.5, lower);
    }
    for (let r = 0; r < UPPER_ROWS; r++) {
      row(side, UPPER_START + (r + 1) * UPPER_DEPTH - 0.08, UPPER_BASE + (r + 1) * UPPER_RISE, 0.5, upper);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colours, 3));
  geometry.computeVertexNormals();
  const mesh = new THREE.Mesh(
    geometry,
    new THREE.MeshStandardMaterial({ map: seatTexture(), vertexColors: true, alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.55 }),
  );
  mesh.name = 'seats';
  return mesh;
}

/** The VIP boxes between the decks: a band of lit glass, and the deck's fascia. */
function glazing(): THREE.Group {
  const group = new THREE.Group();
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 64;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#0d1116';
  ctx.fillRect(0, 0, 256, 64);
  const rand = seeded(11);
  for (let i = 0; i < 8; i++) {
    // Each box's window: warm, a few dimmer, mullions between.
    const warm = 150 + Math.floor(rand() * 80);
    ctx.fillStyle = `rgb(${warm}, ${Math.floor(warm * 0.78)}, ${Math.floor(warm * 0.52)})`;
    ctx.fillRect(i * 32 + 2, 6, 28, 50);
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.fillRect(i * 32 + 15, 6, 2, 50);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;

  const positions: number[] = [];
  const uvs: number[] = [];
  const y0 = LOWER_TOP + 0.3;
  const y1 = UPPER_BASE - 1.3;
  for (const [nx, nz] of SIDES) {
    const d = GLASS;
    const reach = BACK;
    const p = (a: number, y: number): number[] => [nx * d - nz * a, y, nz * d + nx * a];
    const quad = [p(-reach, y0), p(reach, y0), p(reach, y1), p(-reach, y1)];
    const len = (2 * reach) / 32;
    const uv = [
      [0, 0],
      [len, 0],
      [len, 1],
      [0, 1],
    ];
    for (const i of [0, 1, 2, 0, 2, 3]) {
      positions.push(...quad[i]);
      uvs.push(uv[i][0], uv[i][1]);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.computeVertexNormals();
  const glass = new THREE.Mesh(
    geometry,
    new THREE.MeshStandardMaterial({
      map: texture,
      emissive: 0xffffff,
      emissiveMap: texture,
      emissiveIntensity: 0.55,
      roughness: 0.15,
      metalness: 0.3,
      side: THREE.DoubleSide,
    }),
  );
  glass.name = 'vip-glazing';
  group.add(glass);
  return group;
}

// -------------------------------------------------------------------- crowd

/** Fan billboards: each is three people side by side. */
const CROWD_COLUMNS = 8;
const CROWD_ROWS = 4;
const CROWD_VARIANTS = 16;
const GROUP_WIDTH = 1.65;
const GROUP_HEIGHT = 1.3;

/**
 * The fans, drawn: 16 groups of three, each seated (calm) and standing with
 * arms up (cheering). Figures are white-lit by the floodlights.
 */
function crowdAtlas(): THREE.CanvasTexture {
  const fw = 160;
  const fh = 128;
  const canvas = document.createElement('canvas');
  canvas.width = fw * CROWD_COLUMNS;
  canvas.height = fh * CROWD_ROWS;
  const ctx = canvas.getContext('2d')!;
  const shirts = ['#c0392b', '#e67e22', '#f1c40f', '#ecf0f1', '#2c3e50', '#16a085', '#8e44ad', '#d35400', '#7f8c8d', '#2980b9', '#ff8a3d', '#1b1d22'];
  const skin = ['#f1c27d', '#e0ac69', '#c68642', '#8d5524', '#ffdbac', '#6b4423'];
  const hair = ['#1b1410', '#3b2a1e', '#6b4a2b', '#a87b4f', '#d8c08a', '#111111'];
  const rand = seeded(23);
  const people = Array.from({ length: CROWD_VARIANTS * 3 }, () => ({
    shirt: shirts[Math.floor(rand() * shirts.length)],
    skin: skin[Math.floor(rand() * skin.length)],
    hair: hair[Math.floor(rand() * hair.length)],
    width: 32 + rand() * 10,
    height: 0.85 + rand() * 0.2,
    scarf: rand() < 0.2,
    cap: rand() < 0.2,
  }));

  for (let frame = 0; frame < CROWD_VARIANTS * 2; frame++) {
    const variant = frame % CROWD_VARIANTS;
    const cheer = frame >= CROWD_VARIANTS;
    const col = frame % CROWD_COLUMNS;
    const row = Math.floor(frame / CROWD_COLUMNS);
    // Canvas y runs down; texture v runs up (flipY), so row 0 is at the bottom.
    const ox = col * fw;
    const oy = (CROWD_ROWS - 1 - row) * fh;
    for (let k = 0; k < 3; k++) {
      const p = people[variant * 3 + k];
      const cx = ox + 27 + k * 53 + (rand() - 0.5) * 6;
      const base = oy + fh - 2;
      // Seated: shoulders low. Standing: the whole figure up.
      const torso = (cheer ? 72 : 52) * p.height;
      const top = base - torso;
      ctx.fillStyle = p.shirt;
      ctx.beginPath();
      ctx.roundRect(cx - p.width / 2, top, p.width, torso, 9);
      ctx.fill();
      // Arms: up and waving when cheering, at the sides when not.
      ctx.strokeStyle = p.shirt;
      ctx.lineWidth = 7;
      ctx.lineCap = 'round';
      if (cheer) {
        ctx.beginPath();
        ctx.moveTo(cx - p.width / 2 + 4, top + 8);
        ctx.lineTo(cx - p.width / 2 - 6, top - 30);
        ctx.moveTo(cx + p.width / 2 - 4, top + 8);
        ctx.lineTo(cx + p.width / 2 + 6, top - 30);
        ctx.stroke();
        ctx.fillStyle = p.skin;
        ctx.beginPath();
        ctx.arc(cx - p.width / 2 - 6, top - 32, 4.5, 0, Math.PI * 2);
        ctx.arc(cx + p.width / 2 + 6, top - 32, 4.5, 0, Math.PI * 2);
        ctx.fill();
      }
      if (p.scarf) {
        ctx.fillStyle = '#ff8a3d';
        ctx.fillRect(cx - p.width / 2 - (cheer ? 8 : 0), cheer ? top - 30 : top + 4, p.width + (cheer ? 16 : 0), 7);
      }
      // Head.
      ctx.fillStyle = p.skin;
      ctx.beginPath();
      ctx.arc(cx, top - 12, 11, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = p.cap ? p.shirt : p.hair;
      ctx.beginPath();
      ctx.arc(cx, top - 15, 11, Math.PI, Math.PI * 2);
      ctx.fill();
    }
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.generateMipmaps = true;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.anisotropy = 4;
  return texture;
}

/** How many recent events the crowd reacts to at once. */
const EVENT_SLOTS = 4;

function crowd(): {
  mesh: THREE.Mesh;
  update: (t: number) => void;
  react: (event: WorldEvent, t: number) => void;
} {
  const origins: number[] = [];
  const dirs: number[] = [];
  const variants: number[] = [];
  const phases: number[] = [];
  const rand = seeded(5);
  const place = (side: [number, number], d: number, y: number, fill: number, row: number, lower: boolean): void => {
    const [nx, nz] = side;
    // Each side's crowd stops where the next side's begins (the corners).
    const reach = d;
    for (let a = -reach + GROUP_WIDTH / 2; a < reach - GROUP_WIDTH / 2; a += GROUP_WIDTH) {
      if (inAisle(a) || (lower && inTunnel(a, row))) continue;
      // Emptier toward the corners and the back.
      const corner = Math.abs(a) / reach;
      if (rand() > fill * (1 - 0.35 * corner * corner)) continue;
      origins.push(nx * d - nz * a, y, nz * d + nx * a);
      dirs.push(-nx, -nz);
      variants.push(Math.floor(rand() * CROWD_VARIANTS));
      phases.push(rand() * 100);
    }
  };
  for (const side of SIDES) {
    for (let r = 0; r < LOWER_ROWS; r++) {
      place(side, LOWER_START + r * LOWER_DEPTH + 0.5, LOWER_BASE + (r + 1) * LOWER_RISE, 0.88, r, true);
    }
    for (let r = 0; r < UPPER_ROWS; r++) {
      place(side, UPPER_START + r * UPPER_DEPTH + 0.5, UPPER_BASE + (r + 1) * UPPER_RISE, 0.7 - r * 0.012, r, false);
    }
  }

  const geometry = new THREE.InstancedBufferGeometry();
  geometry.setAttribute(
    'position',
    new THREE.Float32BufferAttribute(
      [-GROUP_WIDTH / 2, 0, 0, GROUP_WIDTH / 2, 0, 0, GROUP_WIDTH / 2, GROUP_HEIGHT, 0, -GROUP_WIDTH / 2, GROUP_HEIGHT, 0],
      3,
    ),
  );
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  geometry.setAttribute('aOrigin', new THREE.InstancedBufferAttribute(new Float32Array(origins), 3));
  geometry.setAttribute('aDir', new THREE.InstancedBufferAttribute(new Float32Array(dirs), 2));
  geometry.setAttribute('aVariant', new THREE.InstancedBufferAttribute(new Float32Array(variants), 1));
  geometry.setAttribute('aPhase', new THREE.InstancedBufferAttribute(new Float32Array(phases), 1));
  geometry.instanceCount = variants.length;

  const events = Array.from({ length: EVENT_SLOTS }, () => new THREE.Vector4(0, 0, -100, 0));
  const uniforms = {
    ...THREE.UniformsLib.fog,
    uAtlas: { value: crowdAtlas() },
    uTime: { value: 0 },
    uEvents: { value: events },
    uWave: { value: -100 },
    uLight: { value: 0.7 },
  };
  const material = new THREE.ShaderMaterial({
    uniforms,
    fog: true,
    side: THREE.DoubleSide,
    vertexShader: /* glsl */ `
      attribute vec3 aOrigin;
      attribute vec2 aDir;
      attribute float aVariant;
      attribute float aPhase;
      uniform float uTime;
      uniform vec4 uEvents[${EVENT_SLOTS}];
      uniform float uWave;
      varying vec2 vUv;
      #include <fog_pars_vertex>
      void main() {
        // How worked up this part of the crowd is: recent kills and blasts,
        // strongest nearest them, fading over a few seconds.
        float excite = 0.0;
        for (int i = 0; i < ${EVENT_SLOTS}; i++) {
          vec4 e = uEvents[i];
          float age = uTime - e.z;
          if (age >= 0.0 && age < 7.0) {
            float d = distance(aOrigin.xz, e.xy);
            excite += e.w * exp(-age * 0.55) * (0.3 + 0.7 * exp(-d / 150.0));
          }
        }
        // The wave: a narrow band of standing fans running round the bowl.
        float angle = atan(aOrigin.z, aOrigin.x);
        float off = mod(angle - uWave + 3.14159, 6.28318) - 3.14159;
        float wave = uWave > -50.0 ? exp(-off * off * 60.0) : 0.0;
        float own = fract(sin(aPhase * 12.9898) * 43758.5453);
        float cheer = step(0.6, (excite * (0.4 + own) + wave * 1.4));
        float bob = sin(uTime * (1.5 + own * 2.0) + aPhase) * 0.02
          + cheer * abs(sin(uTime * (6.0 + own * 3.0) + aPhase * 3.0)) * 0.25;
        float frame = aVariant + cheer * ${CROWD_VARIANTS}.0;
        vec2 cell = vec2(mod(frame, ${CROWD_COLUMNS}.0), floor(frame / ${CROWD_COLUMNS}.0));
        vUv = (cell + uv) / vec2(${CROWD_COLUMNS}.0, ${CROWD_ROWS}.0);
        // Billboard along the stand, facing the arena.
        vec3 along = vec3(-aDir.y, 0.0, aDir.x);
        vec3 world = aOrigin + along * position.x + vec3(0.0, position.y + bob, 0.0);
        vec4 mvPosition = viewMatrix * vec4(world, 1.0);
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }`,
    fragmentShader: /* glsl */ `
      uniform sampler2D uAtlas;
      uniform float uLight;
      varying vec2 vUv;
      #include <fog_pars_fragment>
      void main() {
        vec4 texel = texture2D(uAtlas, vUv);
        if (texel.a < 0.5) discard;
        gl_FragColor = vec4(texel.rgb * uLight, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
        #include <fog_fragment>
      }`,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  mesh.name = 'crowd';
  mesh.raycast = () => {};

  let next = 0;
  let waveStart = -100;
  let nextWave = 25 + Math.random() * 30;
  return {
    mesh,
    update(t) {
      uniforms.uTime.value = t;
      // Now and then a wave starts somewhere and runs once round the bowl.
      if (t > nextWave) {
        waveStart = t;
        nextWave = t + 50 + Math.random() * 60;
      }
      const age = t - waveStart;
      uniforms.uWave.value = age < 14 ? -Math.PI + (age / 14) * Math.PI * 2 + 0.5 : -100;
    },
    react(event, t) {
      events[next].set(event.x, event.z, t, event.kind === 'kill' ? 1.4 : 0.6);
      next = (next + 1) % EVENT_SLOTS;
    },
  };
}

// ---------------------------------------------------------------- broadcast

/** The two big screens over opposite corners: LIVE, and who just went out. */
function bigScreens(): { object: THREE.Group; update: (dt: number) => void; show: (text: string) => void } {
  const group = new THREE.Group();
  group.name = 'big-screens';
  const canvas = document.createElement('canvas');
  canvas.width = 768;
  canvas.height = 400;
  const ctx = canvas.getContext('2d')!;
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const idle = ['LAST CAR STANDING', 'YOVNOK LIVE', ...SPONSORS.slice(0, 4)];
  let idleIndex = 0;
  let idleFor = 0;
  let message: string | null = null;
  let messageFor = 0;

  const draw = (headline: string, alert: boolean): void => {
    ctx.fillStyle = alert ? '#2a0b06' : '#07090d';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    // Scanlines, for an LED panel.
    ctx.fillStyle = 'rgba(255,255,255,0.03)';
    for (let y = 0; y < canvas.height; y += 4) ctx.fillRect(0, y, canvas.width, 1);
    ctx.fillStyle = '#ff3b30';
    ctx.beginPath();
    ctx.arc(46, 46, 12, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 34px sans-serif';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillText('LIVE', 70, 48);
    ctx.fillStyle = '#ff8a3d';
    ctx.textAlign = 'right';
    ctx.fillText('YOVNOK', canvas.width - 30, 48);
    ctx.textAlign = 'center';
    ctx.fillStyle = alert ? '#ffb38a' : '#ffffff';
    ctx.font = `bold ${alert ? 66 : 58}px sans-serif`;
    ctx.fillText(headline, canvas.width / 2, canvas.height / 2 + 30, canvas.width - 60);
    texture.needsUpdate = true;
  };
  draw(idle[0], false);

  const screen = new THREE.MeshStandardMaterial({ map: texture, emissive: 0xffffff, emissiveMap: texture, emissiveIntensity: 1.3, color: 0x000000 });
  const frame = new THREE.MeshStandardMaterial({ color: 0x1a1d22, roughness: 0.6, metalness: 0.4 });
  for (const [sx, sz] of [
    [1, 1],
    [-1, -1],
  ]) {
    const unit = new THREE.Group();
    const width = 36;
    const height = 19;
    const back = new THREE.Mesh(new THREE.BoxGeometry(width + 1.2, height + 1.2, 1), frame);
    const face = new THREE.Mesh(new THREE.PlaneGeometry(width, height), screen);
    face.position.z = 0.51;
    unit.add(back, face);
    // Hung from the roof over the corner, angled down at the floor.
    const d = LOWER_START + 3;
    unit.position.set(sx * d, ROOF_Y - 12.5, sz * d);
    unit.lookAt(0, 4, 0);
    group.add(unit);
  }
  return {
    object: group,
    update(dt) {
      if (message) {
        messageFor -= dt;
        if (messageFor <= 0) {
          message = null;
          draw(idle[idleIndex], false);
        }
        return;
      }
      idleFor += dt;
      if (idleFor > 6) {
        idleFor = 0;
        idleIndex = (idleIndex + 1) % idle.length;
        draw(idle[idleIndex], false);
      }
    },
    show(text) {
      message = text;
      messageFor = 4;
      draw(text, true);
    },
  };
}

/** The LED ribbon along the upper deck's front: sponsors, scrolling. */
function ledRibbon(): { mesh: THREE.Mesh; update: (dt: number) => void } {
  const texture = sponsorTexture('#05070a', 40);
  const positions: number[] = [];
  const uvs: number[] = [];
  const y0 = UPPER_BASE - 1.25;
  const y1 = UPPER_BASE - 0.15;
  for (const [nx, nz] of SIDES) {
    const d = GLASS - 0.02;
    const reach = BACK;
    const [rx, rz] = [-nz, nx];
    const a = [nx * d - rx * reach, nz * d - rz * reach];
    const b = [nx * d + rx * reach, nz * d + rz * reach];
    const len = (2 * reach) / 40;
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
  const mesh = new THREE.Mesh(
    geometry,
    new THREE.MeshStandardMaterial({ map: texture, emissive: 0xffffff, emissiveMap: texture, emissiveIntensity: 1.0, color: 0x000000, side: THREE.DoubleSide }),
  );
  mesh.name = 'led-ribbon';
  return {
    mesh,
    update(dt) {
      texture.offset.x = (texture.offset.x + dt * 0.04) % 1;
    },
  };
}

/** A strip of sponsor panels: the barrier boards and the LED ribbon. */
function sponsorTexture(background: string | null, fontSize = 54): THREE.CanvasTexture {
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
    ctx.fillStyle = background ?? bg;
    ctx.fillRect(i * panel, 0, panel, canvas.height);
    ctx.fillStyle = background ? colours[i % colours.length][1] === '#0b0d12' ? '#ff6a2b' : colours[i % colours.length][1] : fg;
    ctx.font = `bold ${fontSize}px sans-serif`;
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

/** The LED advertising boards on the inside face of the barrier. */
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
  const texture = sponsorTexture(null);
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

/** Fans' banners hanging over the VIP glass: painted cloth, slogans. */
function banners(): THREE.Mesh {
  const W = 512;
  const H = 128;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H * BANNERS.length;
  const ctx = canvas.getContext('2d')!;
  const palettes = [
    ['#ff8a3d', '#0b0d12'],
    ['#0b0d12', '#ffffff'],
    ['#f2f2ee', '#c0392b'],
    ['#1b2a3a', '#f2c94c'],
  ];
  BANNERS.forEach((text, i) => {
    const [bg, fg] = palettes[i % palettes.length];
    ctx.fillStyle = bg;
    ctx.fillRect(0, i * H, W, H);
    ctx.strokeStyle = fg;
    ctx.lineWidth = 6;
    ctx.strokeRect(10, i * H + 10, W - 20, H - 20);
    ctx.fillStyle = fg;
    ctx.font = 'bold italic 60px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, W / 2, i * H + H / 2 + 3, W - 50);
  });
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;

  const positions: number[] = [];
  const uvs: number[] = [];
  const rand = seeded(31);
  const top = UPPER_BASE - 1.3;
  for (const [nx, nz] of SIDES) {
    const d = GLASS - 0.1;
    for (let a = -190; a <= 190; a += 47.5) {
      if (rand() < 0.25) continue;
      const which = Math.floor(rand() * BANNERS.length);
      const width = 9 + rand() * 3;
      const height = width / 4;
      const p = (u: number, y: number): number[] => [nx * d - nz * (a + u), y, nz * d + nx * (a + u)];
      // Hung slightly crooked, as fans hang them.
      const sag = (rand() - 0.5) * 0.6;
      const quad = [p(-width / 2, top - height + sag), p(width / 2, top - height - sag), p(width / 2, top), p(-width / 2, top)];
      // "along" runs left to right as seen from the arena, so u does too.
      const v0 = 1 - (which + 1) / BANNERS.length;
      const v1 = 1 - which / BANNERS.length;
      const uv = [
        [0, v0],
        [1, v0],
        [1, v1],
        [0, v1],
      ];
      for (const i of [0, 1, 2, 0, 2, 3]) {
        positions.push(...quad[i]);
        uvs.push(uv[i][0], uv[i][1]);
      }
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.computeVertexNormals();
  const mesh = new THREE.Mesh(
    geometry,
    new THREE.MeshStandardMaterial({ map: texture, side: THREE.DoubleSide, roughness: 0.95, emissive: 0xffffff, emissiveMap: texture, emissiveIntensity: 0.2 }),
  );
  mesh.name = 'banners';
  return mesh;
}

/** TV camera platforms on the barrier at the middle of each side. */
function cameraPlatforms(): THREE.Mesh {
  const pieces: THREE.BufferGeometry[] = [];
  for (const side of SIDES) {
    for (const a of [-70, 70]) {
      // Deck, rail, tripod and camera body, all facing the arena.
      pieces.push(sideBox(side, STADIUM_HALF - 0.4, FRONT + 1, a - 1.6, a + 1.6, STADIUM_WALL, STADIUM_WALL + 0.25));
      pieces.push(sideBox(side, FRONT + 0.8, FRONT + 1, a - 1.6, a + 1.6, STADIUM_WALL + 0.25, STADIUM_WALL + 1.2));
      pieces.push(sideBox(side, STADIUM_HALF + 0.6, STADIUM_HALF + 0.8, a - 0.1, a + 0.1, STADIUM_WALL + 0.25, STADIUM_WALL + 1.5));
      pieces.push(sideBox(side, STADIUM_HALF + 0.1, STADIUM_HALF + 1.0, a - 0.3, a + 0.3, STADIUM_WALL + 1.5, STADIUM_WALL + 2.0));
      pieces.push(sideBox(side, STADIUM_HALF - 0.25, STADIUM_HALF + 0.1, a - 0.18, a + 0.18, STADIUM_WALL + 1.6, STADIUM_WALL + 1.9));
    }
  }
  const mesh = new THREE.Mesh(mergeGeometries(pieces)!, new THREE.MeshStandardMaterial({ color: 0x1c1f24, roughness: 0.5, metalness: 0.6 }));
  mesh.name = 'camera-platforms';
  mesh.castShadow = true;
  return mesh;
}

/** A camera crane on one corner, its arm sweeping slowly over the floor. */
function cameraCrane(): { object: THREE.Group; update: (t: number) => void } {
  const material = new THREE.MeshStandardMaterial({ color: 0x24282e, roughness: 0.45, metalness: 0.7 });
  const object = new THREE.Group();
  object.name = 'camera-crane';
  const c = STADIUM_HALF - 4;
  object.position.set(-c, 0, c);
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.6, 9, 10), material);
  mast.position.y = 4.5;
  const pivot = new THREE.Group();
  pivot.position.y = 9;
  const arm = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.4, 16), material);
  arm.position.z = -5;
  const counter = new THREE.Mesh(new THREE.BoxGeometry(1.2, 1.2, 1.2), material);
  counter.position.z = 3.6;
  const head = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.6, 1.0), material);
  head.position.set(0, -0.5, -13);
  const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.12, 8, 6), new THREE.MeshBasicMaterial({ color: 0xff2a2a }));
  lamp.position.set(0, -0.1, -13.4);
  pivot.add(arm, counter, head, lamp);
  object.add(mast, pivot);
  for (const o of [mast, arm, counter, head]) o.castShadow = true;
  return {
    object,
    update(t) {
      pivot.rotation.y = -Math.PI * 0.75 + Math.sin(t * 0.17) * 0.7;
      pivot.rotation.x = -0.12 + Math.sin(t * 0.11) * 0.08;
    },
  };
}

/** Flags on poles along the roof's edge, waving (in the vertex shader). */
function flags(): { mesh: THREE.Mesh; update: (t: number) => void } {
  const positions: number[] = [];
  const weights: number[] = [];
  const colours: number[] = [];
  const phases: number[] = [];
  const colour = new THREE.Color();
  const palette = [0xff8a3d, 0xf2f2ee, 0x1b1d22, 0xc0392b, 0x2a3c55];
  const rand = seeded(41);
  const segments = 6;
  const poles: THREE.BufferGeometry[] = [];
  for (const [nx, nz] of SIDES) {
    const d = ROOF_FRONT + 0.6;
    for (let a = -BACK + 20; a < BACK - 10; a += 30) {
      const x = nx * d - nz * a;
      const z = nz * d + nx * a;
      const y = ROOF_Y + 0.5;
      poles.push(boxAt(x, y + 2.5, z, 0.12, 5, 0.12));
      colour.setHex(palette[Math.floor(rand() * palette.length)]);
      const phase = rand() * 10;
      // The flag flies along the side, from the pole.
      for (let s = 0; s < segments; s++) {
        const u0 = (s / segments) * 3.2;
        const u1 = ((s + 1) / segments) * 3.2;
        const p = (u: number, v: number): number[] => [x - nz * u, y + 2.8 + v, z + nx * u];
        const quad = [p(u0, 0), p(u1, 0), p(u1, 2), p(u0, 2)];
        const w = [u0, u1, u1, u0];
        for (const i of [0, 1, 2, 0, 2, 3]) {
          positions.push(...quad[i]);
          weights.push(w[i] / 3.2);
          colours.push(colour.r, colour.g, colour.b);
          phases.push(phase);
        }
      }
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('aWeight', new THREE.Float32BufferAttribute(weights, 1));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colours, 3));
  geometry.setAttribute('aPhase', new THREE.Float32BufferAttribute(phases, 1));
  const uniforms = { ...THREE.UniformsLib.fog, uTime: { value: 0 } };
  const material = new THREE.ShaderMaterial({
    uniforms,
    fog: true,
    vertexColors: true,
    side: THREE.DoubleSide,
    vertexShader: /* glsl */ `
      attribute float aWeight;
      attribute float aPhase;
      uniform float uTime;
      varying vec3 vColour;
      varying float vShade;
      #include <fog_pars_vertex>
      void main() {
        float wave = sin(uTime * 4.0 + aWeight * 5.0 + aPhase) * 0.35 * aWeight;
        vec3 p = position + vec3(wave, 0.0, wave);
        vColour = color;
        vShade = 0.75 + 0.25 * cos(uTime * 4.0 + aWeight * 5.0 + aPhase);
        vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }`,
    fragmentShader: /* glsl */ `
      varying vec3 vColour;
      varying float vShade;
      #include <fog_pars_fragment>
      void main() {
        gl_FragColor = vec4(vColour * vShade * 0.8, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
        #include <fog_fragment>
      }`,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'flags';
  mesh.frustumCulled = false;
  mesh.add(new THREE.Mesh(mergeGeometries(poles)!, new THREE.MeshStandardMaterial({ color: 0x9aa0a8, metalness: 0.8, roughness: 0.3 })));
  return {
    mesh,
    update(t) {
      uniforms.uTime.value = t;
    },
  };
}

/**
 * Flame jets along the top of the barrier. A kill fires the four nearest it:
 * a roaring column for a second and a half.
 */
function flameJets(): { object: THREE.Group; update: (dt: number) => void; fire: (x: number, z: number) => void } {
  const object = new THREE.Group();
  object.name = 'flame-jets';
  const nozzles: Array<{ x: number; y: number; z: number; burning: number }> = [];
  const nozzleGeometry: THREE.BufferGeometry[] = [];
  for (const [nx, nz] of SIDES) {
    for (const a of [-180, -110, -40, 40, 110, 180]) {
      const d = STADIUM_HALF + 0.75;
      const x = nx * d - nz * a;
      const z = nz * d + nx * a;
      nozzles.push({ x, y: STADIUM_WALL + 0.5, z, burning: 0 });
      nozzleGeometry.push(boxAt(x, STADIUM_WALL + 0.25, z, 0.7, 0.5, 0.7));
    }
  }
  object.add(new THREE.Mesh(mergeGeometries(nozzleGeometry)!, new THREE.MeshStandardMaterial({ color: 0x2a2c30, metalness: 0.8, roughness: 0.4 })));
  const fire = new ParticlePool(360, softTexture(), THREE.AdditiveBlending, 3);
  fire.mesh.name = 'flame-jets-fire';
  object.add(fire.mesh);
  let carry = 0;
  return {
    object,
    update(dt) {
      carry += dt * 70;
      const emit = Math.floor(carry);
      carry -= emit;
      for (const n of nozzles) {
        if (n.burning <= 0) continue;
        n.burning -= dt;
        for (let i = 0; i < emit; i++) {
          fire.spawn((p) => {
            p.x = n.x + (Math.random() - 0.5) * 0.4;
            p.y = n.y;
            p.z = n.z + (Math.random() - 0.5) * 0.4;
            p.vx = (Math.random() - 0.5) * 1.2;
            p.vy = 15 + Math.random() * 5;
            p.vz = (Math.random() - 0.5) * 1.2;
            p.life = p.maxLife = 0.55 + Math.random() * 0.25;
            p.size0 = 1.1;
            p.size1 = 2.8;
            p.drag = 1.2;
            p.gravity = -2;
            p.r0 = 1;
            p.g0 = 0.78;
            p.b0 = 0.35;
            p.r1 = 0.75;
            p.g1 = 0.18;
            p.b1 = 0.04;
            p.opacity = 0.95;
            p.fade = 1.2;
          });
        }
      }
      fire.update(dt);
    },
    fire(x, z) {
      const nearest = [...nozzles].sort((a, b) => Math.hypot(a.x - x, a.z - z) - Math.hypot(b.x - x, b.z - z)).slice(0, 4);
      for (const n of nearest) n.burning = 1.5;
    },
  };
}

// ---------------------------------------------------------------- floodlights

/** Floodlight masts at the four corners, with glowing lamp banks. */
function masts(): THREE.Group {
  const group = new THREE.Group();
  group.name = 'floodlights';
  const corner = BACK + 12;
  const height = ROOF_Y + 26;
  const spots: Array<[number, number]> = [
    [corner, corner],
    [-corner, corner],
    [corner, -corner],
    [-corner, -corner],
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
    opacity: 0.6,
  });
  for (const [x, z] of spots) {
    appendGeometry(poles, poleNormals, poleUvs, new THREE.CylinderGeometry(0.7, 1.2, height, 10).translate(x, height / 2, z), tile);
    // A big lamp bank, tilted down toward the arena centre.
    const bank = new THREE.Mesh(new THREE.BoxGeometry(16, 7, 0.8), lampMaterial);
    bank.position.set(x, height + 2, z);
    bank.lookAt(0, 0, 0);
    lamps.add(bank);
    const halo = new THREE.Sprite(haloMaterial);
    halo.position.set(x * 0.985, height + 2, z * 0.985);
    halo.scale.setScalar(36);
    halo.renderOrder = 2;
    // Decoration only: aim and camera rays must pass straight through it (a
    // Sprite also throws when raycast without a camera set).
    halo.raycast = () => {};
    lamps.add(halo);
  }
  const poleMesh = batchMesh(poles, poleNormals, poleUvs, new THREE.MeshStandardMaterial({ color: PALETTE.landmark }), PALETTE.landmark);
  poleMesh.castShadow = true;
  group.add(poleMesh, lamps, beams(spots, height + 2));
  return group;
}

/**
 * The floodlight BEAMS: faint cones of light from each lamp bank down into the
 * arena — what a floodlit stadium looks like at night (light caught in the
 * haze). Fake volumetrics, not lights: additive cones that fade along their
 * length and toward their silhouette edges. All merged: one draw call, no
 * lighting cost.
 */
function beams(spots: Array<[number, number]>, lampY: number): THREE.Mesh {
  const pieces: THREE.BufferGeometry[] = [];
  const up = new THREE.Vector3(0, 1, 0);
  for (const [x, z] of spots) {
    const lamp = new THREE.Vector3(x, lampY, z);
    // Aimed at the arena floor a third of the way in from the mast.
    const target = new THREE.Vector3(x * 0.3, 0, z * 0.3);
    const axis = new THREE.Vector3().subVectors(lamp, target);
    const length = axis.length();
    // Open-ended cone, narrow at the lamp (top, uv.y = 1) and wide at the floor.
    const cone = new THREE.CylinderGeometry(5, 48, length, 28, 1, true);
    cone.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(up, axis.normalize()));
    cone.translate((lamp.x + target.x) / 2, (lamp.y + target.y) / 2, (lamp.z + target.z) / 2);
    pieces.push(cone);
  }
  const geometry = mergeGeometries(pieces)!;
  const material = new THREE.ShaderMaterial({
    uniforms: { uColour: { value: new THREE.Color(0xfff1d6) }, uStrength: { value: 0.3 } },
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
