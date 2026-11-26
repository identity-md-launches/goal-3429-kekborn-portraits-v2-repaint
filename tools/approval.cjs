#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const {
  MASTER_WIDTH, MASTER_HEIGHT, createImage, decodePNG, encodePNG,
} = require('../src/raster/index.cjs');

const SAMPLE_IDS = Array.from({ length: 12 }, (_, index) => String(index + 1).padStart(2, '0'));
const THUMB_WIDTH = 256;
const THUMB_HEIGHT = 320;
const GUTTER = 16;
const SHEET = 'contact-sheet.png';
const MANIFEST = 'manifest.json';
const SHA256 = /^[a-f0-9]{64}$/;

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function read(root, relative) {
  return fs.readFileSync(path.join(root, relative));
}

function readJson(root, relative) {
  const bytes = read(root, relative);
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    throw new Error(`${relative}: ${error.message}`);
  }
}

function writeOutput(root, relative, bytes) {
  const target = path.join(root, relative);
  const temporary = `${target}.${randomUUID()}.tmp`;
  const fd = fs.openSync(temporary, 'wx');
  try {
    try {
      fs.writeFileSync(fd, bytes);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temporary, target);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

// Each destination pixel covers an exact 8 × 8 block of the full master.
// Weight RGB by alpha so hidden colors cannot bleed into frame edges.
function thumbnailInto(sheet, source, left) {
  const block = MASTER_WIDTH / THUMB_WIDTH;
  const area = block * block;
  for (let y = 0; y < THUMB_HEIGHT; y++) {
    for (let x = 0; x < THUMB_WIDTH; x++) {
      let alpha = 0;
      let red = 0;
      let green = 0;
      let blue = 0;
      for (let row = 0; row < block; row++) {
        let offset = ((y * block + row) * source.width + x * block) * 4;
        for (let col = 0; col < block; col++, offset += 4) {
          const weight = source.data[offset + 3];
          alpha += weight;
          red += source.data[offset] * weight;
          green += source.data[offset + 1] * weight;
          blue += source.data[offset + 2] * weight;
        }
      }
      const dest = (y * sheet.width + left + x) * 4;
      const coverage = Math.round(alpha / area);
      if (coverage) {
        sheet.data[dest] = Math.round(red / alpha);
        sheet.data[dest + 1] = Math.round(green / alpha);
        sheet.data[dest + 2] = Math.round(blue / alpha);
        sheet.data[dest + 3] = coverage;
      }
    }
  }
}

function sheet(root) {
  const width = SAMPLE_IDS.length * THUMB_WIDTH + (SAMPLE_IDS.length - 1) * GUTTER;
  const output = createImage(width, THUMB_HEIGHT);
  for (const [index, id] of SAMPLE_IDS.entries()) {
    const relative = `samples/${id}.png`;
    let source;
    try {
      source = decodePNG(read(root, relative));
    } catch (error) {
      throw new Error(`${relative}: ${error.message}`);
    }
    if (source.width !== MASTER_WIDTH || source.height !== MASTER_HEIGHT) {
      throw new Error(`${relative}: expected ${MASTER_WIDTH}×${MASTER_HEIGHT}, got ${source.width}×${source.height}`);
    }
    thumbnailInto(output, source, index * (THUMB_WIDTH + GUTTER));
  }
  writeOutput(root, SHEET, encodePNG(output));
}

function deliveredFiles(root) {
  const files = [];
  function visit(directory) {
    for (const entry of fs.readdirSync(path.join(root, directory), { withFileTypes: true })) {
      const relative = directory ? `${directory}/${entry.name}` : entry.name;
      if (['.git', '.hg', '.svn', 'node_modules'].includes(entry.name) ||
          ['.imd', 'artifacts/goal', 'scratch', 'test/scratch', MANIFEST].includes(relative) ||
          (!directory && entry.name.startsWith('.imd-'))) continue;
      if (entry.isDirectory()) visit(relative);
      if (entry.isFile()) files.push(relative);
    }
  }
  visit('');
  return files.sort();
}

function requireOne(files, candidates, description) {
  const matches = candidates.filter(candidate => files.has(candidate));
  if (matches.length !== 1) {
    throw new Error(`${description}: expected exactly one of ${candidates.join(', ')}; found ${matches.length}`);
  }
  return matches[0];
}

function checkPackage(root, paths) {
  const files = new Set(paths);
  for (const required of ['style-guide.md', 'template/bust.svg', SHEET]) {
    if (!files.has(required)) throw new Error(`Missing ${required}`);
  }
  const requirements = [
    ['layer library', /^layers\/.+\.png$/i],
    ['catalog JSON', /^(?:.*\/)?(?:catalogs?\/.+|[^/]*catalog[^/]*)\.json$/i],
    ['compositor source', /^(?:(?:src|tools)\/)?(?:compositor\/.+|compositor|compose)\.[cm]?js$/i],
    ['compositor tests', /^tests?\/(?:compositor\/.*|[^/]*(?:compositor|compose)[^/]*)\.[cm]?js$/i],
  ];
  for (const [description, pattern] of requirements) {
    if (!paths.some(relative => pattern.test(relative))) throw new Error(`Missing ${description}`);
  }

  for (const id of SAMPLE_IDS) {
    const png = `samples/${id}.png`;
    if (!files.has(png)) throw new Error(`Missing ${png}`);
    const inputPath = requireOne(files, [
      `sample-inputs/${id}.json`, `samples/inputs/${id}.json`, `samples/${id}.input.json`, `inputs/${id}.json`,
    ], `Sample ${id} input`);
    const sidecarPath = requireOne(files, [
      `samples/${id}.json`, `samples/${id}.sidecar.json`, `samples/${id}.png.json`,
    ], `Sample ${id} sidecar`);
    const input = readJson(root, inputPath);
    const sidecar = readJson(root, sidecarPath);
    if (!sidecar || !Object.hasOwn(sidecar, 'input') || !isDeepStrictEqual(sidecar.input, input)) {
      throw new Error(`${sidecarPath}: input does not match ${inputPath}`);
    }
    if (sidecar.pngSha256 !== sha256(read(root, png))) {
      throw new Error(`${sidecarPath}: pngSha256 does not match ${png}`);
    }
  }
}

function manifest(root) {
  const paths = deliveredFiles(root);
  checkPackage(root, paths);
  const files = paths.map(relative => ({ path: relative, sha256: sha256(read(root, relative)) }));
  writeOutput(root, MANIFEST, JSON.stringify({ algorithm: 'sha256', files }, null, 2) + '\n');
}

function verify(root) {
  const recorded = readJson(root, MANIFEST);
  if (recorded?.algorithm !== 'sha256' || !Array.isArray(recorded.files)) {
    throw new Error(`${MANIFEST}: expected a sha256 file list`);
  }

  const expected = new Map();
  let previous;
  for (const entry of recorded.files) {
    if (typeof entry?.path !== 'string' || typeof entry.sha256 !== 'string' ||
        !SHA256.test(entry.sha256) || (previous !== undefined && previous >= entry.path)) {
      throw new Error(`${MANIFEST}: invalid, duplicate or unsorted file entry`);
    }
    expected.set(entry.path, entry.sha256);
    previous = entry.path;
  }

  const errors = [];
  for (const relative of deliveredFiles(root)) {
    const hash = sha256(read(root, relative));
    if (!expected.has(relative)) errors.push(`Extra file: ${relative}`);
    else if (expected.get(relative) !== hash) errors.push(`Changed file: ${relative}`);
    expected.delete(relative);
  }
  for (const relative of expected.keys()) errors.push(`Missing file: ${relative}`);
  if (errors.length) throw new Error(errors.join('\n'));
}

if (require.main === module) {
  const [operation, root = path.resolve(__dirname, '..'), ...extra] = process.argv.slice(2);
  const operations = new Map([['sheet', sheet], ['manifest', manifest], ['verify', verify]]);
  try {
    if (extra.length || !operations.has(operation)) {
      throw new Error('Usage: node tools/approval.cjs <sheet|manifest|verify> [package-root]');
    }
    operations.get(operation)(root);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
