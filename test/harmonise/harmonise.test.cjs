'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { after, before, test } = require('node:test');
const { createImage, decodePNG, encodePNG } = require('../../src/raster/index.cjs');

const root = path.resolve(__dirname, '../..');
const scratch = path.join(root, 'test/scratch');
const cli = path.join(root, 'bin/harmonise.cjs');
let work, plain, model;

before(() => {
  fs.mkdirSync(scratch, { recursive: true });
  work = fs.mkdtempSync(path.join(scratch, 'harmonise-'));
  plain = createImage();
  model = createImage();
  plain.data.fill(Buffer.from([10, 20, 30, 255]));
  model.data.fill(Buffer.from([210, 220, 230, 255]));
  model.data[(500 * model.width + 500) * 4 + 3] = 0;
  model.data[(500 * model.width + 501) * 4 + 3] = 128;
  plain.data[(500 * plain.width + 501) * 4 + 3] = 97;
  plain.data[(500 * plain.width + 502) * 4 + 3] = 0;
  fs.writeFileSync(path.join(work, 'plain.png'), encodePNG(plain));
  fs.writeFileSync(path.join(work, 'model.png'), encodePNG(model));
  fs.writeFileSync(path.join(work, 'tiny.png'), encodePNG(createImage(2, 2)));
  fs.writeFileSync(path.join(work, 'broken.png'), Buffer.from('invalid PNG fixture'));
});

after(() => {
  if (work) fs.rmSync(work, { recursive: true, force: true });
});

function run(...args) {
  return spawnSync(process.execPath, [cli, ...args], { cwd: work, encoding: 'utf8' });
}

test('request carries the guide’s verbatim prompts and locked model settings', () => {
  const result = run('request', 'plain.png', 'request.json');
  assert.equal(result.status, 0, result.stderr);
  const request = JSON.parse(fs.readFileSync(path.join(work, 'request.json'), 'utf8'));
  const guide = fs.readFileSync(path.join(root, 'style-guide.md'), 'utf8');
  assert.equal(request.input, path.join(work, 'plain.png'));
  assert.equal(request.prompt, guide.match(/^## Locked prompt\s*\n([^\n]+)/m)[1]);
  assert.equal(request.negativePrompt, guide.match(/^## Negative prompt\s*\n([^\n]+)/m)[1]);
  assert.equal(request.strength, 0.22);
  assert.ok(request.strength <= 0.30);
  assert.equal(request.seed, 1536);
  assert.deepEqual([request.width, request.height], [2048, 2560]);
  assert.deepEqual(request.aperture, { x: 144, y: 144, width: 1760, height: 2224 });
  assert.notEqual(run('request', 'plain.png', 'request.json', '--strength=0.31').status, 0);
});

test('apply feathers inward, preserves all rail pixels and produces deterministic bytes', () => {
  for (const name of ['first.png', 'second.png']) {
    const result = run('apply', 'plain.png', 'model.png', name);
    assert.equal(result.status, 0, result.stderr);
  }
  const first = fs.readFileSync(path.join(work, 'first.png'));
  assert.ok(first.equals(fs.readFileSync(path.join(work, 'second.png'))));
  const { data, width, height } = decodePNG(first);
  for (let y = 0; y < height; y++) {
    const row = y * width * 4;
    const end = row + width * 4;
    const ranges = y <= 144 || y >= 2367
      ? [[row, end]]
      : [[row, row + 145 * 4], [row + 1903 * 4, end]];
    for (const [start, stop] of ranges) {
      assert.ok(data.subarray(start, stop).equals(plain.data.subarray(start, stop)), `row ${y}`);
    }
  }

  const pixel = (x, y) => {
    const offset = (y * width + x) * 4;
    return [...data.subarray(offset, offset + 4)];
  };
  assert.deepEqual(pixel(176, 600), [32, 42, 52, 255]);
  assert.deepEqual(pixel(600, 176), [32, 42, 52, 255]);
  assert.deepEqual(pixel(1871, 600), [32, 42, 52, 255]);
  assert.deepEqual(pixel(600, 2335), [32, 42, 52, 255]);
  assert.deepEqual(pixel(208, 600), [54, 64, 74, 255]);
  assert.deepEqual(pixel(500, 500), [10, 20, 30, 255]);
  assert.deepEqual(pixel(501, 500), [32, 42, 52, 97]);
  assert.deepEqual(pixel(502, 500), [10, 20, 30, 0]);
});

test('apply identifies malformed model PNGs before writing output', () => {
  const result = run('apply', 'plain.png', 'broken.png', 'invalid-model.png');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^Model PNG could not be decoded:/);
  assert.equal(fs.existsSync(path.join(work, 'invalid-model.png')), false);
});

test('both commands reject off-size input before writing output', () => {
  for (const args of [
    ['request', 'tiny.png', 'invalid.json'],
    ['apply', 'tiny.png', 'model.png', 'invalid.png'],
    ['apply', 'plain.png', 'tiny.png', 'invalid.png'],
  ]) {
    const result = run(...args);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /must be 2048x2560/);
    assert.equal(fs.existsSync(path.join(work, args.at(-1))), false);
  }
});
