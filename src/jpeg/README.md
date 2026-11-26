# src/jpeg

A pure-JavaScript JPEG encoder and decoder in one plain file, `index.cjs`. It needs nothing but Node.

It was written for this repository and is not vendored: no third-party source is copied into it, so it carries no licence of its own and falls under whatever terms cover the rest of the repository. The quantisation and Huffman tables are the example tables of the JPEG standard (ITU-T T.81, Annex K), which every baseline encoder ships.

```js
const { encodeJPEG, decodeJPEG, jpegSize } = require('./src/jpeg/index.cjs');
```

| Call | Result |
| --- | --- |
| `encodeJPEG(image, { quality = 90, subsampling = '444', background = [0, 0, 0], restartInterval = 0 })` | `Buffer` holding a baseline (SOF0) JFIF file |
| `decodeJPEG(bytes)` | `{ width, height, data }`, RGBA8 with alpha 255 |
| `jpegSize(bytes)` | `{ width, height, components, progressive }` from the frame header alone |

`image` is the raster shape `src/raster` uses: `{ width, height, data }` with straight RGBA8 pixels in row-major order.

## Encoder

- Baseline sequential DCT, 8-bit, YCbCr, one interleaved scan, 4:4:4 by default or 4:2:0.
- `quality` is an integer from 1 to 100 and scales the Annex K tables the way the IJG library does; 90 gives a luma table that starts 3, 2, 2, 3.
- JPEG has no alpha. Each pixel is flattened over `background` before encoding.
- The output has no comment, timestamp or other varying field: the same raster and options give the same bytes on every run.

## Decoder

- Baseline, extended sequential and progressive Huffman files, 8-bit, greyscale or three-component, any sampling factors, restart intervals, interleaved or per-component scans.
- Three components are read as YCbCr unless an Adobe marker says RGB. Subsampled chroma is upsampled by replication.
- Lossless, hierarchical, arithmetic-coded, 12-bit and four-component (CMYK) files are refused with an error that says which.

## How it was checked

`test/approval/jpeg.test.cjs` round-trips rasters through both halves, checks the file structure, the restart markers, the alpha flatten, the refusals and one small progressive file.

While it was written, both halves were also compared in `test/scratch/` against jpeg-js 0.4, an independent decoder: files from this encoder (4:4:4 and 4:2:0, with and without restart markers), files from jpeg-js's encoder, and four progressive files with 4:2:0, 4:2:2, 4:4:4 and greyscale sampling, three of them with successive-approximation refinement scans. The two decoders agreed to within 4 levels of 255 on every pixel, the difference being rounding in the inverse DCT and colour conversion. None of that is in the repository: jpeg-js is not a dependency.

Not exercised by any file tried: DC refinement scans, 16-bit quantisation tables, Adobe RGB files and DNL markers (the last are refused).
