'use strict';

/**
 * Pure-JS JPEG codec for the approval previews. No dependencies.
 *
 * Raster = { width, height, data: Uint8Array }, straight RGBA8, row-major, the
 * same shape src/raster uses.
 *
 * encodeJPEG(image, { quality = 90, subsampling = '444', background = [0, 0, 0],
 *                     restartInterval = 0 }) -> Buffer
 *   Baseline sequential DCT (SOF0), 8-bit, YCbCr (JFIF/BT.601 full range), one
 *   interleaved scan, the Annex K quantisation tables scaled by `quality`
 *   (1..100, the usual IJG scaling) and the Annex K Huffman tables. Alpha is
 *   not stored: JPEG has none, so each pixel is first flattened over
 *   `background` (default black). subsampling is '444' or '420'.
 *   restartInterval, in MCUs, adds a DRI segment and RSTn markers; 0 is none.
 *   Output carries no timestamps or comments: equal input gives equal bytes.
 *
 * decodeJPEG(bytes) -> Raster (alpha 255)
 *   Baseline, extended sequential and progressive Huffman JPEG, 8-bit,
 *   greyscale or three-component (YCbCr, or RGB when an Adobe marker says so),
 *   any sampling factors, restart intervals, interleaved or per-component
 *   scans. Chroma is upsampled by replication. Lossless, hierarchical,
 *   arithmetic-coded, 12-bit and four-component files are refused with an
 *   error that names the reason.
 *
 * jpegSize(bytes) -> { width, height, components, progressive }
 *   Reads the frame header only.
 */

const ZIGZAG = Uint8Array.from([
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5,
  12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28,
  35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51,
  58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63,
]);

// ITU-T T.81 Annex K.1, natural (row-major) order.
const LUMA_QUANT = [
  16, 11, 10, 16, 24, 40, 51, 61,
  12, 12, 14, 19, 26, 58, 60, 55,
  14, 13, 16, 24, 40, 57, 69, 56,
  14, 17, 22, 29, 51, 87, 80, 62,
  18, 22, 37, 56, 68, 109, 103, 77,
  24, 35, 55, 64, 81, 104, 113, 92,
  49, 64, 78, 87, 103, 121, 120, 101,
  72, 92, 95, 98, 112, 100, 103, 99,
];
const CHROMA_QUANT = [
  17, 18, 24, 47, 99, 99, 99, 99,
  18, 21, 26, 66, 99, 99, 99, 99,
  24, 26, 56, 99, 99, 99, 99, 99,
  47, 66, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99,
];

// ITU-T T.81 Annex K.3: code-length counts (lengths 1..16) and symbols.
const hex = text => text.trim().split(/\s+/).map(pair => parseInt(pair, 16));
const DC_VALUES = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
const HUFFMAN = Object.freeze({
  dcLuma: { bits: [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0], values: DC_VALUES },
  dcChroma: { bits: [0, 3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0], values: DC_VALUES },
  acLuma: {
    bits: [0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d],
    values: hex(`
      01 02 03 00 04 11 05 12 21 31 41 06 13 51 61 07 22 71 14 32 81 91 a1 08
      23 42 b1 c1 15 52 d1 f0 24 33 62 72 82 09 0a 16 17 18 19 1a 25 26 27 28
      29 2a 34 35 36 37 38 39 3a 43 44 45 46 47 48 49 4a 53 54 55 56 57 58 59
      5a 63 64 65 66 67 68 69 6a 73 74 75 76 77 78 79 7a 83 84 85 86 87 88 89
      8a 92 93 94 95 96 97 98 99 9a a2 a3 a4 a5 a6 a7 a8 a9 aa b2 b3 b4 b5 b6
      b7 b8 b9 ba c2 c3 c4 c5 c6 c7 c8 c9 ca d2 d3 d4 d5 d6 d7 d8 d9 da e1 e2
      e3 e4 e5 e6 e7 e8 e9 ea f1 f2 f3 f4 f5 f6 f7 f8 f9 fa`),
  },
  acChroma: {
    bits: [0, 2, 1, 2, 4, 4, 3, 4, 7, 5, 4, 4, 0, 1, 2, 0x77],
    values: hex(`
      00 01 02 03 11 04 05 21 31 06 12 41 51 07 61 71 13 22 32 81 08 14 42 91
      a1 b1 c1 09 23 33 52 f0 15 62 72 d1 0a 16 24 34 e1 25 f1 17 18 19 1a 26
      27 28 29 2a 35 36 37 38 39 3a 43 44 45 46 47 48 49 4a 53 54 55 56 57 58
      59 5a 63 64 65 66 67 68 69 6a 73 74 75 76 77 78 79 7a 82 83 84 85 86 87
      88 89 8a 92 93 94 95 96 97 98 99 9a a2 a3 a4 a5 a6 a7 a8 a9 aa b2 b3 b4
      b5 b6 b7 b8 b9 ba c2 c3 c4 c5 c6 c7 c8 c9 ca d2 d3 d4 d5 d6 d7 d8 d9 da
      e2 e3 e4 e5 e6 e7 e8 e9 ea f2 f3 f4 f5 f6 f7 f8 f9 fa`),
  },
});

// COS[u * 8 + x] = c(u) / 2 * cos((2x + 1) u pi / 16), the orthonormal 1-D DCT.
const COS = new Float64Array(64);
for (let u = 0; u < 8; u++) {
  for (let x = 0; x < 8; x++) {
    COS[u * 8 + x] = (u === 0 ? Math.SQRT1_2 : 1) / 2 * Math.cos((2 * x + 1) * u * Math.PI / 16);
  }
}

/** Canonical codes for a { bits, values } table: code[symbol], size[symbol]. */
function canonicalCodes(table) {
  const code = new Uint16Array(256);
  const size = new Uint8Array(256);
  let next = 0;
  let index = 0;
  for (let length = 1; length <= 16; length++) {
    for (let count = 0; count < table.bits[length - 1]; count++, index++) {
      if (index >= table.values.length || next >= (1 << length)) throw new Error('JPEG: invalid Huffman table');
      const symbol = table.values[index];
      if (size[symbol]) throw new Error('JPEG: duplicate Huffman symbol');
      code[symbol] = next++;
      size[symbol] = length;
    }
    next <<= 1;
  }
  if (index !== table.values.length) throw new Error('JPEG: invalid Huffman table');
  return { code, size };
}

function scaledQuant(base, quality) {
  const scale = quality < 50 ? Math.floor(5000 / quality) : 200 - quality * 2;
  return Uint8Array.from(base, value => Math.min(255, Math.max(1, Math.floor((value * scale + 50) / 100))));
}

function checkRaster(image) {
  const { width, height, data } = image || {};
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 ||
      width > 65535 || height > 65535) throw new Error('JPEG: width and height must be integers from 1 to 65535');
  if (!(data instanceof Uint8Array) || data.length !== width * height * 4) {
    throw new Error('JPEG: data must hold width × height RGBA8 pixels');
  }
}

/** Growable byte sink with the entropy-coded bit writer and FF stuffing. */
class Writer {
  constructor(capacity) {
    this.bytes = Buffer.allocUnsafe(capacity);
    this.length = 0;
    this.accumulator = 0;
    this.pending = 0;
  }

  reserve(extra) {
    if (this.length + extra <= this.bytes.length) return;
    const grown = Buffer.allocUnsafe(Math.max(this.bytes.length * 2, this.length + extra));
    this.bytes.copy(grown, 0, 0, this.length);
    this.bytes = grown;
  }

  raw(values) {
    this.reserve(values.length);
    for (const value of values) this.bytes[this.length++] = value;
  }

  segment(marker, payload) {
    this.raw([0xff, marker, (payload.length + 2) >> 8, (payload.length + 2) & 255]);
    this.raw(payload);
  }

  // value holds `count` (1..16) significant low bits.
  bits(value, count) {
    this.accumulator = (this.accumulator << count) | value;
    this.pending += count;
    while (this.pending >= 8) {
      this.pending -= 8;
      const byte = (this.accumulator >>> this.pending) & 255;
      if (this.length + 2 > this.bytes.length) this.reserve(2);
      this.bytes[this.length++] = byte;
      if (byte === 255) this.bytes[this.length++] = 0;
    }
    this.accumulator &= (1 << this.pending) - 1;
  }

  flush() {
    if (this.pending) this.bits((1 << (8 - this.pending)) - 1, 8 - this.pending);
  }
}

function encodeJPEG(image, options = {}) {
  checkRaster(image);
  const { quality = 90, subsampling = '444', background = [0, 0, 0], restartInterval = 0 } = options;
  if (!Number.isInteger(restartInterval) || restartInterval < 0 || restartInterval > 65535) {
    throw new Error('JPEG: restartInterval must be an integer from 0 to 65535');
  }
  if (!Number.isInteger(quality) || quality < 1 || quality > 100) throw new Error('JPEG: quality must be an integer from 1 to 100');
  if (subsampling !== '444' && subsampling !== '420') throw new Error("JPEG: subsampling must be '444' or '420'");
  const { width, height, data } = image;
  const sub = subsampling === '420' ? 2 : 1;
  const mcu = 8 * sub;
  const mcuCols = Math.ceil(width / mcu);
  const mcuRows = Math.ceil(height / mcu);
  const paddedWidth = mcuCols * mcu;
  const paddedHeight = mcuRows * mcu;

  // Level-shifted planes, padded to whole MCUs by repeating the last row/column.
  const luma = new Float32Array(paddedWidth * paddedHeight);
  const fullCb = new Float32Array(paddedWidth * paddedHeight);
  const fullCr = new Float32Array(paddedWidth * paddedHeight);
  for (let y = 0; y < paddedHeight; y++) {
    const sourceRow = Math.min(y, height - 1) * width;
    for (let x = 0; x < paddedWidth; x++) {
      const offset = (sourceRow + Math.min(x, width - 1)) * 4;
      const alpha = data[offset + 3] / 255;
      const red = data[offset] * alpha + background[0] * (1 - alpha);
      const green = data[offset + 1] * alpha + background[1] * (1 - alpha);
      const blue = data[offset + 2] * alpha + background[2] * (1 - alpha);
      const at = y * paddedWidth + x;
      luma[at] = 0.299 * red + 0.587 * green + 0.114 * blue - 128;
      fullCb[at] = -0.168735892 * red - 0.331264108 * green + 0.5 * blue;
      fullCr[at] = 0.5 * red - 0.418687589 * green - 0.081312411 * blue;
    }
  }
  let cb = fullCb;
  let cr = fullCr;
  const chromaWidth = paddedWidth / sub;
  if (sub === 2) {
    cb = new Float32Array(chromaWidth * paddedHeight / 2);
    cr = new Float32Array(chromaWidth * paddedHeight / 2);
    for (let y = 0; y < paddedHeight / 2; y++) {
      for (let x = 0; x < chromaWidth; x++) {
        const at = y * 2 * paddedWidth + x * 2;
        cb[y * chromaWidth + x] = (fullCb[at] + fullCb[at + 1] + fullCb[at + paddedWidth] + fullCb[at + paddedWidth + 1]) / 4;
        cr[y * chromaWidth + x] = (fullCr[at] + fullCr[at + 1] + fullCr[at + paddedWidth] + fullCr[at + paddedWidth + 1]) / 4;
      }
    }
  }

  const quant = [scaledQuant(LUMA_QUANT, quality), scaledQuant(CHROMA_QUANT, quality)];
  const codes = {
    dc: [canonicalCodes(HUFFMAN.dcLuma), canonicalCodes(HUFFMAN.dcChroma)],
    ac: [canonicalCodes(HUFFMAN.acLuma), canonicalCodes(HUFFMAN.acChroma)],
  };

  const out = new Writer(Math.max(4096, width * height >> 1));
  out.raw([0xff, 0xd8]);
  out.segment(0xe0, [0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]); // JFIF 1.01, square pixels
  for (let id = 0; id < 2; id++) out.segment(0xdb, [id, ...Array.from(ZIGZAG, natural => quant[id][natural])]);
  out.segment(0xc0, [8, height >> 8, height & 255, width >> 8, width & 255, 3,
    1, sub << 4 | sub, 0, 2, 0x11, 1, 3, 0x11, 1]);
  for (const [id, table] of [[0x00, HUFFMAN.dcLuma], [0x10, HUFFMAN.acLuma], [0x01, HUFFMAN.dcChroma], [0x11, HUFFMAN.acChroma]]) {
    out.segment(0xc4, [id, ...table.bits, ...table.values]);
  }
  if (restartInterval) out.segment(0xdd, [restartInterval >> 8, restartInterval & 255]);
  out.segment(0xda, [3, 1, 0x00, 2, 0x11, 3, 0x11, 0, 63, 0]);

  const temp = new Float64Array(64);
  const block = new Int32Array(64);
  const predictors = [0, 0, 0];

  function encodeBlock(plane, stride, left, top, component) {
    const table = component === 0 ? 0 : 1;
    const divisors = quant[table];
    // Rows, then columns.
    for (let y = 0; y < 8; y++) {
      const row = (top + y) * stride + left;
      for (let u = 0; u < 8; u++) {
        let sum = 0;
        for (let x = 0; x < 8; x++) sum += plane[row + x] * COS[u * 8 + x];
        temp[y * 8 + u] = sum;
      }
    }
    for (let u = 0; u < 8; u++) {
      for (let v = 0; v < 8; v++) {
        let sum = 0;
        for (let y = 0; y < 8; y++) sum += temp[y * 8 + u] * COS[v * 8 + y];
        block[v * 8 + u] = Math.round(sum / divisors[v * 8 + u]);
      }
    }

    const dcCodes = codes.dc[table];
    const acCodes = codes.ac[table];
    const difference = block[0] - predictors[component];
    predictors[component] = block[0];
    let magnitude = Math.abs(difference);
    let category = 0;
    while (magnitude) { category++; magnitude >>= 1; }
    out.bits(dcCodes.code[category], dcCodes.size[category]);
    if (category) out.bits((difference < 0 ? difference - 1 : difference) & ((1 << category) - 1), category);

    let run = 0;
    for (let index = 1; index < 64; index++) {
      const value = block[ZIGZAG[index]];
      if (value === 0) { run++; continue; }
      while (run > 15) { out.bits(acCodes.code[0xf0], acCodes.size[0xf0]); run -= 16; }
      magnitude = Math.abs(value);
      category = 0;
      while (magnitude) { category++; magnitude >>= 1; }
      const symbol = run << 4 | category;
      out.bits(acCodes.code[symbol], acCodes.size[symbol]);
      out.bits((value < 0 ? value - 1 : value) & ((1 << category) - 1), category);
      run = 0;
    }
    if (run) out.bits(acCodes.code[0], acCodes.size[0]);
  }

  for (let row = 0, unit = 0; row < mcuRows; row++) {
    for (let col = 0; col < mcuCols; col++, unit++) {
      if (restartInterval && unit && unit % restartInterval === 0) {
        out.flush();
        out.raw([0xff, 0xd0 + (unit / restartInterval - 1) % 8]);
        predictors.fill(0);
      }
      for (let v = 0; v < sub; v++) {
        for (let h = 0; h < sub; h++) encodeBlock(luma, paddedWidth, col * mcu + h * 8, row * mcu + v * 8, 0);
      }
      encodeBlock(cb, chromaWidth, col * 8, row * 8, 1);
      encodeBlock(cr, chromaWidth, col * 8, row * 8, 2);
    }
  }
  out.flush();
  out.raw([0xff, 0xd9]);
  return Buffer.from(out.bytes.subarray(0, out.length));
}

const SOF_NAMES = new Map([
  [0xc3, 'lossless'], [0xc5, 'hierarchical'], [0xc6, 'hierarchical progressive'],
  [0xc7, 'hierarchical lossless'], [0xc9, 'arithmetic-coded'], [0xca, 'arithmetic-coded progressive'],
  [0xcb, 'arithmetic-coded lossless'], [0xcd, 'hierarchical arithmetic-coded'],
  [0xce, 'hierarchical arithmetic-coded'], [0xcf, 'hierarchical arithmetic-coded'],
]);

/** Walks marker segments up to and including each SOS header. */
function* segments(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new Error('JPEG: expected bytes');
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error('JPEG: missing SOI marker');
  let position = 2;
  while (true) {
    while (position < bytes.length && bytes[position] !== 0xff) position++; // tolerate stray bytes
    while (position < bytes.length && bytes[position] === 0xff) position++; // fill bytes
    if (position >= bytes.length) throw new Error('JPEG: truncated before EOI');
    const marker = bytes[position++];
    if (marker === 0xd9) return;
    if (marker === 0x00 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (position + 2 > bytes.length) throw new Error('JPEG: truncated segment');
    const length = bytes[position] << 8 | bytes[position + 1];
    if (length < 2 || position + length > bytes.length) throw new Error('JPEG: truncated segment');
    const resume = yield { marker, start: position + 2, end: position + length };
    position = resume === undefined ? position + length : resume;
  }
}

function readFrame(bytes, marker, start, end) {
  if (SOF_NAMES.has(marker)) throw new Error(`JPEG: ${SOF_NAMES.get(marker)} JPEG is not supported, only sequential and progressive Huffman`);
  if (end - start < 6) throw new Error('JPEG: invalid frame header');
  const precision = bytes[start];
  const height = bytes[start + 1] << 8 | bytes[start + 2];
  const width = bytes[start + 3] << 8 | bytes[start + 4];
  const count = bytes[start + 5];
  if (end - start !== 6 + count * 3) throw new Error('JPEG: invalid frame header');
  if (!width || !height) throw new Error('JPEG: zero width or height (DNL) is not supported');
  const components = [];
  for (let index = 0; index < count; index++) {
    const at = start + 6 + index * 3;
    const h = bytes[at + 1] >> 4;
    const v = bytes[at + 1] & 15;
    if (h < 1 || h > 4 || v < 1 || v > 4 || bytes[at + 2] > 3) throw new Error('JPEG: invalid component');
    components.push({ id: bytes[at], h, v, quant: bytes[at + 2], predictor: 0 });
  }
  return { precision, width, height, components, progressive: marker === 0xc2 };
}

function jpegSize(bytes) {
  for (const { marker, start, end } of segments(bytes)) {
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const frame = readFrame(bytes, SOF_NAMES.has(marker) ? 0xc0 : marker, start, end);
      const progressive = marker === 0xc2 || marker === 0xc6 || marker === 0xca || marker === 0xce;
      return { width: frame.width, height: frame.height, components: frame.components.length, progressive };
    }
    if (marker === 0xda) break;
  }
  throw new Error('JPEG: no frame header');
}

/** 16-bit lookup: entry = length << 8 | symbol, 0 for an unused prefix. */
function decodeTable(bits, values) {
  const lookup = new Uint16Array(65536);
  let code = 0;
  let index = 0;
  for (let length = 1; length <= 16; length++) {
    for (let count = 0; count < bits[length - 1]; count++, index++) {
      if (code >= (1 << length)) throw new Error('JPEG: invalid Huffman table');
      const first = code << (16 - length);
      lookup.fill(length << 8 | values[index], first, first + (1 << (16 - length)));
      code++;
    }
    code <<= 1;
  }
  return lookup;
}

function decodeJPEG(bytes) {
  const quantTables = [];
  const huffman = { dc: [], ac: [] };
  let frame = null;
  let restartInterval = 0;
  let adobeTransform = -1;
  let sawScan = false;

  // Entropy-coded segment reader state.
  let position = 0;
  let buffer = 0;
  let available = 0;
  let atMarker = false;

  function fill() {
    while (available <= 24) {
      let byte = 0;
      if (!atMarker && position < bytes.length) {
        byte = bytes[position];
        if (byte === 0xff) {
          const next = bytes[position + 1];
          if (next === 0) position += 2;
          else { atMarker = true; byte = 0; }
        } else position++;
      } else atMarker = true;
      buffer = (buffer << 8) | byte;
      available += 8;
    }
  }

  function symbol(lookup) {
    if (available < 16) fill();
    const entry = lookup[(buffer >>> (available - 16)) & 0xffff];
    if (!entry) throw new Error('JPEG: invalid Huffman code in scan data');
    available -= entry >> 8;
    return entry & 255;
  }

  function receiveExtend(count) {
    if (available < count) fill();
    const value = (buffer >>> (available - count)) & ((1 << count) - 1);
    available -= count;
    return value < (1 << (count - 1)) ? value - (1 << count) + 1 : value;
  }

  function receive(count) {
    if (available < count) fill();
    available -= count;
    return (buffer >>> available) & ((1 << count) - 1);
  }

  // Progressive scans (T.81 Annex G). eobRun counts blocks whose band is
  // already at end-of-band; it is reset with the predictors.
  let eobRun = 0;
  let spectralStart = 0;
  let spectralEnd = 63;
  let approxLow = 0;

  function dcFirst(component, target, offset) {
    const category = symbol(component.dcTable);
    if (category > 11) throw new Error('JPEG: invalid DC category');
    if (category) component.predictor += receiveExtend(category);
    target[offset] = component.predictor * (1 << approxLow);
  }

  function dcRefine(component, target, offset) {
    if (receive(1)) target[offset] |= 1 << approxLow;
  }

  function acFirst(component, target, offset) {
    if (eobRun > 0) { eobRun--; return; }
    for (let index = spectralStart; index <= spectralEnd;) {
      const entry = symbol(component.acTable);
      const size = entry & 15;
      const run = entry >> 4;
      if (size === 0) {
        if (run < 15) {
          eobRun = (1 << run) - 1;
          if (run) eobRun += receive(run);
          break;
        }
        index += 16;
        continue;
      }
      index += run;
      if (index > spectralEnd) throw new Error('JPEG: coefficient run past band end');
      target[offset + ZIGZAG[index++]] = receiveExtend(size) * (1 << approxLow);
    }
  }

  function acRefine(component, target, offset) {
    const plus = 1 << approxLow;
    const minus = -plus;
    let index = spectralStart;
    if (eobRun === 0) {
      for (; index <= spectralEnd; index++) {
        const entry = symbol(component.acTable);
        const size = entry & 15;
        let run = entry >> 4;
        let value = 0;
        if (size) {
          if (size !== 1) throw new Error('JPEG: invalid refinement symbol');
          value = receive(1) ? plus : minus;
        } else if (run !== 15) {
          eobRun = 1 << run;
          if (run) eobRun += receive(run);
          break;
        }
        // Step over `run` still-zero coefficients, correcting the nonzero ones passed.
        for (; index <= spectralEnd; index++) {
          const at = offset + ZIGZAG[index];
          const current = target[at];
          if (current !== 0) {
            if (receive(1) && (current & plus) === 0) target[at] = current + (current >= 0 ? plus : minus);
          } else if (--run < 0) break;
        }
        if (value && index <= spectralEnd) target[offset + ZIGZAG[index]] = value;
      }
    }
    if (eobRun > 0) {
      for (; index <= spectralEnd; index++) {
        const at = offset + ZIGZAG[index];
        const current = target[at];
        if (current !== 0 && receive(1) && (current & plus) === 0) target[at] = current + (current >= 0 ? plus : minus);
      }
      eobRun--;
    }
  }

  function decodeBlock(component, target, offset) {
    const category = symbol(component.dcTable);
    if (category > 11) throw new Error('JPEG: invalid DC category');
    if (category) component.predictor += receiveExtend(category);
    target[offset] = component.predictor;
    for (let index = 1; index < 64;) {
      const entry = symbol(component.acTable);
      const size = entry & 15;
      const run = entry >> 4;
      if (size === 0) {
        if (run !== 15) break;
        index += 16;
        continue;
      }
      index += run;
      if (index > 63) throw new Error('JPEG: coefficient run past block end');
      target[offset + ZIGZAG[index++]] = receiveExtend(size);
    }
  }

  function decodeScan(start, end) {
    const count = bytes[start];
    if (count < 1 || count > 4 || end - start !== 4 + count * 2) throw new Error('JPEG: invalid scan header');
    const scan = [];
    for (let index = 0; index < count; index++) {
      const component = frame.components.find(candidate => candidate.id === bytes[start + 1 + index * 2]);
      if (!component) throw new Error('JPEG: scan names an unknown component');
      const selectors = bytes[start + 2 + index * 2];
      component.dcTable = huffman.dc[selectors >> 4];
      component.acTable = huffman.ac[selectors & 15];
      component.predictor = 0;
      scan.push(component);
    }
    spectralStart = bytes[end - 3];
    spectralEnd = bytes[end - 2];
    const approxHigh = bytes[end - 1] >> 4;
    approxLow = bytes[end - 1] & 15;
    eobRun = 0;
    let decode = decodeBlock;
    let needsDc = true;
    let needsAc = true;
    if (frame.progressive) {
      if (spectralStart > spectralEnd || spectralEnd > 63 || approxLow > 13 ||
          (spectralStart === 0 ? spectralEnd !== 0 : scan.length !== 1)) throw new Error('JPEG: invalid progressive scan');
      decode = spectralStart === 0 ? (approxHigh ? dcRefine : dcFirst) : (approxHigh ? acRefine : acFirst);
      needsDc = decode === dcFirst;
      needsAc = spectralStart !== 0;
    }
    for (const component of scan) {
      if ((needsDc && !component.dcTable) || (needsAc && !component.acTable)) {
        throw new Error('JPEG: scan uses an undefined Huffman table');
      }
    }
    position = end;
    buffer = 0;
    available = 0;
    atMarker = false;

    const single = scan.length === 1;
    const cols = single ? Math.ceil(Math.ceil(frame.width * scan[0].h / frame.hMax) / 8) : frame.mcuCols;
    const rows = single ? Math.ceil(Math.ceil(frame.height * scan[0].v / frame.vMax) / 8) : frame.mcuRows;
    const total = cols * rows;
    for (let unit = 0; unit < total; unit++) {
      if (restartInterval && unit && unit % restartInterval === 0) {
        // Drop the padding bits, then step over the RSTn marker.
        buffer = 0;
        available = 0;
        while (position < bytes.length && !(bytes[position] === 0xff && bytes[position + 1] >= 0xd0 && bytes[position + 1] <= 0xd7)) {
          if (bytes[position] === 0xff && bytes[position + 1] !== 0 && bytes[position + 1] !== 0xff) {
            throw new Error('JPEG: missing restart marker');
          }
          position++;
        }
        if (position >= bytes.length) throw new Error('JPEG: truncated scan data');
        position += 2;
        atMarker = false;
        for (const component of scan) component.predictor = 0;
        eobRun = 0;
      }
      const col = unit % cols;
      const row = (unit - col) / cols;
      if (single) {
        decode(scan[0], scan[0].coefficients, (row * scan[0].blockCols + col) * 64);
      } else {
        for (const component of scan) {
          for (let v = 0; v < component.v; v++) {
            for (let h = 0; h < component.h; h++) {
              decode(component, component.coefficients,
                ((row * component.v + v) * component.blockCols + col * component.h + h) * 64);
            }
          }
        }
      }
    }
    // Rewind to the first byte the bit reader did not consume as scan data.
    while (position < bytes.length && !(bytes[position] === 0xff && bytes[position + 1] !== 0 &&
        !(bytes[position + 1] >= 0xd0 && bytes[position + 1] <= 0xd7))) position++;
    return position;
  }

  const walker = segments(bytes);
  let resume;
  while (true) {
    const step = walker.next(resume);
    resume = undefined;
    if (step.done) break;
    const { marker, start, end } = step.value;
    if (marker === 0xdb) {
      for (let at = start; at < end;) {
        const wide = bytes[at] >> 4;
        const id = bytes[at] & 15;
        if (wide > 1 || id > 3 || at + 1 + 64 * (wide + 1) > end) throw new Error('JPEG: invalid quantisation table');
        const table = new Uint16Array(64);
        for (let index = 0; index < 64; index++) {
          table[ZIGZAG[index]] = wide ? bytes[at + 1 + index * 2] << 8 | bytes[at + 2 + index * 2] : bytes[at + 1 + index];
        }
        quantTables[id] = table;
        at += 1 + 64 * (wide + 1);
      }
    } else if (marker === 0xc4) {
      for (let at = start; at < end;) {
        const kind = bytes[at] >> 4;
        const id = bytes[at] & 15;
        if (kind > 1 || id > 3 || at + 17 > end) throw new Error('JPEG: invalid Huffman table');
        const bits = bytes.subarray(at + 1, at + 17);
        const count = bits.reduce((sum, value) => sum + value, 0);
        if (count > 256 || at + 17 + count > end) throw new Error('JPEG: invalid Huffman table');
        (kind ? huffman.ac : huffman.dc)[id] = decodeTable(bits, bytes.subarray(at + 17, at + 17 + count));
        at += 17 + count;
      }
    } else if (marker === 0xdd) {
      if (end - start !== 2) throw new Error('JPEG: invalid restart interval');
      restartInterval = bytes[start] << 8 | bytes[start + 1];
    } else if (marker === 0xee && end - start >= 12 && bytes.subarray(start, start + 5).toString('latin1') === 'Adobe') {
      adobeTransform = bytes[start + 11];
    } else if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc8 && marker !== 0xcc) {
      if (frame) throw new Error('JPEG: more than one frame');
      frame = readFrame(bytes, marker, start, end);
      if (frame.precision !== 8) throw new Error(`JPEG: ${frame.precision}-bit samples are not supported, only 8-bit`);
      if (frame.components.length !== 1 && frame.components.length !== 3) {
        throw new Error(`JPEG: ${frame.components.length}-component JPEG is not supported, only greyscale and three-component`);
      }
      if (frame.components.length === 1) { frame.components[0].h = 1; frame.components[0].v = 1; }
      frame.hMax = Math.max(...frame.components.map(component => component.h));
      frame.vMax = Math.max(...frame.components.map(component => component.v));
      frame.mcuCols = Math.ceil(frame.width / (8 * frame.hMax));
      frame.mcuRows = Math.ceil(frame.height / (8 * frame.vMax));
      for (const component of frame.components) {
        component.blockCols = frame.mcuCols * component.h;
        component.blockRows = frame.mcuRows * component.v;
        component.coefficients = new Int16Array(component.blockCols * component.blockRows * 64);
      }
    } else if (marker === 0xda) {
      if (!frame) throw new Error('JPEG: scan before frame header');
      resume = decodeScan(start, end);
      sawScan = true;
    }
  }
  if (!frame || !sawScan) throw new Error('JPEG: no image data');

  // Dequantise and inverse-transform every block into per-component planes.
  const temp = new Float64Array(64);
  for (const component of frame.components) {
    const table = quantTables[component.quant];
    if (!table) throw new Error('JPEG: component uses an undefined quantisation table');
    const stride = component.blockCols * 8;
    const plane = new Uint8Array(stride * component.blockRows * 8);
    const coefficients = component.coefficients;
    for (let blockRow = 0; blockRow < component.blockRows; blockRow++) {
      for (let blockCol = 0; blockCol < component.blockCols; blockCol++) {
        const base = (blockRow * component.blockCols + blockCol) * 64;
        for (let v = 0; v < 8; v++) {
          for (let x = 0; x < 8; x++) {
            let sum = 0;
            for (let u = 0; u < 8; u++) {
              const value = coefficients[base + v * 8 + u];
              if (value) sum += value * table[v * 8 + u] * COS[u * 8 + x];
            }
            temp[v * 8 + x] = sum;
          }
        }
        for (let x = 0; x < 8; x++) {
          for (let y = 0; y < 8; y++) {
            let sum = 0;
            for (let v = 0; v < 8; v++) sum += temp[v * 8 + x] * COS[v * 8 + y];
            const sample = Math.round(sum + 128);
            plane[(blockRow * 8 + y) * stride + blockCol * 8 + x] = sample < 0 ? 0 : sample > 255 ? 255 : sample;
          }
        }
      }
    }
    component.plane = plane;
    component.stride = stride;
    component.coefficients = null;
  }

  const { width, height } = frame;
  const data = Buffer.alloc(width * height * 4, 255);
  const [first, second, third] = frame.components;
  const rgb = frame.components.length === 3 && (adobeTransform === 0 ||
    (adobeTransform < 0 && first.id === 0x52 && second.id === 0x47 && third.id === 0x42));
  // Chroma is upsampled by replication.
  const sampler = component => {
    const { plane, stride } = component;
    const h = component.h / frame.hMax;
    const v = component.v / frame.vMax;
    return h === 1 && v === 1 ? (x, y) => plane[y * stride + x]
      : (x, y) => plane[Math.floor(y * v) * stride + Math.floor(x * h)];
  };
  const clamp = value => value < 0 ? 0 : value > 255 ? 255 : Math.round(value);
  if (frame.components.length === 1) {
    const grey = sampler(first);
    for (let y = 0, offset = 0; y < height; y++) {
      for (let x = 0; x < width; x++, offset += 4) data[offset] = data[offset + 1] = data[offset + 2] = grey(x, y);
    }
  } else {
    const a = sampler(first);
    const b = sampler(second);
    const c = sampler(third);
    for (let y = 0, offset = 0; y < height; y++) {
      for (let x = 0; x < width; x++, offset += 4) {
        const one = a(x, y);
        const two = b(x, y);
        const three = c(x, y);
        if (rgb) {
          data[offset] = one; data[offset + 1] = two; data[offset + 2] = three;
        } else {
          data[offset] = clamp(one + 1.402 * (three - 128));
          data[offset + 1] = clamp(one - 0.344136286 * (two - 128) - 0.714136286 * (three - 128));
          data[offset + 2] = clamp(one + 1.772 * (two - 128));
        }
      }
    }
  }
  return { width, height, data };
}

module.exports = { encodeJPEG, decodeJPEG, jpegSize, HUFFMAN, canonicalCodes };
