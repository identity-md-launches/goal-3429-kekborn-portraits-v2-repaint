'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { test } = require('node:test');
const armsPath = require.resolve('../../src/heraldry/index.cjs');
const {
  buildArms, SHIELD_WIDTH, SHIELD_HEIGHT, COLOURS, METALS, DIVISIONS, ORDINARIES, CHARGES,
} = require(armsPath);
const { createImage, composite } = require('../../src/raster/index.cjs');

const ROOT = path.resolve(__dirname, '..', '..');

function seedFor(label) {
  return crypto.createHash('sha256').update(label).digest();
}

function pixel(image, x, y) {
  const i = (y * image.width + x) * 4;
  return Array.from(image.data.subarray(i, i + 4));
}

test('image shape matches the heater shield box', () => {
  const { image } = buildArms(seedFor('shape'), { root: ROOT });
  assert.equal(image.width, SHIELD_WIDTH);
  assert.equal(image.height, SHIELD_HEIGHT);
  assert.equal(image.data.length, SHIELD_WIDTH * SHIELD_HEIGHT * 4);
});

test('repeated seed is byte-identical: image, choices and usedLayers', () => {
  const seed = seedFor('repeat-me');
  const a = buildArms(Buffer.from(seed), { root: ROOT });
  const b = buildArms(Buffer.from(seed), { root: ROOT });
  assert.deepEqual(a.image, b.image);
  assert.deepEqual(a.choices, b.choices);
  assert.deepEqual(a.usedLayers, b.usedLayers);
});

test('a changed seed changes the result', () => {
  const a = buildArms(seedFor('seed-A'), { root: ROOT });
  const b = buildArms(seedFor('seed-B'), { root: ROOT });
  assert.notDeepEqual(a.choices, b.choices);
  assert.notDeepEqual(a.image.data, b.image.data);
});

test('valid combinations: tinctures, division, ordinary and charge all come from the published sets', () => {
  const colourHexes = new Set(COLOURS.map((c) => c.hex));
  const metalHexes = new Set(METALS.map((m) => m.hex));
  for (let i = 0; i < 12; i++) {
    const { choices } = buildArms(seedFor(`combo-${i}`), { root: ROOT });
    assert.ok(colourHexes.has(choices.tincture.field.hex), 'field is a published colour');
    assert.ok(colourHexes.has(choices.tincture.secondary.hex), 'secondary is a published colour');
    assert.notEqual(choices.tincture.field.hex, choices.tincture.secondary.hex, 'field and secondary differ');
    assert.ok(metalHexes.has(choices.tincture.metal.hex), 'metal is a published metal (rule of tincture)');
    assert.ok(DIVISIONS.includes(choices.division));
    assert.ok(ORDINARIES.includes(choices.ordinary));
    assert.ok(CHARGES.includes(choices.charge));
  }
});

test('draws cover every division, ordinary and charge option across a seed sample', () => {
  const seen = { division: new Set(), ordinary: new Set(), charge: new Set() };
  for (let i = 0; i < 30; i++) {
    const { choices } = buildArms(seedFor(`spread-${i}`), { root: ROOT });
    seen.division.add(choices.division);
    seen.ordinary.add(choices.ordinary);
    seen.charge.add(choices.charge);
  }
  assert.equal(seen.division.size, DIVISIONS.length);
  assert.equal(seen.ordinary.size, ORDINARIES.length);
  assert.equal(seen.charge.size, CHARGES.length);
});

test('usedLayers names root-relative paths inside layers/heraldry and matches each source file sha256', () => {
  const { usedLayers } = buildArms(seedFor('hashes'), { root: ROOT });
  assert.ok(usedLayers.length >= 2);
  for (const { path: relPath, sha256 } of usedLayers) {
    assert.ok(relPath.startsWith('layers/heraldry/'), `${relPath} is under layers/heraldry/`);
    const absPath = path.join(ROOT, relPath);
    const bytes = fs.readFileSync(absPath);
    const expected = crypto.createHash('sha256').update(bytes).digest('hex');
    assert.equal(sha256, expected, `${relPath} sha256 matches the file on disk`);
  }
});

test('rejects a malformed seed or a missing root', () => {
  assert.throws(() => buildArms(Buffer.alloc(31), { root: ROOT }), TypeError);
  assert.throws(() => buildArms('not bytes', { root: ROOT }), TypeError);
  assert.throws(() => buildArms(seedFor('ok'), {}), TypeError);
});

test('clear exterior: the box corners outside the heater-shield outline stay transparent', () => {
  const { image } = buildArms(seedFor('clear-exterior'), { root: ROOT });
  for (const [x, y] of [[0, 0], [SHIELD_WIDTH - 1, 0], [0, SHIELD_HEIGHT - 1], [SHIELD_WIDTH - 1, SHIELD_HEIGHT - 1]]) {
    assert.equal(pixel(image, x, y)[3], 0, `corner (${x},${y}) is clear`);
  }
});

test('the charge stays legible scaled down to the 100x120 rail size', () => {
  for (const label of ['rail-1', 'rail-2', 'rail-3']) {
    const { image } = buildArms(seedFor(label), { root: ROOT });
    const rail = createImage(100, 120);
    composite(rail, image, { x: 0, y: 0, width: 100, height: 120 });
    // Charge/ordinary centre (master-local 120,176) vs an open-field corner
    // (master-local 210,30) far from every ordinary and charge shape.
    const scale = { x: 100 / SHIELD_WIDTH, y: 120 / SHIELD_HEIGHT };
    const centre = pixel(rail, Math.round(120 * scale.x), Math.round(176 * scale.y));
    const field = pixel(rail, Math.round(210 * scale.x), Math.round(30 * scale.y));
    const distance = Math.abs(centre[0] - field[0]) + Math.abs(centre[1] - field[1]) + Math.abs(centre[2] - field[2]);
    assert.ok(centre[3] > 200, `${label}: charge centre is opaque at rail size`);
    assert.ok(distance > 120, `${label}: charge vs field colour distance ${distance} stays legible at rail size`);
  }
});
