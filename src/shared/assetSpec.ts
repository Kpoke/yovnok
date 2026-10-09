/**
 * The vehicle asset contract.
 *
 * Anything that produces a vehicle part — this repository's procedural
 * geometry, a parametric generator, or an AI 3D tool — has to satisfy this, and
 * `scripts/assetcheck.ts` enforces it automatically. That is the point: without a
 * machine-checkable spec, generated assets arrive "nearly right" and silently
 * break collision, seats or sockets.
 *
 * AXES. Three.js convention, matching the simulation:
 *   +X = the vehicle's right
 *   -Z = forward
 *   +Y = up
 * Parts are modelled around THEIR OWN origin, because the rig positions them:
 *   chassis   origin at the chassis centre, `rideHeight` above the ground
 *   wheel     origin at the axle centre (so it can spin)
 *   seat      origin at the seat cushion
 *   engine    origin at the block centre
 *
 * SCALE. One unit is one metre, matching `VEHICLE_CLASSES`. A part that needs
 * rescaling is a part that will break hit-testing.
 */

import type { VehicleSpec } from './config';

export type PartKind = 'chassis' | 'engine' | 'wheel' | 'seat' | 'turret' | 'gun';

export type Bounds = {
  min: readonly [number, number, number];
  max: readonly [number, number, number];
};

export type PartAssetSpec = {
  kind: PartKind;
  /** Expected local-space bounding box, in metres, for a given vehicle class. */
  bounds: (spec: VehicleSpec) => Bounds;
  /** Allowed proportional error on each axis of the box. */
  tolerance: number;
  /** Triangle ceiling. This is a browser game with up to 8 cars on screen. */
  maxTriangles: number;
  /**
   * Ceiling for the realistic ("hero") tier, measured on lod0 only. A hero asset
   * buys this budget by also shipping LODs, meshopt geometry and KTX2 textures
   * (see `HERO_RULES`), so distant cars stay cheap.
   */
  heroTriangles: number;
  /**
   * Nodes the loader looks for by name. Missing sockets do not fail the build,
   * but they disable the feature that depends on them — so they are reported.
   */
  sockets: string[];
  /** Material slot names the loader expects to substitute colours into. */
  materialSlots: string[];
};

/**
 * Triangle budgets. Deliberately tiny: 8 vehicles at 60fps in a browser, with
 * shadows, leaves very little room. For scale, a typical AI text-to-3D mesh is
 * 50k–200k triangles — roughly 100x these budgets — which is why generic
 * generation is a poor fit for the cars themselves.
 */
export const PART_ASSET_SPECS: Record<PartKind, PartAssetSpec> = {
  chassis: {
    kind: 'chassis',
    bounds: (v) => ({
      min: [-v.halfWidth * 1.05, -v.rideHeight - 0.1, -v.halfLength * 1.05],
      max: [v.halfWidth * 1.05, v.boxHeight / 2 + 0.1, v.halfLength * 1.05],
    }),
    tolerance: 0.2,
    maxTriangles: 2200,
    heroTriangles: 60_000,
    sockets: [
      'exhaust.left',
      'exhaust.right',
      'decal.left',
      'decal.right',
      'roofRack',
    ],
    materialSlots: ['body', 'bodyDark', 'trim', 'glass', 'interior', 'metal', 'lamp', 'tailLamp'],
  },
  engine: {
    kind: 'engine',
    bounds: () => ({ min: [-0.6, -0.35, -0.6], max: [0.6, 0.45, 0.55] }),
    tolerance: 0.35,
    maxTriangles: 500,
    heroTriangles: 8_000,
    sockets: ['intake', 'exhaustPort.left', 'exhaustPort.right'],
    materialSlots: ['metal', 'bodyDark', 'hub'],
  },
  wheel: {
    kind: 'wheel',
    bounds: (v) => ({
      // A wheel is a disc on an axle along X (the rig spins it about X):
      // diameter from the radius, width a fraction of it (0.9 r, like the
      // procedural wheel; real tyres vary, hence the looser tolerance).
      min: [-v.wheelRadius * 0.45, -v.wheelRadius * 1.1, -v.wheelRadius * 1.1],
      max: [v.wheelRadius * 0.45, v.wheelRadius * 1.1, v.wheelRadius * 1.1],
    }),
    tolerance: 0.35,
    maxTriangles: 600,
    heroTriangles: 6_000,
    sockets: ['rim'],
    materialSlots: ['wheel', 'hub', 'metal'],
  },
  seat: {
    kind: 'seat',
    bounds: () => ({ min: [-0.4, -0.05, -0.35], max: [0.4, 0.68, 0.4] }),
    tolerance: 0.3,
    maxTriangles: 300,
    heroTriangles: 4_000,
    sockets: ['eye', 'firePort'],
    materialSlots: ['seat'],
  },
  /**
   * A car-mounted gun, on a class whose seat has `mounted` weapons. Origin at
   * the base where it meets the roof; the barrel points -Z; `muzzle` is the tip.
   */
  turret: {
    kind: 'turret',
    bounds: () => ({ min: [-0.5, 0, -1.45], max: [0.5, 0.85, 0.8] }),
    tolerance: 0.5,
    maxTriangles: 1500,
    // A roof weapon station carries a whole weapon (the RPG alone is ~13.6k).
    heroTriangles: 16_000,
    sockets: ['muzzle'],
    materialSlots: ['metal', 'bodyDark'],
  },
  /**
   * One car-mounted gun (each of a twin pair). Origin at its mounting pivot;
   * barrel along -Z; `muzzle` at the tip.
   */
  gun: {
    kind: 'gun',
    bounds: () => ({ min: [-0.1, 0, -0.78], max: [0.1, 0.22, 0.54] }),
    tolerance: 0.6,
    maxTriangles: 800,
    heroTriangles: 9_000,
    sockets: ['muzzle'],
    materialSlots: ['metal', 'bodyDark'],
  },
};

/**
 * Asset tier. `standard` is the original low-poly budget; `hero` is realistic
 * art, built by `npm run assetbuild`.
 */
export type AssetTier = 'standard' | 'hero';

/** What a hero asset must carry in exchange for its larger budget. */
export const HERO_RULES = {
  /**
   * The LOD rules apply only above this many lod0 triangles: a small part (a
   * turret, a wheel nut) costs too little for distance copies to be worth it.
   */
  lodsAboveTriangles: 5_000,
  /** Detail levels below lod0. */
  minExtraLods: 2,
  /** lod1 may keep at most this share of lod0's triangles. */
  lod1MaxShare: 0.5,
  /** The farthest LOD may keep at most this share. */
  lastLodMaxShare: 0.25,
  /** Geometry compression extension required. */
  meshExtension: 'EXT_meshopt_compression',
  /** Texture compression extension required when the asset has textures. */
  textureExtension: 'KHR_texture_basisu',
} as const;

/** Manifest shape a glTF part library reads. See `ASSET_SPEC.md`. */
export type PartManifestEntry = {
  /** Path to a .glb, relative to the manifest. */
  file: string;
  /** Node inside the file to use. Omit for the whole scene. */
  node?: string;
  /** Uniform scale applied on load. Should be 1 for conformant assets. */
  scale?: number;
  /** Local offset applied on load, metres. */
  offset?: readonly [number, number, number];
  /**
   * Material names on this asset that take the livery colour, as a tint over
   * their texture (e.g. `["exterior"]`). Realistic assets keep their own
   * materials rather than being swapped for a slot, so this is how paint applies.
   */
  paint?: readonly string[];
  /** 0..1: how strongly `paint` tints toward the livery colour. Default 0.45. */
  paintStrength?: number;
  /**
   * Fixed colour multipliers by material name (hex), applied under any paint —
   * for matching a part from another model (e.g. a tan turret on a grey truck).
   */
  baseTint?: Readonly<Record<string, string>>;
  /**
   * Camera distances (m) at which lod0, lod1, lod2… take over, for assets built
   * with LODs (`npm run assetbuild`). Default `[0, 30, 80]`.
   */
  lodDistances?: readonly number[];
};

export type VehicleManifest = {
  version: 1;
  /** Keyed by `kind` or `kind:variant`, e.g. `chassis`, `wheel:offroad`. */
  parts: Record<string, PartManifestEntry>;
};
