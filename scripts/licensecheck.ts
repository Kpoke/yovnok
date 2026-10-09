/**
 * Asset licence gate.
 *
 *   npm run licensecheck            # verify; non-zero exit on any problem
 *   npm run licensecheck -- --write # regenerate ASSETS.md and public/credits.json
 *   npm run licensecheck -- --selftest
 *
 * CONVOY is GPL-3.0-or-later and every asset it ships must be redistributable
 * alongside it, with credit. `assets.json` is the single source of truth: one
 * entry per asset, naming its files, author, source and SPDX licence. From it this
 * script generates the human credits (`ASSETS.md`) and the in-game credits
 * screen's data (`public/credits.json`), so the three can never disagree.
 *
 * It FAILS when:
 *   - a media file under `public/` or `assets-src/` is not listed (an asset got in
 *     without a licence record);
 *   - a listed file does not exist;
 *   - a licence is NonCommercial or NoDerivatives, or not on the allowlist;
 *   - an entry is missing a field credit depends on;
 *   - the generated files are stale (run with --write).
 */

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { CreditsSection } from '../src/shared/credits';

const ROOT = join(import.meta.dirname, '..');
const MANIFEST = join(ROOT, 'assets.json');
const CREDITS_MD = join(ROOT, 'ASSETS.md');
const CREDITS_JSON = join(ROOT, 'public', 'credits.json');

/** Folders whose media must be accounted for. */
const SCANNED = ['public', 'assets-src'];
/** Generated or vendored code, not assets (see scripts/vendor.mjs). */
const IGNORED_DIRS = ['public/libs'];
/** File types that are assets. Data files (.json) and docs (.md) are not. */
const MEDIA = /\.(mp3|ogg|oga|wav|flac|m4a|glb|gltf|bin|png|jpe?g|webp|avif|ktx2|basis|hdr|exr|tga|ttf|otf|woff2?|svg|blend|fbx|obj|mtl)$/i;

type LicenceInfo = { name: string; url: string };

/**
 * Licences compatible with shipping inside a GPL-3 project. NC is out because
 * GPL-3 grants commercial use; ND is out because assets get modified (split into
 * parts, recompressed). Anything else must be added here deliberately.
 */
const LICENCES: Record<string, LicenceInfo> = {
  'CC0-1.0': { name: 'CC0 1.0', url: 'https://creativecommons.org/publicdomain/zero/1.0/' },
  'CC-BY-3.0': { name: 'CC BY 3.0', url: 'https://creativecommons.org/licenses/by/3.0/' },
  'CC-BY-4.0': { name: 'CC BY 4.0', url: 'https://creativecommons.org/licenses/by/4.0/' },
  'CC-BY-SA-3.0': { name: 'CC BY-SA 3.0', url: 'https://creativecommons.org/licenses/by-sa/3.0/' },
  'CC-BY-SA-4.0': { name: 'CC BY-SA 4.0', url: 'https://creativecommons.org/licenses/by-sa/4.0/' },
  'OFL-1.1': { name: 'SIL OFL 1.1', url: 'https://openfontlicense.org/' },
  MIT: { name: 'MIT', url: 'https://opensource.org/license/mit' },
  'Apache-2.0': { name: 'Apache 2.0', url: 'https://www.apache.org/licenses/LICENSE-2.0' },
  'GPL-3.0-or-later': { name: 'GPL-3.0-or-later', url: 'https://www.gnu.org/licenses/gpl-3.0.html' },
};

const KINDS = ['music', 'sound', 'model', 'texture', 'hdri', 'image', 'font'] as const;
type Kind = (typeof KINDS)[number];

/** Section headings on the credits screen, in display order. */
const HEADINGS: Record<Kind, string> = {
  model: '3D MODELS',
  texture: 'TEXTURES',
  hdri: 'SKIES & LIGHTING',
  image: 'IMAGES',
  music: 'MUSIC',
  sound: 'SOUND EFFECTS',
  font: 'FONTS',
};

export type AssetEntry = {
  files: string[];
  kind: Kind;
  title: string;
  author: string;
  authorUrl?: string;
  source: string;
  license: string;
  changes: string;
};


// ------------------------------------------------------------------ checks

export function validateEntries(entries: AssetEntry[], exists: (path: string) => boolean): string[] {
  const errors: string[] = [];
  const seen = new Map<string, string>();

  entries.forEach((entry, index) => {
    const label = `assets.json #${index + 1} (${entry.title ?? 'untitled'})`;
    for (const field of ['title', 'author', 'source', 'license', 'changes'] as const) {
      if (typeof entry[field] !== 'string' || entry[field].trim() === '') {
        errors.push(`${label}: missing "${field}"`);
      }
    }
    if (!KINDS.includes(entry.kind)) {
      errors.push(`${label}: kind "${entry.kind}" is not one of ${KINDS.join(', ')}`);
    }
    if (typeof entry.source === 'string' && !/^https?:\/\//.test(entry.source)) {
      errors.push(`${label}: source must be a URL, so the credit can link to it`);
    }

    const licence = String(entry.license ?? '');
    if (/(^|-)NC(-|$)/i.test(licence)) {
      errors.push(`${label}: ${licence} is NonCommercial, which conflicts with GPL-3; remove the asset`);
    } else if (/(^|-)ND(-|$)/i.test(licence)) {
      errors.push(`${label}: ${licence} is NoDerivatives; assets are modified on import, so it cannot be used`);
    } else if (!LICENCES[licence]) {
      errors.push(
        `${label}: licence "${licence}" is not on the allowlist (${Object.keys(LICENCES).join(', ')}). ` +
          'Use an SPDX id; add a new licence to scripts/licensecheck.ts only after checking GPL-3 compatibility',
      );
    }

    if (!Array.isArray(entry.files) || entry.files.length === 0) {
      errors.push(`${label}: lists no files`);
      return;
    }
    for (const file of entry.files) {
      const earlier = seen.get(file);
      if (earlier) errors.push(`${label}: ${file} is already listed under "${earlier}"`);
      seen.set(file, entry.title);
      if (!exists(file)) errors.push(`${label}: ${file} does not exist`);
    }
  });
  return errors;
}

/** Media files on disk that no entry accounts for. */
export function unlisted(onDisk: string[], entries: AssetEntry[]): string[] {
  const listed = new Set(entries.flatMap((e) => e.files ?? []));
  return onDisk.filter((file) => !listed.has(file));
}

function scan(dir: string, out: string[] = []): string[] {
  const abs = join(ROOT, dir);
  if (!existsSync(abs)) return out;
  for (const name of readdirSync(abs)) {
    const rel = `${dir}/${name}`;
    if (IGNORED_DIRS.includes(rel)) continue;
    if (statSync(join(ROOT, rel)).isDirectory()) scan(rel, out);
    else if (MEDIA.test(name)) out.push(rel);
  }
  return out;
}

// --------------------------------------------------------------- generation

/** Group by kind, author and licence, so attribution reads once per group. */
export function creditsSections(entries: AssetEntry[]): CreditsSection[] {
  const groups = new Map<string, AssetEntry[]>();
  for (const kind of Object.keys(HEADINGS) as Kind[]) {
    for (const entry of entries.filter((e) => e.kind === kind)) {
      const key = `${kind}|${entry.author}|${entry.license}`;
      groups.set(key, [...(groups.get(key) ?? []), entry]);
    }
  }
  return [...groups.values()].map((group) => {
    const first = group[0];
    const licence = LICENCES[first.license];
    return {
      heading: HEADINGS[first.kind],
      items: group.map((e) => ({ title: e.title, source: e.source })),
      attribution: first.authorUrl ? `${first.author} (${first.authorUrl.replace(/^https?:\/\//, '')})` : first.author,
      license: licence?.name ?? first.license,
      licenseUrl: licence?.url ?? '',
    };
  });
}

export function creditsMarkdown(entries: AssetEntry[]): string {
  const lines = [
    '# Asset credits',
    '',
    '<!-- Generated by `npm run licensecheck -- --write` from assets.json. Do not edit by hand. -->',
    '',
    "CONVOY's code is free software under **GPL-3.0-or-later** (see `LICENSE`). The",
    'assets below are **not** original to this project. Each is redistributed under its',
    'own licence, listed with its author, source and any changes made.',
    '',
    'To add an asset: put the file in `assets-src/` or `public/`, add an entry to',
    '`assets.json`, and run `npm run licensecheck -- --write`. Only CC0, CC BY,',
    'CC BY-SA, OFL, MIT or Apache-2.0 assets are accepted; **NonCommercial (NC) and',
    'NoDerivatives (ND) licences are rejected** by the check, which runs in',
    '`npm run check` and `npm run build`.',
  ];
  for (const kind of Object.keys(HEADINGS) as Kind[]) {
    const group = entries.filter((e) => e.kind === kind);
    if (group.length === 0) continue;
    lines.push('', `## ${HEADINGS[kind].charAt(0)}${HEADINGS[kind].slice(1).toLowerCase()}`, '');
    lines.push('| Title | Author | Licence | Changes | Files |', '|---|---|---|---|---|');
    for (const e of group) {
      const licence = LICENCES[e.license];
      const author = e.authorUrl ? `[${e.author}](${e.authorUrl})` : e.author;
      const files = e.files.map((f) => `\`${f}\``).join('<br>');
      lines.push(
        `| [${e.title}](${e.source}) | ${author} | [${licence?.name ?? e.license}](${licence?.url ?? ''}) | ${e.changes} | ${files} |`,
      );
    }
  }
  return `${lines.join('\n')}\n`;
}

// --------------------------------------------------------------------- main

/** Prove the gate rejects what it must, on synthetic entries. */
function selftest(): number {
  const good: AssetEntry = {
    files: ['a.mp3'],
    kind: 'music',
    title: 'Good',
    author: 'Someone',
    source: 'https://example.com/a',
    license: 'CC-BY-4.0',
    changes: 'None.',
  };
  const all = (): boolean => true;
  const cases: [string, boolean][] = [
    ['a complete CC BY entry passes', validateEntries([good], all).length === 0],
    ['NonCommercial is rejected', validateEntries([{ ...good, license: 'CC-BY-NC-4.0' }], all).some((e) => e.includes('NonCommercial'))],
    ['NoDerivatives is rejected', validateEntries([{ ...good, license: 'CC-BY-ND-4.0' }], all).some((e) => e.includes('NoDerivatives'))],
    ['NC-SA is rejected', validateEntries([{ ...good, license: 'CC-BY-NC-SA-4.0' }], all).length > 0],
    ['an unknown licence is rejected', validateEntries([{ ...good, license: 'Royalty-Free' }], all).some((e) => e.includes('allowlist'))],
    ['a missing author is rejected', validateEntries([{ ...good, author: '' }], all).some((e) => e.includes('"author"'))],
    ['a non-URL source is rejected', validateEntries([{ ...good, source: 'my drive' }], all).some((e) => e.includes('URL'))],
    ['a listed file that does not exist is rejected', validateEntries([good], () => false).some((e) => e.includes('does not exist'))],
    ['a file listed twice is rejected', validateEntries([good, { ...good, title: 'Dup' }], all).some((e) => e.includes('already listed'))],
    ['an unlisted file on disk is reported', unlisted(['a.mp3', 'b.glb'], [good]).join() === 'b.glb'],
  ];
  let failures = 0;
  for (const [name, ok] of cases) {
    console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}`);
    if (!ok) failures++;
  }
  console.log(failures === 0 ? '\n✓ licence gate selftest passed' : `\n✗ ${failures} selftest failure(s)`);
  return failures === 0 ? 0 : 1;
}

function main(): number {
  if (process.argv.includes('--selftest')) return selftest();
  const write = process.argv.includes('--write');
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8')) as { assets?: AssetEntry[] };
  const entries = manifest.assets ?? [];

  const errors = validateEntries(entries, (file) => existsSync(join(ROOT, file)));
  const onDisk = SCANNED.flatMap((dir) => scan(dir));
  for (const file of unlisted(onDisk, entries)) {
    errors.push(`${file} is not listed in assets.json — every asset needs a licence record`);
  }

  const markdown = creditsMarkdown(entries);
  const json = `${JSON.stringify({ sections: creditsSections(entries) }, null, 2)}\n`;
  const stale = (path: string, text: string): boolean =>
    !existsSync(path) || readFileSync(path, 'utf8') !== text;

  if (write) {
    writeFileSync(CREDITS_MD, markdown);
    writeFileSync(CREDITS_JSON, json);
    console.log(`wrote ${relative(ROOT, CREDITS_MD)} and ${relative(ROOT, CREDITS_JSON)}`);
  } else {
    for (const path of [CREDITS_MD, CREDITS_JSON]) {
      if (stale(path, path === CREDITS_MD ? markdown : json)) {
        errors.push(`${relative(ROOT, path)} is out of date — run: npm run licensecheck -- --write`);
      }
    }
  }

  const licences = new Set(entries.map((e) => e.license));
  console.log(
    `licensecheck: ${entries.length} assets, ${onDisk.length} media files, licences: ${[...licences].join(', ') || 'none'}`,
  );
  if (errors.length > 0) {
    for (const error of errors) console.error(`  ✗ ${error}`);
    console.error(`\n✗ ${errors.length} licence problem(s)`);
    return 1;
  }
  console.log('✓ every asset is listed, credited and under an allowed licence');
  return 0;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop() ?? '')) {
  process.exit(main());
}
