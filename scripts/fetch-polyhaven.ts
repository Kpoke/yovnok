/**
 * Fetch CC0 materials from Poly Haven into the asset pipeline.
 *
 *   npx tsx scripts/fetch-polyhaven.ts asphalt_02 metal_plate ...
 *   npx tsx scripts/fetch-polyhaven.ts --hdri satara_night     # 1K .hdr environment
 *   npx tsx scripts/fetch-polyhaven.ts --model Barrel_01       # 1K prop, into assets-src/props
 *   npm run assetbuild && npm run licensecheck -- --write
 *
 * Each material is Poly Haven's own 2K glTF (a plane carrying the material:
 * colour, normal and an AO/roughness/metal map), saved to
 * `assets-src/materials/<id>/`. `assetbuild` then turns it into
 * `public/assets/materials/<id>/<id>_2k.glb` with KTX2 textures, and the arena
 * takes the material off it by name. The `assets.json` licence record is written
 * here too, with the author(s) Poly Haven's API names — so credit is correct by
 * construction rather than typed by hand.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const API = 'https://api.polyhaven.com';
const RESOLUTION = '2k';

type FileEntry = { url: string; include?: Record<string, { url: string }> };

async function json<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return (await res.json()) as T;
}

async function download(url: string, to: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  mkdirSync(dirname(to), { recursive: true });
  writeFileSync(to, new Uint8Array(await res.arrayBuffer()));
}

/**
 * A prop MODEL: Poly Haven's 1K glTF into `assets-src/props/<id>/`, built by
 * assetbuild into `public/assets/props/<id>/<id>_1k.glb`. Props are placed
 * dozens of times, so the sidecar simplifies scan-grade meshes (`baseRatio`).
 */
async function fetchModel(id: string): Promise<{ files: string[]; title: string; authors: string; built: string }> {
  const info = await json<{ name: string; authors: Record<string, string>; polycount?: number }>(`${API}/info/${id}`);
  const files = await json<{ gltf: Record<string, { gltf: FileEntry }> }>(`${API}/files/${id}`);
  const entry = files.gltf?.['1k']?.gltf;
  if (!entry) throw new Error(`${id}: no 1k glTF on Poly Haven`);
  const dir = join(ROOT, 'assets-src', 'props', id);
  const gltfName = entry.url.split('/').pop()!;
  const written: string[] = [];
  await download(entry.url, join(dir, gltfName));
  written.push(join('assets-src', 'props', id, gltfName));
  for (const [path, inc] of Object.entries(entry.include ?? {})) {
    await download(inc.url, join(dir, path));
    written.push(join('assets-src', 'props', id, path));
  }
  // Aim for ~3k triangles at lod0 whatever the source.
  const baseRatio = Math.min(1, 3000 / Math.max(1, info.polycount ?? 3000));
  writeFileSync(
    join(dir, gltfName.replace(/\.gltf$/, '.asset.json')),
    `${JSON.stringify({ lods: [0.4, 0.12], maxTexture: 1024, baseRatio: Number(baseRatio.toFixed(3)) })}\n`,
  );
  return {
    files: written,
    title: info.name,
    authors: Object.keys(info.authors).join(', '),
    built: `public/assets/props/${id}/${gltfName.replace(/\.gltf$/, '.glb')}`,
  };
}

async function fetchMaterial(id: string): Promise<{ files: string[]; title: string; authors: string }> {
  const info = await json<{ name: string; authors: Record<string, string> }>(`${API}/info/${id}`);
  const files = await json<{ gltf: Record<string, { gltf: FileEntry }> }>(`${API}/files/${id}`);
  const entry = files.gltf?.[RESOLUTION]?.gltf;
  if (!entry) throw new Error(`${id}: no ${RESOLUTION} glTF on Poly Haven`);

  const dir = join(ROOT, 'assets-src', 'materials', id);
  const gltfName = entry.url.split('/').pop()!;
  const written: string[] = [];
  await download(entry.url, join(dir, gltfName));
  written.push(join('assets-src', 'materials', id, gltfName));
  for (const [path, inc] of Object.entries(entry.include ?? {})) {
    await download(inc.url, join(dir, path));
    written.push(join('assets-src', 'materials', id, path));
  }
  // A material library: no LODs, and the displacement plane is dropped.
  writeFileSync(join(dir, gltfName.replace(/\.gltf$/, '.asset.json')), '{ "lods": [], "materialOnly": true }\n');
  return { files: written, title: info.name, authors: Object.keys(info.authors).join(', ') };
}

/** An HDRI for environment lighting: the 1K .hdr straight into public/ (it ships as-is). */
async function fetchHdri(id: string): Promise<{ files: string[]; title: string; authors: string }> {
  const info = await json<{ name: string; authors: Record<string, string> }>(`${API}/info/${id}`);
  const files = await json<{ hdri: Record<string, { hdr: FileEntry }> }>(`${API}/files/${id}`);
  const entry = files.hdri?.['1k']?.hdr;
  if (!entry) throw new Error(`${id}: no 1k .hdr on Poly Haven`);
  const rel = join('public', 'assets', 'hdri', `${id}_1k.hdr`);
  await download(entry.url, join(ROOT, rel));
  return { files: [rel], title: info.name, authors: Object.keys(info.authors).join(', ') };
}

async function main(): Promise<void> {
  const hdri = process.argv.includes('--hdri');
  const model = process.argv.includes('--model');
  const ids = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  if (ids.length === 0) {
    console.log('usage: npx tsx scripts/fetch-polyhaven.ts <id> [...]');
    return;
  }
  const manifestPath = join(ROOT, 'assets.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { assets: Array<Record<string, unknown>> };

  for (const id of ids) {
    const fetched = model ? await fetchModel(id) : hdri ? await fetchHdri(id) : await fetchMaterial(id);
    const { files, title, authors } = fetched;
    const built = 'built' in fetched ? fetched.built : `public/assets/materials/${id}/${id}_${RESOLUTION}.glb`;
    const record = {
      files: hdri ? files : [...files, built],
      kind: model ? 'model' : hdri ? 'hdri' : 'texture',
      title,
      author: authors,
      authorUrl: 'https://polyhaven.com',
      source: `https://polyhaven.com/a/${id}`,
      license: 'CC0-1.0',
      changes: model
        ? 'Poly Haven 1K glTF, simplified with LODs and KTX2 textures by scripts/assetbuild.ts; arena set dressing.'
        : hdri
        ? 'Unmodified 1K HDR; used as the environment (image-based) lighting, not shown as the sky.'
        : 'Poly Haven 2K glTF, recompressed to KTX2 by scripts/assetbuild.ts; tiled in world space on the arena.',
    };
    const existing = manifest.assets.findIndex((a) => a.source === record.source);
    if (existing >= 0) manifest.assets[existing] = record;
    else manifest.assets.push(record);
    console.log(`✓ ${id}: ${title} by ${authors} (${files.length} files)`);
  }
  // The built .glb is listed already; run `npm run assetbuild` before the
  // licence check, which fails on a listed file that does not exist yet.
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

await main();
