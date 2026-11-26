'use strict';

// The real twelve study inputs live at sample-inputs/NN.json. The approval
// tool must accept that location, and only one input per study.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { test } = require('node:test');
const { createImage, encodePNG } = require('../../src/raster/index.cjs');

const tool = path.resolve(__dirname, '../../tools/approval.cjs');
const repo = path.resolve(__dirname, '../..');
const scratch = path.resolve(__dirname, '../scratch');
const ids = Array.from({ length: 12 }, (_, index) => String(index + 1).padStart(2, '0'));
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

function fixture(t) {
  fs.mkdirSync(scratch, { recursive: true });
  const root = fs.mkdtempSync(path.join(scratch, 'approval-inputs-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (relative, bytes) => {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes);
  };
  const run = (operation) => spawnSync(process.execPath, [tool, operation, root], { encoding: 'utf8' });
  return { root, write, run };
}

function populate(pkg) {
  const png = encodePNG(createImage(4, 5));
  for (const relative of ['style-guide.md', 'template/bust.svg', 'layers/skins/moss.png', 'catalog/foundation.json',
    'src/compositor/index.cjs', 'test/compositor/render.test.cjs', 'contact-sheet.png']) {
    pkg.write(relative, 'fixture');
  }
  for (const id of ids) {
    // The real inputs, copied byte for byte.
    const bytes = fs.readFileSync(path.join(repo, 'sample-inputs', `${id}.json`));
    pkg.write(`sample-inputs/${id}.json`, bytes);
    pkg.write(`samples/${id}.png`, png);
    pkg.write(`samples/${id}.json`, JSON.stringify({ input: JSON.parse(bytes), pngSha256: digest(png) }));
  }
}

test('manifest accepts the real sample-inputs/NN.json layout and lists those files', (t) => {
  const pkg = fixture(t);
  populate(pkg);
  const result = pkg.run('manifest');
  assert.equal(result.status, 0, result.stderr);
  const manifest = JSON.parse(fs.readFileSync(path.join(pkg.root, 'manifest.json'), 'utf8'));
  const listed = manifest.files.map((entry) => entry.path);
  for (const id of ids) assert.ok(listed.includes(`sample-inputs/${id}.json`), id);
  assert.equal(pkg.run('verify').status, 0);
});

test('a second input for the same study at another accepted path is refused', (t) => {
  const pkg = fixture(t);
  populate(pkg);
  pkg.write('samples/inputs/05.json', fs.readFileSync(path.join(repo, 'sample-inputs', '05.json')));
  const result = pkg.run('manifest');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Sample 05 input: expected exactly one of sample-inputs\/05\.json.*found 2/);
});

test('a sidecar that disagrees with sample-inputs/NN.json is refused', (t) => {
  const pkg = fixture(t);
  populate(pkg);
  const png = encodePNG(createImage(4, 5));
  pkg.write('samples/03.json', JSON.stringify({ input: { tier: 'rare' }, pngSha256: digest(png) }));
  const result = pkg.run('manifest');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /samples\/03\.json: input does not match sample-inputs\/03\.json/);
});

test('every real sample input parses and names a wallet, tier, category and artSeed', () => {
  for (const id of ids) {
    const input = JSON.parse(fs.readFileSync(path.join(repo, 'sample-inputs', `${id}.json`), 'utf8'));
    assert.equal(typeof input.wallet, 'string', id);
    assert.equal(typeof input.tier, 'string', id);
    assert.equal(typeof input.traits.category, 'string', id);
    assert.equal(typeof input.artSeed, 'string', id);
  }
});
