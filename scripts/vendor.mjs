/**
 * Copy runtime decoders that must be served as plain files into public/libs/.
 *
 * KTX2Loader loads the Basis transcoder (JS + WASM) by URL at runtime, so it
 * cannot be bundled. Copying it from the installed three.js on every dev/build
 * keeps it in lock-step with the library version. public/libs/ is gitignored
 * and skipped by the licence gate: it is third-party CODE (Apache-2.0, part of
 * the three.js distribution), not an asset.
 */
import { copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const from = join(root, 'node_modules', 'three', 'examples', 'jsm', 'libs', 'basis');
const to = join(root, 'public', 'libs', 'basis');
mkdirSync(to, { recursive: true });
for (const file of ['basis_transcoder.js', 'basis_transcoder.wasm']) {
  copyFileSync(join(from, file), join(to, file));
}
console.log('vendor: basis transcoder → public/libs/basis/');
