# Kekborn approval package

Run these commands from the merged package root with Node.js. The tool uses Node built-ins and the repository's raster API.

```sh
node tools/approval.cjs sheet
node tools/approval.cjs manifest
node tools/approval.cjs verify
```

Each operation accepts an optional package-root argument after the operation name. By default, the root is the repository containing the tool. Finish writing package files before running these commands and keep the package unchanged through verification. A failed operation exits nonzero and reports the relevant path or requirement.

## Contact sheet

The figures are **01, 02, 03, 04, 05, 06, 07, 08, 09, 10, 11, 12** from left to right in a single row. Figure numbers correspond to `samples/01.png` through `samples/12.png`. Refer to each figure's adjacent JSON sidecar for its portrait input.

`sheet` decodes all twelve 2048×2560 masters. Each 256×320 thumbnail covers the entire master, including all four frame rails. An alpha-weighted average of each 8×8 source block yields one output pixel. The row has 16-pixel transparent gutters and measures 3248×320. The tool writes `contact-sheet.png` after all twelve samples pass decoding and dimension checks.

## Manifest and verification

Run `manifest` after the sheet and all source and documentation files are final. It checks for:

- `style-guide.md`, `template/bust.svg`, and `contact-sheet.png`.
- PNGs under `layers/`, catalog JSON files (for example `layers/catalog.json` or `catalogs/skins.json`), and JavaScript compositor source and tests (for example `src/compositor/index.cjs` and `test/compositor.test.cjs`).
- Every numbered sample PNG, one input JSON, and one sidecar JSON per sample. For 01, the accepted input paths are `sample-inputs/01.json` (where the twelve study inputs actually live), `samples/inputs/01.json`, `samples/01.input.json`, and `inputs/01.json`; exactly one of them must exist. The accepted sidecar paths are `samples/01.json`, `samples/01.sidecar.json`, and `samples/01.png.json`. The same patterns apply through 12.

The sidecar's `input` must equal the parsed input JSON, regardless of object key order, and its `pngSha256` must match the sample PNG bytes. The tool then writes `manifest.json` with `algorithm` set to `sha256` and a `files` list ordered lexically by package-relative path. The list covers regular files, including tools, tests, and docs. The scan skips symlinks, VCS internals, task metadata (`artifacts/goal/`, root `.imd` and `.imd-*`), `node_modules/`, and the root `scratch/` and `test/scratch/` trees. The root manifest excludes itself because writing its own digest into the file would change the bytes being hashed.

`verify` independently walks the package and hashes its current files. It fails for missing, extra, or changed files and malformed manifest entries. It compares against the supplied manifest, so retain a trusted copy when checking a transferred package.

## Local checks

Run the fixture tests with:

```sh
node --test test/approval/approval.test.cjs test/approval/sample-inputs.test.cjs
```

The tests exercise numeric figure order, box averaging, all four frame edges, gutters, missing and wrong-size samples, manifest exclusions, sidecar input and digest checks, and detection of missing, extra, and modified files. `sample-inputs.test.cjs` copies the real `sample-inputs/NN.json` files into a fixture package and checks that `manifest` accepts and lists them, refuses a second input for the same study, and refuses a sidecar whose input disagrees.
