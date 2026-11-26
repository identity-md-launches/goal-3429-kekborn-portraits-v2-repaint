'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const { deflateSync } = require('node:zlib');
const rasterPath = require.resolve('../../src/raster/index.cjs');
const {
  MASTER_WIDTH, MASTER_HEIGHT, FRAME_APERTURE, createImage, decodePNG,
  composite, finish, encodePNG,
} = require(rasterPath);

function image(width, height, bytes) {
  return { width, height, data: Buffer.from(bytes) };
}

function pixel(raster, x, y) {
  const i = (y * raster.width + x) * 4;
  return Array.from(raster.data.subarray(i, i + 4));
}

function pngFixture(width, height, depth, colorType, raw, chunks = [], interlace = 0) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = depth;
  header[9] = colorType;
  header[12] = interlace;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    ...[['IHDR', header], ...chunks, ['IDAT', deflateSync(Buffer.from(raw))], ['IEND', []]]
      .map(([name, payload]) => {
        const body = Buffer.concat([Buffer.from(name), Buffer.from(payload)]);
        const size = Buffer.alloc(4);
        size.writeUInt32BE(payload.length);
        const checksum = Buffer.alloc(4);
        let crc = 0xffffffff;
        for (const byte of body) {
          crc ^= byte;
          for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
        }
        checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
        return Buffer.concat([size, body, checksum]);
      }),
  ]);
}

test('RGBA PNG round trip preserves opaque, semitransparent and hidden RGB samples', () => {
  const input = image(2, 2, [212, 51, 60, 0, 42, 55, 9, 1, 8, 80, 222, 127, 0, 54, 91, 255]);
  const png = encodePNG(input);
  const wrapped = Buffer.concat([Buffer.from([42]), png, Buffer.from([17])]);
  assert.deepEqual(decodePNG(wrapped.subarray(1, -1)), input);
  png[png.length - 1] ^= 1;
  assert.throws(() => decodePNG(png), /CRC in IEND/);
});

test('reuses caller-owned decode storage for consecutive layers', () => {
  const scratch = new Uint8Array(4);
  const dest = createImage(1, 1);
  const red = decodePNG(encodePNG(image(1, 1, [255, 0, 0, 128])), scratch);
  assert.equal(red.data, scratch);
  composite(dest, red);
  const bluePNG = encodePNG(image(1, 1, [0, 0, 255, 128]));
  composite(dest, decodePNG(bluePNG, scratch));
  assert.deepEqual(pixel(dest, 0, 0), [85, 0, 170, 192]);
  assert.throws(() => decodePNG(bluePNG, new Uint8Array(3)), /decode target/);
});

test('decodes packed palette transparency and 16-bit grayscale transparency', () => {
  const palette = pngFixture(3, 1, 2, 3, [0, 0x18], [
    ['PLTE', [255, 30, 0, 0, 240, 2, 40, 0, 235]], ['tRNS', [0, 96]],
  ]);
  assert.deepEqual(decodePNG(palette), image(3, 1, [255, 30, 0, 0, 0, 240, 2, 96, 40, 0, 235, 255]));

  const grayscale = pngFixture(2, 1, 16, 0, [0, 0x80, 0, 0x80, 1],
    [['tRNS', [0x80, 0]]]);
  assert.deepEqual(decodePNG(grayscale), image(2, 1, [128, 128, 128, 0, 128, 128, 128, 255]));
});

test('assembles Adam7 passes and reverses a Sub-filtered scanline', () => {
  const adam7 = pngFixture(2, 2, 8, 6, [
    0, 5, 20, 40, 255,
    0, 10, 40, 80, 128,
    1, 15, 60, 120, 0, 5, 20, 40, 64,
  ], [], 1);
  assert.deepEqual(decodePNG(adam7), image(2, 2, [
    5, 20, 40, 255, 10, 40, 80, 128, 15, 60, 120, 0, 20, 80, 160, 64,
  ]));
});

test('source-over preserves straight alpha and composites in call order', () => {
  const red = image(1, 1, [255, 0, 0, 128]);
  const blue = image(1, 1, [0, 0, 255, 128]);
  const clear = image(1, 1, [0, 255, 0, 0]);
  const dest = createImage(1, 1);
  assert.equal(composite(dest, red), dest);
  assert.deepEqual(pixel(dest, 0, 0), [255, 0, 0, 128]);
  composite(dest, clear);
  assert.deepEqual(pixel(dest, 0, 0), [255, 0, 0, 128]);
  composite(dest, blue);
  assert.deepEqual(pixel(dest, 0, 0), [85, 0, 170, 192]);
  assert.deepEqual(pixel(composite(composite(createImage(1, 1), blue), red), 0, 0),
    [170, 0, 85, 192]);
  assert.deepEqual(pixel(red, 0, 0), [255, 0, 0, 128]);
});

test('uses the same transparent source at different scales and clips placement', () => {
  const shield = image(2, 1, [210, 30, 10, 255, 0, 255, 255, 0]);
  const dest = createImage(6, 3);
  composite(dest, shield, { x: 1, y: 0, width: 4, height: 2 });
  composite(dest, shield, { x: -1, y: 2, width: 3, height: 1 });
  assert.deepEqual(pixel(dest, 0, 0), [0, 0, 0, 0]);
  assert.deepEqual(pixel(dest, 1, 1), [210, 30, 10, 255]);
  assert.deepEqual(pixel(dest, 2, 1), [210, 30, 10, 191]);
  assert.deepEqual(pixel(dest, 3, 1), [210, 30, 10, 64]);
  assert.deepEqual(pixel(dest, 4, 1), [0, 0, 0, 0]);
  assert.deepEqual(pixel(dest, 0, 2), [210, 30, 10, 128]);
  assert.deepEqual(pixel(dest, 1, 2), [0, 0, 0, 0]);
  assert.throws(() => composite(dest, shield, { x: 1.5, y: 0, width: 4, height: 2 }), /integer/);
});

test('finish repeats from pristine input, preserves alpha and shadows the top/left inside the aperture', () => {
  assert.deepEqual([MASTER_WIDTH, MASTER_HEIGHT], [2048, 2560]);
  assert.deepEqual(FRAME_APERTURE, { x: 144, y: 144, width: 1760, height: 2224 });
  // Half-scale aperture starts at x=72; a 44 master-pixel shadow at x=94 has faded.
  const original = createImage(1024, 1280);
  original.data.fill(Buffer.from([112, 112, 112, 143]));
  original.data.set([1, 2, 3, 0], 0);
  const a = image(original.width, original.height, original.data);
  const b = image(original.width, original.height, original.data);
  const c = image(original.width, original.height, original.data);
  assert.equal(finish(a, Uint8Array.of(1, 2, 3)), a);
  finish(b, Buffer.from([1, 2, 3]));
  finish(c, Buffer.from([1, 2, 4]));
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, c);
  assert.deepEqual(pixel(a, 0, 0), [1, 2, 3, 0]);
  for (let i = 3; i < a.data.length; i += 4) {
    assert.equal(a.data[i], original.data[i]);
  }
  assert.ok(pixel(a, 72, 500)[0] + 15 < pixel(a, 71, 500)[0]);
  assert.ok(pixel(a, 72, 500)[0] + 15 < pixel(a, 94, 500)[0]);
  assert.ok(pixel(a, 500, 72)[0] + 15 < pixel(a, 500, 71)[0]);
  assert.ok(pixel(a, 500, 72)[0] + 15 < pixel(a, 500, 94)[0]);
  // These edges only clip the opening; neither casts an independent shadow.
  assert.ok(Math.abs(pixel(a, 951, 500)[0] - pixel(a, 952, 500)[0]) <= 2);
  assert.ok(Math.abs(pixel(a, 500, 1183)[0] - pixel(a, 500, 1184)[0]) <= 2);
  const [red, , blue] = pixel(a, 400, 500);
  assert.ok(red > blue);
});

test('two fresh Node processes produce identical master PNG bytes', () => {
  const script = `
    const { composite, createImage, decodePNG, encodePNG, finish } = require(process.argv[1]);
    const canvas = createImage();
    canvas.data.fill(Buffer.from([37, 62, 50, 255]));
    const shield = createImage(16, 20);
    for (let y = 1; y < 19; y++) {
      shield.data.fill(Buffer.from([201, 164, 90, 220]), (y * 16 + 2) * 4, (y * 16 + 14) * 4);
    }
    const source = decodePNG(encodePNG(shield));
    composite(canvas, source, { x: 1500, y: 340, width: 240, height: 288 });
    composite(canvas, source, { x: 974, y: 2404, width: 100, height: 120 });
    process.stdout.write(encodePNG(finish(canvas, Buffer.from('shared-seed'))));
  `;
  const render = () => {
    const run = spawnSync(process.execPath, ['-e', script, rasterPath], { maxBuffer: 16 * 1024 * 1024 });
    assert.ifError(run.error);
    assert.equal(run.status, 0, run.stderr.toString());
    return run.stdout;
  };
  const first = render();
  assert.deepEqual(first, render());
  const portrait = decodePNG(first);
  assert.deepEqual([portrait.width, portrait.height], [2048, 2560]);
  assert.ok(pixel(portrait, 1620, 484)[0] > 160);
  assert.ok(pixel(portrait, 1024, 2464)[0] > 160);
});
