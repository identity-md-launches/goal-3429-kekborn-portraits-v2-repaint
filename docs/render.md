# Offline portrait renderer (`bin/render.cjs`)

```
node bin/render.cjs [--root DIR] input.json output.png
```

Renders one 2048×2560 Kekborn portrait from local files only (no network, no chain) and writes:

- `output.png`: RGBA8 PNG, no ancillary chunks, byte-identical for identical input and repository contents;
- `output.json`: the layer record beside it (`output.png` → `output.json`; a name without `.png` gets `.json` appended).

`--root DIR` (or `KEKBORN_ROOT`) selects the repository root that holds `catalog/`, the layer files,
`src/raster/index.cjs` and `src/heraldry/index.cjs`. By default it is the checkout containing `bin/`.

Exit codes: `0` success, `2` invalid input / catalog / selector / missing asset (message `render: E_CODE: …` on
stderr, nothing written), `64` usage, `1` unexpected internal error.

## Input

```json
{
  "wallet": "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed",
  "tier": "legendary",
  "genetics": { "skin": "skin.moss", "eyes": "eyes.amber" },
  "traits": { "category": "scholar", "expression": "expression.smug", "background": "bg.umber", "banner": "banner.oxblood" },
  "artSeed": "kek-001"
}
```

| Field | Rule |
|---|---|
| `wallet` | nonempty string, used exactly as supplied (no checksum or case normalisation) |
| `artSeed` | string (may be empty), used exactly as supplied |
| `tier` | `common`, `uncommon`, `rare`, `epic`, `legendary` (case-insensitive) |
| `traits.category` | required: `scholar`, `antiquary`, `knight`, `artisan`, `seer`, `council` (case-insensitive) |
| `genetics.skin`, `genetics.eyes` | optional full asset ID |
| `traits.expression`, `traits.background`, `traits.banner` | optional full asset ID |

Other keys in `genetics`/`traits` are kept in the record but do not affect rendering.
An explicit ID must exist (`E_UNKNOWN_ID`), belong to the right slot and fit the tier and category (`E_SELECTOR`).

## Seed

`seed = SHA-256(UTF-8(wallet) ‖ UTF-8(artSeed))`, 32 bytes, recorded as lowercase hex. Example: wallet
`0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed`, artSeed `kek-001` →
`0a4562dcb97eb6cd4cdf417a109078ed60682f370b89c29c51b0823502a12314`.

Default choices use labelled draws: `u = uint64BE(SHA-256("kekborn/draw/v1\0" ‖ label ‖ "\0" ‖ seed)[0..8])`,
labels being the slot name (`background`, `banner`, `skin`, `expression`, `eyes`, `headwear`, `regalia`, `frame`).
Candidates are the assets of that slot that fit tier and category, sorted by ID; `u mod Σweight` picks one, weighting
by `rarity` (absent/common 8, uncommon 4, rare 2, epic 1, legendary 1). A draw depends only on its own label and pool.

## Catalog

Every `catalog/*.json` (read in file-name order) is
`{"schema":"kekborn-assets@1","assets":[{id,slot,path,tier?,category?,rarity?,requiresEyes?}]}`.
IDs are unique across files; `path` is relative to the root and must stay inside it; `tier`, `category` and
`requiresEyes` may be a string or an array. An asset without `tier`/`category` fits every tier/category.
Every drawn layer must be a full-canvas 2048×2560 PNG (`E_ASSET_SIZE`) and exist (`E_MISSING_FILE`); all
files are checked before painting. Records with a slot not listed below are ignored. `rarity` must be one of
`common`, `uncommon`, `rare`, `epic`, `legendary`; any other value stops the load with `E_CATALOG`. A file may carry
other top-level fields beside `schema` and `assets` (`catalog/foundation.json` keeps its registration document and
registers `skin.moss` and `frame.common` in its `assets`).

## Stack (back to front)

1. one `background` 2. one `banner` 3. **banner arms** (procedural) 4. all matching `prop-rear`
5. all matching `attire-back` 6. one `skin` 7. one `eyes` 8. one `expression` 9. all matching `attire-front`
10. all matching `accessory` 11. one `headwear` (skipped if none fits) 12. one `regalia` (skipped if none fits)
13. all matching `prop-front` 14. one `frame` 15. **rail arms** (procedural), then `finish(canvas, seed)` once and
`encodePNG`.

Background, banner, skin, eyes, expression and frame are required (`E_MISSING_ASSET`). "All matching" layers are
stacked in ID order.

**requiresEyes.** The expression is resolved before the eyes. An explicit expression whose `requiresEyes` excludes
explicit `genetics.eyes` is an error (`E_INCOMPATIBLE`). A default-drawn expression is drawn only from those
compatible with explicit eyes. Default eyes are drawn from the expression's `requiresEyes` list when it has one.

**Arms.** `require(root/src/heraldry/index.cjs).buildArms(seedBytes, {root})` must return
`{image, choices, usedLayers}`; `image` is a raster `{width,height,data}` composited (scaled) at
`(1500,340,240,288)` on the banner and `(974,2404,100,120)` on the frame rail. `usedLayers` entries are paths
(or objects with `path`) relative to the root; each is hashed and must exist.

Layers are decoded into one reused `2048*2560*4` buffer and composited with `src/raster` synchronously.

## Record (`output.json`)

```
{ schema: "kekborn-render@1", catalogSchema, input, seed, tier, category, canvas,
  layers: [ {index, group, kind:"catalog", id, slot, path, sha256, source, placement}
          | {index, group:"banner-arms"|"rail-arms", kind:"procedural", id, imageSha256, source, placement} ],
  arms: { choices, imageSize, imageSha256, parts:[{path, sha256, …}], placements:{banner, rail} },
  finish: { pass:"raster.finish", count:1, afterLayer }, pngSha256 }
```

`source` is `explicit`, `draw`, `draw:requiresEyes` or `match`. `imageSha256` hashes `"<w>x<h>\0"` followed by the
raw RGBA bytes of the arms image. The JSON uses 2-space indentation, a trailing newline and root-relative paths, so it
is identical between checkouts.

## Tests

`node --test test/compositor/render.test.cjs` builds a private fixture root in the OS temp dir (catalog, layer PNGs,
stub heraldry, raster shim) and does not depend on the shared library.
`node --test test/compositor/real-catalog.test.cjs` loads the real `catalog/` folder and selects layers for all twelve
`sample-inputs/NN.json`, so a catalog file the loader rejects or an asset the samples need but no file registers fails a test.
