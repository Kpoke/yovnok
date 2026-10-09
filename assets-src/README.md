# assets-src

Editable source models (`.glb` / `.gltf`), kept in the repository because GPL-3
asks for the preferred form for modification. `npm run assetbuild` turns each
one into a game-ready file at the same relative path under `public/assets/`
(LODs, KTX2 textures, meshopt geometry). An optional `<name>.asset.json` sidecar
tunes the build.

Every file here must be listed in `/assets.json`; see `ASSET_SPEC.md` § Hero tier.
