'use strict';

// The v2 approval commands: preview, sheet, manifest, verify.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { test } = require('node:test');
const { createImage, encodePNG } = require('../../src/raster/index.cjs');
const { encodeJPEG, decodeJPEG, jpegSize } = require('../../src/jpeg/index.cjs');

const tool = path.resolve(__dirname, '../../tools/approval.cjs');
const scratch = path.resolve(__dirname, '../scratch');
const ids = Array.from({ length: 12 }, (_, index) => String(index + 1).padStart(2, '0'));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

function fixture(t) {
  fs.mkdirSync(scratch, { recursive: true });
  const root = fs.mkdtempSync(path.join(scratch, 'approval-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return {
    root,
    file: relative => path.join(root, relative),
    write(relative, bytes) {
      const target = path.join(root, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, bytes);
    },
    read: relative => fs.readFileSync(path.join(root, relative)),
    remove: relative => fs.unlinkSync(path.join(root, relative)),
    // Runs `operation root`, or the given arguments as they are.
    run(operation, failure, args = [operation, root]) {
      const result = spawnSync(process.execPath, [tool, ...args], { encoding: 'utf8' });
      assert.ifError(result.error);
      assert.equal(result.status, failure ? 1 : 0, result.stderr);
      if (failure) assert.match(result.stderr, failure);
      return result;
    },
  };
}

function flat(width, height, colour) {
  const image = createImage(width, height);
  for (let offset = 0; offset < image.data.length; offset += 4) image.data.set([...colour, 255], offset);
  return image;
}

function pixel(image, x, y) {
  const offset = (y * image.width + x) * 4;
  return Array.from(image.data.subarray(offset, offset + 3));
}

function near(actual, expected, tolerance, message) {
  for (let channel = 0; channel < 3; channel++) {
    assert.ok(Math.abs(actual[channel] - expected[channel]) <= tolerance, `${message}: got ${actual}, expected ${expected}`);
  }
}

test('preview box-averages a 2048×2560 master to a 1024×1280 baseline JPEG at quality 90', t => {
  const pkg = fixture(t);
  const master = flat(2048, 2560, [0x2f, 0x5b, 0x3a]);
  const { width, data } = master;
  // A one-pixel checkerboard of black and white: every 2×2 block averages to mid
  // grey, where a resize that samples single pixels would give black or white.
  for (let y = 512; y < 768; y++) {
    for (let x = 512; x < 768; x++) data.set((x + y) % 2 ? [255, 255, 255, 255] : [0, 0, 0, 255], (y * width + x) * 4);
  }
  // Opaque red beside fully transparent pixels: alpha multiplies, so half red.
  for (let y = 1024; y < 1280; y++) {
    for (let x = 1024; x < 1280; x++) data.set(x % 2 ? [200, 0, 0, 255] : [0, 255, 0, 0], (y * width + x) * 4);
  }
  // Each quadrant's own colour in the far corners: nothing is cropped or flipped.
  for (let y = 0; y < 64; y++) {
    for (let x = 0; x < 64; x++) {
      data.set([220, 30, 30, 255], (y * width + x) * 4);
      data.set([30, 30, 220, 255], ((2559 - y) * width + 2047 - x) * 4);
    }
  }
  pkg.write('master.png', encodePNG(master));

  pkg.run('preview', null, ['preview', pkg.file('master.png'), pkg.file('out.jpg')]);
  const bytes = pkg.read('out.jpg');
  assert.deepEqual(jpegSize(bytes), { width: 1024, height: 1280, components: 3, progressive: false });
  // Baseline frame, and the quality-90 luma table (3, 2, 2, 3, ...).
  assert.ok(bytes.includes(Buffer.from([0xff, 0xc0, 0, 17, 8, 5, 0, 4, 0])));
  const dqt = bytes.indexOf(Buffer.from([0xff, 0xdb]));
  assert.deepEqual([...bytes.subarray(dqt + 4, dqt + 9)], [0, 3, 2, 2, 3]);
  assert.ok(bytes.length < 4_000_000);

  const small = decodeJPEG(bytes);
  near(pixel(small, 700, 900), [0x2f, 0x5b, 0x3a], 3, 'ground');
  near(pixel(small, 320, 320), [128, 128, 128], 3, 'checkerboard');
  near(pixel(small, 576, 576), [100, 0, 0], 4, 'half-covered red');
  near(pixel(small, 8, 8), [220, 30, 30], 4, 'top-left corner');
  near(pixel(small, 1015, 1271), [30, 30, 220], 4, 'bottom-right corner');

  // Same master, same bytes.
  pkg.run('preview', null, ['preview', pkg.file('master.png'), pkg.file('again.jpg')]);
  assert.deepEqual(pkg.read('again.jpg'), bytes);
});

test('preview refuses a master of another size, a missing master and a wrong argument count', t => {
  const pkg = fixture(t);
  pkg.write('small.png', encodePNG(createImage(1024, 1280)));
  pkg.run('preview', /small\.png: expected 2048×2560, got 1024×1280/, ['preview', pkg.file('small.png'), pkg.file('out.jpg')]);
  pkg.run('preview', /ENOENT/, ['preview', pkg.file('absent.png'), pkg.file('out.jpg')]);
  pkg.write('not.png', 'not a png');
  pkg.run('preview', /not\.png: /, ['preview', pkg.file('not.png'), pkg.file('out.jpg')]);
  pkg.run('preview', /Usage:/, ['preview', pkg.file('small.png')]);
  pkg.run('bogus', /Usage:/, ['bogus']);
  assert.deepEqual(fs.readdirSync(pkg.root).sort(), ['not.png', 'small.png']);
});

// Distinct, saturated colours so a swapped cell or half cannot pass.
const plainColour = index => [40 + index * 16, 200 - index * 12, 60];
const harmonisedColour = index => [200 - index * 12, 60, 40 + index * 16];

test('sheet lays twelve numbered plain/harmonised pairs out four by three', t => {
  const pkg = fixture(t);
  const { SHEET_WIDTH, SHEET_HEIGHT, THUMB_WIDTH, THUMB_HEIGHT, PAIR_GAP, CELL_WIDTH, GUTTER, GLYPHS } = require(tool);
  for (const [index, id] of [...ids.entries()].reverse()) {
    const plain = flat(1024, 1280, plainColour(index));
    // A two-pixel white rail on the right edge of the plain portrait: the
    // half-size thumbnail must still show it in its last column.
    for (let y = 0; y < 1280; y++) {
      plain.data.set([255, 255, 255, 255], (y * 1024 + 1022) * 4);
      plain.data.set([255, 255, 255, 255], (y * 1024 + 1023) * 4);
    }
    pkg.write(`samples/${id}-plain.jpg`, encodeJPEG(plain));
    pkg.write(`samples/${id}-harmonised.jpg`, encodeJPEG(flat(1024, 1280, harmonisedColour(index))));
  }

  pkg.run('sheet');
  const bytes = pkg.read('contact-sheet.jpg');
  assert.ok(bytes.length < 4_000_000);
  assert.deepEqual(jpegSize(bytes), { width: SHEET_WIDTH, height: SHEET_HEIGHT, components: 3, progressive: false });
  assert.equal(SHEET_WIDTH, GUTTER + 4 * (CELL_WIDTH + GUTTER));
  assert.equal(SHEET_HEIGHT, GUTTER + 3 * (THUMB_HEIGHT + GUTTER));
  assert.equal(CELL_WIDTH, 2 * THUMB_WIDTH + PAIR_GAP);
  const result = decodeJPEG(bytes);
  const ground = pixel(result, 4, 4);
  const lit = (x, y) => { const [r, g, b] = pixel(result, x, y); return r + g + b > 128 * 3; };

  for (const [index, id] of ids.entries()) {
    const left = GUTTER + (index % 4) * (CELL_WIDTH + GUTTER);
    const top = GUTTER + Math.floor(index / 4) * (THUMB_HEIGHT + GUTTER);
    const middle = top + THUMB_HEIGHT / 2;
    near(pixel(result, left + THUMB_WIDTH / 2, middle), plainColour(index), 4, `${id} plain, left half`);
    near(pixel(result, left + THUMB_WIDTH + PAIR_GAP + THUMB_WIDTH / 2, middle), harmonisedColour(index), 4, `${id} harmonised, right half`);
    near(pixel(result, left + THUMB_WIDTH - 1, middle), [255, 255, 255], 12, `${id} right rail`);
    near(pixel(result, left + THUMB_WIDTH + PAIR_GAP / 2, middle), ground, 6, `${id} gap between the pair`);
    near(pixel(result, left - GUTTER / 2, middle), ground, 6, `${id} gutter`);
    near(pixel(result, left + CELL_WIDTH + GUTTER / 2, middle), ground, 6, `${id} gutter after`);

    // Read the number back off the sheet: 5 × 7 glyphs at scale 6 with a
    // 12-pixel plate margin, one glyph every 36 pixels.
    for (const [place, digit] of [...id].entries()) {
      const rows = [];
      for (let row = 0; row < 7; row++) {
        let line = '';
        for (let col = 0; col < 5; col++) line += lit(left + 12 + place * 36 + col * 6 + 3, top + 12 + row * 6 + 3) ? '#' : '.';
        rows.push(line);
      }
      assert.deepEqual(rows, GLYPHS[digit], `number on cell ${id}, digit ${place}`);
    }
  }

  // A missing or wrong-size preview stops the sheet and leaves the old one.
  const kept = pkg.read('samples/01-harmonised.jpg');
  pkg.remove('samples/01-harmonised.jpg');
  pkg.run('sheet', /samples\/01-harmonised\.jpg.*ENOENT/);
  pkg.write('samples/01-harmonised.jpg', encodeJPEG(flat(512, 640, [9, 9, 9])));
  pkg.run('sheet', /samples\/01-harmonised\.jpg: expected 1024×1280, got 512×640/);
  pkg.write('samples/01-harmonised.jpg', 'not a jpeg');
  pkg.run('sheet', /samples\/01-harmonised\.jpg: JPEG: missing SOI/);
  assert.deepEqual(pkg.read('contact-sheet.jpg'), bytes);
  assert.deepEqual(fs.readdirSync(pkg.root).sort(), ['contact-sheet.jpg', 'samples']);

  // Same previews, same sheet.
  pkg.write('samples/01-harmonised.jpg', kept);
  pkg.run('sheet');
  assert.deepEqual(pkg.read('contact-sheet.jpg'), bytes);
});

// A v2 package in miniature: real preview headers, stand-in bytes elsewhere.
function populate(pkg) {
  const jpeg = encodeJPEG(flat(1024, 1280, [60, 90, 50]));
  const listed = ['style-guide.md', 'layers/skins/moss.png', 'catalog/foundation.json', 'src/compositor/index.cjs',
    'tools/approval.cjs', 'docs/approval.md', 'docs/.keep', 'src/out/kept.txt', 'src/node_modules/kept.txt',
    'test/compositor/render.test.cjs', 'contact-sheet.jpg'];
  for (const relative of listed) pkg.write(relative, `fixture ${relative}`);
  for (const id of ids) {
    const input = JSON.stringify({ wallet: `study-${id}`, tier: 'common' });
    pkg.write(`sample-inputs/${id}.json`, input);
    pkg.write(`samples/${id}.json`, JSON.stringify({ input: JSON.parse(input), pngSha256: '0'.repeat(64) }));
    pkg.write(`samples/${id}-plain.jpg`, jpeg);
    pkg.write(`samples/${id}-harmonised.jpg`, jpeg);
    listed.push(`sample-inputs/${id}.json`, `samples/${id}.json`, `samples/${id}-plain.jpg`, `samples/${id}-harmonised.jpg`);
  }
  for (const relative of ['.git/config', '.imd-blocked.json', '.cache/x', 'artifacts/goal/result.json', 'artifacts/other.txt',
    'node_modules/pkg/index.js', 'out/01.png', 'test/scratch/fixture.txt']) pkg.write(relative, 'skipped');
  return { jpeg, listed: listed.sort() };
}

test('manifest lists path, bytes and sha256 of every file but itself, skipping the named trees', t => {
  const pkg = fixture(t);
  const { listed } = populate(pkg);
  pkg.run('manifest');
  const bytes = pkg.read('manifest.json');
  assert.deepEqual(JSON.parse(bytes), {
    algorithm: 'sha256',
    files: listed.map(relative => ({ path: relative, bytes: pkg.read(relative).length, sha256: digest(pkg.read(relative)) })),
  });
  // Writing it again, with the first manifest.json on disk, changes nothing.
  pkg.run('manifest');
  assert.deepEqual(pkg.read('manifest.json'), bytes);
  pkg.run('verify');

  // The skipped trees may change freely.
  pkg.write('.git/config', 'changed');
  pkg.write('out/02.png', 'new render');
  pkg.write('test/scratch/more.txt', 'new');
  pkg.write('artifacts/goal/more.json', '{}');
  pkg.write('node_modules/pkg/extra.js', '');
  pkg.write('.imd-note', 'new');
  pkg.run('verify');
});

test('manifest still ties each study to one input and a matching sidecar', t => {
  const pkg = fixture(t);
  populate(pkg);
  pkg.run('manifest');
  const bytes = pkg.read('manifest.json');

  pkg.write('samples/04.json', JSON.stringify({ input: { wallet: 'someone-else' }, pngSha256: '0'.repeat(64) }));
  pkg.run('manifest', /samples\/04\.json: input does not match sample-inputs\/04\.json/);
  pkg.write('samples/04.json', JSON.stringify({ input: { tier: 'common', wallet: 'study-04' } }));
  pkg.run('manifest'); // key order is free, and with no full-size PNG its digest is not asked for

  // A committed full-size PNG must match its sidecar's digest.
  const png = encodePNG(createImage(4, 5));
  pkg.write('samples/04.png', png);
  pkg.run('manifest', /samples\/04\.json: pngSha256 does not match samples\/04\.png/);
  pkg.write('samples/04.json', JSON.stringify({ input: { wallet: 'study-04', tier: 'common' }, pngSha256: digest(png) }));
  pkg.run('manifest');
  pkg.remove('samples/04.json');
  pkg.run('manifest', /Sample 04 sidecar: expected exactly one of .*found 0/);
  pkg.remove('samples/04.png');
  pkg.run('manifest'); // previews alone need no sidecar

  pkg.remove('sample-inputs/09.json');
  pkg.run('manifest', /Sample 09 input: expected exactly one of sample-inputs\/09\.json.*found 0/);
  assert.notDeepEqual(pkg.read('manifest.json'), bytes);
});

test('verify fails on a missing, extra or changed file and on a broken manifest', t => {
  const pkg = fixture(t);
  populate(pkg);
  pkg.run('manifest');
  const bytes = pkg.read('manifest.json');

  pkg.write('docs/approval.md', 'changed');
  pkg.run('verify', /^Changed file: docs\/approval\.md$/m);
  pkg.write('docs/approval.md', 'fixture docs/approval.md');
  pkg.run('verify');

  pkg.remove('layers/skins/moss.png');
  pkg.run('verify', /^Missing file: layers\/skins\/moss\.png$/m);
  pkg.write('layers/skins/moss.png', 'fixture layers/skins/moss.png');

  pkg.write('extra.txt', 'extra');
  pkg.write('src/out/extra.txt', 'extra');
  const result = pkg.run('verify', /^Extra file: extra\.txt$/m);
  assert.match(result.stderr, /^Extra file: src\/out\/extra\.txt$/m);
  pkg.remove('extra.txt');
  pkg.remove('src/out/extra.txt');
  pkg.run('verify');

  // Same hash recorded, different length recorded: still a change.
  const recorded = JSON.parse(bytes);
  recorded.files[0].bytes += 1;
  pkg.write('manifest.json', JSON.stringify(recorded));
  pkg.run('verify', new RegExp(`^Changed file: ${recorded.files[0].path}$`, 'm'));
  recorded.files[0].sha256 = 'f'.repeat(64);
  recorded.files[0].bytes -= 1;
  pkg.write('manifest.json', JSON.stringify(recorded));
  pkg.run('verify', new RegExp(`^Changed file: ${recorded.files[0].path}$`, 'm'));

  delete recorded.files[1].bytes;
  pkg.write('manifest.json', JSON.stringify(recorded));
  pkg.run('verify', /manifest\.json: invalid, duplicate or unsorted file entry/);
  pkg.write('manifest.json', JSON.stringify({ files: [] }));
  pkg.run('verify', /manifest\.json: expected a sha256 file list/);
  pkg.write('manifest.json', '{');
  pkg.run('verify', /manifest\.json: /);
  pkg.remove('manifest.json');
  pkg.run('verify', /manifest\.json/);
  pkg.write('manifest.json', bytes);
  pkg.run('verify');
});

test('verify fails on a wrong-size preview, a missing preview and a missing sheet', t => {
  const pkg = fixture(t);
  const { jpeg } = populate(pkg);

  pkg.write('samples/03-harmonised.jpg', encodeJPEG(flat(1280, 1024, [1, 2, 3])));
  pkg.run('manifest');
  pkg.run('verify', /^Wrong size: samples\/03-harmonised\.jpg is 1280×1024, expected 1024×1280$/m);
  pkg.write('samples/03-harmonised.jpg', 'not a jpeg');
  pkg.run('manifest');
  pkg.run('verify', /^Unreadable preview: samples\/03-harmonised\.jpg: JPEG: missing SOI/m);
  pkg.write('samples/03-harmonised.jpg', jpeg);

  pkg.remove('contact-sheet.jpg');
  pkg.run('manifest');
  pkg.run('verify', /^Missing sheet: contact-sheet\.jpg$/m);
  // The v1 PNG sheet does not stand in for it once there are JPEG previews.
  pkg.write('contact-sheet.png', 'old sheet');
  pkg.run('manifest');
  pkg.run('verify', /^Missing sheet: contact-sheet\.jpg$/m);
  pkg.remove('contact-sheet.png');
  pkg.write('contact-sheet.jpg', 'fixture contact-sheet.jpg');

  pkg.remove('samples/11-plain.jpg');
  pkg.run('manifest');
  pkg.run('verify', /^Missing preview: samples\/11-plain\.jpg$/m);
  pkg.write('samples/11-plain.jpg', jpeg);
  pkg.run('manifest');
  pkg.run('verify');

  // No sheet of either kind and no previews: still a missing sheet.
  const bare = fixture(t);
  bare.write('style-guide.md', 'fixture');
  for (const id of ids) bare.write(`sample-inputs/${id}.json`, '{}');
  bare.run('manifest');
  bare.run('verify', /^Missing sheet: contact-sheet\.jpg$/m);
});

test('verify enforces the size limits: under 4,000,000 for previews and the sheet, under 8,000,000 for any file', t => {
  const pkg = fixture(t);
  const { jpeg } = populate(pkg);
  // Bytes after the EOI marker leave the header readable.
  const padded = size => Buffer.concat([jpeg, Buffer.alloc(size - jpeg.length, 0x20)]);

  pkg.write('samples/02-plain.jpg', padded(3_999_999));
  pkg.write('contact-sheet.jpg', Buffer.alloc(3_999_999, 0x20));
  pkg.write('layers/big.png', Buffer.alloc(7_999_999, 0x20));
  pkg.run('manifest');
  pkg.run('verify');

  pkg.write('samples/02-plain.jpg', padded(4_000_000));
  pkg.run('manifest');
  pkg.run('verify', /^Too large: samples\/02-plain\.jpg is 4000000 bytes, previews and the sheet must be under 4000000$/m);
  pkg.write('samples/02-plain.jpg', jpeg);

  pkg.write('contact-sheet.jpg', Buffer.alloc(4_000_000, 0x20));
  pkg.run('manifest');
  pkg.run('verify', /^Too large: contact-sheet\.jpg is 4000000 bytes, previews and the sheet must be under 4000000$/m);
  pkg.write('contact-sheet.jpg', 'fixture');

  pkg.write('layers/big.png', Buffer.alloc(8_000_000, 0x20));
  pkg.run('manifest');
  pkg.run('verify', /^Too large: layers\/big\.png is 8000000 bytes, every file must be under 8000000$/m);
  pkg.write('layers/big.png', 'small again');
  pkg.run('manifest');
  pkg.run('verify');
});
