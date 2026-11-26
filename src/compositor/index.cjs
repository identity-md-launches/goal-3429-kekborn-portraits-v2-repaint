'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { RenderError, loadCatalog, SCHEMA } = require('./catalog.cjs');
const { computeSeed, validateInput, selectLayers } = require('./select.cjs');

const RECORD_SCHEMA = 'kekborn-render@1';
const DEFAULT_ROOT = path.resolve(__dirname, '..', '..');
const ARMS_PLACEMENTS = Object.freeze({
  banner: Object.freeze({ x: 1500, y: 340, width: 240, height: 288 }),
  rail: Object.freeze({ x: 974, y: 2404, width: 100, height: 120 }),
});

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function readAsset(absPath, label) {
  try {
    return fs.readFileSync(absPath);
  } catch (error) {
    throw new RenderError('E_MISSING_FILE', `${label}: cannot read ${absPath} (${error.code || error.message})`);
  }
}

function pngSize(bytes) {
  if (bytes.length < 24 || bytes.toString('latin1', 12, 16) !== 'IHDR') return null;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function relPath(root, abs) {
  return path.relative(root, abs).split(path.sep).join('/');
}

function loadModule(root, rel, label) {
  const file = path.join(root, rel);
  if (!fs.existsSync(file)) throw new RenderError('E_MISSING_FILE', `${label} module not found at ${file}`);
  return require(file);
}

/** Hash the heraldry parts reported by buildArms. Entries are strings or objects with a path. */
function armsParts(root, usedLayers) {
  if (!Array.isArray(usedLayers)) throw new RenderError('E_ARMS', 'buildArms must return usedLayers as an array');
  return usedLayers.map((entry, index) => {
    const meta = typeof entry === 'string' ? { path: entry } : { ...entry };
    if (typeof meta.path !== 'string' || !meta.path) {
      throw new RenderError('E_ARMS', `buildArms usedLayers[${index}] has no path`);
    }
    const abs = path.resolve(root, meta.path);
    const part = { ...meta, path: relPath(root, abs), sha256: sha256(readAsset(abs, `arms part ${index}`)) };
    return part;
  });
}

/**
 * Render one portrait. Pure function of (input, root contents): returns
 * { png: Buffer, record: object }. options.root selects the repository root
 * (catalog/, layers, src/heraldry, src/raster); options.raster and
 * options.heraldry override the modules (used by tests).
 */
function renderPortrait(input, options = {}) {
  const root = path.resolve(options.root || DEFAULT_ROOT);
  const normal = validateInput(input);
  const raster = options.raster || loadModule(root, 'src/raster/index.cjs', 'Raster');
  const heraldry = options.heraldry || loadModule(root, 'src/heraldry/index.cjs', 'Heraldry');
  if (typeof heraldry.buildArms !== 'function') throw new RenderError('E_ARMS', 'src/heraldry/index.cjs must export buildArms');
  const catalog = loadCatalog(root);
  const seed = computeSeed(input.wallet, input.artSeed);
  const stack = selectLayers(catalog, seed, normal);

  const width = raster.MASTER_WIDTH || 2048;
  const height = raster.MASTER_HEIGHT || 2560;
  const full = { x: 0, y: 0, width, height };

  // Read and check every file before painting anything.
  const files = new Map();
  for (const item of stack) {
    if (!item.asset) continue;
    const bytes = readAsset(item.asset.absPath, `Asset ${item.asset.id}`);
    const size = pngSize(bytes);
    if (!size || size.width !== width || size.height !== height) {
      throw new RenderError('E_ASSET_SIZE', `Asset ${item.asset.id}: ${item.asset.path} must be a ${width}x${height} PNG`);
    }
    files.set(item.asset.id, bytes);
  }

  const arms = heraldry.buildArms(seed, { root });
  if (!arms || !arms.image || !arms.choices) throw new RenderError('E_ARMS', 'buildArms must return {image, choices, usedLayers}');
  const armsImageSha256 = sha256(Buffer.concat([
    Buffer.from(`${arms.image.width}x${arms.image.height}\0`), Buffer.from(arms.image.data.buffer,
      arms.image.data.byteOffset, arms.image.data.byteLength),
  ]));
  const parts = armsParts(root, arms.usedLayers || []);

  const canvas = raster.createImage(width, height);
  const scratch = new Uint8Array(width * height * 4);
  const layers = [];
  for (const item of stack) {
    if (item.asset) {
      const bytes = files.get(item.asset.id);
      const decoded = raster.decodePNG(bytes, scratch);
      raster.composite(canvas, decoded, full);
      layers.push({
        index: layers.length, group: item.group, kind: 'catalog', id: item.asset.id, slot: item.asset.slot,
        path: item.asset.path, sha256: sha256(bytes), source: item.source, placement: { ...full },
      });
    } else {
      const where = item.group === 'banner-arms' ? ARMS_PLACEMENTS.banner : ARMS_PLACEMENTS.rail;
      raster.composite(canvas, arms.image, { ...where });
      layers.push({
        index: layers.length, group: item.group, kind: 'procedural', id: `arms:${item.group}`,
        imageSha256: armsImageSha256, source: 'heraldry.buildArms', placement: { ...where },
      });
    }
  }
  raster.finish(canvas, seed);
  const png = raster.encodePNG(canvas);

  const record = {
    schema: RECORD_SCHEMA,
    catalogSchema: SCHEMA,
    input,
    seed: seed.toString('hex'),
    tier: normal.tier,
    category: normal.category,
    canvas: { width, height },
    layers,
    arms: {
      choices: arms.choices,
      imageSize: { width: arms.image.width, height: arms.image.height },
      imageSha256: armsImageSha256,
      parts,
      placements: { banner: { ...ARMS_PLACEMENTS.banner }, rail: { ...ARMS_PLACEMENTS.rail } },
    },
    finish: { pass: 'raster.finish', count: 1, afterLayer: layers.length - 1, seed: 'seed' },
    pngSha256: sha256(png),
  };
  return { png, record };
}

/** Sidecar path: output.png -> output.json (other names get ".json" appended). */
function recordPath(output) {
  return /\.png$/i.test(output) ? output.replace(/\.png$/i, '.json') : `${output}.json`;
}

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

module.exports = { RECORD_SCHEMA, DEFAULT_ROOT, ARMS_PLACEMENTS, RenderError, renderPortrait, recordPath, stableJson };
