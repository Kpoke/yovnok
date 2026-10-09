/**
 * Loaders for the optimised asset format `scripts/assetbuild.ts` produces.
 *
 * Built assets use EXT_meshopt_compression geometry and KTX2 (Basis Universal)
 * textures. KTX2 stays compressed on the GPU, which is what keeps a realistic
 * car's textures from eating video memory; meshopt keeps its geometry small.
 * Both need a decoder registered on the GLTFLoader, and KTX2 needs the renderer
 * to pick the best GPU format (ASTC/BC7/ETC2…) this machine supports.
 *
 * The Basis transcoder (basis_transcoder.js + .wasm, Apache-2.0, shipped with
 * three.js) is copied to `public/libs/basis/` by `scripts/vendor.mjs` on
 * `npm run dev` and `npm run build`, so it always matches the installed three.
 */

import type * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';

export const BASIS_TRANSCODER_PATH = '/libs/basis/';

let ktx2: KTX2Loader | null = null;

/** A GLTFLoader that reads meshopt geometry and KTX2 textures. */
export function createGltfLoader(renderer: THREE.WebGLRenderer): GLTFLoader {
  if (!ktx2) {
    // One transcoder (and its worker pool) for the whole page.
    ktx2 = new KTX2Loader().setTranscoderPath(BASIS_TRANSCODER_PATH).detectSupport(renderer);
  }
  return new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).setKTX2Loader(ktx2);
}
