'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  createImage, finish, encodePNG, decodePNG,
  GLAZE_STRENGTH, GLAZE_TINT, BRUSH_STRENGTH, CANVAS_WEAVE_WEIGHT, STROKE_RELIEF_WEIGHT,
  VARNISH_STRENGTH, VARNISH_HIGHLIGHT_STRENGTH, VARNISH_TINT,
  CRAQUELURE_STRENGTH, CRAQUELURE_TINT, FRAME_SHADOW_STRENGTH, FRAME_SHADOW_FADE,
} = require('../../src/raster/index.cjs');

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
const stages = ['glaze', 'brush', 'varnish', 'craquelure', 'frameShadow'];
const only = name => Object.fromEntries(stages.map(stage => [stage, stage === name]));
// Retain the original varnish/crack numerical checks independently of the new
// glaze and brush stages. Default-call coverage below exercises all five.
const surface = (image, bytes = seed) => finish(image, bytes, { glaze: false, brush: false });

test('finish exports the restrained named strengths and immutable pigment tints', () => {
  assert.equal(GLAZE_STRENGTH, 0.16);
  assert.equal(BRUSH_STRENGTH, 0.03);
  assert.equal(CANVAS_WEAVE_WEIGHT + STROKE_RELIEF_WEIGHT, 1);
  assert.equal(VARNISH_STRENGTH, 0.06);
  assert.equal(VARNISH_HIGHLIGHT_STRENGTH, 0.01);
  assert.equal(CRAQUELURE_STRENGTH, 24);
  assert.equal(FRAME_SHADOW_STRENGTH, 0.23);
  assert.equal(FRAME_SHADOW_FADE, 44);
  for (const tint of [GLAZE_TINT, VARNISH_TINT, CRAQUELURE_TINT]) assert.ok(Object.isFrozen(tint));
});

test('warm glaze deepens shadows more than highlights without lifting black', () => {
  const colours = [0, 40, 80, 128, 210, 255];
  const painted = colours.map(value => rgb(finish(flat([value, value, value], 1, 1), seed, only('glaze')), 0, 0));
  assert.deepEqual(painted[0], [0, 0, 0]);
  assert.deepEqual(painted.at(-1), [255, 255, 255]);
  for (let i = 1; i < colours.length - 1; i++) {
    const colour = painted[i];
    assert.ok(colour.every(value => value <= colours[i]));
    assert.ok(colour[0] >= colour[1] && colour[1] >= colour[2], 'glaze warms neutral paint');
  }
  const darkLoss = (80 - painted[2][2]) / 80;
  const lightLoss = (210 - painted[4][2]) / 210;
  assert.ok(darkLoss > 0.04 && darkLoss > lightLoss * 5, 'glaze principally deepens the shadows');
});

test('brush texture has seeded, coherent relief bounded to a few percent of lightness', () => {
  const a = finish(flat([128, 128, 128]), seed, only('brush'));
  const b = finish(flat([128, 128, 128]), Buffer.from(seed), only('brush'));
  const c = finish(flat([128, 128, 128]), Buffer.from('different-brush'), only('brush'));
  assert.deepEqual(a.data, b.data);
  assert.notDeepEqual(a.data, c.data);
  let brighter = 0;
  let darker = 0;
  let total = 0;
  let adjacentDifference = 0;
  for (let y = 0; y < a.height; y++) {
    for (let x = 0; x < a.width; x++) {
      const [r, g, b] = rgb(a, x, y);
      assert.equal(r, g);
      assert.equal(g, b);
      assert.ok(Math.abs(r - 128) <= Math.ceil(128 * BRUSH_STRENGTH));
      brighter += r > 128;
      darker += r < 128;
      total += r;
      if (y) adjacentDifference += Math.abs(r - a.data[((y - 1) * a.width + x) * 4]);
    }
  }
  const count = a.width * a.height;
  assert.ok(brighter > count * 0.01 && darker > count * 0.01, 'relief has both light and dark slopes');
  assert.ok(Math.abs(total / count - 128) < 0.25, 'texture does not act as an overall exposure change');
  assert.ok(adjacentDifference / count < 0.20, 'elongated strokes remain correlated along their length');
  for (const value of [0, 255]) {
    const protectedPaint = flat([value, value, value], 128, 160);
    const before = Buffer.from(protectedPaint.data);
    finish(protectedPaint, seed, only('brush'));
    assert.deepEqual(protectedPaint.data, before, 'brush protects the ends of the tonal range');
  }
});

test('every finishing stage measurably contributes to the default five-stage pass', () => {
  const full = finish(flat([110, 126, 82]), seed);
  assert.deepEqual(full, finish(flat([110, 126, 82]), seed, {}));
  for (const stage of stages) {
    const without = finish(flat([110, 126, 82]), seed, { [stage]: false });
    let changed = 0;
    let distance = 0;
    for (let i = 0; i < full.data.length; i += 4) {
      const delta = Math.abs(full.data[i] - without.data[i]) +
        Math.abs(full.data[i + 1] - without.data[i + 1]) +
        Math.abs(full.data[i + 2] - without.data[i + 2]);
      changed += delta > 0;
      distance += delta;
    }
    const pixels = full.width * full.height;
    assert.ok(changed > pixels * 0.005, `${stage} must change a measurable area (${changed} pixels)`);
    assert.ok(distance / pixels > 0.005, `${stage} must change stored RGB measurably`);
  }
  const unmodified = flat([110, 126, 82]);
  const before = Buffer.from(unmodified.data);
  finish(unmodified, seed, Object.fromEntries(stages.map(stage => [stage, false])));
  assert.deepEqual(unmodified.data, before);
});

test('varnish is a restrained #E0B870 multiply and yellowing grows in highlights', () => {
  // At white, crack visibility is zero. At black a crack-free pixel must remain
  // black: an additive amber wash would lift it. Small fixtures miss the rails.
  assert.deepEqual(rgb(surface(flat([255, 255, 255], 1, 1)), 0, 0), [253, 250, 245]);
  const black = surface(flat([0, 0, 0]));
  assert.ok(black.data.some((value, i) => i % 4 === 0 && value === 0));
  const mid = surface(flat([128, 128, 128]));
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
  const dark = surface(flat([80, 80, 80]));
  const light = surface(flat([210, 210, 210]));
  const anotherSeed = surface(flat([80, 80, 80]), Buffer.from('finish-properties-2'));
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
  const painted = surface(flat([70, 100, 180]));
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

test('frame shadow clips correctly over coloured brush texture, including non-4:5 rasters', () => {
  for (const [width, height] of [[512, 640], [320, 256]]) {
    const base = finish(flat([110, 126, 82], width, height), seed, { frameShadow: false });
    const shadowed = finish(flat([110, 126, 82], width, height), seed);
    let changed = 0;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const masterX = (x + 0.5) * 2048 / width;
        const masterY = (y + 0.5) * 2560 / height;
        const inside = masterX >= 144 && masterX < 1904 && masterY >= 144 && masterY < 2368;
        const casting = inside && (masterX < 188 || masterY < 188);
        const offset = (y * width + x) * 4;
        for (let c = 0; c < 3; c++) {
          const before = base.data[offset + c];
          const after = shadowed.data[offset + c];
          if (casting) {
            assert.ok(after <= before);
            assert.ok(after >= Math.floor(before * (1 - FRAME_SHADOW_STRENGTH)));
            changed += after !== before;
          } else {
            assert.equal(after, before, 'rails and right/bottom edges add no independent shadow');
          }
        }
      }
    }
    assert.ok(changed > width * height * 0.01);
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

test('invalid stage switches fail before mutation; all-disabled still validates the seed', () => {
  for (const invalid of [null, true, [], { brush: 1 }, { craquelure: undefined }, { typo: false }]) {
    const input = flat([70, 100, 180], 2, 2);
    const before = Buffer.from(input.data);
    assert.throws(() => finish(input, seed, invalid), /boolean finish stage switches/);
    assert.deepEqual(input.data, before);
  }
  assert.throws(() => finish(flat([70, 100, 180], 1, 1), Buffer.alloc(0), only('none')), /nonempty seed bytes/);
});
