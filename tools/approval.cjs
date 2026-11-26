#!/usr/bin/env node
'use strict';

// Kekborn v2 approval tooling: JPEG previews, the contact sheet, the manifest
// and its verification. Plain Node, no dependencies. See docs/approval.md.

const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const { MASTER_WIDTH, MASTER_HEIGHT, createImage, decodePNG } = require('../src/raster/index.cjs');
const { encodeJPEG, decodeJPEG, jpegSize } = require('../src/jpeg/index.cjs');

const SAMPLE_IDS = Array.from({ length: 12 }, (_, index) => String(index + 1).padStart(2, '0'));
const VARIANTS = ['plain', 'harmonised'];
const PREVIEW_WIDTH = 1024;
const PREVIEW_HEIGHT = 1280;
const PREVIEW_QUALITY = 90;
const PREVIEW_PATTERN = /^samples\/\d\d-(?:plain|harmonised)\.jpg$/;
const SHEET = 'contact-sheet.jpg';
const LEGACY_SHEET = 'contact-sheet.png';
const MANIFEST = 'manifest.json';
const PREVIEW_LIMIT = 4_000_000; // a preview or the sheet must be smaller than this
const FILE_LIMIT = 8_000_000; // every file must be smaller than this
const SKIPPED_ROOTS = ['artifacts', 'node_modules', 'out', 'test/scratch'];
const SHA256 = /^[a-f0-9]{64}$/;

// Contact sheet geometry: four columns by three rows of cells. A cell is the
// plain portrait, a narrow gap, then the harmonised portrait, each at half the
// preview's size.
const SHEET_COLUMNS = 4;
const SHEET_ROWS = 3;
const THUMB_WIDTH = PREVIEW_WIDTH / 2;
const THUMB_HEIGHT = PREVIEW_HEIGHT / 2;
const PAIR_GAP = 8;
const CELL_WIDTH = THUMB_WIDTH * 2 + PAIR_GAP;
const GUTTER = 32;
const SHEET_WIDTH = GUTTER + SHEET_COLUMNS * (CELL_WIDTH + GUTTER);
const SHEET_HEIGHT = GUTTER + SHEET_ROWS * (THUMB_HEIGHT + GUTTER);
const SHEET_GROUND = [0x16, 0x12, 0x0f];
const LABEL_INK = [0xf2, 0xe6, 0xc8];
const SHEET_QUALITIES = [90, 85, 80, 75, 70, 65, 60];

// 5 × 7 label glyphs, one string per row.
const GLYPHS = {
  0: ['.###.', '#...#', '#..##', '#.#.#', '##..#', '#...#', '.###.'],
  1: ['..#..', '.##..', '..#..', '..#..', '..#..', '..#..', '.###.'],
  2: ['.###.', '#...#', '....#', '...#.', '..#..', '.#...', '#####'],
  3: ['.###.', '#...#', '....#', '..##.', '....#', '#...#', '.###.'],
  4: ['...#.', '..##.', '.#.#.', '#..#.', '#####', '...#.', '...#.'],
  5: ['#####', '#....', '####.', '....#', '....#', '#...#', '.###.'],
  6: ['.###.', '#....', '#....', '####.', '#...#', '#...#', '.###.'],
  7: ['#####', '....#', '...#.', '..#..', '.#...', '.#...', '.#...'],
  8: ['.###.', '#...#', '#...#', '.###.', '#...#', '#...#', '.###.'],
  9: ['.###.', '#...#', '#...#', '.####', '....#', '....#', '.###.'],
  P: ['####.', '#...#', '#...#', '####.', '#....', '#....', '#....'],
  H: ['#...#', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
};

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

// Write beside the target and rename, so a failed run leaves the old file.
function writeOutput(target, bytes) {
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

/**
 * Box-average `source` by an integer factor into `destination` at (left, top).
 * Every destination pixel is the mean of an exact factor × factor block, so no
 * source pixel is skipped. Alpha multiplies the colour (a flatten over black):
 * the output is opaque, as JPEG has no alpha.
 */
function boxAverageInto(destination, source, factor, left = 0, top = 0) {
  const width = source.width / factor;
  const height = source.height / factor;
  const area = factor * factor * 255;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let red = 0;
      let green = 0;
      let blue = 0;
      for (let row = 0; row < factor; row++) {
        let offset = ((y * factor + row) * source.width + x * factor) * 4;
        for (let col = 0; col < factor; col++, offset += 4) {
          const weight = source.data[offset + 3];
          red += source.data[offset] * weight;
          green += source.data[offset + 1] * weight;
          blue += source.data[offset + 2] * weight;
        }
      }
      const dest = ((top + y) * destination.width + left + x) * 4;
      destination.data[dest] = Math.round(red / area);
      destination.data[dest + 1] = Math.round(green / area);
      destination.data[dest + 2] = Math.round(blue / area);
      destination.data[dest + 3] = 255;
    }
  }
}

function fillRect(image, left, top, width, height, [red, green, blue]) {
  for (let y = top; y < top + height; y++) {
    for (let x = left; x < left + width; x++) {
      image.data.set([red, green, blue, 255], (y * image.width + x) * 4);
    }
  }
}

/** Draws `text` in LABEL_INK on a SHEET_GROUND plate whose top-left is (left, top). */
function drawLabel(image, text, left, top, scale) {
  const pad = scale * 2;
  const advance = scale * 6;
  fillRect(image, left, top, pad * 2 + text.length * advance - scale, pad * 2 + scale * 7, SHEET_GROUND);
  for (const [index, character] of [...text].entries()) {
    for (const [row, line] of GLYPHS[character].entries()) {
      for (let col = 0; col < 5; col++) {
        if (line[col] === '#') {
          fillRect(image, left + pad + index * advance + col * scale, top + pad + row * scale, scale, scale, LABEL_INK);
        }
      }
    }
  }
}

/** preview <master.png> <out.jpg>: 2048×2560 PNG to a 1024×1280 baseline JPEG at quality 90. */
function preview(masterPath, outPath) {
  let master;
  try {
    master = decodePNG(fs.readFileSync(masterPath));
  } catch (error) {
    throw new Error(`${masterPath}: ${error.message}`);
  }
  if (master.width !== MASTER_WIDTH || master.height !== MASTER_HEIGHT) {
    throw new Error(`${masterPath}: expected ${MASTER_WIDTH}×${MASTER_HEIGHT}, got ${master.width}×${master.height}`);
  }
  const small = createImage(PREVIEW_WIDTH, PREVIEW_HEIGHT);
  boxAverageInto(small, master, MASTER_WIDTH / PREVIEW_WIDTH);
  const bytes = encodeJPEG(small, { quality: PREVIEW_QUALITY });
  if (bytes.length >= PREVIEW_LIMIT) {
    throw new Error(`${outPath}: preview would be ${bytes.length} bytes, the limit is under ${PREVIEW_LIMIT}`);
  }
  writeOutput(outPath, bytes);
}

/** sheet: samples/NN-plain.jpg and samples/NN-harmonised.jpg for 01..12 to contact-sheet.jpg. */
function sheet(root) {
  const output = createImage(SHEET_WIDTH, SHEET_HEIGHT);
  fillRect(output, 0, 0, SHEET_WIDTH, SHEET_HEIGHT, SHEET_GROUND);
  for (const [index, id] of SAMPLE_IDS.entries()) {
    const left = GUTTER + (index % SHEET_COLUMNS) * (CELL_WIDTH + GUTTER);
    const top = GUTTER + Math.floor(index / SHEET_COLUMNS) * (THUMB_HEIGHT + GUTTER);
    for (const [slot, variant] of VARIANTS.entries()) {
      const relative = `samples/${id}-${variant}.jpg`;
      let source;
      try {
        source = decodeJPEG(read(root, relative));
      } catch (error) {
        throw new Error(`${relative}: ${error.message}`);
      }
      if (source.width !== PREVIEW_WIDTH || source.height !== PREVIEW_HEIGHT) {
        throw new Error(`${relative}: expected ${PREVIEW_WIDTH}×${PREVIEW_HEIGHT}, got ${source.width}×${source.height}`);
      }
      const x = left + slot * (THUMB_WIDTH + PAIR_GAP);
      boxAverageInto(output, source, PREVIEW_WIDTH / THUMB_WIDTH, x, top);
      // P for plain, H for harmonised, bottom-left of each half.
      drawLabel(output, variant[0].toUpperCase(), x, top + THUMB_HEIGHT - 33, 3);
    }
    drawLabel(output, id, left, top, 6);
  }
  // Quality 90 unless the sheet would reach the size limit; then step down.
  let bytes;
  for (const quality of SHEET_QUALITIES) {
    bytes = encodeJPEG(output, { quality });
    if (bytes.length < PREVIEW_LIMIT) break;
  }
  if (bytes.length >= PREVIEW_LIMIT) {
    throw new Error(`${SHEET}: ${bytes.length} bytes even at quality ${SHEET_QUALITIES.at(-1)}, the limit is under ${PREVIEW_LIMIT}`);
  }
  writeOutput(path.join(root, SHEET), bytes);
}

/**
 * Every regular file of the package, sorted. Skips root entries whose names
 * start with a dot, and artifacts/, node_modules/, out/ and test/scratch/.
 * manifest.json is listed here; the callers set it aside.
 */
function deliveredFiles(root) {
  const files = [];
  function visit(directory) {
    for (const entry of fs.readdirSync(path.join(root, directory), { withFileTypes: true })) {
      const relative = directory ? `${directory}/${entry.name}` : entry.name;
      if ((!directory && entry.name.startsWith('.')) || SKIPPED_ROOTS.includes(relative)) continue;
      if (entry.isDirectory()) visit(relative);
      else if (entry.isFile()) files.push(relative);
    }
  }
  visit('');
  return files.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * The studies must stay tied to their inputs: exactly one input JSON per
 * sample, at most one sidecar, a sidecar that repeats that input, and, where
 * the full-size PNG is in the package, a sidecar whose pngSha256 matches it.
 */
function checkSamples(root, paths) {
  const files = new Set(paths);
  const matching = candidates => candidates.filter(candidate => files.has(candidate));
  for (const id of SAMPLE_IDS) {
    const inputCandidates = [`sample-inputs/${id}.json`, `samples/inputs/${id}.json`, `samples/${id}.input.json`, `inputs/${id}.json`];
    const sidecarCandidates = [`samples/${id}.json`, `samples/${id}.sidecar.json`, `samples/${id}.png.json`];
    const inputs = matching(inputCandidates);
    if (inputs.length !== 1) {
      throw new Error(`Sample ${id} input: expected exactly one of ${inputCandidates.join(', ')}; found ${inputs.length}`);
    }
    const sidecars = matching(sidecarCandidates);
    const png = `samples/${id}.png`;
    if (sidecars.length > 1 || (sidecars.length === 0 && files.has(png))) {
      throw new Error(`Sample ${id} sidecar: expected exactly one of ${sidecarCandidates.join(', ')}; found ${sidecars.length}`);
    }
    if (!sidecars.length) continue;
    const input = readJson(root, inputs[0]);
    const sidecar = readJson(root, sidecars[0]);
    if (!sidecar || !Object.hasOwn(sidecar, 'input') || !isDeepStrictEqual(sidecar.input, input)) {
      throw new Error(`${sidecars[0]}: input does not match ${inputs[0]}`);
    }
    if (files.has(png) && sidecar.pngSha256 !== sha256(read(root, png))) {
      throw new Error(`${sidecars[0]}: pngSha256 does not match ${png}`);
    }
  }
}

/** manifest: path, bytes and sha256 of every file but manifest.json itself. */
function manifest(root) {
  const paths = deliveredFiles(root).filter(relative => relative !== MANIFEST);
  checkSamples(root, paths);
  const files = paths.map(relative => {
    const bytes = read(root, relative);
    return { path: relative, bytes: bytes.length, sha256: sha256(bytes) };
  });
  writeOutput(path.join(root, MANIFEST), JSON.stringify({ algorithm: 'sha256', files }, null, 2) + '\n');
}

/** verify: collects every problem, then fails with one line per problem. */
function verify(root) {
  const recorded = readJson(root, MANIFEST);
  if (recorded?.algorithm !== 'sha256' || !Array.isArray(recorded.files)) {
    throw new Error(`${MANIFEST}: expected a sha256 file list`);
  }
  const expected = new Map();
  let previous;
  for (const entry of recorded.files) {
    if (typeof entry?.path !== 'string' || typeof entry.sha256 !== 'string' || !SHA256.test(entry.sha256) ||
        !Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || entry.path === MANIFEST ||
        (previous !== undefined && previous >= entry.path)) {
      throw new Error(`${MANIFEST}: invalid, duplicate or unsorted file entry`);
    }
    expected.set(entry.path, entry);
    previous = entry.path;
  }

  const errors = [];
  const present = new Set();
  for (const relative of deliveredFiles(root)) {
    const bytes = read(root, relative);
    const shown = PREVIEW_PATTERN.test(relative) || relative === SHEET;
    if (bytes.length >= FILE_LIMIT) {
      errors.push(`Too large: ${relative} is ${bytes.length} bytes, every file must be under ${FILE_LIMIT}`);
    } else if (shown && bytes.length >= PREVIEW_LIMIT) {
      errors.push(`Too large: ${relative} is ${bytes.length} bytes, previews and the sheet must be under ${PREVIEW_LIMIT}`);
    }
    if (PREVIEW_PATTERN.test(relative)) {
      try {
        const size = jpegSize(bytes);
        if (size.width !== PREVIEW_WIDTH || size.height !== PREVIEW_HEIGHT) {
          errors.push(`Wrong size: ${relative} is ${size.width}×${size.height}, expected ${PREVIEW_WIDTH}×${PREVIEW_HEIGHT}`);
        }
      } catch (error) {
        errors.push(`Unreadable preview: ${relative}: ${error.message}`);
      }
    }
    if (relative === MANIFEST) continue;
    present.add(relative);
    const entry = expected.get(relative);
    if (!entry) errors.push(`Extra file: ${relative}`);
    else if (entry.bytes !== bytes.length || entry.sha256 !== sha256(bytes)) errors.push(`Changed file: ${relative}`);
    expected.delete(relative);
  }
  for (const relative of expected.keys()) errors.push(`Missing file: ${relative}`);

  // A v1 package (the code-drawn studies) carried contact-sheet.png and no JPEG
  // preview. Anything with a preview or a JPEG sheet is v2 and needs all of it.
  const previews = SAMPLE_IDS.flatMap(id => VARIANTS.map(variant => `samples/${id}-${variant}.jpg`));
  const v2 = present.has(SHEET) || [...present].some(relative => PREVIEW_PATTERN.test(relative));
  if (v2 || !present.has(LEGACY_SHEET)) {
    if (!present.has(SHEET)) errors.push(`Missing sheet: ${SHEET}`);
    for (const relative of previews) {
      if (!present.has(relative)) errors.push(`Missing preview: ${relative}`);
    }
  }
  if (errors.length) throw new Error(errors.join('\n'));
}

const USAGE = `Usage:
  node tools/approval.cjs preview <master.png> <out.jpg>
  node tools/approval.cjs sheet [package-root]
  node tools/approval.cjs manifest [package-root]
  node tools/approval.cjs verify [package-root]`;

function main(argv) {
  const [operation, ...rest] = argv;
  if (operation === 'preview') {
    if (rest.length !== 2) throw new Error(USAGE);
    return preview(rest[0], rest[1]);
  }
  const operations = { sheet, manifest, verify };
  if (!Object.hasOwn(operations, operation) || rest.length > 1) throw new Error(USAGE);
  return operations[operation](rest[0] ?? path.resolve(__dirname, '..'));
}

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = {
  preview, sheet, manifest, verify, deliveredFiles,
  SAMPLE_IDS, PREVIEW_WIDTH, PREVIEW_HEIGHT, PREVIEW_QUALITY, PREVIEW_LIMIT, FILE_LIMIT,
  SHEET, MANIFEST, SHEET_WIDTH, SHEET_HEIGHT, THUMB_WIDTH, THUMB_HEIGHT, PAIR_GAP, CELL_WIDTH, GUTTER, GLYPHS,
};
