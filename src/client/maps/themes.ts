/**
 * How each map LOOKS: what its palette roles are made of, the scenery built
 * around and on it, and its weather. The shape (and its time of day) is shared
 * data in `shared/maps/`; none of this touches the simulation.
 */

import * as THREE from 'three';
import type { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { SOLIDS, STADIUM_HALF } from '../../shared/arena';
import { PALETTE } from '../../shared/config';
import type { MapId } from '../../shared/mapIds';
import type { SurfaceTable } from '../arenaSurfaces';
import { buildProps } from '../buildProps';
import { buildStadium } from '../buildStadium';
import { Weather as WeatherFx } from '../weather';
import { boxes, lampPosts, outerRock, pines, ringPoints, rocks, seeded, solidsOf, water } from './scenery';

export type Weather = 'none' | 'dust' | 'rain' | 'snow' | 'mist';

/** Something happened in the arena that the scenery may react to. */
export type WorldEvent = { kind: 'kill' | 'blast'; x: number; z: number; label?: string };

/** A map's scenery: its objects, and optional per-frame and event hooks. */
export type Dressing = {
  objects: THREE.Object3D[];
  update?: (dt: number, view: THREE.Vector3) => void;
  react?: (event: WorldEvent) => void;
};

export type MapTheme = {
  /** Materials by palette role, over the defaults (arenaSurfaces.SURFACES). */
  surfaces?: SurfaceTable;
  /** Draw cover blocks as stacks of shipping containers. */
  containers: boolean;
  /** Palette roles drawn by the scenery instead of as plain boxes. */
  skip?: number[];
  /** Scenery: everything drawn beyond the solids themselves. */
  dressing: (loader: GLTFLoader) => Promise<Dressing[]>;
};

/** Weather as a dressing: built for the map, following the camera. */
function weather(kind: Exclude<Weather, 'none'>): Dressing {
  const fx = new WeatherFx(kind);
  return { objects: [fx.object], update: (dt, view) => fx.update(dt, view) };
}

/** Rotate a point a quarter turn n times (scenery follows the layout's symmetry). */
function turn(x: number, z: number, n: number): [number, number] {
  let p: [number, number] = [x, z];
  for (let i = 0; i < n; i++) p = [p[1], -p[0]];
  return p;
}

const matte = (material: string, tile: number, tint?: number) => ({ material, tile, tint, matte: true });

export const THEMES: Record<MapId, MapTheme> = {
  stadium: {
    containers: true,
    dressing: async (loader) => [buildStadium(), { objects: [await buildProps(loader)] }],
  },

  canyon: {
    containers: false,
    skip: [PALETTE.rock],
    surfaces: {
      zoneCentre: matte('red_laterite_soil_stones', 10),
      zoneDunes: matte('coast_sand_01', 12, 0xe0a070),
      zoneScrapyard: matte('coast_sand_01', 12, 0xd09060),
      zoneLakebed: matte('coast_sand_01', 14, 0xc88858),
      zoneRim: matte('coast_sand_01', 14, 0xc88858),
      road: matte('sandy_gravel_02', 9, 0xd8b090),
      rock: { material: 'sandstone_cracks', tile: 10, tint: 0xe0a080 },
      plateau: { material: 'sandstone_cracks', tile: 8, tint: 0xc88060 },
      ramp: matte('red_laterite_soil_stones', 6),
      wall: { material: 'sandstone_cracks', tile: 8, tint: 0xd09070 },
      pad: { material: 'sandstone_cracks', tile: 6, tint: 0xe8b090 },
      hazard: { material: 'brown_mud_03', tile: 4, tint: 0x302018, wet: true },
    },
    dressing: async () => [
      {
        objects: [
          rocks(SOLIDS, PALETTE.rock, 1.4),
          // Canyon walls all round, and buttes further out.
          outerRock(PALETTE.rock, { inner: STADIUM_HALF + 6, outer: STADIUM_HALF + 70, height: [26, 62], count: 90, seed: 3 }),
          outerRock(PALETTE.rock, { inner: STADIUM_HALF + 120, outer: STADIUM_HALF + 260, height: [40, 110], count: 40, seed: 4 }),
        ],
      },
      weather('dust'),
    ],
  },

  dockyard: {
    containers: true,
    surfaces: {
      zoneCentre: { material: 'concrete_floor_worn_001', tile: 7, wet: true },
      zoneDunes: { material: 'asphalt_02', tile: 7, wet: true },
      zoneScrapyard: { material: 'asphalt_02', tile: 7, wet: true },
      zoneLakebed: { material: 'asphalt_02', tile: 8, wet: true },
      zoneRim: { material: 'concrete_floor_worn_001', tile: 8, wet: true },
      road: { material: 'asphalt_02', tile: 6, tint: 0x8a929a, wet: true },
      plateau: { material: 'concrete_floor_worn_001', tile: 6, wet: true },
      landmark: { material: 'rusty_metal_02', tile: 3 },
      building: { material: 'corrugated_iron', tile: 6, tint: 0x7f8f9d },
      hazard: { material: 'brown_mud_03', tile: 4, tint: 0x15161a, glossy: true },
    },
    dressing: async () => {
      const yellow = new THREE.MeshStandardMaterial({ color: 0xd4a017, metalness: 0.5, roughness: 0.5 });
      const steel = new THREE.MeshStandardMaterial({ color: 0x3a4048, metalness: 0.6, roughness: 0.5 });
      const crane: Array<[number, number, number, number, number, number]> = [];
      const legs: Array<[number, number, number, number, number, number]> = [];
      for (let q = 0; q < 4; q++) {
        // The gantry: legs up from the solids, a girder across, a boom out to sea.
        for (const [lx, lz] of [
          [197.25, 41.25],
          [197.25, 71.25],
          [227.25, 41.25],
          [227.25, 71.25],
        ]) {
          const [x, z] = turn(lx, lz, q);
          legs.push([x, 17, z, 2.5, 22, 2.5]);
        }
        const [gx, gz] = turn(212, 41.25, q);
        const [hx, hz] = turn(212, 71.25, q);
        const along = q % 2 === 0;
        crane.push([gx, 29, gz, along ? 34 : 2.4, 2.4, along ? 2.4 : 34]);
        crane.push([hx, 29, hz, along ? 34 : 2.4, 2.4, along ? 2.4 : 34]);
        const [bx, bz] = turn(240, 56, q);
        crane.push([bx, 31, bz, along ? 60 : 3, 2.2, along ? 3 : 60]);
        const [cx, cz] = turn(214, 56, q);
        crane.push([cx, 27, cz, 4, 3, 4]);
      }
      // Lamp posts along the lanes and the quay.
      const lamps: Array<{ x: number; z: number }> = [];
      for (let q = 0; q < 4; q++) {
        for (const [x, z] of [
          [60, 12],
          [120, 12],
          [180, 12],
          [118, 88],
          [20, 140],
          [210, 180],
          [140, 228],
        ]) {
          const [tx, tz] = turn(x, z, q);
          lamps.push({ x: tx, z: tz });
        }
      }
      // Ships moored off the quay, as dark hulls with lit decks.
      const hull = new THREE.MeshStandardMaterial({ color: 0x1a1f26, roughness: 0.7 });
      const ships: Array<[number, number, number, number, number, number]> = [];
      for (let q = 0; q < 4; q++) {
        const [x, z] = turn(330, -60, q);
        const along = q % 2 === 1;
        ships.push([x, 5, z, along ? 180 : 32, 14, along ? 32 : 180]);
        const [bx, bz] = turn(330, -130, q);
        ships.push([bx, 20, bz, 14, 18, 14]);
      }
      return [
        {
          objects: [
            water(),
            boxes([...legs, ...crane], yellow, 'gantry-cranes'),
            boxes(ships, hull, 'ships'),
            lampPosts(lamps, 0xffb25a, 15),
            // The quay's edge: a steel lip all round the arena.
            boxes(
              [
                [0, -0.2, STADIUM_HALF + 6, 2 * STADIUM_HALF + 24, 2.4, 10],
                [0, -0.2, -STADIUM_HALF - 6, 2 * STADIUM_HALF + 24, 2.4, 10],
                [STADIUM_HALF + 6, -0.2, 0, 10, 2.4, 2 * STADIUM_HALF + 24],
                [-STADIUM_HALF - 6, -0.2, 0, 10, 2.4, 2 * STADIUM_HALF + 24],
              ],
              steel,
              'quay',
            ),
          ],
        },
        weather('rain'),
      ];
    },
  },

  snowbase: {
    containers: false,
    skip: [PALETTE.landmark],
    surfaces: {
      zoneCentre: { material: 'concrete_floor_worn_001', tile: 7, tint: 0xdde4ea },
      zoneDunes: matte('snow_02', 8),
      zoneScrapyard: matte('snow_02', 9),
      zoneLakebed: matte('snow_field_aerial', 14),
      zoneRim: matte('snow_field_aerial', 14),
      road: { material: 'asphalt_02', tile: 8, tint: 0xc8d0d8 },
      ramp: matte('snow_02', 6),
      block: { material: 'concrete_wall_008', tile: 4, tint: 0xd0d4d8 },
      building: { material: 'corrugated_iron', tile: 6, tint: 0xb4c0ca },
      wall: { material: 'concrete_wall_007', tile: 5, tint: 0xe0e4e8 },
    },
    dressing: async () => {
      const metal = new THREE.MeshStandardMaterial({ color: 0xc8d0d6, metalness: 0.6, roughness: 0.4 });
      const dark = new THREE.MeshStandardMaterial({ color: 0x2c3036, metalness: 0.4, roughness: 0.6 });
      const group = new THREE.Group();
      // Fuel tanks (10 × 10 landmarks) as cylinders; watchtowers (3 × 3) on legs.
      for (const s of solidsOf(SOLIDS, PALETTE.landmark)) {
        const w = s.max.x - s.min.x;
        const cx = (s.min.x + s.max.x) / 2;
        const cz = (s.min.z + s.max.z) / 2;
        const h = s.max.y - s.min.y;
        if (w > 6) {
          const tank = new THREE.Mesh(new THREE.CylinderGeometry(w / 2, w / 2, h, 24), metal);
          tank.position.set(cx, h / 2, cz);
          tank.castShadow = tank.receiveShadow = true;
          const cap = new THREE.Mesh(new THREE.SphereGeometry(w / 2, 24, 8, 0, Math.PI * 2, 0, Math.PI / 2), metal);
          cap.scale.y = 0.3;
          cap.position.set(cx, h, cz);
          group.add(tank, cap);
        } else {
          const tower = boxes(
            [
              [cx, h / 2, cz, w, h * 0.8, w],
              [cx, h - 1, cz, w + 1.6, 2.4, w + 1.6],
              [cx, h + 0.6, cz, w + 2.4, 0.4, w + 2.4],
            ],
            dark,
            'watchtower',
          );
          group.add(tower);
        }
      }
      // Hangar roofs: a barrel vault over each hangar; a radar dome on the small one.
      for (const s of solidsOf(SOLIDS, PALETTE.building)) {
        const sx = s.max.x - s.min.x;
        const sz = s.max.z - s.min.z;
        const cx = (s.min.x + s.max.x) / 2;
        const cz = (s.min.z + s.max.z) / 2;
        if (sx * sz < 600) {
          const dome = new THREE.Mesh(new THREE.SphereGeometry(5, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0xf2f4f6, roughness: 0.6 }));
          dome.position.set(cx, s.max.y, cz);
          dome.castShadow = true;
          group.add(dome);
          continue;
        }
        const long = Math.max(sx, sz);
        const span = Math.min(sx, sz);
        const vault = new THREE.Mesh(new THREE.CylinderGeometry(span / 2, span / 2, long, 20, 1, false, 0, Math.PI), metal);
        vault.rotation.z = Math.PI / 2;
        if (sz > sx) vault.rotation.y = Math.PI / 2;
        vault.scale.set(1, 1, 0.45);
        if (sz > sx) vault.scale.set(1, 1, 0.45);
        vault.position.set(cx, s.max.y, cz);
        vault.castShadow = true;
        group.add(vault);
      }
      // Snowy pines all round, outside the fence.
      const rand = seeded(17);
      const trees = ringPoints(rand, STADIUM_HALF + 10, STADIUM_HALF + 190, 700).map((p) => ({ ...p, h: 14 + rand() * 14 }));
      return [{ objects: [group, pines(trees, { snowy: true, seed: 5 })] }, weather('snow')];
    },
  },

  quarry: {
    containers: false,
    skip: [PALETTE.rock],
    surfaces: {
      zoneCentre: matte('rocky_trail', 10),
      zoneDunes: matte('rocky_trail', 10),
      zoneScrapyard: matte('rocky_trail', 11),
      zoneLakebed: matte('rocky_trail', 12),
      zoneRim: matte('rocky_trail', 12),
      road: matte('rocky_trail', 8),
      plateau: matte('sandy_gravel_02', 12, 0xc8beb0),
      ramp: matte('rocky_trail', 7),
      rock: { material: 'rock_boulder_dry', tile: 10, tint: 0xb8b0a4 },
      wall: { material: 'rock_boulder_dry', tile: 8, tint: 0xb8b0a4 },
      landmark: { material: 'rusty_metal_02', tile: 3 },
      pad: { material: 'concrete_floor_worn_001', tile: 6 },
      hazard: { material: 'brown_mud_03', tile: 4, tint: 0x6a5a40, wet: true },
    },
    dressing: async () => {
      const steel = new THREE.MeshStandardMaterial({ color: 0x6b5a48, metalness: 0.5, roughness: 0.6 });
      const belt: Array<[number, number, number, number, number, number]> = [];
      const group = new THREE.Group();
      for (let q = 0; q < 4; q++) {
        // A conveyor from the crusher up onto the bench, on its two legs.
        const piece = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.8, 46), steel);
        const [x, z] = turn(21, 79, q);
        piece.position.set(x, 10.8, z);
        piece.rotation.y = (-q * Math.PI) / 2;
        piece.rotateX(-Math.atan2(5, 46));
        piece.castShadow = true;
        group.add(piece);
        const [hx, hz] = turn(38, 48, q);
        belt.push([hx, 11, hz, 6, 4, 6]);
      }
      return [
        {
          objects: [
            rocks(SOLIDS, PALETTE.rock, 0.8),
            group,
            boxes(belt, steel, 'crusher-hoppers'),
            // The pit's faces climbing away in benches.
            outerRock(PALETTE.rock, { inner: STADIUM_HALF + 4, outer: STADIUM_HALF + 130, height: [24, 52], count: 110, seed: 8, steps: true }),
          ],
        },
        weather('dust'),
      ];
    },
  },

  forest: {
    containers: false,
    skip: [PALETTE.trunk, PALETTE.rock],
    surfaces: {
      zoneCentre: matte('brown_mud_leaves_01', 8),
      zoneDunes: matte('forrest_ground_01', 9),
      zoneScrapyard: matte('forrest_ground_01', 9),
      zoneLakebed: matte('forest_leaves_02', 10),
      zoneRim: matte('forest_leaves_02', 10),
      road: matte('brown_mud_leaves_01', 7, 0xb09070),
      plateau: { material: 'mossy_rock', tile: 8 },
      ramp: { material: 'mossy_rock', tile: 6 },
      rock: { material: 'mossy_rock', tile: 6 },
      wall: { material: 'mossy_rock', tile: 6 },
      log: { material: 'bark_brown_02', tile: 2, tint: 0xc8b090 },
      building: { material: 'corrugated_iron', tile: 6, tint: 0x8a7a68 },
      pad: { material: 'concrete_floor_worn_001', tile: 6, tint: 0xb0a890 },
      hazard: { material: 'brown_mud_03', tile: 4, tint: 0x4a3a26, wet: true },
    },
    dressing: async () => {
      const rand = seeded(21);
      // A pine on every trunk in the arena (the trunk is its collision)...
      const inside = solidsOf(SOLIDS, PALETTE.trunk).map((s) => ({
        x: (s.min.x + s.max.x) / 2,
        z: (s.min.z + s.max.z) / 2,
        h: 22 + rand() * 10,
      }));
      // ...and a dense forest beyond the arena's edge.
      const outside = ringPoints(rand, STADIUM_HALF + 4, STADIUM_HALF + 190, 1500).map((p) => ({ ...p, h: 20 + rand() * 14 }));
      return [{ objects: [rocks(SOLIDS, PALETTE.rock, 0.6), pines([...inside, ...outside], { seed: 6 })] }, weather('mist')];
    },
  },
};
