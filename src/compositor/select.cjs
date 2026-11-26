'use strict';

const { createHash } = require('node:crypto');
const { TIERS, CATEGORIES, RenderError, eligible, matches } = require('./catalog.cjs');

// Relative draw weights by rarity. Records without a rarity weigh as common.
const WEIGHTS = Object.freeze({ common: 8, uncommon: 4, rare: 2, epic: 1, legendary: 1 });

/** seed = SHA-256(UTF-8 wallet || UTF-8 artSeed), strings exactly as supplied. */
function computeSeed(wallet, artSeed) {
  return createHash('sha256').update(Buffer.from(wallet, 'utf8')).update(Buffer.from(artSeed, 'utf8')).digest();
}

/**
 * Stable labelled draw: u = first 8 bytes of SHA-256("kekborn/draw/v1\0" ||
 * label || "\0" || seed) as an unsigned big-endian integer; the result is the
 * candidate whose cumulative weight interval contains u mod totalWeight.
 * Candidates arrive sorted by ID, so adding a draw elsewhere never changes
 * this one.
 */
function draw(seed, label, candidates) {
  if (!candidates.length) return null;
  const digest = createHash('sha256').update('kekborn/draw/v1\0').update(label).update('\0').update(seed).digest();
  const weights = candidates.map((asset) => WEIGHTS[asset.rarity || 'common']);
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  let point = Number(digest.readBigUInt64BE(0) % BigInt(total));
  for (let i = 0; i < candidates.length; i++) {
    if (point < weights[i]) return candidates[i];
    point -= weights[i];
  }
  throw new Error('unreachable');
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Validate and normalise {wallet,tier,genetics,traits,artSeed}. */
function validateInput(input) {
  if (!isObject(input)) throw new RenderError('E_INPUT', 'Input must be a JSON object');
  if (typeof input.wallet !== 'string' || !input.wallet.length) {
    throw new RenderError('E_INPUT', 'wallet must be a nonempty string');
  }
  if (typeof input.artSeed !== 'string') throw new RenderError('E_INPUT', 'artSeed must be a string');
  if (typeof input.tier !== 'string' || !TIERS.includes(input.tier.toLowerCase())) {
    throw new RenderError('E_INPUT', `tier must be one of ${TIERS.join(', ')}`);
  }
  const genetics = input.genetics === undefined ? {} : input.genetics;
  const traits = input.traits;
  if (!isObject(genetics)) throw new RenderError('E_INPUT', 'genetics must be an object');
  if (!isObject(traits)) throw new RenderError('E_INPUT', 'traits must be an object with a category');
  if (typeof traits.category !== 'string' || !CATEGORIES.includes(traits.category.toLowerCase())) {
    throw new RenderError('E_INPUT', `traits.category must be one of ${CATEGORIES.join(', ')}`);
  }
  const selectors = {};
  for (const [owner, key, slot] of SELECTORS) {
    const value = (owner === 'genetics' ? genetics : traits)[key];
    if (value === undefined || value === null) continue;
    if (typeof value !== 'string' || !value.length) {
      throw new RenderError('E_INPUT', `${owner}.${key} must be a full asset ID string`);
    }
    selectors[slot] = { id: value, field: `${owner}.${key}` };
  }
  return {
    tier: input.tier.toLowerCase(),
    category: traits.category.toLowerCase(),
    selectors,
  };
}

const SELECTORS = Object.freeze([
  ['genetics', 'skin', 'skin'],
  ['genetics', 'eyes', 'eyes'],
  ['traits', 'expression', 'expression'],
  ['traits', 'background', 'background'],
  ['traits', 'banner', 'banner'],
]);

function explicit(catalog, selector, slot, tier, category) {
  const asset = catalog.get(selector.id);
  if (!asset) throw new RenderError('E_UNKNOWN_ID', `${selector.field}: unknown asset ID "${selector.id}"`);
  if (asset.slot !== slot) {
    throw new RenderError('E_SELECTOR', `${selector.field}: "${selector.id}" is a ${asset.slot} asset, not ${slot}`);
  }
  if (!matches(asset, tier, category)) {
    throw new RenderError('E_SELECTOR', `${selector.field}: "${selector.id}" is not available for tier ${tier} / category ${category}`);
  }
  return asset;
}

/**
 * Resolve the catalog part of the stack. Returns an ordered list of
 * { group, asset, source } plus marker entries { group: "banner-arms" } and
 * { group: "rail-arms" } where the procedural arms go.
 */
function selectLayers(catalog, seed, normal) {
  const { tier, category, selectors } = normal;
  const stack = [];
  const one = (slot, required) => {
    const selector = selectors[slot];
    if (selector) return { asset: explicit(catalog, selector, slot, tier, category), source: 'explicit' };
    const asset = draw(seed, slot, eligible(catalog, slot, tier, category));
    if (!asset && required) {
      throw new RenderError('E_MISSING_ASSET', `No ${slot} asset available for tier ${tier} / category ${category}`);
    }
    return asset ? { asset, source: 'draw' } : null;
  };
  const push = (group, choice) => { if (choice) stack.push({ group, ...choice }); };
  const all = (slot) => {
    for (const asset of eligible(catalog, slot, tier, category)) stack.push({ group: slot, asset, source: 'match' });
  };

  push('background', one('background', true));
  push('banner', one('banner', true));
  stack.push({ group: 'banner-arms' });
  all('prop-rear');
  all('attire-back');
  push('skin', one('skin', true));

  // Expression is resolved before eyes so that requiresEyes can constrain them.
  const eyeSel = selectors.eyes ? explicit(catalog, selectors.eyes, 'eyes', tier, category) : null;
  let expression;
  if (selectors.expression) {
    expression = { asset: explicit(catalog, selectors.expression, 'expression', tier, category), source: 'explicit' };
    const need = expression.asset.requiresEyes;
    if (need && eyeSel && !need.includes(eyeSel.id)) {
      throw new RenderError('E_INCOMPATIBLE', `traits.expression "${expression.asset.id}" requires eyes ` +
        `${need.join(' or ')}, but genetics.eyes is "${eyeSel.id}"`);
    }
  } else {
    const candidates = eligible(catalog, 'expression', tier, category)
      .filter((asset) => !asset.requiresEyes || !eyeSel || asset.requiresEyes.includes(eyeSel.id));
    const asset = draw(seed, 'expression', candidates);
    if (!asset) throw new RenderError('E_MISSING_ASSET', `No expression asset available for tier ${tier} / category ${category}`);
    expression = { asset, source: 'draw' };
  }
  let eyes;
  if (eyeSel) {
    eyes = { asset: eyeSel, source: 'explicit' };
  } else {
    const need = expression.asset.requiresEyes;
    const candidates = eligible(catalog, 'eyes', tier, category).filter((asset) => !need || need.includes(asset.id));
    const asset = draw(seed, 'eyes', candidates);
    if (!asset) {
      throw new RenderError(need ? 'E_INCOMPATIBLE' : 'E_MISSING_ASSET', need
        ? `Expression ${expression.asset.id} requires eyes ${need.join(' or ')}, none available for tier ${tier} / category ${category}`
        : `No eyes asset available for tier ${tier} / category ${category}`);
    }
    eyes = { asset, source: need ? 'draw:requiresEyes' : 'draw' };
  }
  push('eyes', eyes);
  push('expression', expression);

  all('attire-front');
  all('accessory');
  push('headwear', one('headwear', false));
  push('regalia', one('regalia', false));
  all('prop-front');
  push('frame', one('frame', true));
  stack.push({ group: 'rail-arms' });
  return stack;
}

module.exports = { WEIGHTS, SELECTORS, computeSeed, draw, validateInput, selectLayers };
