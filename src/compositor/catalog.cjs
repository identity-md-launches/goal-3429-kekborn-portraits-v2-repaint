'use strict';

const fs = require('node:fs');
const path = require('node:path');

const SCHEMA = 'kekborn-assets@1';
const TIERS = Object.freeze(['common', 'uncommon', 'rare', 'epic', 'legendary']);
const CATEGORIES = Object.freeze(['scholar', 'antiquary', 'knight', 'artisan', 'seer', 'council']);
const RARITIES = Object.freeze(['common', 'uncommon', 'rare', 'epic', 'legendary']);
// Slots the compositor stacks. Records with any other slot are kept in the
// catalog (other tools may use them) but never drawn.
const SLOTS = Object.freeze([
  'background', 'banner', 'prop-rear', 'attire-back', 'skin', 'eyes', 'expression',
  'attire-front', 'accessory', 'headwear', 'regalia', 'prop-front', 'frame',
]);

class RenderError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RenderError';
    this.code = code;
  }
}

function asList(value, field, id, allowed) {
  if (value === undefined) return null;
  const list = Array.isArray(value) ? value : [value];
  if (!list.length || !list.every((item) => typeof item === 'string' && item.length)) {
    throw new RenderError('E_CATALOG', `Asset ${id}: ${field} must be a nonempty string or array of strings`);
  }
  const normal = list.map((item) => item.toLowerCase());
  if (allowed) {
    for (const item of normal) {
      if (!allowed.includes(item)) throw new RenderError('E_CATALOG', `Asset ${id}: unknown ${field} "${item}"`);
    }
  }
  return normal;
}

function assetPath(root, value, field, id) {
  const rel = value.replace(/\\/g, '/');
  const abs = path.resolve(root, rel);
  const fromRoot = path.relative(root, abs);
  if (!fromRoot || path.isAbsolute(rel) || path.win32.isAbsolute(rel) ||
      /^[a-z]:/i.test(rel) || rel.includes('\0') || path.isAbsolute(fromRoot) ||
      fromRoot === '..' || fromRoot.startsWith('..' + path.sep)) {
    throw new RenderError('E_CATALOG', `Asset ${id}: ${field} must stay inside the repository`);
  }
  return { path: rel, absPath: abs };
}

function loadSkinPaint(root, value, id) {
  if (value === undefined) return null;
  if (typeof value !== 'string' || !value) {
    throw new RenderError('E_CATALOG', `Asset ${id}: skinPaint must be a nonempty PNG path`);
  }
  const file = assetPath(root, value, 'skinPaint', id);
  try {
    const realRoot = fs.realpathSync(root);
    const realFile = fs.realpathSync(file.absPath);
    assetPath(realRoot, path.relative(realRoot, realFile), 'skinPaint', id);
    if (fs.statSync(realFile).isFile()) return file;
  } catch (error) {
    if (error instanceof RenderError) throw error;
  }
  throw new RenderError('E_CATALOG', `Asset ${id}: skinPaint file ${file.path} is unavailable`);
}

/**
 * Load every root/catalog/*.json (sorted by file name). Each file must be
 * { schema: "kekborn-assets@1", assets: [{ id, slot, path, tier?, category?,
 * rarity?, requiresEyes?, tone?, skinPaint?, explicitOnly? }] }.
 * IDs are unique across all files. Paths are
 * relative to root and may not leave it.
 */
function loadCatalog(root) {
  const dir = path.join(root, 'catalog');
  let names;
  try {
    names = fs.readdirSync(dir).filter((name) => name.endsWith('.json')).sort();
  } catch (error) {
    throw new RenderError('E_CATALOG', `Cannot read catalog directory ${dir}: ${error.code || error.message}`);
  }
  if (!names.length) throw new RenderError('E_CATALOG', `No catalog/*.json files in ${root}`);
  const byId = new Map();
  for (const name of names) {
    let doc;
    try {
      doc = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
    } catch (error) {
      throw new RenderError('E_CATALOG', `catalog/${name}: ${error.message}`);
    }
    if (!doc || doc.schema !== SCHEMA || !Array.isArray(doc.assets)) {
      throw new RenderError('E_CATALOG', `catalog/${name}: expected schema "${SCHEMA}" with an assets array`);
    }
    for (const raw of doc.assets) {
      if (!raw || typeof raw.id !== 'string' || !raw.id || typeof raw.slot !== 'string' ||
          typeof raw.path !== 'string' || !raw.path) {
        throw new RenderError('E_CATALOG', `catalog/${name}: every asset needs string id, slot and path`);
      }
      const id = raw.id;
      if (byId.has(id)) throw new RenderError('E_CATALOG', `Duplicate asset id ${id} (catalog/${name})`);
      const file = assetPath(root, raw.path, 'path', id);
      const { tone, explicitOnly } = raw;
      if (tone !== undefined && (raw.slot !== 'skin' || !Array.isArray(tone) || tone.length !== 3 ||
          !tone.every((row) => Array.isArray(row) && row.length === 4 && row.every(Number.isFinite)))) {
        throw new RenderError('E_CATALOG', `Asset ${id}: tone must be a 3x4 matrix of finite numbers on a skin asset`);
      }
      if (explicitOnly !== undefined && typeof explicitOnly !== 'boolean') {
        throw new RenderError('E_CATALOG', `Asset ${id}: explicitOnly must be a boolean`);
      }
      if (raw.rarity !== undefined && (typeof raw.rarity !== 'string' ||
          !RARITIES.includes(raw.rarity.toLowerCase()))) {
        throw new RenderError('E_CATALOG', `Asset ${id}: unknown rarity "${raw.rarity}"`);
      }
      byId.set(id, Object.freeze({
        id,
        slot: raw.slot,
        ...file,
        tone: tone || null,
        skinPaint: loadSkinPaint(root, raw.skinPaint, id),
        explicitOnly: explicitOnly === true,
        tier: asList(raw.tier, 'tier', id, TIERS),
        category: asList(raw.category, 'category', id, CATEGORIES),
        rarity: raw.rarity === undefined ? null : raw.rarity.toLowerCase(),
        requiresEyes: asList(raw.requiresEyes, 'requiresEyes', id, null)
          ? (Array.isArray(raw.requiresEyes) ? raw.requiresEyes : [raw.requiresEyes]) : null,
        file: `catalog/${name}`,
      }));
    }
  }
  for (const asset of byId.values()) {
    for (const eyeId of asset.requiresEyes || []) {
      const eye = byId.get(eyeId);
      if (!eye || eye.slot !== 'eyes') {
        throw new RenderError('E_CATALOG', `Asset ${asset.id}: requiresEyes names unknown eyes asset ${eyeId}`);
      }
    }
  }
  return byId;
}

function matches(asset, tier, category) {
  return (!asset.tier || asset.tier.includes(tier)) && (!asset.category || asset.category.includes(category));
}

/** Implicit candidates that fit the slot, tier and category, sorted by ID. */
function eligible(catalog, slot, tier, category) {
  return [...catalog.values()]
    .filter((asset) => asset.slot === slot && !asset.explicitOnly && matches(asset, tier, category))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

module.exports = { SCHEMA, TIERS, CATEGORIES, RARITIES, SLOTS, RenderError, loadCatalog, matches, eligible };
