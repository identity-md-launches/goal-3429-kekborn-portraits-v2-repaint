'use strict';

const { constants, deflateSync, inflateSync } = require('node:zlib');

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
const DEPTHS = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
const ADAM7 = [
  [0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4],
  [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2],
];

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) {
    value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  }
  return value;
});

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 255];
  return (crc ^ 0xffffffff) >>> 0;
}

function pixelBytes(width, height) {
  const size = width * height * 4;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 ||
      size > 256 * 1024 * 1024) {
    throw new RangeError('Unsupported raster dimensions');
  }
  return size;
}

function validateImage(image) {
  if (!(image.data instanceof Uint8Array) ||
      image.data.length !== pixelBytes(image.width, image.height)) {
    throw new TypeError('Expected tightly packed RGBA8 image data');
  }
}

function paeth(left, up, corner) {
  const estimate = left + up - corner;
  const a = Math.abs(estimate - left);
  const b = Math.abs(estimate - up);
  const c = Math.abs(estimate - corner);
  if (a <= b && a <= c) return left;
  return b <= c ? up : corner;
}

function predictor(filter, left, up, corner) {
  switch (filter) {
    case 0: return 0;
    case 1: return left;
    case 2: return up;
    case 3: return (left + up) >>> 1;
    case 4: return paeth(left, up, corner);
    default: throw new Error('Invalid PNG row filter');
  }
}

function sample(row, index, depth) {
  if (depth === 8) return row[index];
  if (depth === 16) return row.readUInt16BE(index * 2);
  const bit = index * depth;
  return (row[bit >>> 3] >>> (8 - depth - (bit & 7))) & ((1 << depth) - 1);
}

function decodePNG(input, target) {
  if (!(input instanceof Uint8Array)) throw new TypeError('Expected PNG bytes');
  const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (!bytes.subarray(0, 8).equals(SIGNATURE)) throw new Error('Invalid PNG signature');

  let width, height, depth, type, interlace, palette, transparency;
  let end = false;
  let closedData = false;
  const compressed = [];
  for (let offset = 8; offset < bytes.length;) {
    if (offset + 12 > bytes.length) throw new Error('Truncated PNG chunk');
    const length = bytes.readUInt32BE(offset);
    const next = offset + length + 12;
    if (next > bytes.length) throw new Error('Truncated PNG chunk');
    const name = bytes.toString('latin1', offset + 4, offset + 8);
    const payload = bytes.subarray(offset + 8, next - 4);
    if (crc32(bytes.subarray(offset + 4, next - 4)) !== bytes.readUInt32BE(next - 4)) {
      throw new Error(`Invalid PNG CRC in ${name}`);
    }
    if (offset === 8 && name !== 'IHDR') throw new Error('Missing PNG header');
    if (compressed.length && name !== 'IDAT') closedData = true;
    switch (name) {
      case 'IHDR':
        if (offset !== 8 || length !== 13) throw new Error('Invalid PNG header');
        width = payload.readUInt32BE(0);
        height = payload.readUInt32BE(4);
        pixelBytes(width, height);
        depth = payload[8];
        type = payload[9];
        interlace = payload[12];
        if (!DEPTHS[type]?.includes(depth) || payload[10] || payload[11] || interlace > 1) {
          throw new Error('Unsupported PNG header');
        }
        break;
      case 'PLTE':
        if (palette || transparency || compressed.length || !length || length % 3 ||
            length > 768 || type === 0 || type === 4 ||
            (type === 3 && length / 3 > 2 ** depth)) throw new Error('Invalid PNG palette');
        palette = payload;
        break;
      case 'tRNS':
        if (transparency || compressed.length ||
            !((type === 0 && length === 2) || (type === 2 && length === 6) ||
              (type === 3 && palette && length > 0 && length <= palette.length / 3))) {
          throw new Error('Invalid PNG transparency');
        }
        transparency = payload;
        break;
      case 'IDAT':
        if (closedData || (type === 3 && !palette)) throw new Error('Invalid PNG image data order');
        compressed.push(payload);
        break;
      case 'IEND':
        if (length || next !== bytes.length) throw new Error('Invalid PNG end');
        end = true;
        break;
      default:
        if (!(bytes[offset + 4] & 32)) throw new Error(`Unsupported critical PNG chunk ${name}`);
    }
    offset = next;
  }
  if (!end || !compressed.length) throw new Error('Incomplete PNG');
  const size = pixelBytes(width, height);
  const data = target ?? Buffer.allocUnsafe(size);
  if (!(data instanceof Uint8Array) || data.length !== size) {
    throw new TypeError('Expected a PNG decode target with width * height * 4 bytes');
  }
  if (data.buffer === bytes.buffer &&
      data.byteOffset < bytes.byteOffset + bytes.byteLength &&
      bytes.byteOffset < data.byteOffset + data.byteLength) {
    throw new TypeError('PNG bytes and decode target must have disjoint storage');
  }

  const channels = CHANNELS[type];
  const bitsPerPixel = channels * depth;
  const stride = Math.ceil(bitsPerPixel / 8);
  const passes = (interlace ? ADAM7 : [[0, 0, 1, 1]]).map(([x, y, dx, dy]) => {
    const columns = Math.max(0, Math.ceil((width - x) / dx));
    const rows = Math.max(0, Math.ceil((height - y) / dy));
    return { x, y, dx, dy, columns, rows, rowBytes: Math.ceil(columns * bitsPerPixel / 8) };
  }).filter(pass => pass.columns && pass.rows);
  const rawSize = passes.reduce((sum, pass) => sum + pass.rows * (1 + pass.rowBytes), 0);
  const raw = inflateSync(compressed.length === 1 ? compressed[0] : Buffer.concat(compressed),
    { maxOutputLength: rawSize });
  if (raw.length !== rawSize) throw new Error('Invalid inflated PNG size');
  const maxSample = (1 << depth) - 1;
  const toByte = depth === 8 ? value => value : value => Math.round(value * 255 / maxSample);
  const key = transparency && type !== 3
    ? Array.from({ length: transparency.length / 2 }, (_, i) => transparency.readUInt16BE(i * 2))
    : null;

  let offset = 0;
  for (const { x, y, dx, dy, columns, rows, rowBytes } of passes) {
    let previous = Buffer.alloc(rowBytes);
    for (let rowIndex = 0; rowIndex < rows; rowIndex++) {
      const filter = raw[offset++];
      const row = raw.subarray(offset, offset + rowBytes);
      offset += rowBytes;
      if (filter) {
        for (let i = 0; i < rowBytes; i++) {
          const left = i >= stride ? row[i - stride] : 0;
          const corner = i >= stride ? previous[i - stride] : 0;
          row[i] += predictor(filter, left, previous[i], corner);
        }
      }
      let dest = ((y + rowIndex * dy) * width + x) * 4;
      if (type === 6 && depth === 8 && dx === 1) {
        row.copy(data, dest);
      } else {
        for (let col = 0; col < columns; col++, dest += dx * 4) {
          const index = col * channels;
          const first = sample(row, index, depth);
          let alpha = 255;
          if (type === 3) {
            const entry = first * 3;
            if (entry >= palette.length) throw new Error('Invalid PNG palette index');
            data[dest] = palette[entry];
            data[dest + 1] = palette[entry + 1];
            data[dest + 2] = palette[entry + 2];
            alpha = transparency?.[first] ?? 255;
          } else if (type === 0 || type === 4) {
            data[dest] = data[dest + 1] = data[dest + 2] = toByte(first);
            if (type === 4) alpha = toByte(sample(row, index + 1, depth));
            else if (key && first === key[0]) alpha = 0;
          } else {
            const green = sample(row, index + 1, depth);
            const blue = sample(row, index + 2, depth);
            data[dest] = toByte(first);
            data[dest + 1] = toByte(green);
            data[dest + 2] = toByte(blue);
            if (type === 6) alpha = toByte(sample(row, index + 3, depth));
            else if (key && first === key[0] && green === key[1] && blue === key[2]) alpha = 0;
          }
          data[dest + 3] = alpha;
        }
      }
      previous = row;
    }
  }
  return { width, height, data };
}

function chunk(name, payload) {
  const bytes = Buffer.allocUnsafe(payload.length + 12);
  bytes.writeUInt32BE(payload.length, 0);
  bytes.write(name, 4, 'ascii');
  payload.copy(bytes, 8);
  bytes.writeUInt32BE(crc32(bytes.subarray(4, -4)), bytes.length - 4);
  return bytes;
}

function encodePNG(image) {
  validateImage(image);
  const { width, height, data } = image;
  const rowBytes = width * 4;
  const raw = Buffer.allocUnsafe((rowBytes + 1) * height);
  let offset = 0;
  // A fixed Paeth filter and fixed compression options give reproducible output.
  for (let y = 0; y < height; y++) {
    raw[offset++] = 4;
    const start = y * rowBytes;
    for (let x = 0; x < rowBytes; x++) {
      const i = start + x;
      const left = x >= 4 ? data[i - 4] : 0;
      const up = y ? data[i - rowBytes] : 0;
      const corner = y && x >= 4 ? data[i - rowBytes - 4] : 0;
      raw[offset++] = data[i] - paeth(left, up, corner);
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 6, strategy: constants.Z_DEFAULT_STRATEGY })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

module.exports = { decodePNG, encodePNG, pixelBytes, validateImage };
