'use strict';

// Asset-format and registration checks. Run from any directory with Node 18+.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const root = path.resolve(__dirname, '../../../..');
const { decodePNG } = require(path.join(root, 'src/raster/png.cjs'));
const catalog = JSON.parse(fs.readFileSync(path.join(root, 'catalog/attire-knight.json'), 'utf8'));
assert.equal(catalog.schema, 'kekborn-assets@1');
assert.equal(catalog.assets.length, 2);
const wanted = ['attire-front.knight-armour', 'prop-front.knight-gauntlet'];
assert.deepEqual(catalog.assets.map(a => a.id), wanted);
const rasters = [];
const stats = [];

function alpha(im, x, y) { return im.data[(y * im.width + x) * 4 + 3]; }

for (const asset of catalog.assets) {
  assert.equal(asset.category, 'knight');
  assert.equal(asset.slot, asset.id.split('.')[0]);
  assert.equal(asset.path, `layers/attire/knight/${asset.id}.png`);
  const bytes = fs.readFileSync(path.join(root, asset.path));
  assert.equal(bytes.toString('ascii', 12, 16), 'IHDR');
  assert.equal(bytes[24], 8, 'must be 8-bit');
  assert.equal(bytes[25], 6, 'must be ordinary RGBA, not indexed or RGB');
  assert.equal(bytes[28], 0, 'noninterlaced export');
  const im = decodePNG(bytes); // Also validates every chunk CRC.
  assert.deepEqual([im.width, im.height], [2048, 2560]);
  const bbox = [2048, 2560, 0, 0];
  let painted = 0, partial = 0, fullyOpaque = 0, straightSamples = 0;
  for (let y = 0; y < im.height; y++) {
    for (let x = 0; x < im.width; x++) {
      const i = (y * im.width + x) * 4;
      const a = im.data[i + 3];
      if (!a) {
        assert.equal(im.data[i] | im.data[i+1] | im.data[i+2], 0, 'zero hidden RGB');
        continue;
      }
      painted++;
      if (a < 255) {
        partial++;
        if (a < 32 && Math.max(im.data[i], im.data[i+1], im.data[i+2]) > a * 2) straightSamples++;
      } else fullyOpaque++;
      bbox[0] = Math.min(bbox[0], x); bbox[1] = Math.min(bbox[1], y);
      bbox[2] = Math.max(bbox[2], x+1); bbox[3] = Math.max(bbox[3], y+1);
      assert.ok(x >= 144 && x < 1904 && y >= 144 && y < 2368, `${asset.id}: paint outside aperture at ${x},${y}`);
      assert.ok(!(x >= 1476 && x < 1764 && y >= 316 && y < 652), 'banner shield clearance');
      assert.ok(!(x >= 962 && x < 1086 && y >= 2392 && y < 2536), 'rail shield clearance');
      assert.ok(y >= 1536, 'head, eyes, mouth and throat sightlines remain clear');
      assert.ok(im.data[i] + im.data[i+1] + im.data[i+2] > 0, 'no pure-black pigment');
      assert.ok(im.data[i] + im.data[i+1] + im.data[i+2] < 765, 'no pure-white pigment');
    }
  }
  assert.ok(painted > 90000, 'nonempty painted layer');
  assert.ok(fullyOpaque / painted > .96, 'solid paint with anti-aliased boundary');
  assert.ok(partial > 100, 'anti-aliased contour');
  assert.ok(straightSamples > 100, 'edge colors are unassociated/straight, not premultiplied');
  rasters.push(im);
  stats.push({ id: asset.id, bboxExclusive: bbox, paintedPixels: painted, partialAlphaPixels: partial,
    sha256: createHash('sha256').update(bytes).digest('hex') });
}

const [armour, glove] = rasters;
for (const [name,x,y] of [['far shoulder',365,1760], ['near shoulder',1575,1712],
                        ['gorget front at neck ellipse',978,1640], ['breast ridge',970,2000]]) {
  assert.ok(alpha(armour,x,y) > 250, `${name} must attach`);
}
assert.equal(alpha(armour,978,1536), 0, 'throat landmark left visible');
let glovePixels = 0, supported = 0;
for (let i=3;i<glove.data.length;i+=4) {
  if (glove.data[i] > 0) {
    glovePixels++;
    if (armour.data[i] > 250) supported++;
  }
}
assert.ok(supported / glovePixels > .999, 'gauntlet must rest over the armour, not float off its edge');
console.log(JSON.stringify({ result:'PASS', checks:'catalog, RGBA8, CRCs, aperture, both shield clear spaces, sightlines, anchors, straight alpha, gauntlet support',
  gauntletSupport: supported/glovePixels, assets:stats }, null, 2));
