'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { test } = require('node:test');
const { MASTER_WIDTH, MASTER_HEIGHT, FRAME_APERTURE, decodePNG, composite, createImage } = require('../../src/raster/index.cjs');

const root = resolve(__dirname, '../..');
const read = path => readFileSync(resolve(root, path));
const catalog = JSON.parse(read('catalog/foundation.json'));
const svg = read(catalog.template).toString();
const metadata = JSON.parse(svg.match(/<metadata id="kekborn-registration">([\s\S]*?)<\/metadata>/)[1]);

function pixel(image, x, y) {
  const i = (y * image.width + x) * 4;
  return Array.from(image.data.subarray(i, i + 4));
}

test('foundation catalog, SVG registration and raster aperture agree on one master grid', () => {
  assert.equal(catalog.registrationVersion, metadata.version);
  assert.deepEqual([catalog.canvas.width, catalog.canvas.height], [MASTER_WIDTH, MASTER_HEIGHT]);
  assert.deepEqual([metadata.canvas.w, metadata.canvas.h], [MASTER_WIDTH, MASTER_HEIGHT]);
  assert.deepEqual(catalog.frameAperture, FRAME_APERTURE);
  assert.deepEqual(metadata.frameAperture, { x0: 144, y0: 144, x1: 1904, y1: 2368, x1y1: 'exclusive' });
  const { farEye, nearEye, tympanum, crownSeat, eyeBeds, crownOverlap } = catalog.registration;
  for (const [name, landmark] of Object.entries({ farEye, nearEye, tympanum, crownSeat })) {
    assert.deepEqual(metadata.landmarks[name], landmark);
  }
  assert.deepEqual(tympanum, { x: 1238, y: 1046, rx: 56, ry: 62, approximate: true });
  assert.equal((nearEye.y - farEye.y) / (nearEye.x - farEye.x), -1 / 15);
  for (const name of ['far', 'near']) assert.deepEqual(metadata.eyeBeds[name], eyeBeds[name]);
  assert.deepEqual(metadata.crownOverlap.centralBand, crownOverlap.centralBand);
  assert.equal(metadata.crownOverlap.minimumPaintOverlap, crownOverlap.minimumPaintOverlap);
  for (const name of ['bannerArms', 'railArms']) assert.deepEqual(metadata.reserves[name], catalog.reserves[name]);
  assert.match(svg, /id="tympanum" cx="1238" cy="1046"/);
  assert.match(svg, /id="far-eye-bed" cx="680" cy="936" rx="44" ry="48"/);
  assert.match(svg, /id="near-eye-bed" cx="1040" cy="912" rx="68" ry="68"/);
  assert.match(svg, /id="crown-overlap"/);
});

test('accepted foundation PNGs retain their hashes, dimensions and painted eye beds', () => {
  for (const layer of catalog.layers) {
    const bytes = read(layer.path);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), layer.sha256, layer.path);
    const image = decodePNG(bytes);
    assert.deepEqual([image.width, image.height], [MASTER_WIDTH, MASTER_HEIGHT]);
    if (layer.kind === 'skin') {
      for (const { cx, cy } of Object.values(catalog.registration.eyeBeds)) {
        const [r, g, b, a] = pixel(image, cx, cy);
        assert.equal(a, 255, 'eye bed is painted substrate, not an alpha hole');
        assert.ok(r < 80 && g < 65 && b < 60, 'bed is dark umber awaiting eye paint');
      }
      // The nominal seat is just above the skin. A band ending there would
      // float. The lower central overlap guide actually reaches opaque paint.
      assert.equal(pixel(image, 969, 680)[3], 0);
      assert.equal(pixel(image, 969, 720)[3], 255);
    }
  }
});

test('rail shield and its clear space keep opaque wood beneath transparent arms corners', () => {
  const frameLayer = catalog.layers.find(layer => layer.kind === 'frame');
  const frame = decodePNG(read(frameLayer.path));
  const { x0, y0, x1, y1, clearSpace } = catalog.reserves.railArms;
  for (let y = y0 - clearSpace; y < y1 + clearSpace; y++) {
    for (let x = x0 - clearSpace; x < x1 + clearSpace; x++) {
      assert.equal(pixel(frame, x, y)[3], 255, `rail substrate missing at ${x},${y}`);
    }
  }
  assert.equal(pixel(frame, 1024, 1000)[3], 0, 'the actual frame opening stays transparent');
  const woodCorner = pixel(frame, x0, y0);
  const arms = createImage(5, 6);
  arms.data.set([201, 164, 90, 255], (3 * 5 + 2) * 4);
  composite(frame, arms, { x: x0, y: y0, width: x1 - x0, height: y1 - y0 });
  assert.deepEqual(pixel(frame, x0, y0), woodCorner, 'clear arms corners must reveal the existing wood');
  assert.equal(pixel(frame, 1024, 2474)[3], 255);
});
