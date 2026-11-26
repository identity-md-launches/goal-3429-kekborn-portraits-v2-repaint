'use strict';

// The pure-JS JPEG codec in src/jpeg: round trips, file structure, refusals.

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createImage } = require('../../src/raster/index.cjs');
const { encodeJPEG, decodeJPEG, jpegSize, HUFFMAN, canonicalCodes } = require('../../src/jpeg/index.cjs');

// Smooth gradients with a hard-edged square: easy to predict, not trivial to code.
function pattern(width, height) {
  const image = createImage(width, height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const square = x >= width / 3 && x < width * 2 / 3 && y >= height / 3 && y < height * 2 / 3;
      image.data.set(square ? [230, 40, 60, 255]
        : [Math.round(x * 255 / width), Math.round(y * 255 / height), 200 - Math.round(x * 120 / width), 255],
      (y * width + x) * 4);
    }
  }
  return image;
}

function difference(a, b) {
  assert.equal(a.width, b.width);
  assert.equal(a.height, b.height);
  let max = 0;
  let squares = 0;
  for (let index = 0; index < a.data.length; index++) {
    const delta = Math.abs(a.data[index] - b.data[index]);
    if (delta > max) max = delta;
    squares += delta * delta;
  }
  return { max, psnr: 10 * Math.log10(255 * 255 / (squares / (a.data.length * 3 / 4) || 1e-9)) };
}

function markers(bytes) {
  const found = [];
  for (let at = 2; bytes[at] === 0xff && bytes[at + 1] !== 0xda; at += 2 + (bytes[at + 2] << 8 | bytes[at + 3])) {
    found.push(bytes[at + 1]);
  }
  return found;
}

test('the Annex K Huffman tables are complete prefix codes', () => {
  for (const [name, table] of Object.entries(HUFFMAN)) {
    const expected = name.startsWith('dc') ? 12 : 162;
    assert.equal(table.values.length, expected, name);
    assert.equal(new Set(table.values).size, expected, name);
    assert.equal(table.bits.reduce((sum, count) => sum + count, 0), expected, name);
    const { size } = canonicalCodes(table);
    if (name.startsWith('ac')) {
      // Every run/size pair a baseline encoder can emit, plus EOB and ZRL.
      for (let run = 0; run < 16; run++) for (let bits = 1; bits <= 10; bits++) assert.ok(size[run << 4 | bits], `${name} ${run}/${bits}`);
      assert.ok(size[0x00] && size[0xf0], name);
    }
  }
});

test('encode then decode keeps the picture, at odd sizes and both samplings', () => {
  for (const [width, height] of [[1, 1], [7, 9], [16, 16], [101, 77], [200, 250]]) {
    for (const subsampling of ['444', '420']) {
      const source = pattern(width, height);
      const bytes = encodeJPEG(source, { quality: 90, subsampling });
      assert.deepEqual(jpegSize(bytes), { width, height, components: 3, progressive: false });
      const decoded = decodeJPEG(bytes);
      const { psnr } = difference(source, decoded);
      // 4:2:0 smears the square's coloured edge, most of all on a tiny image;
      // 4:4:4 must stay close.
      const floor = (subsampling === '444' ? 30 : 22) - (width < 32 ? 4 : 0);
      if (process.env.JPEG_TEST_REPORT) console.log(width, height, subsampling, psnr.toFixed(1));
      assert.ok(psnr > floor, `${width}×${height} ${subsampling}: PSNR ${psnr.toFixed(1)}`);
      for (let offset = 3; offset < decoded.data.length; offset += 4) assert.equal(decoded.data[offset], 255);
    }
  }
});

test('a flat colour survives exactly enough and quality trades bytes for error', () => {
  const flat = createImage(64, 64);
  for (let offset = 0; offset < flat.data.length; offset += 4) flat.data.set([0x2f, 0x5b, 0x3a, 255], offset);
  assert.ok(difference(flat, decodeJPEG(encodeJPEG(flat))).max <= 2);

  const source = pattern(160, 120);
  const fine = encodeJPEG(source, { quality: 95 });
  const coarse = encodeJPEG(source, { quality: 30 });
  assert.ok(coarse.length < fine.length);
  assert.ok(difference(source, decodeJPEG(fine)).psnr > difference(source, decodeJPEG(coarse)).psnr);
});

test('the file is a baseline JFIF with quality-scaled tables and no varying bytes', () => {
  const source = pattern(40, 24);
  const bytes = encodeJPEG(source);
  assert.deepEqual(bytes, encodeJPEG(source, { quality: 90, subsampling: '444' }));
  assert.deepEqual([...bytes.subarray(0, 4)], [0xff, 0xd8, 0xff, 0xe0]);
  assert.equal(bytes.subarray(6, 11).toString('latin1'), 'JFIF\0');
  assert.deepEqual([...bytes.subarray(-2)], [0xff, 0xd9]);
  // APP0, two DQT, SOF0 (baseline), four DHT; then the scan.
  assert.deepEqual(markers(bytes), [0xe0, 0xdb, 0xdb, 0xc0, 0xc4, 0xc4, 0xc4, 0xc4]);
  // Quality 90 scales the Annex K luma table 16, 11, 10, 16 to 3, 2, 2, 3.
  const dqt = bytes.indexOf(Buffer.from([0xff, 0xdb]));
  assert.deepEqual([...bytes.subarray(dqt + 4, dqt + 9)], [0, 3, 2, 2, 3]);
  const sof = bytes.indexOf(Buffer.from([0xff, 0xc0]));
  assert.deepEqual([...bytes.subarray(sof + 4, sof + 19)], [8, 0, 24, 0, 40, 3, 1, 0x11, 0, 2, 0x11, 1, 3, 0x11, 1]);
  const subsampled = encodeJPEG(source, { subsampling: '420' });
  assert.equal(subsampled[subsampled.indexOf(Buffer.from([0xff, 0xc0])) + 11], 0x22);
});

test('alpha is flattened over the background', () => {
  const image = createImage(16, 16);
  for (let offset = 0; offset < image.data.length; offset += 4) image.data.set([255, 255, 255, 0], offset);
  const black = decodeJPEG(encodeJPEG(image));
  assert.ok(black.data[0] <= 2 && black.data[1] <= 2 && black.data[2] <= 2);
  const cream = decodeJPEG(encodeJPEG(image, { background: [240, 230, 200] }));
  assert.ok(Math.abs(cream.data[0] - 240) <= 2 && Math.abs(cream.data[1] - 230) <= 2 && Math.abs(cream.data[2] - 200) <= 2);
});

test('restart markers change the bytes and not the picture', () => {
  const source = pattern(101, 77);
  for (const subsampling of ['444', '420']) {
    const plain = encodeJPEG(source, { subsampling });
    for (const restartInterval of [1, 3, 7]) {
      const restarted = encodeJPEG(source, { subsampling, restartInterval });
      assert.ok(restarted.includes(Buffer.from([0xff, 0xdd, 0, 4, 0, restartInterval])));
      assert.ok(restarted.includes(Buffer.from([0xff, 0xd0])));
      // Every MCU restarts: the marker number has wrapped past RST7.
      if (restartInterval === 1) assert.ok(restarted.includes(Buffer.from([0xff, 0xd7])));
      assert.deepEqual(decodeJPEG(restarted).data, decodeJPEG(plain).data);
    }
  }
});

// 24×20 progressive file (DC scan, then one AC scan per component), written by
// mozjpeg at quality 92 from the pattern rebuilt below. Not made by this encoder.
const PROGRESSIVE = '/9j/4AAQSkZJRgABAQAAAQABAAD/2wCEAAMDAwMDAwMDAwMEBAQEBAYFBQUFBgkGBwYHBgkOCAoICAoIDgwPDAsMDwwWEQ8PERYZFRQVGR4bGx4mJCYyMkMBAwMDAwMDAwMDAwQEBAQEBgUFBQUGCQYHBgcGCQ4ICggICggODA8MCwwPDBYRDw8RFhkVFBUZHhsbHiYkJjIyQ//CABEIABQAGAMBEQACEQEDEQH/xAAuAAEAAwEAAAAAAAAAAAAAAAAGAAUHCAEBAAMBAAAAAAAAAAAAAAAABwYICQX/2gAMAwEAAhADEAAAAOP7fxdqC2pZQafL17K2Vl072fjFdw15etCZ0Zkrn//EACQQAAAEBQMFAAAAAAAAAAAAAAAEBiMBAgMFMREhMhIigYPS/9oACAEBAAE/ACCUw0CiSjS066csPMAQSmGgQSnFoU0ioqvC2zR9lP6BBKYbBC3FNmwQtxXZsELcV7Wx/8QAIhEAAQMEAgIDAAAAAAAAAAAABQAEIgECAzIREwexEmJj/9oACAECAQE/ADJjaaJ+QQTj5dJCt3P5Zae7UZMbTRkxtNZmLpvz3Y6W8fa2vqqMmNpoy6zTkjLrNKSMus05L//EACURAAAEBQIHAAAAAAAAAAAAAAAEBiIBAgMFMgexERIUIzNkhP/aAAgBAwEBPwBPX/B4syZWRTk6i0xk4exRjtOE9fsHhPX/AAeC+s+mhrwKWE/yGob0wnr9g8J45XY8J45XY8J45X7bx//Z';

test('a progressive file from another encoder decodes to its source', () => {
  const bytes = Buffer.from(PROGRESSIVE, 'base64');
  assert.deepEqual(jpegSize(bytes), { width: 24, height: 20, components: 3, progressive: true });
  const source = createImage(24, 20);
  for (let y = 0; y < 20; y++) {
    for (let x = 0; x < 24; x++) {
      const square = x >= 8 && x < 16 && y >= 6 && y < 14;
      source.data.set(square ? [230, 40, 60, 255] : [x * 10, y * 12, 200 - x * 5, 255], (y * 24 + x) * 4);
    }
  }
  const { max, psnr } = difference(source, decodeJPEG(bytes));
  assert.ok(max <= 12 && psnr > 40, `max ${max}, PSNR ${psnr.toFixed(1)}`);
});

test('bad input and unsupported files are refused by name', () => {
  const source = pattern(16, 16);
  assert.throws(() => encodeJPEG(source, { quality: 0 }), /quality/);
  assert.throws(() => encodeJPEG(source, { quality: 90.5 }), /quality/);
  assert.throws(() => encodeJPEG(source, { subsampling: '422' }), /subsampling/);
  assert.throws(() => encodeJPEG({ width: 2, height: 2, data: new Uint8Array(15) }), /RGBA8/);
  assert.throws(() => encodeJPEG({ width: 0, height: 2, data: new Uint8Array(0) }), /width and height/);

  const bytes = encodeJPEG(source);
  assert.throws(() => decodeJPEG(Buffer.from('not a jpeg at all')), /missing SOI/);
  assert.throws(() => jpegSize(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a])), /missing SOI/);
  assert.throws(() => decodeJPEG(bytes.subarray(0, 300)), /JPEG: /);
  assert.throws(() => decodeJPEG(Buffer.from([0xff, 0xd8, 0xff, 0xd9])), /no image data/);
  const sof = bytes.indexOf(Buffer.from([0xff, 0xc0]));
  for (const [marker, reason] of [[0xc9, /arithmetic-coded JPEG is not supported/], [0xc3, /lossless JPEG is not supported/]]) {
    const other = Buffer.from(bytes);
    other[sof + 1] = marker;
    assert.throws(() => decodeJPEG(other), reason);
  }
  const deep = Buffer.from(bytes);
  deep[sof + 4] = 12;
  assert.throws(() => decodeJPEG(deep), /12-bit samples are not supported/);
});
