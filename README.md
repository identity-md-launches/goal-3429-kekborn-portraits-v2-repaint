# Kekborn portraits v2

This repository renders Kekborn portraits. A Kekborn is an original anthropomorphic frog noble painted as a
16th-century Tudor court oil portrait: half-length, three-quarter view facing left, 2048 × 2560 (4:5).
Every portrait is a stack of full-canvas transparent layers (backdrop, banner, skin, eyes, expression,
attire, headwear, regalia, props and frame) painted by an image model from one locked prompt. Two
procedural coats of arms go on top, and one shared oil-paint finish is applied at the end. The repository
is plain Node (24 is what it is tested with) and needs no dependencies, network or chain access.
Nothing in it deploys, mints or spends.

| Path | What it holds |
| --- | --- |
| `style-guide.md` | the locked prompt, negative prompt, palette and the registration rules every layer follows |
| `template/` | the bust template: `bust.svg` (registration grid and reserves) and `master-reference.png/.json` (the painted reference bust and its landmarks) |
| `layers/` | the painted layer library: skins, eyes, expressions (`<name>.png` with `<name>.skin.png` beneath it), attire per category, headwear, regalia and frame per tier, backdrops, banners, heraldry parts |
| `catalog/*.json` | the asset registry, schema `kekborn-assets@1` (see `docs/render.md`) |
| `src/compositor`, `bin/render.cjs` | the deterministic renderer |
| `src/raster` | the PNG codec, compositing, and the finish: glaze, brush texture, varnish, craquelure and frame shadow (`docs/finish.md`) |
| `src/heraldry` | the seeded arms on the banner and the frame rail |
| `src/harmonise`, `bin/harmonise.cjs` | the optional low-strength image-to-image harmonisation (`docs/harmonise.md`) |
| `src/jpeg`, `tools/approval.cjs` | the previews, contact sheet, manifest and verification for the owner's approval (`docs/approval.md`) |
| `sample-inputs/01.json` … `12.json` | the twelve studies rendered for approval |
| `provenance/` | per-target painting records: model, prompt suffix, seed, cut-out method, hashes. `baseline.json` holds the code-drawn v1 imports. `integration.json` holds the review of the assembled library |
| `docs/painting.md` | the painting contract every layer follows |

## Render a portrait

```sh
node bin/render.cjs sample-inputs/01.json out/01-plain.png
```

This writes `out/01-plain.png`, a 2048 × 2560 RGBA PNG, and `out/01-plain.json`, a record of every layer used
with its sha256. The same input and repository always give the same bytes. An input names a `wallet`, a `tier`
(`common` … `legendary`), a `traits.category` (`scholar`, `antiquary`, `knight`, `artisan`, `seer`, `council`)
and an `artSeed`. It may also pin `genetics.skin`, `genetics.eyes`, `traits.expression`, `traits.background`
and `traits.banner` by asset ID. A slot left unpinned is drawn from the seed. The input format, the stack order
and the exit codes are in `docs/render.md`.

Render all twelve studies:

```sh
for n in 01 02 03 04 05 06 07 08 09 10 11 12; do
  node bin/render.cjs sample-inputs/$n.json out/$n-plain.png
done
```

Keep full-size masters in `out/`. It is not committed: the masters are reproducible from the compositor.

## Harmonise (optional)

Harmonisation is an image-to-image pass applied after the finish at low strength. It knits the layers
together further. The plain render never needs it.

```sh
node bin/harmonise.cjs request out/01-plain.png out/01-request.json
# give the model out/01-plain.png with the locked prompt and negative prompt from the request,
# strength 0.22 (never above 0.30), seed 1536, full 2048 × 2560 canvas, aperture as the mask if supported;
# save its output as out/01-model.png and record the model, version and settings
node bin/harmonise.cjs apply out/01-plain.png out/01-model.png out/01-harmonised.png
```

`apply` runs offline. It mixes at most 22% of the model's colour inside the frame aperture, feathered over 64 px,
and leaves the frame rails, plaque and rail arms byte-identical to the plain render (`docs/harmonise.md`).

## Build the approval previews

```sh
for n in 01 02 03 04 05 06 07 08 09 10 11 12; do
  node tools/approval.cjs preview out/$n-plain.png      samples/$n-plain.jpg
  node tools/approval.cjs preview out/$n-harmonised.png samples/$n-harmonised.jpg
done
node tools/approval.cjs sheet      # contact-sheet.jpg: all twelve, plain beside harmonised
node tools/approval.cjs manifest   # manifest.json: path, bytes and sha256 of every file
node tools/approval.cjs verify
```

Each preview is a 1024 × 1280 JPEG at quality 90 and stays under 4 MB, and so does the sheet. No committed
file may reach 8 MB. Layers stay under 7.9 MB (`docs/painting.md`).

## Verify

```sh
node --test test/*/*.test.cjs
```

- `test/library/library.test.cjs` proves the painted library whole. It checks that every catalog `path` and
  `skinPaint` exists, that every layer PNG decodes at 2048 × 2560 and is under 7.9 MB, and that no repository
  file reaches 8,000,000 bytes. It also checks the registrations: six skins with ivory and oxblood rare, the ten
  named expressions (melancholy, smug, paranoid side-eye, dim grin, scowl, serene, startled, regal, sly,
  weeping), eight eyes, five backdrops, three banners, five frames (one per tier), and headwear and regalia for
  every tier. Every layer PNG listed in `provenance/baseline.json` that is still present must differ from the
  imported code-drawn file. All twelve sample inputs must render.
- `test/compositor` covers the renderer and the real catalog. `test/raster` covers the codec and the finish.
  `test/heraldry` covers the arms and their legibility. `test/harmonise` covers the harmonisation apply step.
  `test/approval` covers previews, sheet, manifest and verify.

`node tools/approval.cjs verify` checks a finished package against its `manifest.json`.

## Painting new layers

Read `style-guide.md` and `docs/painting.md` first. Use the locked prompt and negative prompt verbatim, followed by
a layer-specific suffix. Paint attire, headwear, regalia and props onto `template/master-reference.png` by
inpainting, then cut each one out to a full-canvas transparent PNG. Register it in `catalog/` and record its
provenance. Never draw a layer with code and never copy existing artwork. `provenance/integration.json` lists the
layers the integration review found misregistered or not convincingly painted.
