/**
 * Vehicle asset validator.
 *
 *   npm run assetcheck -- <file.glb> <kind> <class>
 *   npm run assetcheck -- assets/suv-body.glb chassis suv
 *   npm run assetcheck -- --selftest
 *
 * Enforces `src/shared/assetSpec.ts`: bounding box, origin, triangle budget,
 * sockets and material slots. The point is that an asset from *any* source —
 * an artist, a parametric generator, an AI tool — can be checked by machine
 * rather than by someone squinting at a screenshot. Assets that fail here will
 * break collision, seats or cameras if they get in, so this is the gate.
 *
 * Reads the GLB container directly (header + JSON chunk). No glTF library is
 * needed because everything validated lives in the JSON: accessor bounds give
 * the geometry box, primitive counts give triangles, node names give sockets.
 */

import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { HERO_RULES, PART_ASSET_SPECS, type AssetTier, type PartKind } from '../src/shared/assetSpec';
import { VEHICLE_CLASSES, type VehicleClassId } from '../src/shared/config';

// ------------------------------------------------------------------ parsing

type Accessor = {
  type: string;
  count: number;
  /** glTF component type; with `normalized`, integer min/max map to [-1, 1] or [0, 1]. */
  componentType?: number;
  normalized?: boolean;
  min?: number[];
  max?: number[];
};

type GltfJson = {
  scenes?: Array<{ nodes?: number[] }>;
  scene?: number;
  nodes?: Array<{
    name?: string;
    mesh?: number;
    children?: number[];
    matrix?: number[];
    translation?: number[];
    rotation?: number[];
    scale?: number[];
  }>;
  meshes?: Array<{ primitives?: Array<{ attributes?: Record<string, number>; indices?: number; material?: number }> }>;
  accessors?: Accessor[];
  materials?: Array<{ name?: string }>;
  textures?: Array<{ source?: number; extensions?: Record<string, unknown> }>;
  extensionsUsed?: string[];
};

const GLB_MAGIC = 0x46546c67;
const CHUNK_JSON = 0x4e4f534a;

function parseGlb(buffer: Buffer): GltfJson {
  if (buffer.length < 12) throw new Error('file is too small to be a GLB');
  if (buffer.readUInt32LE(0) !== GLB_MAGIC) {
    throw new Error('not a GLB (bad magic). Export as .glb (binary), not .gltf');
  }
  const total = buffer.readUInt32LE(8);
  let offset = 12;
  while (offset + 8 <= total) {
    const chunkLength = buffer.readUInt32LE(offset);
    const chunkType = buffer.readUInt32LE(offset + 4);
    if (chunkType === CHUNK_JSON) {
      const text = buffer.subarray(offset + 8, offset + 8 + chunkLength).toString('utf8');
      return JSON.parse(text) as GltfJson;
    }
    offset += 8 + chunkLength;
  }
  throw new Error('GLB has no JSON chunk');
}

function loadJson(path: string): GltfJson {
  if (path.endsWith('.gltf')) return JSON.parse(readFileSync(path, 'utf8')) as GltfJson;
  return parseGlb(readFileSync(path));
}

// ----------------------------------------------------------------- analysis

type Analysis = {
  box: THREE.Box3;
  triangles: number;
  nodeNames: string[];
  materialNames: string[];
  transformedNodes: number;
  primitives: number;
  /** Triangles per LOD level, when the roots are `lod0`, `lod1`… (built assets). */
  lodTriangles: number[];
  extensionsUsed: string[];
  textures: number;
};

function cornersOf(box: THREE.Box3): THREE.Vector3[] {
  const out: THREE.Vector3[] = [];
  for (const x of [box.min.x, box.max.x]) {
    for (const y of [box.min.y, box.max.y]) {
      for (const z of [box.min.z, box.max.z]) out.push(new THREE.Vector3(x, y, z));
    }
  }
  return out;
}

/** Divisor that maps a normalised integer component to its float range. */
const NORMALIZED_RANGE: Record<number, number> = { 5120: 127, 5121: 255, 5122: 32767, 5123: 65535 };

/** Walk the scene graph, composing transforms, to get true world-space bounds. */
function analyse(json: GltfJson): Analysis {
  const nodes = json.nodes ?? [];
  const meshes = json.meshes ?? [];
  const accessors = json.accessors ?? [];
  const roots = json.scenes?.[json.scene ?? 0]?.nodes ?? nodes.map((_, i) => i);

  const box = new THREE.Box3();
  let triangles = 0;
  let primitives = 0;
  let transformedNodes = 0;
  const nodeNames: string[] = [];
  const materialNames: string[] = [];
  const identity = new THREE.Matrix4();

  const visit = (index: number, parent: THREE.Matrix4): void => {
    const node = nodes[index];
    if (!node) return;
    if (node.name) nodeNames.push(node.name);

    const local = new THREE.Matrix4();
    if (node.matrix) {
      local.fromArray(node.matrix);
    } else {
      local.compose(
        new THREE.Vector3(...(node.translation ?? [0, 0, 0])),
        new THREE.Quaternion(...((node.rotation ?? [0, 0, 0, 1]) as [number, number, number, number])),
        new THREE.Vector3(...(node.scale ?? [1, 1, 1])),
      );
    }
    if (!local.equals(identity)) transformedNodes++;

    const world = parent.clone().multiply(local);

    if (node.mesh !== undefined) {
      for (const primitive of meshes[node.mesh]?.primitives ?? []) {
        const positionIndex = primitive.attributes?.POSITION;
        if (positionIndex === undefined) continue;
        const accessor = accessors[positionIndex];
        if (!accessor?.min || !accessor?.max) continue;
        primitives++;

        const count =
          primitive.indices !== undefined ? (accessors[primitive.indices]?.count ?? 0) : accessor.count;
        triangles += Math.floor(count / 3);

        // Quantised (KHR_mesh_quantization) positions store integers; the node
        // transform above them rescales to metres, so undo the normalisation here.
        const scale = accessor.normalized ? (NORMALIZED_RANGE[accessor.componentType ?? 0] ?? 1) : 1;
        const local3 = new THREE.Box3(
          new THREE.Vector3(...(accessor.min as [number, number, number])).divideScalar(scale),
          new THREE.Vector3(...(accessor.max as [number, number, number])).divideScalar(scale),
        );
        for (const corner of cornersOf(local3)) box.expandByPoint(corner.applyMatrix4(world));

        const material = primitive.material !== undefined ? json.materials?.[primitive.material] : undefined;
        if (material?.name) materialNames.push(material.name);
      }
    }

    for (const child of node.children ?? []) visit(child, world);
  };

  const lodTriangles: number[] = [];
  for (const root of roots) {
    const before = triangles;
    visit(root, identity);
    const match = /^lod(\d+)$/.exec(nodes[root]?.name ?? '');
    if (match) lodTriangles[Number(match[1])] = triangles - before;
  }

  return {
    box,
    triangles,
    nodeNames,
    materialNames,
    transformedNodes,
    primitives,
    lodTriangles: lodTriangles.filter((n) => n !== undefined),
    extensionsUsed: json.extensionsUsed ?? [],
    textures: json.textures?.length ?? 0,
  };
}

// ---------------------------------------------------------------- validation

type Verdict = { errors: string[]; warnings: string[] };

const v3 = (value: number[]): string => `(${value.map((n) => n.toFixed(2)).join(', ')})`;

function validate(kind: PartKind, cls: VehicleClassId, analysis: Analysis, tier: AssetTier = 'standard'): Verdict {
  const spec = PART_ASSET_SPECS[kind];
  const expected = spec.bounds(VEHICLE_CLASSES[cls]);
  const errors: string[] = [];
  const warnings: string[] = [];

  if (analysis.box.isEmpty()) {
    errors.push('no POSITION accessors found — nothing to measure');
    return { errors, warnings };
  }

  const expectedMin = new THREE.Vector3(...(expected.min as [number, number, number]));
  const expectedMax = new THREE.Vector3(...(expected.max as [number, number, number]));
  const expectedSize = new THREE.Vector3().subVectors(expectedMax, expectedMin);
  const actualSize = new THREE.Vector3();
  analysis.box.getSize(actualSize);

  // Size per axis.
  for (const axis of ['x', 'y', 'z'] as const) {
    const want = expectedSize[axis];
    if (want <= 0.001) continue;
    const got = actualSize[axis];
    const error = Math.abs(got - want) / want;
    if (error > spec.tolerance) {
      errors.push(
        `${axis} extent ${got.toFixed(2)}m vs expected ${want.toFixed(2)}m (±${Math.round(spec.tolerance * 100)}% allowed)`,
      );
    } else if (error > spec.tolerance * 0.6) {
      warnings.push(`${axis} extent is ${Math.round(error * 100)}% off expected`);
    }
  }

  // Origin: the box must sit where the rig expects to place it.
  const actualCentre = new THREE.Vector3();
  analysis.box.getCenter(actualCentre);
  const expectedCentre = new THREE.Vector3().addVectors(expectedMin, expectedMax).multiplyScalar(0.5);
  const offset = actualCentre.distanceTo(expectedCentre);
  const limit = Math.max(0.25, expectedSize.length() * 0.25);
  if (offset > limit) {
    errors.push(
      `origin looks wrong: box centre ${v3(actualCentre.toArray())} vs expected ${v3(expectedCentre.toArray())}`,
    );
  }

  // Budget. This is the check that rejects typical AI output. A built asset is
  // measured on lod0 alone: the other levels are never drawn at the same time.
  const budget = tier === 'hero' ? spec.heroTriangles : spec.maxTriangles;
  const drawn = analysis.lodTriangles[0] ?? analysis.triangles;
  if (drawn > budget) {
    errors.push(`${drawn} triangles exceeds the ${budget} ${tier} budget`);
  } else if (drawn > budget * 0.8) {
    warnings.push(`near budget: ${drawn}/${budget} triangles`);
  }

  if (tier === 'hero') {
    // The price of the big budget: distant copies must be cheap, and the data
    // must stay compressed in memory. Build with `npm run assetbuild`.
    const lods = analysis.lodTriangles;
    if (drawn <= HERO_RULES.lodsAboveTriangles) {
      // Small part: LODs are optional, and judged only if present.
      if (lods.length > 1 && lods[lods.length - 1] > lods[0] * 0.9) {
        warnings.push('LODs barely simplify this small part; consider "lods": [] in its .asset.json');
      }
    } else if (lods.length < HERO_RULES.minExtraLods + 1) {
      errors.push(`hero assets need lod0 + ${HERO_RULES.minExtraLods} LODs; found ${Math.max(0, lods.length - 1)} (run npm run assetbuild)`);
    } else {
      if (lods[1] > lods[0] * HERO_RULES.lod1MaxShare) {
        errors.push(`lod1 keeps ${Math.round((lods[1] / lods[0]) * 100)}% of lod0; at most ${HERO_RULES.lod1MaxShare * 100}% allowed`);
      }
      const last = lods[lods.length - 1];
      if (last > lods[0] * HERO_RULES.lastLodMaxShare) {
        errors.push(`farthest LOD keeps ${Math.round((last / lods[0]) * 100)}% of lod0; at most ${HERO_RULES.lastLodMaxShare * 100}% allowed`);
      }
    }
    if (!analysis.extensionsUsed.includes(HERO_RULES.meshExtension)) {
      errors.push(`hero geometry must use ${HERO_RULES.meshExtension} (run npm run assetbuild)`);
    }
    if (analysis.textures === 0) {
      warnings.push('no textures — a realistic asset normally carries PBR maps');
    } else if (!analysis.extensionsUsed.includes(HERO_RULES.textureExtension)) {
      errors.push(`hero textures must be KTX2 (${HERO_RULES.textureExtension}); run npm run assetbuild`);
    }
  }

  // Built assets carry quantisation transforms on purpose; bounds compose them.
  if (analysis.transformedNodes > 0 && tier !== 'hero') {
    warnings.push(
      `${analysis.transformedNodes} node(s) carry transforms — bake them, or bounds depend on the hierarchy`,
    );
  }

  // Sockets. Missing ones disable features rather than breaking the build, so
  // they are warnings: a socket-less asset still renders.
  for (const name of spec.sockets) {
    if (!analysis.nodeNames.includes(name)) {
      warnings.push(`missing socket "${name}" — the feature using it will be disabled`);
    }
  }

  if (spec.materialSlots.length > 0) {
    const matched = analysis.materialNames.filter((n) => spec.materialSlots.includes(n));
    if (matched.length === 0) {
      warnings.push(
        `no material is named after a slot (${spec.materialSlots.join(', ')}) — cosmetic colours cannot be applied`,
      );
    }
  }

  return { errors, warnings };
}

// ------------------------------------------------------------------ self-test

function writeGlb(json: unknown): Buffer {
  const text = JSON.stringify(json);
  const padded = text + ' '.repeat((4 - (text.length % 4)) % 4);
  const jsonChunk = Buffer.from(padded, 'utf8');
  const header = Buffer.alloc(12);
  header.writeUInt32LE(GLB_MAGIC, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + jsonChunk.length, 8);
  const chunkHeader = Buffer.alloc(8);
  chunkHeader.writeUInt32LE(jsonChunk.length, 0);
  chunkHeader.writeUInt32LE(CHUNK_JSON, 4);
  return Buffer.concat([header, chunkHeader, jsonChunk]);
}

function syntheticGlb(options: {
  min: number[];
  max: number[];
  triangles: number;
  nodeNames: string[];
  materialNames: string[];
}): GltfJson {
  const nodes: Array<Record<string, unknown>> = options.nodeNames.map((name) => ({ name }));
  nodes[0].mesh = 0;
  return {
    scenes: [{ nodes: options.nodeNames.map((_, i) => i) }],
    nodes: nodes as GltfJson['nodes'],
    materials: options.materialNames.map((name) => ({ name })),
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }],
    accessors: [
      { type: 'VEC3', count: options.triangles * 3, min: options.min, max: options.max },
    ],
  };
}

function selftest(): number {
  // A validator nobody has seen fail is not a validator. These cases prove it
  // rejects the things it exists to reject.
  const spec = PART_ASSET_SPECS.chassis;
  const coupe = VEHICLE_CLASSES.coupe;
  const bounds = spec.bounds(coupe);
  const pass = syntheticGlb({
    min: [...bounds.min],
    max: [...bounds.max],
    triangles: 900,
    nodeNames: ['Body', ...spec.sockets],
    materialNames: spec.materialSlots,
  });

  let failures = 0;
  const expect = (label: string, condition: boolean, detail = ''): void => {
    console.log(`  [${condition ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`);
    if (!condition) failures++;
  };

  const good = validate('chassis', 'coupe', analyse(pass));
  expect('conformant asset passes', good.errors.length === 0, good.errors.join('; '));

  const oversized = syntheticGlb({
    min: [bounds.min[0] * 2.2, bounds.min[1], bounds.min[2] * 2.2],
    max: [bounds.max[0] * 2.2, bounds.max[1], bounds.max[2] * 2.2],
    triangles: 900,
    nodeNames: ['Body', ...spec.sockets],
    materialNames: spec.materialSlots,
  });
  const tooBig = validate('chassis', 'coupe', analyse(oversized));
  expect('oversized asset is rejected', tooBig.errors.some((e) => e.includes('extent')));

  const heavy = syntheticGlb({
    min: [...bounds.min],
    max: [...bounds.max],
    triangles: spec.maxTriangles * 8,
    nodeNames: ['Body', ...spec.sockets],
    materialNames: spec.materialSlots,
  });
  const tooHeavy = validate('chassis', 'coupe', analyse(heavy));
  expect(
    'over-budget triangle count is rejected',
    tooHeavy.errors.some((e) => e.includes('triangles exceeds')),
    tooHeavy.errors.join('; '),
  );

  const socketless = syntheticGlb({
    min: [...bounds.min],
    max: [...bounds.max],
    triangles: 900,
    nodeNames: ['Body'],
    materialNames: spec.materialSlots,
  });
  const noSockets = validate('chassis', 'coupe', analyse(socketless));
  expect(
    'missing sockets warn rather than fail',
    noSockets.errors.length === 0 && noSockets.warnings.some((w) => w.includes('missing socket')),
  );

  // ---- hero tier ----
  const hero = (options: { lods: number[]; extensions: string[]; textures: number }): GltfJson => {
    const json: GltfJson = {
      scenes: [{ nodes: options.lods.map((_, i) => i) }],
      nodes: [
        ...options.lods.map((_, i) => ({ name: `lod${i}`, mesh: i })),
        ...spec.sockets.map((name) => ({ name })),
      ],
      materials: spec.materialSlots.map((name) => ({ name })),
      meshes: options.lods.map((_, i) => ({ primitives: [{ attributes: { POSITION: i }, material: 0 }] })),
      accessors: options.lods.map((tris) => ({ type: 'VEC3', count: tris * 3, min: [...bounds.min], max: [...bounds.max] })),
      textures: Array.from({ length: options.textures }, () => ({ source: 0 })),
      extensionsUsed: options.extensions,
    };
    // Sockets hang off lod0, as assetbuild leaves them.
    json.nodes![0].children = spec.sockets.map((_, i) => options.lods.length + i);
    return json;
  };
  const built = ['EXT_meshopt_compression', 'KHR_texture_basisu', 'KHR_mesh_quantization'];

  const heroGood = validate('chassis', 'coupe', analyse(hero({ lods: [40_000, 14_000, 4_000], extensions: built, textures: 3 })), 'hero');
  expect('a built hero asset passes', heroGood.errors.length === 0, heroGood.errors.join('; '));
  expect(
    'the same asset fails the standard budget',
    validate('chassis', 'coupe', analyse(hero({ lods: [40_000, 14_000, 4_000], extensions: built, textures: 3 }))).errors.some((e) => e.includes('standard budget')),
  );
  expect(
    'a hero over its own budget is rejected',
    validate('chassis', 'coupe', analyse(hero({ lods: [90_000, 20_000, 5_000], extensions: built, textures: 3 })), 'hero').errors.some((e) => e.includes('hero budget')),
  );
  expect(
    'a hero without LODs is rejected',
    validate('chassis', 'coupe', analyse(hero({ lods: [40_000], extensions: built, textures: 3 })), 'hero').errors.some((e) => e.includes('LODs')),
  );
  expect(
    'a hero whose LODs barely simplify is rejected',
    validate('chassis', 'coupe', analyse(hero({ lods: [40_000, 35_000, 30_000], extensions: built, textures: 3 })), 'hero').errors.some((e) => e.includes('lod1 keeps')),
  );
  expect(
    'a hero with uncompressed textures is rejected',
    validate('chassis', 'coupe', analyse(hero({ lods: [40_000, 14_000, 4_000], extensions: ['EXT_meshopt_compression'], textures: 3 })), 'hero').errors.some((e) => e.includes('KTX2')),
  );
  expect(
    'a hero without meshopt geometry is rejected',
    validate('chassis', 'coupe', analyse(hero({ lods: [40_000, 14_000, 4_000], extensions: ['KHR_texture_basisu'], textures: 3 })), 'hero').errors.some((e) => e.includes('EXT_meshopt')),
  );

  return failures;
}

// ---------------------------------------------------------------------- main

function main(): number {
  const args = process.argv.slice(2);

  if (args.includes('--selftest')) {
    console.log('\n=== assetcheck self-test ===');
    const failures = selftest();
    console.log(failures === 0 ? '\n✓ validator behaves correctly\n' : `\n✗ ${failures} self-test(s) failed\n`);
    return failures === 0 ? 0 : 1;
  }

  const tierIndex = args.indexOf('--tier');
  const tier = (tierIndex >= 0 ? args[tierIndex + 1] : 'standard') as AssetTier;
  if (tier !== 'standard' && tier !== 'hero') {
    console.error(`unknown tier "${tier}" (standard | hero)`);
    return 2;
  }
  const positional = args.filter((a, i) => !a.startsWith('--') && (tierIndex < 0 || i !== tierIndex + 1));
  const [file, kindArg, clsArg] = positional;
  if (!file || !kindArg) {
    console.log('usage: npm run assetcheck -- <file.glb> <kind> <class> [--tier hero]');
    console.log(`       kinds: ${Object.keys(PART_ASSET_SPECS).join(', ')}`);
    console.log(`       class: ${Object.keys(VEHICLE_CLASSES).join(', ')}`);
    console.log('       npm run assetcheck -- --selftest');
    return 2;
  }

  const kind = kindArg as PartKind;
  const cls = (clsArg ?? 'suv') as VehicleClassId;
  if (!PART_ASSET_SPECS[kind]) {
    console.error(`unknown part kind "${kind}"`);
    return 2;
  }
  if (!VEHICLE_CLASSES[cls]) {
    console.error(`unknown vehicle class "${cls}"`);
    return 2;
  }

  let analysis: Analysis;
  try {
    analysis = analyse(loadJson(file));
  } catch (error) {
    console.error(`✗ ${file}: ${(error as Error).message}`);
    return 1;
  }

  const { errors, warnings } = validate(kind, cls, analysis, tier);
  const size = new THREE.Vector3();
  analysis.box.getSize(size);

  console.log(`\n${file}  →  ${kind} / ${cls} · ${tier} tier`);
  if (analysis.lodTriangles.length > 0) console.log(`  LODs: ${analysis.lodTriangles.join(' → ')} tris`);
  console.log(
    `  size ${v3(size.toArray())} m · ${analysis.triangles} tris · ${analysis.primitives} primitive(s) · ${analysis.nodeNames.length} nodes`,
  );
  for (const w of warnings) console.log(`  [warn]  ${w}`);
  for (const e of errors) console.log(`  [ERROR] ${e}`);

  if (errors.length === 0) {
    console.log('\n✓ conforms to the asset spec\n');
    return 0;
  }
  console.log(`\n✗ ${errors.length} error(s)\n`);
  return 1;
}

process.exit(main());
