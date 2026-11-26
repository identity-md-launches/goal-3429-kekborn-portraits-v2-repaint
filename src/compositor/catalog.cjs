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

/**
 * Load every root/catalog/*.json (sorted by file name). Each file must be
 * { schema: "kekborn-assets@1", assets: [{ id, slot, path, tier?, category?,
 * rarity?, requiresEyes? }] }. IDs are unique across all files. Paths are
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
      const rel = raw.path.replace(/\\/g, '/');
      const abs = path.resolve(root, rel);
      if (path.isAbsolute(rel) || !abs.startsWith(path.resolve(root) + path.sep)) {
        throw new RenderError('E_CATALOG', `Asset ${id}: path must stay inside the repository`);
      }
      if (raw.rarity !== undefined && (typeof raw.rarity !== 'string' ||
          !RARITIES.includes(raw.rarity.toLowerCase()))) {
        throw new RenderError('E_CATALOG', `Asset ${id}: unknown rarity "${raw.rarity}"`);
      }
      byId.set(id, Object.freeze({
        id,
        slot: raw.slot,
        path: rel,
        absPath: abs,
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

/** Assets of a slot that fit the tier and category, sorted by ID (code-unit order). */
function eligible(catalog, slot, tier, category) {
  return [...catalog.values()]
    .filter((asset) => asset.slot === slot && matches(asset, tier, category))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

module.exports = { SCHEMA, TIERS, CATEGORIES, RARITIES, SLOTS, RenderError, loadCatalog, matches, eligible };
