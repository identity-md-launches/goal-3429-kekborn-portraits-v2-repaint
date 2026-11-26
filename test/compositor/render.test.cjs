'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

const { fixtureRoot } = require('./fixtures.cjs');
const { renderPortrait, recordPath, ARMS_PLACEMENTS } = require('../../src/compositor/index.cjs');
const { loadCatalog } = require('../../src/compositor/catalog.cjs');
const { computeSeed, draw, validateInput, selectLayers } = require('../../src/compositor/select.cjs');
const raster = require('../../src/raster/index.cjs');

const CLI = path.resolve(__dirname, '..', '..', 'bin', 'render.cjs');
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

const BASE = Object.freeze({
  wallet: '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed',
  tier: 'legendary',
  genetics: {},
  traits: { category: 'scholar' },
  artSeed: 'kek-001',
});
const input = (patch = {}) => ({
  ...BASE, ...patch,
  genetics: { ...BASE.genetics, ...patch.genetics },
  traits: { ...BASE.traits, ...patch.traits },
});

function runCli(root, data, name = 'out.png') {
  const inFile = path.join(root, 'in.json');
  fs.writeFileSync(inFile, JSON.stringify(data));
  const outFile = path.join(root, 'out', name);
  const result = spawnSync(process.execPath, [CLI, '--root', root, inFile, outFile], { encoding: 'utf8' });
  return { ...result, outFile, jsonFile: recordPath(outFile) };
}

function plan(root, data) {
  const normal = validateInput(data);
  return selectLayers(loadCatalog(root), computeSeed(data.wallet, data.artSeed), normal)
    .map((item) => (item.asset ? item.asset.id : item.group));
}

function catalogError(root, data, code) {
  assert.throws(() => plan(root, data), (error) => error.code === code);
}

test('known seed vector: SHA-256 of UTF-8 wallet then UTF-8 artSeed', () => {
  assert.equal(computeSeed(BASE.wallet, BASE.artSeed).toString('hex'),
    '0a4562dcb97eb6cd4cdf417a109078ed60682f370b89c29c51b0823502a12314');
  // Non-ASCII strings are hashed as supplied, no case folding or normalisation.
  assert.equal(computeSeed('wallet·ünicode', 'seed').toString('hex'),
    'ffbaf81f16a44fe79a600dd449e34ab38e446ba439ee4d655350b6c17b155eaa');
  assert.notEqual(computeSeed(BASE.wallet.toLowerCase(), BASE.artSeed).toString('hex'),
    computeSeed(BASE.wallet, BASE.artSeed).toString('hex'));
});

test('labelled draws are stable and independent of other labels', () => {
  const seed = computeSeed('w', 's');
  const pool = ['c', 'a', 'b'].map((id) => ({ id, rarity: null })).sort((x, y) => (x.id < y.id ? -1 : 1));
  const first = draw(seed, 'skin', pool);
  assert.equal(draw(seed, 'skin', pool), first);
  assert.equal(draw(seed, 'skin', []), null);
  const counts = { a: 0, b: 0, c: 0 };
  for (let i = 0; i < 600; i++) counts[draw(computeSeed('w', String(i)), 'skin', pool).id]++;
  assert.ok(Object.values(counts).every((n) => n > 120), JSON.stringify(counts));
});

test('CLI renders a PNG and an adjacent JSON record', () => {
  const root = fixtureRoot();
  const result = runCli(root, input());
  assert.equal(result.status, 0, result.stderr);
  const png = fs.readFileSync(result.outFile);
  const record = JSON.parse(fs.readFileSync(result.jsonFile, 'utf8'));
  assert.equal(record.pngSha256, sha(png));
  assert.equal(record.seed, '0a4562dcb97eb6cd4cdf417a109078ed60682f370b89c29c51b0823502a12314');
  assert.deepEqual(record.input, input());
  const decoded = raster.decodePNG(png);
  assert.equal(decoded.width, 2048);
  assert.equal(decoded.height, 2560);
  // Stack order and contents for a legendary scholar.
  const groups = record.layers.map((layer) => layer.group);
  assert.deepEqual(groups, ['background', 'banner', 'banner-arms', 'prop-rear', 'attire-back', 'skin', 'eyes',
    'expression', 'attire-front', 'accessory', 'headwear', 'regalia', 'prop-front', 'frame', 'rail-arms']);
  const byGroup = Object.fromEntries(record.layers.map((layer) => [layer.group, layer]));
  assert.equal(byGroup.frame.id, 'frame.legendary');
  assert.equal(byGroup.headwear.id, 'headwear.crown');
  assert.equal(byGroup['attire-front'].id, 'attire-front.robe');
  for (const layer of record.layers.filter((entry) => entry.kind === 'catalog')) {
    assert.equal(layer.sha256, sha(fs.readFileSync(path.join(root, layer.path))));
    assert.deepEqual(layer.placement, { x: 0, y: 0, width: 2048, height: 2560 });
  }
  assert.deepEqual(byGroup['banner-arms'].placement, { x: 1500, y: 340, width: 240, height: 288 });
  assert.deepEqual(byGroup['rail-arms'].placement, { x: 974, y: 2404, width: 100, height: 120 });
  assert.deepEqual(record.arms.placements, { banner: ARMS_PLACEMENTS.banner, rail: ARMS_PLACEMENTS.rail });
  assert.deepEqual(record.arms.parts.map((part) => part.path), ['heraldry/parts/field.png', 'heraldry/parts/charge.png']);
  assert.equal(record.arms.parts[0].sha256, sha(Buffer.from('field-part')));
  assert.equal(record.arms.choices.charge, 'frog');
  assert.equal(record.finish.count, 1);
  // The arms colour (seed bytes 0..2) shows in the banner reserve before finishing changes it slightly.
  const seed = Buffer.from(record.seed, 'hex');
  const i = (480 * 2048 + 1620) * 4;
  for (let c = 0; c < 3; c++) assert.ok(Math.abs(decoded.data[i + c] - seed[c]) < 40);
});

test('CLI usage and input errors exit nonzero with a message', () => {
  const root = fixtureRoot();
  const usage = spawnSync(process.execPath, [CLI], { encoding: 'utf8' });
  assert.equal(usage.status, 64);
  assert.match(usage.stderr, /Usage/);
  const bad = runCli(root, { ...input(), tier: 'mythic' });
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /E_INPUT: tier/);
  assert.equal(fs.existsSync(bad.outFile), false);
  for (const broken of [{ ...input(), wallet: '' }, { ...input(), artSeed: 7 }, { ...input(), traits: {} },
    { ...input(), traits: { category: 'jester' } }, input({ genetics: { skin: 5 } })]) {
    assert.throws(() => validateInput(broken), (error) => error.code === 'E_INPUT');
  }
});

test('explicit full IDs select skin, eyes, expression, background and banner', () => {
  const root = fixtureRoot();
  const ids = plan(root, input({
    genetics: { skin: 'skin.gold', eyes: 'eyes.amber' },
    traits: { expression: 'expression.serene', background: 'bg.forest', banner: 'banner.ochre' },
  }));
  for (const id of ['skin.gold', 'eyes.amber', 'expression.serene', 'bg.forest', 'banner.ochre']) {
    assert.ok(ids.includes(id), id);
  }
  // Wrong slot, filtered by tier, and unknown IDs are rejected.
  catalogError(root, input({ genetics: { skin: 'eyes.amber' } }), 'E_SELECTOR');
  catalogError(root, input({ tier: 'common', traits: { banner: 'banner.ochre' } }), 'E_SELECTOR');
  catalogError(root, input({ traits: { background: 'bg.nope' } }), 'E_UNKNOWN_ID');
});

test('tier and category filters apply to defaults and multi-layer slots', () => {
  const root = fixtureRoot();
  const common = plan(root, input({ tier: 'common', traits: { category: 'knight' } }));
  assert.ok(common.includes('frame.common'));
  assert.ok(common.includes('headwear.cap'));
  assert.ok(common.includes('attire-front.plate'));
  assert.ok(!common.some((id) => /robe|spectacles|lectern|hood|scroll|sceptre|legend|ochre/.test(id)), common.join());
  // No uncommon frame exists in the fixture: a required asset is missing.
  catalogError(root, input({ tier: 'uncommon' }), 'E_MISSING_ASSET');
  const seer = plan(root, input({ tier: 'rare', traits: { category: 'seer' } }));
  assert.ok(seer.includes('attire-back.hood'));
  assert.ok(!seer.includes('headwear.cap'), 'headwear is optional when the tier has none');
});

test('side-eye expression resolves requiresEyes before eye selection', () => {
  const root = fixtureRoot();
  const forced = plan(root, input({ traits: { expression: 'expression.side-eye' } }));
  assert.ok(forced.includes('eyes.side'));
  assert.ok(forced.indexOf('eyes.side') < forced.indexOf('expression.side-eye'));
  assert.deepEqual(plan(root, input({ genetics: { eyes: 'eyes.side' }, traits: { expression: 'expression.side-eye' } }))
    .filter((id) => id.startsWith('eyes')), ['eyes.side']);
  catalogError(root, input({ genetics: { eyes: 'eyes.amber' }, traits: { expression: 'expression.side-eye' } }),
    'E_INCOMPATIBLE');
  // Default expression draws never pick side-eye when explicit eyes are incompatible.
  for (let i = 0; i < 40; i++) {
    const ids = plan(root, input({ artSeed: `s${i}`, genetics: { eyes: 'eyes.amber' } }));
    assert.ok(!ids.includes('expression.side-eye'));
  }
  // And whenever side-eye is drawn by default, its eyes follow.
  let seen = 0;
  for (let i = 0; i < 60; i++) {
    const ids = plan(root, input({ artSeed: `t${i}` }));
    if (ids.includes('expression.side-eye')) { seen++; assert.ok(ids.includes('eyes.side')); }
  }
  assert.ok(seen > 0);
});

test('unknown IDs and missing files fail through the CLI', () => {
  const root = fixtureRoot();
  const unknown = runCli(root, input({ genetics: { eyes: 'eyes.nope' } }));
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /E_UNKNOWN_ID: genetics\.eyes: unknown asset ID "eyes\.nope"/);
  fs.rmSync(path.join(root, 'layers', 'frame', 'frame.legendary.png'));
  const missing = runCli(root, input());
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /E_MISSING_FILE: Asset frame\.legendary/);
  assert.equal(fs.existsSync(missing.outFile), false);
  const root2 = fixtureRoot();
  fs.rmSync(path.join(root2, 'heraldry', 'parts', 'charge.png'));
  assert.notEqual(runCli(root2, input()).status, 0);
  const root3 = fixtureRoot();
  fs.rmSync(path.join(root3, 'src', 'heraldry'), { recursive: true });
  assert.match(runCli(root3, input()).stderr, /E_MISSING_FILE: Heraldry module/);
  const root4 = fixtureRoot();
  fs.writeFileSync(path.join(root4, 'catalog', 'c.json'), JSON.stringify({ schema: 'other@1', assets: [] }));
  assert.match(runCli(root4, input()).stderr, /E_CATALOG/);
  const root5 = fixtureRoot();
  fs.writeFileSync(path.join(root5, 'layers', 'skin', 'skin.moss.png'), raster.encodePNG(raster.createImage(4, 5)));
  fs.writeFileSync(path.join(root5, 'layers', 'skin', 'skin.gold.png'), raster.encodePNG(raster.createImage(4, 5)));
  assert.match(runCli(root5, input()).stderr, /E_ASSET_SIZE/);
});

test('placements, reusable decode storage and a single finish before encode', () => {
  const root = fixtureRoot();
  const calls = [];
  const targets = new Set();
  const spy = {
    ...raster,
    createImage: (...args) => { calls.push(['createImage', ...args]); return raster.createImage(...args); },
    decodePNG: (bytes, target) => { targets.add(target); calls.push(['decode']); return raster.decodePNG(bytes, target); },
    composite: (dest, src, rect) => { calls.push(['composite', rect, src.width]); return raster.composite(dest, src, rect); },
    finish: (image, seed) => { calls.push(['finish', Buffer.from(seed).toString('hex')]); return raster.finish(image, seed); },
    encodePNG: (image) => { calls.push(['encode']); return raster.encodePNG(image); },
  };
  const { record, png } = renderPortrait(input(), { root, raster: spy });
  assert.equal(targets.size, 1);
  assert.ok([...targets][0] instanceof Uint8Array && [...targets][0].length === 2048 * 2560 * 4);
  const names = calls.map((call) => call[0]);
  assert.equal(names.filter((name) => name === 'finish').length, 1);
  assert.equal(names.at(-1), 'encode');
  assert.equal(names.at(-2), 'finish');
  assert.equal(names.lastIndexOf('composite'), names.length - 3);
  assert.equal(calls.find((call) => call[0] === 'finish')[1], record.seed);
  const rects = calls.filter((call) => call[0] === 'composite').map((call) => call[1]);
  assert.deepEqual(rects, record.layers.map((layer) => layer.placement));
  assert.deepEqual(rects[2], { x: 1500, y: 340, width: 240, height: 288 });
  assert.deepEqual(rects.at(-1), { x: 974, y: 2404, width: 100, height: 120 });
  assert.equal(calls.filter((call) => call[0] === 'composite')[2][2], 24, 'arms image composited scaled');
  assert.equal(record.pngSha256, sha(png));
});

test('independent CLI runs give byte-identical PNG and JSON; other seeds differ', () => {
  const a = runCli(fixtureRoot(), input(), 'a.png');
  const rootB = fixtureRoot();
  const b = runCli(rootB, input(), 'b.png');
  assert.equal(a.status, 0, a.stderr);
  assert.equal(b.status, 0, b.stderr);
  assert.ok(fs.readFileSync(a.outFile).equals(fs.readFileSync(b.outFile)));
  assert.equal(fs.readFileSync(a.jsonFile, 'utf8'), fs.readFileSync(b.jsonFile, 'utf8'));
  const c = runCli(rootB, input({ artSeed: 'kek-002' }), 'c.png');
  assert.equal(c.status, 0, c.stderr);
  assert.ok(!fs.readFileSync(a.outFile).equals(fs.readFileSync(c.outFile)));
});
