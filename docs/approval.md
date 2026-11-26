# Kekborn approval package (v2)

`tools/approval.cjs` turns the compositor's full-size renders into what the owner is shown: 24 JPEG previews, one contact sheet and a manifest of every file. It is plain Node with no dependencies; the JPEG encoder and decoder are in `src/jpeg/` (see `src/jpeg/README.md`), PNG reading is `src/raster`.

```sh
node tools/approval.cjs preview <master.png> <out.jpg>
node tools/approval.cjs sheet    [package-root]
node tools/approval.cjs manifest [package-root]
node tools/approval.cjs verify   [package-root]
```

`package-root` defaults to the repository that holds the tool. A failed command prints what was wrong, exits 1 and leaves any earlier output file as it was: outputs are written beside the target and renamed into place.

## The order to run it in

1. Render each of the twelve inputs in `sample-inputs/` twice with the compositor, plain and harmonised, to 2048×2560 PNG masters. Put them somewhere that is not committed; `out/` is skipped by the manifest.
2. `preview` each master to `samples/NN-plain.jpg` and `samples/NN-harmonised.jpg`, NN from 01 to 12.
3. `sheet`.
4. `manifest`, once every other file is final.
5. `verify`.

```sh
for n in 01 02 03 04 05 06 07 08 09 10 11 12; do
  node tools/approval.cjs preview out/$n-plain.png      samples/$n-plain.jpg
  node tools/approval.cjs preview out/$n-harmonised.png samples/$n-harmonised.jpg
done
node tools/approval.cjs sheet && node tools/approval.cjs manifest && node tools/approval.cjs verify
```

## preview

Reads one PNG that must be exactly 2048×2560 and writes a 1024×1280 baseline JPEG at quality 90, 4:4:4, with no metadata. Paths are taken as given, relative to the working directory.

Each output pixel is the mean of one exact 2×2 block of the master, so nothing is skipped or sampled twice. A master should be opaque; where it is not, colour is multiplied by alpha, which is a flatten over black. The same master always gives the same bytes. A preview that would reach 4,000,000 bytes is refused rather than written.

## sheet

Reads `samples/NN-plain.jpg` and `samples/NN-harmonised.jpg` for 01 to 12, each of which must decode and be 1024×1280, and writes `contact-sheet.jpg`.

| | |
| --- | --- |
| Layout | four columns by three rows, 01 to 04 on the top row, 09 to 12 on the bottom |
| Cell | the plain portrait on the left, an 8-pixel gap, the harmonised portrait on the right, 1032×640 |
| Portrait in a cell | 512×640, each pixel the mean of a 2×2 block of the preview |
| Gutter and border | 32 pixels of `#16120F` |
| Sheet | 4288×2048 |
| Number | the study's two digits, cream on a dark plate, top-left of the cell |
| Tags | a small `P` and `H` at the bottom-left of the plain and harmonised halves |

The numbers and tags are a 5×7 bitmap font drawn by the tool. They are labels, not artwork, and nothing else on the sheet is drawn.

The sheet is encoded at quality 90. If that reaches 4,000,000 bytes the tool steps down through 85, 80, 75, 70, 65 and 60 and keeps the first that fits, and fails if none does. A sheet of twelve noisy test pairs came to under 1 MB at 90.

## manifest

Writes `manifest.json`:

```json
{ "algorithm": "sha256", "files": [ { "path": "bin/render.cjs", "bytes": 1234, "sha256": "…" } ] }
```

`files` holds the path, byte length and sha256 of every regular file but `manifest.json` itself, sorted by path. The walk skips root entries whose names start with a dot (`.git`, `.imd-blocked.json`, …) and the root-relative trees `artifacts/`, `node_modules/`, `out/` and `test/scratch/`. A dot-file or an `out/` directory deeper in the tree is listed like anything else. Symlinks are not followed or listed.

Before writing, it checks that the studies are still tied to their inputs:

- each of 01 to 12 has exactly one input, at `sample-inputs/NN.json` (where they live), `samples/inputs/NN.json`, `samples/NN.input.json` or `inputs/NN.json`;
- at most one sidecar, at `samples/NN.json`, `samples/NN.sidecar.json` or `samples/NN.png.json`, whose `input` equals the parsed input whatever the key order;
- if the full-size `samples/NN.png` is in the package, there is a sidecar and its `pngSha256` matches that PNG. v2 does not commit those PNGs, so normally nothing is asked here.

It does not look for the previews or the sheet; `verify` does.

## verify

Walks the package the same way, hashes what is there and reports every problem it finds, one per line:

| Line starts | Meaning |
| --- | --- |
| `Missing file:` | in the manifest, not on disk |
| `Extra file:` | on disk, not in the manifest |
| `Changed file:` | byte length or sha256 differs from the manifest |
| `Wrong size:` | a `samples/NN-plain.jpg` or `samples/NN-harmonised.jpg` whose frame header is not 1024×1280 |
| `Unreadable preview:` | such a file with no readable JPEG frame header |
| `Missing sheet:` | no `contact-sheet.jpg` |
| `Missing preview:` | one of the 24 previews is absent |
| `Too large:` | a preview or the sheet of 4,000,000 bytes or more, or any file, `manifest.json` included, of 8,000,000 or more |

A malformed manifest (bad JSON, an entry without `path`, `bytes` and a 64-digit `sha256`, entries out of order or repeated) fails before anything is compared.

One exception, kept so the v1 fixtures in `test/approval/sample-inputs.test.cjs` still verify: a package with `contact-sheet.png`, no `contact-sheet.jpg` and no JPEG preview at all is taken to be a v1 package, and the sheet and preview lines are not raised for it. As soon as one preview or the JPEG sheet exists, all 24 previews and the sheet are required.

`verify` reads preview dimensions from the frame header and does not decode the pictures; `sheet` decodes all of them. It compares against the manifest it is given, so keep a trusted copy of `manifest.json` when checking a package that has travelled.

## Tests

```sh
node --test test/approval/*.test.cjs
```

- `approval.test.cjs`: `preview` (size, baseline frame, quality-90 table, 2×2 averaging on a one-pixel checkerboard, alpha, corners, repeatable bytes, refusals); `sheet` (dimensions, which colour lands in which half of which cell, gutters, the number read back off the decoded sheet glyph by glyph, refusals that leave the old sheet); `manifest` (exact contents, skipped trees, input and sidecar rules); `verify` (each line in the table above, and the limits at exactly one byte either side).
- `jpeg.test.cjs`: the codec on its own.
- `sample-inputs.test.cjs`: the real `sample-inputs/NN.json` files through `manifest` and `verify`. Unchanged from v1.

## Not done here

No previews, sheet or manifest are committed by this change: the repainted layers and the harmonisation pass they depend on had not landed when it was written. The tool has only been run on synthetic test images.
