'use strict';

// Contrast measure for the coat of arms: how well the charge reads against what
// lies under it, and how well the shield edge reads against banner cloth, at the
// 240x288 banner size and reduced to the 100x120 rail size.
//
// Contrast is the WCAG ratio (L1 + 0.05) / (L2 + 0.05) of the mean relative
// luminance of a region in the finished arms against the mean relative
// luminance of the same region in what lies under it.

const path = require('node:path');
const { createImage, composite } = require('../../src/raster/index.cjs');
const H = require('../../src/heraldry/index.cjs');

const ROOT = path.resolve(__dirname, '..', '..');
const RAIL = { width: 100, height: 120 };

function channel(v) {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}
function luminance(data, i) {
  return 0.2126 * channel(data[i]) + 0.7152 * channel(data[i + 1]) + 0.0722 * channel(data[i + 2]);
}
function ratio(a, b) {
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

function reduce(image) {
  const out = createImage(RAIL.width, RAIL.height);
  composite(out, image, { x: 0, y: 0, width: RAIL.width, height: RAIL.height });
  return out;
}

function alphaOf(file) {
  return H.paintParts([{ file, tincture: '#B0B0B0' }], { root: ROOT }).image;
}

// Mean luminance of `top` and `under` over pixels where pick(i) is true.
function regionContrast(top, under, pick) {
  let a = 0; let b = 0; let n = 0;
  for (let i = 0; i < top.data.length; i += 4) {
    if (!pick(i)) continue;
    a += luminance(top.data, i);
    b += luminance(under.data, i);
    n++;
  }
  if (!n) return { contrast: null, pixels: 0 };
  return { contrast: ratio(a / n, b / n), pixels: n };
}

const CHARGE_PARTS = (charge) => new Set([
  `charges/${charge}-keyline.png`, `charges/${charge}-fimbriation.png`, `charges/${charge}.png`,
]);

function measureCharge(choices) {
  const plan = H.planArms(choices);
  const drop = CHARGE_PARTS(choices.charge);
  const full = H.paintParts(plan, { root: ROOT }).image;
  const under = H.paintParts(plan.filter((p) => !drop.has(p.file)), { root: ROOT }).image;
  const masks = {
    charge: alphaOf(`charges/${choices.charge}.png`),
    rim: alphaOf(`charges/${choices.charge}-fimbriation.png`),
    ordinary: alphaOf(`ordinaries/${choices.ordinary}.png`),
  };
  const result = {};
  for (const [size, f, u, m, rimMin] of [
    ['banner', full, under, masks, 200],
    ['rail', reduce(full), reduce(under), {
      charge: reduce(masks.charge), rim: reduce(masks.rim), ordinary: reduce(masks.ordinary),
    }, 160],
  ]) {
    const A = (img, i) => img.data[i + 3];
    // Charge body lying on the ordinary: charge colour vs metal.
    const onOrdinary = regionContrast(f, u, (i) => A(m.charge, i) >= 200 && A(m.ordinary, i) >= 200);
    // Charge silhouette where it leaves the ordinary: metal rim vs the colour field.
    const rimOnField = regionContrast(f, u, (i) => A(m.rim, i) >= rimMin && A(m.charge, i) < 60 && A(m.ordinary, i) < 40);
    // Charge body on the field (colour on colour; separated by the rim, reported only).
    const bodyOnField = regionContrast(f, u, (i) => A(m.charge, i) >= 200 && A(m.ordinary, i) < 40);
    result[size] = { onOrdinary, rimOnField, bodyOnField };
  }
  return result;
}

function flatCloth(hex, width, height) {
  const img = createImage(width, height);
  const r = parseInt(hex.slice(1, 3), 16); const g = parseInt(hex.slice(3, 5), 16); const b = parseInt(hex.slice(5, 7), 16);
  for (let i = 0; i < img.data.length; i += 4) {
    img.data[i] = r; img.data[i + 1] = g; img.data[i + 2] = b; img.data[i + 3] = 255;
  }
  return img;
}

// Shield edge against a cloth painted in the field's own colour: the edge band
// (keyline + fillet) on the cloth image vs the bare cloth.
function measureEdge(choices, { withEdge = true } = {}) {
  let plan = H.planArms(choices);
  if (!withEdge) plan = plan.filter((p) => !p.file.startsWith('fields/edge-'));
  const arms = H.paintParts(plan, { root: ROOT }).image;
  const fillet = alphaOf('fields/edge-fillet.png');
  const out = {};
  for (const [size, w, h, min] of [['banner', 240, 288, 200], ['rail', 100, 120, 120]]) {
    const cloth = flatCloth(choices.tincture.field.hex, w, h);
    const onCloth = flatCloth(choices.tincture.field.hex, w, h);
    composite(onCloth, arms, { x: 0, y: 0, width: w, height: h });
    const mask = size === 'rail' ? reduce(fillet) : fillet;
    out[size] = regionContrast(onCloth, cloth, (i) => mask.data[i + 3] >= min);
  }
  return out;
}

function choicesFor({ field, secondary, metal, chargeTincture, division, ordinary, charge }) {
  const pick = (list, name) => {
    const t = list.find((c) => c.name === name);
    return { name: t.name, hex: t.hex };
  };
  return {
    tincture: {
      field: pick(H.COLOURS, field),
      secondary: pick(H.COLOURS, secondary),
      metal: pick(H.METALS, metal),
      charge: pick(H.COLOURS, chargeTincture),
    },
    division,
    ordinary,
    charge,
  };
}

module.exports = { measureCharge, measureEdge, choicesFor, ROOT };
