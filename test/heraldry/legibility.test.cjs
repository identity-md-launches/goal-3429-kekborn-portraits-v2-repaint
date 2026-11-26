'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { test } = require('node:test');
const H = require('../../src/heraldry/index.cjs');
const { measureCharge, measureEdge, choicesFor, ROOT } = require('./legibility-measure.cjs');

// WCAG's minimum for graphical objects; every pairing is required to meet it at
// the 240x288 banner size and reduced to the 100x120 rail size.
const MIN_CONTRAST = 3.0;
const COLOUR_NAMES = H.COLOURS.map((c) => c.name);

function cases() {
  const out = [];
  for (const division of H.DIVISIONS) {
    for (const ordinary of H.ORDINARIES) {
      for (const charge of H.CHARGES) {
        for (const metal of H.METALS.map((m) => m.name)) {
          for (let k = 0; k < COLOUR_NAMES.length; k++) {
            out.push({
              division, ordinary, charge, metal,
              chargeTincture: COLOUR_NAMES[k],
              field: COLOUR_NAMES[(k + 1) % COLOUR_NAMES.length],
              secondary: COLOUR_NAMES[(k + 2) % COLOUR_NAMES.length],
            });
          }
        }
      }
    }
  }
  return out;
}

test('every division x ordinary x charge pairing: charge reads on the ordinary and against the field at both sizes', () => {
  const weak = [];
  for (const c of cases()) {
    const m = measureCharge(choicesFor(c));
    for (const size of ['banner', 'rail']) {
      for (const region of ['onOrdinary', 'rimOnField']) {
        const { contrast, pixels } = m[size][region];
        if (!pixels) continue;
        if (contrast < MIN_CONTRAST) {
          weak.push(`${c.division}/${c.ordinary}/${c.charge} ${c.chargeTincture} on ${c.metal} over ${c.field}: ${size} ${region} ${contrast.toFixed(2)}`);
        }
      }
      assert.ok(m[size].onOrdinary.pixels > 0, `${c.ordinary}/${c.charge}: some of the charge lies on the ordinary at ${size}`);
    }
  }
  assert.deepEqual(weak, []);
});

test('the shield edge reads on a banner cloth of the field\'s own colour at both sizes', () => {
  for (const field of COLOUR_NAMES) {
    for (const metal of H.METALS.map((m) => m.name)) {
      const i = COLOUR_NAMES.indexOf(field);
      const choices = choicesFor({
        field, metal,
        secondary: COLOUR_NAMES[(i + 1) % 4], chargeTincture: COLOUR_NAMES[(i + 2) % 4],
        division: 'plain', ordinary: 'bend', charge: 'tower',
      });
      const edge = measureEdge(choices);
      for (const size of ['banner', 'rail']) {
        assert.ok(edge[size].contrast >= MIN_CONTRAST,
          `${field} field, ${metal} edge on ${field} cloth at ${size}: ${edge[size].contrast.toFixed(2)}`);
      }
    }
  }
});

test('charge tincture is its own seeded colour, never the field or secondary, and is recorded in choices', () => {
  const seen = new Set();
  for (let i = 0; i < 40; i++) {
    const seed = crypto.createHash('sha256').update(`charge-tincture-${i}`).digest();
    const { choices, usedLayers } = H.buildArms(seed, { root: ROOT });
    const t = choices.tincture.charge;
    assert.ok(H.COLOURS.some((c) => c.name === t.name && c.hex === t.hex), 'charge tincture is a published colour');
    assert.notEqual(t.name, choices.tincture.field.name);
    assert.notEqual(t.name, choices.tincture.secondary.name);
    seen.add(t.name);
    const paths = usedLayers.map((l) => l.path);
    for (const part of [`charges/${choices.charge}.png`, `charges/${choices.charge}-fimbriation.png`,
      `charges/${choices.charge}-keyline.png`, 'fields/edge-keyline.png', 'fields/edge-fillet.png']) {
      assert.ok(paths.includes(`layers/heraldry/${part}`), `${part} is recorded in usedLayers`);
    }
  }
  assert.equal(seen.size, H.COLOURS.length, 'every colour appears as a charge tincture across the sample');
});

test('two builds from one seed are byte-identical', () => {
  const seed = crypto.createHash('sha256').update('legibility-repeat').digest();
  const a = H.buildArms(Buffer.from(seed), { root: ROOT });
  const b = H.buildArms(Buffer.from(seed), { root: ROOT });
  assert.equal(Buffer.compare(Buffer.from(a.image.data), Buffer.from(b.image.data)), 0);
  assert.deepEqual(a.choices, b.choices);
  assert.deepEqual(a.usedLayers, b.usedLayers);
});
