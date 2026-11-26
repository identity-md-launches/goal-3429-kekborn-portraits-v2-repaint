'use strict';

// Proves the repainted Kekborn v2 layer library whole: every catalog file the
// compositor reads exists and decodes at the master size, the required trait
// sets are registered, every code-drawn PNG imported at bootstrap has been
// replaced, no repository file reaches 8,000,000 bytes, and all twelve sample
// inputs render. Plain Node, no dependencies.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { test } = require('node:test');

const root = path.resolve(__dirname, '../..');
const { loadCatalog, SCHEMA } = require(path.join(root, 'src/compositor/catalog.cjs'));
const { renderPortrait } = require(path.join(root, 'src/compositor/index.cjs'));
const { decodePNG } = require(path.join(root, 'src/raster/png.cjs'));

const WIDTH = 2048;
const HEIGHT = 2560;
const REPO_FILE_LIMIT = 8000000; // no file of the repository may reach this
const LAYER_FILE_LIMIT = 7900000; // docs/painting.md: every delivered layer strictly under 7.9 MB
const TIERS = ['common', 'uncommon', 'rare', 'epic', 'legendary'];
const SKINS = ['skin.moss', 'skin.lichen', 'skin.peat', 'skin.slate', 'skin.ivory', 'skin.oxblood'];
const RARE_SKINS = ['skin.ivory', 'skin.oxblood'];
const EXPRESSIONS = ['melancholy', 'smug', 'paranoid-side-eye', 'dim-grin', 'scowl', 'serene', 'startled',
  'regal', 'sly', 'weeping'].map((name) => `expression.${name}`);
const SAMPLES = Array.from({ length: 12 }, (_, index) => String(index + 1).padStart(2, '0'));

const rel = (abs) => path.relative(root, abs).split(path.sep).join('/');
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

let cachedCatalog;
function catalog() {
  if (!cachedCatalog) cachedCatalog = loadCatalog(root);
  return cachedCatalog;
}
const ofSlot = (slot) => [...catalog().values()].filter((asset) => asset.slot === slot);
const fits = (asset, tier) => !asset.tier || asset.tier.includes(tier);

function walk(dir, out, skip) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (skip(rel(abs), entry)) continue;
    if (entry.isDirectory()) walk(abs, out, skip);
    else if (entry.isFile()) out.push(abs);
  }
  return out;
}

// Files that are, or would be, part of the repository: tracked plus untracked
// non-ignored files from git when it is available, otherwise a walk of the
// tree. Dot entries at the root (.git, tool caches), node_modules, out/ (render
// masters are kept out of commits, docs/approval.md) and test/scratch/
// (deleted before submission) are not repository content.
function excluded(file) {
  const top = file.split('/')[0];
  return top.startsWith('.') || top === 'node_modules' || top === 'out' ||
    file === 'test/scratch' || file.startsWith('test/scratch/') || file.includes('/node_modules/');
}
function repositoryFiles() {
  let names = null;
  try {
    const listed = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
      { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
    names = listed.split('\0').filter(Boolean);
  } catch {
    names = null;
  }
  if (!names) names = walk(root, [], (file) => excluded(file)).map(rel);
  return [...new Set(names)].filter((file) => !excluded(file)).filter((file) => {
    try {
      return fs.lstatSync(path.join(root, file)).isFile();
    } catch {
      return false; // tracked but deleted in the working tree
    }
  }).sort();
}

function layerPNGs() {
  return walk(path.join(root, 'layers'), [], () => false).filter((file) => file.endsWith('.png')).map(rel).sort();
}

test('every catalog file carries kekborn-assets@1 and every asset path and skinPaint exists', () => {
  const names = fs.readdirSync(path.join(root, 'catalog')).filter((name) => name.endsWith('.json')).sort();
  assert.ok(names.length > 0, 'catalog/*.json present');
  const missing = [];
  for (const name of names) {
    const doc = JSON.parse(fs.readFileSync(path.join(root, 'catalog', name), 'utf8'));
    assert.equal(doc.schema, SCHEMA, `catalog/${name} schema`);
    assert.ok(Array.isArray(doc.assets), `catalog/${name} assets`);
    for (const asset of doc.assets) {
      for (const field of ['path', 'skinPaint']) {
        if (asset[field] === undefined) continue;
        const file = path.join(root, asset[field]);
        if (!fs.existsSync(file) || !fs.statSync(file).isFile()) missing.push(`catalog/${name} ${asset.id} ${field} ${asset[field]}`);
      }
    }
  }
  assert.deepEqual(missing, [], 'catalog files that do not exist');
  assert.ok(catalog().size > 0, 'the compositor loads the catalog');
});

test('every layer PNG decodes as a 2048x2560 RGBA master under 7.9 MB', () => {
  const files = layerPNGs();
  assert.ok(files.length > 0, 'layers/**/*.png present');
  const registered = new Set();
  for (const asset of catalog().values()) {
    registered.add(asset.path);
    if (asset.skinPaint) registered.add(asset.skinPaint.path);
  }
  for (const file of registered) {
    if (file.endsWith('.png') && !file.startsWith('layers/')) files.push(file);
  }
  const bad = [];
  for (const file of files) {
    const bytes = fs.readFileSync(path.join(root, file));
    if (bytes.length >= LAYER_FILE_LIMIT) bad.push(`${file}: ${bytes.length} bytes`);
    try {
      const image = decodePNG(bytes);
      if (image.width !== WIDTH || image.height !== HEIGHT) bad.push(`${file}: ${image.width}x${image.height}`);
      else if (image.data.length !== WIDTH * HEIGHT * 4) bad.push(`${file}: ${image.data.length} pixel bytes`);
    } catch (error) {
      bad.push(`${file}: ${error.message}`);
    }
  }
  assert.deepEqual(bad, [], 'layer PNGs that do not decode at 2048x2560');
});

test('no file of the repository is 8,000,000 bytes or more', () => {
  const files = repositoryFiles();
  assert.ok(files.length > 0);
  const large = files.map((file) => [file, fs.statSync(path.join(root, file)).size])
    .filter(([, size]) => size >= REPO_FILE_LIMIT).map(([file, size]) => `${file}: ${size}`);
  assert.deepEqual(large, [], 'files at or over 8,000,000 bytes');
});

test('six skins are registered, ivory and oxblood rare and the rest not', () => {
  const skins = ofSlot('skin');
  assert.deepEqual(skins.map((asset) => asset.id).sort(), [...SKINS].sort());
  for (const asset of skins) {
    if (RARE_SKINS.includes(asset.id)) assert.equal(asset.rarity, 'rare', `${asset.id} rarity`);
    else assert.notEqual(asset.rarity, 'rare', `${asset.id} rarity`);
    assert.ok(!asset.explicitOnly, `${asset.id} is drawable`);
  }
});

test('the ten named expressions and eight eyes are registered', () => {
  const expressions = new Map(ofSlot('expression').map((asset) => [asset.id, asset]));
  for (const id of EXPRESSIONS) {
    const asset = expressions.get(id);
    assert.ok(asset, `${id} registered`);
    assert.ok(!asset.explicitOnly, `${id} is drawable`);
    assert.ok(asset.skinPaint, `${id} has its skin-paint layer`);
  }
  const named = EXPRESSIONS.map((id) => expressions.get(id).path);
  assert.equal(new Set(named).size, 10, 'the ten expressions are ten different paintings');
  for (const asset of expressions.values()) {
    if (!EXPRESSIONS.includes(asset.id)) assert.ok(asset.explicitOnly, `${asset.id} is an explicit-only alias`);
  }
  const eyes = ofSlot('eyes');
  assert.equal(eyes.length, 8, `eyes: ${eyes.map((asset) => asset.id).join(', ')}`);
  assert.equal(new Set(eyes.map((asset) => asset.path)).size, 8, 'eight different eye paintings');
});

test('five backdrops, three banners and five frames, one per tier, are registered', () => {
  const unique = (slot) => new Set(ofSlot(slot).map((asset) => asset.path)).size;
  assert.equal(ofSlot('background').length, 5, 'backdrops');
  assert.equal(unique('background'), 5, 'five different backdrop paintings');
  assert.equal(ofSlot('banner').length, 3, 'banners');
  assert.equal(unique('banner'), 3, 'three different banner paintings');
  const frames = ofSlot('frame');
  assert.equal(frames.length, 5, 'frames');
  assert.equal(unique('frame'), 5, 'five different frame paintings');
  for (const tier of TIERS) {
    assert.equal(frames.filter((asset) => fits(asset, tier)).length, 1, `one frame fits ${tier}`);
  }
});

test('headwear and regalia are registered for every tier', () => {
  for (const slot of ['headwear', 'regalia']) {
    for (const tier of TIERS) {
      const own = ofSlot(slot).filter((asset) => asset.tier && asset.tier.includes(tier) && !asset.explicitOnly);
      assert.ok(own.length >= 1, `${slot} registered for ${tier}`);
    }
  }
});

test('every baseline layer PNG still present has been repainted', () => {
  const baseline = JSON.parse(fs.readFileSync(path.join(root, 'provenance/baseline.json'), 'utf8'));
  const listed = Object.entries(baseline.files).filter(([file]) => file.endsWith('.png'));
  assert.ok(listed.length > 0, 'baseline lists layer PNGs');
  const unchanged = [];
  for (const [file, digest] of listed) {
    const abs = path.join(root, file);
    if (!fs.existsSync(abs)) continue;
    if (sha256(fs.readFileSync(abs)) === digest) unchanged.push(file);
  }
  assert.deepEqual(unchanged, [], 'layer PNGs still identical to the imported code-drawn file');
});

for (const id of SAMPLES) {
  test(`sample input ${id} renders`, () => {
    const input = JSON.parse(fs.readFileSync(path.join(root, 'sample-inputs', `${id}.json`), 'utf8'));
    const { png, record } = renderPortrait(input, { root });
    assert.ok(Buffer.isBuffer(png) || png instanceof Uint8Array);
    assert.equal(Buffer.from(png.subarray(1, 4)).toString('latin1'), 'PNG', `sample ${id} is a PNG`);
    const header = Buffer.from(png.subarray(16, 24));
    assert.equal(header.readUInt32BE(0), WIDTH, `sample ${id} width`);
    assert.equal(header.readUInt32BE(4), HEIGHT, `sample ${id} height`);
    assert.equal(record.pngSha256, sha256(png), `sample ${id} record hash`);
    for (const layer of record.layers) {
      if (layer.kind === 'procedural') continue;
      const bytes = fs.readFileSync(path.join(root, layer.path));
      assert.equal(sha256(bytes), layer.sha256, `sample ${id}: ${layer.path}`);
    }
    for (const slot of ['background', 'banner', 'skin', 'eyes', 'expression', 'frame']) {
      assert.equal(record.layers.filter((layer) => layer.kind === 'catalog' && layer.slot === slot).length, 1,
        `sample ${id}: one ${slot}`);
    }
  });
}
