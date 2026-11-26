'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createImage, finish, encodePNG, decodePNG } = require('../../src/raster/index.cjs');

function flat(rgb, width = 512, height = 640) {
  const image = createImage(width, height);
  image.data.fill(Buffer.from([...rgb, 255]));
  return image;
}

function rgb(image, x, y) {
  const i = (y * image.width + x) * 4;
  return Array.from(image.data.subarray(i, i + 3));
}

const seed = Buffer.from('finish-properties');

test('varnish is a restrained #E0B870 multiply and yellowing grows in highlights', () => {
  // At white, crack visibility is zero. At black a crack-free pixel must remain
  // black: an additive amber wash would lift it. Small fixtures miss the rails.
  assert.deepEqual(rgb(finish(flat([255, 255, 255], 1, 1), seed), 0, 0), [253, 250, 245]);
  const black = finish(flat([0, 0, 0]), seed);
  assert.ok(black.data.some((value, i) => i % 4 === 0 && value === 0));
  const mid = finish(flat([128, 128, 128]), seed);
  const colors = new Map();
  for (let y = 64; y < 576; y++) {
    for (let x = 64; x < 448; x++) {
      const color = rgb(mid, x, y).join(',');
      colors.set(color, (colors.get(color) || 0) + 1);
    }
  }
  const [uncracked] = [...colors].sort((a, b) => b[1] - a[1])[0];
  assert.equal(uncracked, '127,126,124');
});

test('crackle is fine, restrained, seeded and weighted toward dark paint', () => {
  const dark = finish(flat([80, 80, 80]), seed);
  const light = finish(flat([210, 210, 210]), seed);
  const anotherSeed = finish(flat([80, 80, 80]), Buffer.from('finish-properties-2'));
  let darkCracks = 0;
  let lightCracks = 0;
  let changedGeometry = 0;
  const total = 384 * 512;
  for (let y = 64; y < 576; y++) {
    for (let x = 64; x < 448; x++) {
      const d = rgb(dark, x, y);
      const l = rgb(light, x, y);
      if (d.join(',') !== '79,79,77') darkCracks++;
      if (l.join(',') !== '208,206,202') lightCracks++;
      if (d.join(',') !== rgb(anotherSeed, x, y).join(',')) changedGeometry++;
      // Hairlines and crossings should leave most of the paint unmarked and
      // never become a heavy black grid (three RGB levels at most here).
      assert.ok(d[0] >= 76 && d[1] >= 76 && d[2] >= 74);
    }
  }
  assert.ok(darkCracks > total * 0.02 && darkCracks < total * 0.30);
  assert.ok(darkCracks > lightCracks * 4);
  assert.ok(changedGeometry > total * 0.02);
});

test('crack pigment blends toward warm #2A1E17 rather than subtracting neutral RGB', () => {
  const painted = finish(flat([70, 100, 180]), seed);
  // Away from cracks this swatch becomes [69,98,174]. Warm umber lines
  // attenuate its blue much more than its red. Neutral subtraction cannot do so.
  let strongest;
  for (let y = 64; y < 576; y++) {
    for (let x = 64; x < 448; x++) {
      const p = rgb(painted, x, y);
      if (!strongest || p[2] < strongest[2]) strongest = p;
    }
  }
  assert.equal(strongest[0], 69);
  assert.ok(strongest[1] >= 95 && strongest[1] <= 97);
  assert.ok(strongest[2] >= 168 && strongest[2] <= 170);
});

test('only the top/left cast inward; the 44px fade scales with preview dimensions', () => {
  for (const [width, height] of [[256, 320], [512, 640], [1024, 1280]]) {
    // White suppresses cracks, allowing exact boundary comparisons at all sizes.
    const painted = finish(flat([255, 255, 255], width, height), seed);
    const left = 144 * width / 2048;
    const top = 144 * height / 2560;
    const right = 1904 * width / 2048;
    const bottom = 2368 * height / 2560;
    const middleX = width / 2;
    const middleY = height / 2;
    const base = [253, 250, 245];
    assert.deepEqual(rgb(painted, left - 1, middleY), base);
    assert.deepEqual(rgb(painted, middleX, top - 1), base);
    assert.ok(rgb(painted, left, middleY)[0] < 205);
    assert.ok(rgb(painted, middleX, top)[0] < 205);
    assert.deepEqual(rgb(painted, right - 1, middleY), base);
    assert.deepEqual(rgb(painted, right, middleY), base);
    assert.deepEqual(rgb(painted, middleX, bottom - 1), base);
    assert.deepEqual(rgb(painted, middleX, bottom), base);
    const fadedX = Math.ceil(left + 44 * width / 2048);
    const fadedY = Math.ceil(top + 44 * height / 2560);
    assert.deepEqual(rgb(painted, fadedX, middleY), base);
    assert.deepEqual(rgb(painted, middleX, fadedY), base);
    let previous = 0;
    for (let x = left; x <= fadedX; x++) {
      const value = rgb(painted, x, middleY)[0];
      assert.ok(value >= previous, 'shadow must fade smoothly inward');
      previous = value;
    }
    // Shadow is clipped even at corners; it does not double at the top-left.
    assert.deepEqual(rgb(painted, left, top), rgb(painted, left, middleY));
    assert.deepEqual(rgb(painted, left - 1, top), base);
    assert.deepEqual(rgb(painted, left, bottom), base);
    assert.deepEqual(rgb(painted, right, top), base);
  }
});

test('finish preserves all alpha values and hidden RGB, with no alpha-dependent colour shift', () => {
  const partial = flat([70, 100, 180], 256, 320);
  const opaque = flat([70, 100, 180], 256, 320);
  for (let p = 0; p < partial.width * partial.height; p++) partial.data[p * 4 + 3] = p % 256;
  const before = Buffer.from(partial.data);
  // Include distinct hidden RGB to catch transparent pixels being tinted.
  partial.data.set([231, 15, 76, 0], 0);
  before.set([231, 15, 76, 0], 0);
  assert.equal(finish(partial, seed), partial);
  finish(opaque, seed);
  for (let i = 0; i < partial.data.length; i += 4) {
    assert.equal(partial.data[i + 3], before[i + 3]);
    const expected = before[i + 3] === 0 ? before : opaque.data;
    assert.deepEqual(partial.data.subarray(i, i + 3), expected.subarray(i, i + 3));
  }
  assert.deepEqual(decodePNG(encodePNG(partial)), partial);
});

test('seed bytes accept Uint8Array views synchronously and invalid seeds do not mutate paint', () => {
  const a = flat([70, 100, 180], 128, 160);
  const b = flat([70, 100, 180], 128, 160);
  assert.equal(finish(a, Uint8Array.of(99, 1, 2, 3, 88).subarray(1, 4)), a);
  assert.equal(finish(b, Buffer.from([1, 2, 3])), b);
  assert.deepEqual(encodePNG(a), encodePNG(b));
  for (const invalid of [undefined, null, '', 'seed', [], Buffer.alloc(0), new Uint8Array(0)]) {
    const input = flat([70, 100, 180], 1, 1);
    const before = Buffer.from(input.data);
    assert.throws(() => finish(input, invalid), /nonempty seed bytes/);
    assert.deepEqual(input.data, before);
  }
});
