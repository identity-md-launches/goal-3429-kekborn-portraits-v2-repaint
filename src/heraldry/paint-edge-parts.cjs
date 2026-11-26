'use strict';

// Paints the legibility parts of the coat of arms as full-canvas (2048x2560)
// RGBA value maps registered at the banner-arms box (1500,340), like the ten
// original heraldry parts:
//
//   charges/<charge>-fimbriation.png  thin metal rim around the charge
//   charges/<charge>-keyline.png      thin dark keyline outside that rim
//   fields/edge-fillet.png            thin metal fillet just inside the shield outline
//   fields/edge-keyline.png           thin dark keyline on the shield outline itself
//
// The shapes are derived from the existing charge and field alpha by a
// Euclidean distance band, and the value channel carries a directional brush
// texture lit from the upper left. No varnish, craquelure or shadow is painted
// in: those belong to the shared finishing pass.
//
// Usage: node src/heraldry/paint-edge-parts.cjs [repoRoot]
// Output is deterministic (no randomness, no timestamps).

const fs = require('node:fs');
const path = require('node:path');
const { createImage, decodePNG, encodePNG } = require('../raster/index.cjs');

const BOX = { x: 1500, y: 340, width: 240, height: 288 };
const CHARGES = ['estoile', 'trefoil', 'tower'];

// Bands in shield pixels (the shield is painted 1:1 on the master grid).
const CHARGE_RIM = { inner: 0, outer: 4.5 };
const CHARGE_KEYLINE = { inner: 0, outer: 6.5 };
const EDGE_KEYLINE = { inner: 0, outer: 2.0 };
const EDGE_FILLET = { inner: 2.0, outer: 4.5 };

function crop(raster) {
  const out = new Float32Array(BOX.width * BOX.height);
  for (let y = 0; y < BOX.height; y++) {
    for (let x = 0; x < BOX.width; x++) {
      const i = ((y + BOX.y) * raster.width + x + BOX.x) * 4;
      out[y * BOX.width + x] = raster.data[i + 3] / 255;
    }
  }
  return out;
}

// Brute-force Euclidean distance to the nearest pixel where inside(mask) is true,
// limited to `reach`; pixels farther than reach get Infinity.
function distanceTo(mask, predicate, reach) {
  const { width, height } = BOX;
  const out = new Float32Array(width * height).fill(Infinity);
  const r = Math.ceil(reach);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (predicate(mask[y * width + x])) { out[y * width + x] = 0; continue; }
      let best = Infinity;
      for (let dy = -r; dy <= r; dy++) {
        const yy = y + dy;
        for (let dx = -r; dx <= r; dx++) {
          const xx = x + dx;
          const inside = (xx < 0 || yy < 0 || xx >= width || yy >= height)
            ? predicate(0)
            : predicate(mask[yy * width + xx]);
          if (!inside) continue;
          const d = Math.hypot(dx, dy);
          if (d < best) best = d;
        }
      }
      out[y * width + x] = best;
    }
  }
  return out;
}

function smoothstep(edge0, edge1, v) {
  const t = Math.max(0, Math.min(1, (v - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

// Coverage of a band [inner, outer] of distance with ~1px antialiased edges.
function band(d, { inner, outer }) {
  if (!Number.isFinite(d)) return 0;
  const enter = inner <= 0 ? 1 : smoothstep(inner - 0.5, inner + 0.5, d);
  const leave = 1 - smoothstep(outer - 0.5, outer + 0.5, d);
  return Math.max(0, Math.min(1, enter * leave));
}

// Directional brush texture: strokes run down-right, light falls from the
// upper left. Centred near 176, so a tint reproduces the tincture itself.
function brushValue(x, y, centre, swing) {
  const along = (x * 0.55 + y * 0.83);
  const across = (x * 0.83 - y * 0.55);
  const stroke = Math.sin(across * 0.9 + Math.sin(along * 0.07) * 2.1) * 0.6 +
    Math.sin(across * 2.3 + along * 0.05) * 0.4;
  const light = (BOX.width / 2 - x) / BOX.width * 0.6 + (BOX.height / 2 - y) / BOX.height * 0.6;
  return Math.max(60, Math.min(250, Math.round(centre + swing * stroke + 22 * light)));
}

function paint(coverage, centre, swing) {
  const image = createImage();
  for (let y = 0; y < BOX.height; y++) {
    for (let x = 0; x < BOX.width; x++) {
      const a = coverage[y * BOX.width + x];
      if (a <= 0) continue;
      const i = ((y + BOX.y) * image.width + x + BOX.x) * 4;
      const v = brushValue(x, y, centre, swing);
      image.data[i] = v;
      image.data[i + 1] = v;
      image.data[i + 2] = v;
      image.data[i + 3] = Math.round(a * 255);
    }
  }
  return image;
}

function paintAll(root) {
  const dir = path.join(root, 'layers/heraldry');
  const written = [];
  const save = (rel, coverage, centre, swing) => {
    const out = path.join(dir, rel);
    fs.writeFileSync(out, encodePNG(paint(coverage, centre, swing)));
    written.push(rel);
  };

  for (const charge of CHARGES) {
    const alpha = crop(decodePNG(fs.readFileSync(path.join(dir, `charges/${charge}.png`))));
    const dist = distanceTo(alpha, (a) => a >= 0.5, CHARGE_KEYLINE.outer + 1);
    const rim = new Float32Array(alpha.length);
    const key = new Float32Array(alpha.length);
    for (let i = 0; i < alpha.length; i++) {
      rim[i] = band(dist[i], CHARGE_RIM);
      key[i] = band(dist[i], CHARGE_KEYLINE);
    }
    save(`charges/${charge}-keyline.png`, key, 176, 10);
    save(`charges/${charge}-fimbriation.png`, rim, 184, 16);
  }

  const field = crop(decodePNG(fs.readFileSync(path.join(dir, 'fields/plain.png'))));
  // Distance from each inside pixel to the outside of the shield outline.
  const toOutside = distanceTo(field, (a) => a < 0.5, EDGE_FILLET.outer + 1);
  const keyline = new Float32Array(field.length);
  const fillet = new Float32Array(field.length);
  for (let i = 0; i < field.length; i++) {
    if (field[i] <= 0) continue;
    // Distance 0 means outside; inside pixels start at 1 from the outline.
    const d = toOutside[i] - 0.5;
    keyline[i] = Math.min(field[i], band(d, EDGE_KEYLINE));
    fillet[i] = Math.min(field[i], band(d, EDGE_FILLET));
  }
  save('fields/edge-keyline.png', keyline, 176, 10);
  save('fields/edge-fillet.png', fillet, 184, 16);
  return written;
}

if (require.main === module) {
  const root = path.resolve(process.argv[2] || path.join(__dirname, '..', '..'));
  for (const rel of paintAll(root)) console.log(`wrote layers/heraldry/${rel}`);
}

module.exports = { paintAll };
