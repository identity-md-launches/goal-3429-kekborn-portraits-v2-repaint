'use strict';

// Builds a self-contained fixture repository root in a temp directory: a
// catalog, full-canvas layer PNGs, heraldry part files, a stub heraldry module
// and a raster shim that re-exports the real raster module. Tests never depend
// on the shared catalog or layer library other workers are producing.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const realRaster = require.resolve('../../src/raster/index.cjs');
const { createImage, encodePNG, MASTER_WIDTH, MASTER_HEIGHT } = require(realRaster);

function layerPng(color, box) {
  const image = createImage(MASTER_WIDTH, MASTER_HEIGHT);
  const [x0, y0, x1, y1] = box;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * MASTER_WIDTH + x) * 4;
      image.data[i] = color[0];
      image.data[i + 1] = color[1];
      image.data[i + 2] = color[2];
      image.data[i + 3] = color[3] ?? 255;
    }
  }
  return encodePNG(image);
}

// id, slot, extra fields, colour, box
const ASSETS = [
  ['bg.umber', 'background', {}, [50, 37, 31], [144, 144, 1904, 2368]],
  ['bg.forest', 'background', {}, [37, 62, 50], [144, 144, 1904, 2368]],
  ['banner.oxblood', 'banner', {}, [104, 47, 56], [1440, 200, 1800, 900]],
  ['banner.ochre', 'banner', { tier: 'legendary' }, [180, 138, 71], [1440, 200, 1800, 900]],
  ['prop-rear.lectern', 'prop-rear', { category: 'scholar' }, [90, 70, 50], [200, 1600, 500, 2300]],
  ['attire-back.hood', 'attire-back', { category: ['scholar', 'seer'] }, [37, 62, 50], [300, 1500, 1700, 2368]],
  ['skin.moss', 'skin', { rarity: 'common' }, [101, 112, 68], [400, 600, 1300, 1600]],
  ['skin.gold', 'skin', { rarity: 'rare' }, [201, 164, 90], [400, 600, 1300, 1600]],
  ['eyes.amber', 'eyes', {}, [180, 138, 71], [620, 880, 1100, 980]],
  ['eyes.side', 'eyes', {}, [215, 199, 163], [620, 880, 1100, 980]],
  ['eyes.legend', 'eyes', { tier: 'legendary' }, [201, 164, 90], [620, 880, 1100, 980]],
  ['expression.smug', 'expression', {}, [60, 40, 30], [450, 1150, 1100, 1250]],
  ['expression.serene', 'expression', {}, [70, 50, 40], [450, 1150, 1100, 1250]],
  ['expression.side-eye', 'expression', { requiresEyes: 'eyes.side' }, [80, 40, 30], [450, 1150, 1100, 1250]],
  ['attire-front.robe', 'attire-front', { category: 'scholar' }, [104, 47, 56], [300, 1650, 1750, 2368]],
  ['attire-front.plate', 'attire-front', { category: 'knight' }, [167, 169, 164], [300, 1650, 1750, 2368]],
  ['accessory.spectacles', 'accessory', { category: 'scholar' }, [201, 164, 90], [600, 850, 1150, 1000]],
  ['headwear.cap', 'headwear', { tier: 'common' }, [90, 70, 50], [800, 520, 1150, 700]],
  ['headwear.crown', 'headwear', { tier: 'legendary', rarity: 'legendary' }, [201, 164, 90], [800, 500, 1150, 700]],
  ['regalia.sceptre', 'regalia', { tier: 'legendary' }, [201, 164, 90], [1500, 1300, 1560, 2300]],
  ['prop-front.scroll', 'prop-front', { category: 'scholar' }, [215, 199, 163], [200, 2000, 600, 2300]],
  ['frame.common', 'frame', { tier: 'common' }, [122, 90, 58], [0, 0, 2048, 144]],
  ['frame.legendary', 'frame', { tier: 'legendary' }, [201, 164, 90], [0, 0, 2048, 144]],
  ['frame.rare', 'frame', { tier: 'rare' }, [167, 169, 164], [0, 0, 2048, 144]],
];

const HERALDRY_STUB = `'use strict';
const fs = require('node:fs');
const path = require('node:path');
function buildArms(seed, { root }) {
  const width = 24, height = 29;
  const data = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = seed[0]; data[i * 4 + 1] = seed[1]; data[i * 4 + 2] = seed[2]; data[i * 4 + 3] = 255;
  }
  const parts = ['heraldry/parts/field.png', 'heraldry/parts/charge.png'];
  for (const part of parts) fs.statSync(path.join(root, part));
  return { image: { width, height, data }, choices: { tincture: seed[0] % 2 ? 'vert' : 'gules', division: 'per-pale',
    ordinary: 'chevron', charge: 'frog' }, usedLayers: parts };
}
module.exports = { buildArms };
`;

let template;

function buildTemplate() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kekborn-render-tpl-'));
  const records = [];
  for (const [id, slot, extra, color, box] of ASSETS) {
    const rel = `layers/${slot}/${id}.png`;
    fs.mkdirSync(path.join(dir, path.dirname(rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), layerPng(color, box));
    records.push({ id, slot, path: rel, ...extra });
  }
  fs.mkdirSync(path.join(dir, 'catalog'));
  // Split over two files to exercise multi-file loading.
  fs.writeFileSync(path.join(dir, 'catalog', 'a-core.json'),
    JSON.stringify({ schema: 'kekborn-assets@1', assets: records.slice(0, 12) }, null, 2));
  fs.writeFileSync(path.join(dir, 'catalog', 'b-more.json'),
    JSON.stringify({ schema: 'kekborn-assets@1', assets: records.slice(12) }, null, 2));
  fs.mkdirSync(path.join(dir, 'heraldry', 'parts'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'heraldry', 'parts', 'field.png'), Buffer.from('field-part'));
  fs.writeFileSync(path.join(dir, 'heraldry', 'parts', 'charge.png'), Buffer.from('charge-part'));
  fs.mkdirSync(path.join(dir, 'src', 'heraldry'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'heraldry', 'index.cjs'), HERALDRY_STUB);
  fs.mkdirSync(path.join(dir, 'src', 'raster'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'raster', 'index.cjs'),
    `'use strict';\nmodule.exports = require(${JSON.stringify(realRaster)});\n`);
  return dir;
}

/** A fresh copy of the fixture root, safe to mutate in one test. */
function fixtureRoot() {
  template ||= buildTemplate();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kekborn-render-'));
  fs.cpSync(template, dir, { recursive: true });
  return dir;
}

module.exports = { ASSETS, fixtureRoot };
