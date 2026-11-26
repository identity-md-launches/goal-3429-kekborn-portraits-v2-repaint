'use strict';

// Loads the real catalog/ folder and the twelve real sample-inputs so that a
// catalog file the loader rejects, an unknown rarity, or an asset the samples
// name but no catalog file registers fails a test instead of every render.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { loadCatalog, SCHEMA, SLOTS } = require('../../src/compositor/catalog.cjs');
const { computeSeed, validateInput, selectLayers, WEIGHTS } = require('../../src/compositor/select.cjs');

const root = path.resolve(__dirname, '../..');
const ids = Array.from({ length: 12 }, (_, index) => String(index + 1).padStart(2, '0'));
const readInput = (id) => JSON.parse(fs.readFileSync(path.join(root, 'sample-inputs', `${id}.json`), 'utf8'));

test('every real catalog file carries the schema and an assets array', () => {
  const names = fs.readdirSync(path.join(root, 'catalog')).filter((name) => name.endsWith('.json'));
  assert.ok(names.length > 0);
  for (const name of names) {
    const doc = JSON.parse(fs.readFileSync(path.join(root, 'catalog', name), 'utf8'));
    assert.equal(doc.schema, SCHEMA, `catalog/${name} schema`);
    assert.ok(Array.isArray(doc.assets), `catalog/${name} assets`);
  }
});

test('the real catalog folder loads and registers the foundation assets', () => {
  const catalog = loadCatalog(root);
  const moss = catalog.get('skin.moss');
  assert.ok(moss, 'skin.moss registered');
  assert.equal(moss.slot, 'skin');
  assert.equal(moss.path, 'layers/skins/moss.png');
  assert.equal(moss.rarity, 'common');
  const frame = catalog.get('frame.common');
  assert.ok(frame, 'frame.common registered');
  assert.equal(frame.slot, 'frame');
  assert.equal(frame.path, 'layers/frames/common.png');
  assert.deepEqual(frame.tier, ['common']);
  for (const asset of catalog.values()) {
    if (asset.rarity !== null) assert.ok(Object.hasOwn(WEIGHTS, asset.rarity), `${asset.id} rarity ${asset.rarity}`);
  }
});

test('lichen, peat and slate skins draw with the common weight', () => {
  const catalog = loadCatalog(root);
  for (const id of ['skin.lichen', 'skin.peat', 'skin.slate']) {
    const asset = catalog.get(id);
    assert.ok(asset, `${id} registered`);
    assert.equal(WEIGHTS[asset.rarity || 'common'], WEIGHTS.common, id);
  }
});

test('layers are selected for all twelve real sample inputs, every tier and category', () => {
  const catalog = loadCatalog(root);
  const tiers = new Set();
  const categories = new Set();
  for (const id of ids) {
    const input = readInput(id);
    const normal = validateInput(input);
    tiers.add(normal.tier);
    categories.add(normal.category);
    const stack = selectLayers(catalog, computeSeed(input.wallet, input.artSeed), normal);
    const drawn = stack.filter((entry) => entry.asset);
    for (const slot of ['background', 'banner', 'skin', 'eyes', 'expression', 'frame']) {
      assert.equal(drawn.filter((entry) => entry.group === slot).length, 1, `sample ${id}: one ${slot}`);
    }
    for (const entry of drawn) {
      assert.ok(SLOTS.includes(entry.asset.slot), `sample ${id}: ${entry.asset.id} slot`);
      assert.ok(fs.existsSync(entry.asset.absPath), `sample ${id}: ${entry.asset.path} exists`);
    }
    for (const [owner, key, slot] of [['genetics', 'skin', 'skin'], ['genetics', 'eyes', 'eyes'],
      ['traits', 'expression', 'expression'], ['traits', 'background', 'background'], ['traits', 'banner', 'banner']]) {
      const wanted = input[owner] && input[owner][key];
      if (wanted) assert.equal(drawn.find((entry) => entry.group === slot).asset.id, wanted, `sample ${id}: ${slot}`);
    }
    const frame = drawn.find((entry) => entry.group === 'frame').asset;
    assert.ok(!frame.tier || frame.tier.includes(normal.tier), `sample ${id}: frame fits tier`);
  }
  assert.deepEqual([...tiers].sort(), ['common', 'epic', 'legendary', 'rare', 'uncommon']);
  assert.equal(categories.size, 6);
});
