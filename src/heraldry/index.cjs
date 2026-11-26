'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createImage, decodePNG, composite } = require('../raster/index.cjs');

// Registration box: the banner-arms reserve from style-guide.md §2.3, also used
// for the rail-arms placement at 5/12 scale by callers.
const SHIELD_BOX = Object.freeze({ x: 1500, y: 340, width: 2048, height: 2560 });
const SHIELD_WIDTH = 240;
const SHIELD_HEIGHT = 288;

// style-guide.md §3 palette anchors. Colours and metals observe the heraldic
// rule of tincture: colour never sits on colour, metal never sits on metal.
const COLOURS = [
  { name: 'vert', hex: '#253E32' },
  { name: 'gules', hex: '#682F38' },
  { name: 'azure', hex: '#2B4A7A' },
  { name: 'sable', hex: '#32251F' },
];
const METALS = [
  { name: 'or', hex: '#C9A45A' },
  { name: 'argent', hex: '#A7A9A4' },
];
// style-guide.md §3 derived "Night umber": keyline around the charge and shield.
const KEYLINE_HEX = '#14100D';
const DIVISIONS = ['plain', 'pale', 'fess'];
const ORDINARIES = ['cross', 'bend'];
const CHARGES = ['estoile', 'trefoil', 'tower'];

const DIVISION_PARTS = {
  plain: (field) => [{ file: 'fields/plain.png', tincture: field }],
  pale: (field, secondary) => [
    { file: 'divisions/pale-dexter.png', tincture: field },
    { file: 'divisions/pale-sinister.png', tincture: secondary },
  ],
  fess: (field, secondary) => [
    { file: 'divisions/fess-chief.png', tincture: field },
    { file: 'divisions/fess-base.png', tincture: secondary },
  ],
};

function draw(seed, label, count) {
  const digest = createHash('sha256').update(seed).update(label).digest();
  return digest.readUInt32BE(0) % count;
}

function hexToRgb(hex) {
  return {
    r: parseInt(hex.slice(1, 3), 16),
    g: parseInt(hex.slice(3, 5), 16),
    b: parseInt(hex.slice(5, 7), 16),
  };
}

// Layers are authored as value maps: R=G=B brush-stroke lightness centred on
// 176, with alpha carrying the painted shape. Tinting multiplies the chosen
// tincture by that value's departure from the midpoint, so highlights, core
// shadow and stroke direction all survive the recolour.
function tint(raster, hex) {
  const { r, g, b } = hexToRgb(hex);
  const { data } = raster;
  for (let i = 0; i < data.length; i += 4) {
    if (!data[i + 3]) continue;
    const factor = data[i] / 176;
    data[i] = Math.min(255, Math.round(r * factor));
    data[i + 1] = Math.min(255, Math.round(g * factor));
    data[i + 2] = Math.min(255, Math.round(b * factor));
  }
  return raster;
}

// Decoded parts, cropped to the shield box and keyed by the source file's
// sha256, so repeated builds decode each full-canvas layer once. The cache
// holds untinted values; every use tints a fresh copy.
const partCache = new Map();

function cropToShield(raster) {
  const out = createImage(SHIELD_WIDTH, SHIELD_HEIGHT);
  for (let y = 0; y < SHIELD_HEIGHT; y++) {
    const sy = y + SHIELD_BOX.y;
    if (sy < 0 || sy >= raster.height) continue;
    for (let x = 0; x < SHIELD_WIDTH; x++) {
      const sx = x + SHIELD_BOX.x;
      if (sx < 0 || sx >= raster.width) continue;
      const from = (sy * raster.width + sx) * 4;
      const to = (y * SHIELD_WIDTH + x) * 4;
      for (let c = 0; c < 4; c++) out.data[to + c] = raster.data[from + c];
    }
  }
  return out;
}

function loadPart(root, relFile, tinctureHex) {
  const relPath = path.join('layers/heraldry', relFile);
  const absPath = path.join(root, relPath);
  const bytes = fs.readFileSync(absPath);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  let cropped = partCache.get(sha256);
  if (!cropped) {
    const full = decodePNG(bytes);
    if (full.width !== SHIELD_BOX.width || full.height !== SHIELD_BOX.height) {
      throw new RangeError(`${relPath} must be a ${SHIELD_BOX.width}x${SHIELD_BOX.height} master-grid layer`);
    }
    cropped = cropToShield(full);
    partCache.set(sha256, cropped);
  }
  const raster = { width: cropped.width, height: cropped.height, data: Buffer.from(cropped.data) };
  tint(raster, tinctureHex);
  return { relPath: relPath.split(path.sep).join('/'), sha256, raster };
}

/**
 * Tincture rule for legibility (rule of tincture, with fimbriation):
 * - field and secondary are colours; the ordinary is the seed's metal;
 * - the charge is a third colour (never the field or secondary colour), so it
 *   reads as dark paint on the metal ordinary;
 * - the charge is fimbriated: a thin rim of the same metal surrounds it, and a
 *   thin night-umber keyline surrounds the rim, so where the charge leaves the
 *   ordinary its silhouette still reads against the colour field;
 * - the shield is edged with a night-umber keyline on its outline and a thin
 *   metal fillet just inside, so a field matching the banner cloth (gules on
 *   oxblood, vert on vert, or on ochre) keeps a visible edge.
 */
function planArms(choices) {
  const { tincture, division, ordinary, charge } = choices;
  return [
    ...DIVISION_PARTS[division](tincture.field.hex, tincture.secondary.hex),
    { file: `ordinaries/${ordinary}.png`, tincture: tincture.metal.hex },
    { file: `charges/${charge}-keyline.png`, tincture: KEYLINE_HEX },
    { file: `charges/${charge}-fimbriation.png`, tincture: tincture.metal.hex },
    { file: `charges/${charge}.png`, tincture: tincture.charge.hex },
    { file: 'fields/edge-keyline.png', tincture: KEYLINE_HEX },
    { file: 'fields/edge-fillet.png', tincture: tincture.metal.hex },
  ];
}

// Paints a list of { file, tincture } parts, back to front, into a shield raster.
function paintParts(parts, { root }) {
  const image = createImage(SHIELD_WIDTH, SHIELD_HEIGHT);
  const usedLayers = [];
  for (const part of parts) {
    const { relPath, sha256, raster } = loadPart(root, part.file, part.tincture);
    composite(image, raster);
    usedLayers.push({ path: relPath, sha256 });
  }
  return { image, usedLayers };
}

// Paints the arms for a complete choices object (as returned by buildArms).
function paintArms(choices, { root }) {
  return paintParts(planArms(choices), { root });
}

/**
 * buildArms(seedBytes, { root }) -> { image, choices, usedLayers }
 *
 * seedBytes: 32-byte portrait seed (sha256(wallet + artSeed) upstream).
 * root: repository root used to resolve layers/heraldry/** source files.
 *
 * Deterministic: the same seed and root always produce byte-identical output.
 * image is a straight RGBA raster sized to the 240x288 heater shield (the
 * banner-arms box at (1500,340)); callers place it there directly and again,
 * scaled by 5/12, in the 100x120 rail-arms box.
 */
function buildArms(seedBytes, { root }) {
  if (!(seedBytes instanceof Uint8Array) || seedBytes.length !== 32) {
    throw new TypeError('Expected a 32-byte seed');
  }
  if (typeof root !== 'string' || !root) {
    throw new TypeError('Expected a root directory');
  }

  const field = COLOURS[draw(seedBytes, 'tincture/field', COLOURS.length)];
  const remaining = COLOURS.filter((colour) => colour !== field);
  const secondary = remaining[draw(seedBytes, 'tincture/secondary', remaining.length)];
  const metal = METALS[draw(seedBytes, 'tincture/metal', METALS.length)];
  const division = DIVISIONS[draw(seedBytes, 'division', DIVISIONS.length)];
  const ordinary = ORDINARIES[draw(seedBytes, 'ordinary', ORDINARIES.length)];
  const charge = CHARGES[draw(seedBytes, 'charge', CHARGES.length)];
  // Charge tincture: its own labelled draw among the colours that are neither
  // the field nor the secondary, so the charge never repeats a field colour.
  const chargeOptions = COLOURS.filter((colour) => colour !== field && colour !== secondary);
  const chargeTincture = chargeOptions[draw(seedBytes, 'tincture/charge', chargeOptions.length)];

  const choices = {
    tincture: {
      field: { name: field.name, hex: field.hex },
      secondary: { name: secondary.name, hex: secondary.hex },
      metal: { name: metal.name, hex: metal.hex },
      charge: { name: chargeTincture.name, hex: chargeTincture.hex },
    },
    division,
    ordinary,
    charge,
  };

  const { image, usedLayers } = paintArms(choices, { root });
  return { image, choices, usedLayers };
}

module.exports = {
  buildArms,
  paintArms,
  paintParts,
  planArms,
  KEYLINE_HEX,
  SHIELD_WIDTH,
  SHIELD_HEIGHT,
  COLOURS,
  METALS,
  DIVISIONS,
  ORDINARIES,
  CHARGES,
};
