'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { test } = require('node:test');
const { createImage, decodePNG, encodePNG } = require('../../src/raster/index.cjs');

const tool = path.resolve(__dirname, '../../tools/approval.cjs');
const scratch = path.resolve(__dirname, '../scratch');
const ids = Array.from({ length: 12 }, (_, index) => String(index + 1).padStart(2, '0'));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

function fixture(t) {
  fs.mkdirSync(scratch, { recursive: true });
  const root = fs.mkdtempSync(path.join(scratch, 'approval-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return {
    write(relative, bytes) {
      const target = path.join(root, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, bytes);
    },
    read(relative) {
      return fs.readFileSync(path.join(root, relative));
    },
    remove(relative) {
      fs.unlinkSync(path.join(root, relative));
    },
    run(operation, failure) {
      const result = spawnSync(process.execPath, [tool, operation, root], { encoding: 'utf8' });
      assert.ifError(result.error);
      assert.equal(result.status, failure ? 1 : 0, result.stderr);
      if (failure) assert.match(result.stderr, failure);
    },
  };
}

function pixel(image, x, y) {
  const offset = (y * image.width + x) * 4;
  return Array.from(image.data.subarray(offset, offset + 4));
}

test('sheet orders twelve complete frames and box-averages the full masters', t => {
  const pkg = fixture(t);
  const master = createImage();
  const { width, height, data } = master;
  // Write in reverse order. Each frame is just one pixel thick so a crop or
  // center-sampled resize would lose it. The second block tests alpha weighting.
  for (const id of [...ids].reverse()) {
    data.fill(0);
    for (let y = 0; y < height; y++) {
      data.set([0, 64, 0, 255], y * width * 4);
      data.set([0, 128, 0, 255], ((y + 1) * width - 1) * 4);
    }
    for (let x = 0; x < width; x++) {
      data.set([64, 0, 0, 255], x * 4);
      data.set([128, 0, 0, 255], ((height - 1) * width + x) * 4);
    }
    for (let y = 8; y < 16; y++) {
      for (let x = 8; x < 16; x++) {
        data.set([0, 200, 0, 0], (y * width + x) * 4);
      }
    }
    data.set([Number(id), 0, 200, 255], (8 * width + 8) * 4);
    pkg.write(`samples/${id}.png`, encodePNG(master));
  }

  pkg.run('sheet');
  const bytes = pkg.read('contact-sheet.png');
  const result = decodePNG(bytes);
  assert.equal(result.width, 3248);
  assert.equal(result.height, 320);
  for (const [index, id] of ids.entries()) {
    const left = index * 272;
    assert.deepEqual(pixel(result, left + 1, 1), [Number(id), 0, 200, 4]);
    assert.deepEqual(pixel(result, left + 128, 0), [64, 0, 0, 32]);
    assert.deepEqual(pixel(result, left + 128, 319), [128, 0, 0, 32]);
    assert.deepEqual(pixel(result, left, 160), [0, 64, 0, 32]);
    assert.deepEqual(pixel(result, left + 255, 160), [0, 128, 0, 32]);
    if (index < 11) assert.deepEqual(pixel(result, left + 256, 160), [0, 0, 0, 0]);
  }

  pkg.remove('samples/02.png');
  pkg.run('sheet', /samples\/02\.png.*ENOENT/);
  assert.deepEqual(pkg.read('contact-sheet.png'), bytes);
});

test('sheet rejects a sample with the wrong dimensions', t => {
  const pkg = fixture(t);
  pkg.write('samples/01.png', encodePNG(createImage(4, 5)));
  pkg.run('sheet', /samples\/01\.png: expected 2048×2560, got 4×5/);
  assert.throws(() => pkg.read('contact-sheet.png'), { code: 'ENOENT' });
});

test('manifest validates pairs and detects changed, missing and extra delivered files', t => {
  const pkg = fixture(t);
  const png = encodePNG(createImage(4, 5));
  const input = { tier: 'Common', traits: ['moss', 'smug'] };
  const sidecar = { input: { traits: input.traits, tier: input.tier }, pngSha256: digest(png) };
  const required = [
    'style-guide.md', 'template/bust.svg', 'layers/skins/moss.png', 'layers/catalog.json',
    'src/compositor/index.cjs', 'test/compositor.test.cjs', 'tools/approval.cjs', 'docs/approval.md',
    'contact-sheet.png',
  ];
  const excluded = ['.git/config', '.imd-blocked.json', 'artifacts/goal/batches/result.md', 'test/scratch/fixture.txt'];
  for (const relative of [...required, ...excluded]) pkg.write(relative, 'fixture');
  for (const id of ids) {
    pkg.write(`samples/${id}.png`, png);
    pkg.write(`samples/inputs/${id}.json`, JSON.stringify(input));
    pkg.write(`samples/${id}.json`, JSON.stringify(sidecar));
  }

  pkg.remove('test/compositor.test.cjs');
  pkg.run('manifest', /Missing compositor tests/);
  pkg.write('test/compositor.test.cjs', 'fixture');
  pkg.run('manifest');
  const bytes = pkg.read('manifest.json');
  const allPaths = required.concat(ids.flatMap(id => [
    `samples/${id}.json`, `samples/${id}.png`, `samples/inputs/${id}.json`,
  ])).sort();
  assert.deepEqual(JSON.parse(bytes), {
    algorithm: 'sha256',
    files: allPaths.map(relative => ({ path: relative, sha256: digest(pkg.read(relative)) })),
  });
  pkg.run('manifest');
  assert.deepEqual(pkg.read('manifest.json'), bytes);
  pkg.write('.git/config', 'changed excluded file');
  pkg.run('verify');

  const tampered = JSON.parse(bytes);
  tampered.files[0].sha256 = '0'.repeat(64);
  pkg.write('manifest.json', JSON.stringify(tampered));
  pkg.run('verify', /Changed file: contact-sheet\.png/);
  pkg.write('manifest.json', bytes);

  pkg.write('docs/approval.md', 'changed');
  pkg.run('verify', /Changed file: docs\/approval\.md/);
  pkg.write('docs/approval.md', 'fixture');
  pkg.remove('samples/12.json');
  pkg.run('verify', /Missing file: samples\/12\.json/);
  pkg.run('manifest', /Sample 12 sidecar.*found 0/);
  pkg.write('samples/12.json', JSON.stringify(sidecar));
  pkg.write('extra.txt', 'extra');
  pkg.run('verify', /Extra file: extra\.txt/);
  pkg.remove('extra.txt');

  pkg.write('samples/12.json', JSON.stringify({ ...sidecar, input: { ...input, tier: 'Rare' } }));
  pkg.run('manifest', /samples\/12\.json: input does not match samples\/inputs\/12\.json/);
  pkg.write('samples/12.json', JSON.stringify({ ...sidecar, pngSha256: '0'.repeat(64) }));
  pkg.run('manifest', /samples\/12\.json: pngSha256 does not match samples\/12\.png/);
  assert.deepEqual(pkg.read('manifest.json'), bytes);
});
