# Vehicle Asset Spec

The contract any vehicle part must satisfy — procedural code, a parametric
generator, an artist, or an AI 3D tool. **Enforced by `npm run assetcheck`, not
by eye.** An asset that fails here will break collision, seats or cameras if it
gets in, which is why this is a gate rather than a guideline.

---

## Conventions

**Axes** (three.js, matching the simulation):

| | |
|---|---|
| `+X` | the vehicle's right |
| `-Z` | forward |
| `+Y` | up |
| 1 unit | 1 metre |

**Origins.** Parts are modelled around their **own origin**, because the rig
positions them. Getting this wrong puts a wheel through the roof even when the
shape is perfect.

| Part | Origin at |
|---|---|
| `chassis` | the chassis centre, `rideHeight` above the ground |
| `wheel` | the axle centre, so it can spin |
| `seat` | the seat cushion |
| `engine` | the block centre |

**Scale.** One metre per unit, taken from `VEHICLE_CLASSES`. A part that needs
rescaling on import is a part that will break hit-testing — do not ship one.

**Format.** Binary `.glb`. `assetcheck` also reads `.gltf` JSON.

---

## Parts

There are two tiers. **Standard** budgets are deliberately tiny — the original
low-poly look, up to 8 vehicles on screen at 60fps with shadows. For scale, a
typical AI text-to-3D mesh is **50k–200k triangles**, roughly 100× those budgets.

The **hero** tier is for realistic art. It buys a much larger budget (measured on
`lod0`, the closest detail level) by also shipping what keeps a field of realistic
cars affordable: lower-detail copies for distance, compressed geometry, and
textures that stay compressed in video memory. `npm run assetbuild` produces all
of that from a source model (see [Hero tier](#hero-tier-realistic-art)).

| Part | Standard | Hero (lod0) |
|---|---|---|
| `chassis` | 2 200 | 60 000 |
| `engine` | 500 | 8 000 |
| `wheel` | 600 | 6 000 |
| `seat` | 300 | 4 000 |

The per-part sections below give the standard budget.

### `chassis`

The hull, greenhouse and interior. Includes the pillars; the window apertures are
the gaps between them.

- **Bounds:** `±halfWidth` × `boxHeight` × `±halfLength` (from the class spec), ±20%
- **Budget:** 2200 triangles
- **Sockets:** `exhaust.left`, `exhaust.right`, `decal.left`, `decal.right`, `roofRack`
- **Materials:** `body`, `bodyDark`, `trim`, `glass`, `interior`, `metal`, `lamp`, `tailLamp`

### `wheel`

One wheel, reused at all four corners.

- **Bounds:** `2×wheelRadius` diameter, width a fraction of it, ±25%
- **Budget:** 600 triangles
- **Sockets:** `rim`
- **Materials:** `wheel`, `hub`, `metal`

### `seat`

One crew position. `side` decides which window it faces, so the same mesh serves
left and right (mirror it, do not re-author it).

- **Bounds:** roughly 0.8 × 0.7 × 0.8 m, ±30%
- **Budget:** 300 triangles
- **Sockets:** `eye` (per-seat camera anchor), `firePort` (weapon origin)
- **Materials:** `seat`

### `engine`

A damageable module: destroy it and power and boost drop.

- **Bounds:** roughly 1.2 × 0.8 × 1.15 m, ±35%
- **Budget:** 500 triangles
- **Sockets:** `intake`, `exhaustPort.left`, `exhaustPort.right`
- **Materials:** `metal`, `bodyDark`, `hub`

### `turret`

The visible car-mounted gun, for a class whose seat has `mounted` weapons. The
rig places it at the seat's `turret` position (`src/shared/crews.ts`), and the
seat's `firePort` should be its muzzle so shots leave where the barrel is drawn.

- **Origin:** the base, where it meets the roof; the barrel points **-Z**
- **Budget:** 1500 triangles (hero 8000)
- **Sockets:** `muzzle`
- **Materials:** `metal`, `bodyDark`

---

## Sockets

Sockets are **plain nodes with these exact names**. They are how gameplay finds
things:

| Socket | Used by |
|---|---|
| `eye` | per-seat camera (M4) |
| `firePort` | weapon origin and window arc (M5) |
| `rim` | wheel cosmetics |
| `exhaust.*` / `decal.*` / `roofRack` | cosmetic attachment points (M12) |

A missing socket is a **warning, not an error** — the asset still renders, but the
feature that depends on it is silently disabled. `assetcheck` names which ones.

## Material slots

Materials must be **named after the slot** they represent. The loader swaps them
at runtime, which is how an accent colour reaches an asset and how cosmetics
recolour it later. An asset with no matching material names validates with a
warning and renders in whatever colours it shipped with.

Available slots: `body`, `bodyDark`, `trim`, `glass`, `interior`, `seat`,
`metal`, `wheel`, `hub`, `lamp`, `tailLamp`.

---

## Validating

```bash
npm run assetcheck -- assets/coupe-body.glb chassis coupe
npm run assetcheck -- --selftest          # proves the validator rejects bad input
```

It reports measured size, triangle count and node count, then lists warnings and
errors. Exit code is non-zero on failure, so it drops into CI unchanged.

What it checks: **per-axis extent**, **origin placement**, **triangle budget**,
**node transforms** (warns if unbaked), **required sockets**, **material slots**.

Add `--tier hero` for realistic assets: `npm run assetcheck -- public/assets/vehicles/truck/chassis.glb chassis suv --tier hero`.

What it cannot check: whether the thing looks good. That needs your eye.

---

## Hero tier (realistic art)

Realistic models go through a build step instead of being dropped in by hand.

```bash
# 1. put the editable original in assets-src/ (kept: GPL-3 wants the source form)
assets-src/vehicles/truck/chassis.glb
# 2. build: writes public/assets/vehicles/truck/chassis.glb
npm run assetbuild -- vehicles/truck/chassis.glb
# 3. validate against the hero budget and rules
npm run assetcheck -- public/assets/vehicles/truck/chassis.glb chassis suv --tier hero
# 4. record the licence (both files), regenerate credits
npm run licensecheck -- --write
```

What `assetbuild` does:

| Step | Result |
|---|---|
| clean-up | dedup, prune, weld — no visual change |
| LODs | `lod0` (full), `lod1` (~35%), `lod2` (~10%, mesh permitting), as the scene's root nodes |
| textures | resized to ≤ 2048 px, converted to **KTX2** (UASTC + zstd for normal/ORM maps, ETC1S for colour), with mipmaps |
| geometry | quantised + `EXT_meshopt_compression` |

Optional sidecar `assets-src/…/chassis.asset.json`:
`{ "lods": [0.35, 0.1], "maxTexture": 2048, "ktx2": true }` (`"lods": []` skips LODs).

**Hero rules** (`HERO_RULES` in `src/shared/assetSpec.ts`), enforced by
`assetcheck --tier hero`: at least `lod0` + 2 LODs, `lod1` ≤ 50% and the farthest
≤ 25% of `lod0`'s triangles, `EXT_meshopt_compression` geometry, and KTX2
(`KHR_texture_basisu`) textures.

**Prep scripts.** A downloaded model rarely arrives in game convention. A script
in `scripts/prep/` turns the untouched download in `assets-src/**/original/` into
the part files `assetbuild` reads — scaled, turned to face -Z, split into parts,
with sockets added. `scripts/prep/armored.ts` is the worked example (the solo
class's armoured truck and its roof turret). `assetbuild` skips `original/`.

**Manifest options for realistic parts:** `"paint": ["exterior"]` tints those
materials toward the livery (`paintStrength`, default 0.45); `"baseTint"` applies
a fixed colour per material (e.g. to match a part taken from another model).
A wheel entry keyed `<class>/wheel` serves every cosmetic wheel style; the rig
mirrors the wheel on the right side, so author it with the hub facing -X.

**In the game**, `GltfPartLibrary` turns `lod0/lod1/lod2` into a `THREE.LOD`
(switching at 0 / 30 / 80 m; override per part with `"lodDistances"` in the
manifest), and `src/client/assetLoaders.ts` registers the meshopt and KTX2
decoders. Sockets are read from `lod0`; the build renames copies on other levels
(`roofRack@lod1`) so they never shadow the real one.

---

## Licences

Every asset — source and built file alike — must be listed in **`assets.json`**
with its author, source URL, SPDX licence and the changes made. `npm run
licensecheck` (part of `npm run check` and `npm run build`) fails on an unlisted
file, a missing file, or an **NC / ND** licence, and keeps **`ASSETS.md`** and the
in-game **CREDITS** screen (`public/credits.json`) generated from that one list.
Allowed: CC0, CC BY, CC BY-SA, OFL, MIT, Apache-2.0.

---

## Adding an asset

1. Export part(s) as `.glb` matching the conventions above. Realistic parts: put
   them in `assets-src/` and run `npm run assetbuild` (see [Hero tier](#hero-tier-realistic-art)).
2. Validate each: `npm run assetcheck -- <file> <kind> <class>` (`--tier hero` for realistic parts).
3. Drop it under `public/assets/vehicles/`.
4. List it in `assets.json` and run `npm run licensecheck -- --write`.
5. Register it in `public/assets/vehicles/manifest.json`:

```json
{
  "version": 1,
  "parts": {
    "coupe/chassis": { "file": "coupe-body.glb" },
    "suv/wheel":     { "file": "wheels/offroad.glb", "scale": 1 },
    "seat.right.armed": { "file": "seats/sparco.glb", "node": "SeatR" }
  }
}
```

Keys are `<class>/<part>`, or a bare part name to apply to every class. `node`
selects one object out of a multi-part file; `scale`/`offset` exist only to rescue
near-miss assets and should be `1`/absent for conformant ones.

Anything the manifest cannot satisfy **falls back to procedural geometry per
part**, so a half-finished asset set never leaves a car missing a wheel.

---

## Notes on AI-generated meshes

Useful for **concept art and PBR textures** (`Firefly`, `Substance`). For the
vehicles themselves, three problems recur:

1. **Budget.** 50k–200k triangles versus a 2200 budget.
2. **Structure.** They arrive as one welded mesh. This game needs swappable
   wheels, kits and spoilers — a part library, not a statue.
3. **Unbaked transforms and no named nodes**, so no sockets.

If you do generate: ask for **low-poly / game-ready**, request **separate
objects** per part, keep materials **named after slots**, and run everything
through `assetcheck` before it goes near the game. Parametric generators
(`Sloyd`) are a better fit than image-to-3D because they emit part hierarchies.
