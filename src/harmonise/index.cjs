'use strict';

const {
  MASTER_WIDTH, MASTER_HEIGHT, FRAME_APERTURE, decodePNG, encodePNG,
} = require('../raster/index.cjs');

const STRENGTH = 0.22;
const MAX_STRENGTH = 0.30;
const SEED = 1536;
const FEATHER_PIXELS = 64;

if (!Number.isFinite(STRENGTH) || STRENGTH <= 0 || STRENGTH > MAX_STRENGTH) {
  throw new RangeError(`Harmonisation strength must be above zero and at most ${MAX_STRENGTH}`);
}

function promptSection(guide, heading) {
  const section = guide.match(new RegExp(
    `^## ${heading}[ \\t]*\\r?\\n([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, 'm',
  ));
  const prompt = section?.[1].trim().split(/\r?\n[ \t]*\r?\n/, 1)[0];
  if (!prompt) throw new Error(`Missing ${heading} text in style-guide.md`);
  return prompt;
}

function decodeMaster(bytes, label) {
  let image;
  try {
    image = decodePNG(bytes);
  } catch (error) {
    throw new Error(`${label} could not be decoded: ${error.message}`, { cause: error });
  }
  if (image.width !== MASTER_WIDTH || image.height !== MASTER_HEIGHT) {
    throw new Error(`${label} must be ${MASTER_WIDTH}x${MASTER_HEIGHT}`);
  }
  return image;
}

function createRequest(input, plainBytes, guide) {
  decodeMaster(plainBytes, 'Plain PNG');
  return {
    input,
    width: MASTER_WIDTH,
    height: MASTER_HEIGHT,
    prompt: promptSection(guide, 'Locked prompt'),
    negativePrompt: promptSection(guide, 'Negative prompt'),
    strength: STRENGTH,
    seed: SEED,
    aperture: { ...FRAME_APERTURE },
  };
}

function applyHarmonisation(plainBytes, modelBytes) {
  const plain = decodeMaster(plainBytes, 'Plain PNG');
  const model = decodeMaster(modelBytes, 'Model PNG');
  const { x: left, y: top, width, height } = FRAME_APERTURE;
  const right = left + width - 1;
  const bottom = top + height - 1;

  for (let y = top + 1; y < bottom; y++) {
    for (let x = left + 1; x < right; x++) {
      const offset = (y * plain.width + x) * 4;
      if (!plain.data[offset + 3] || !model.data[offset + 3]) continue;

      const distance = Math.min(x - left, right - x, y - top, bottom - y);
      const t = Math.min(distance / FEATHER_PIXELS, 1);
      const feather = t * t * (3 - 2 * t);
      const weight = STRENGTH * feather * (model.data[offset + 3] / 255);
      for (let channel = offset; channel < offset + 3; channel++) {
        const original = plain.data[channel];
        plain.data[channel] = Math.round(original + weight * (model.data[channel] - original));
      }
    }
  }
  return encodePNG(plain);
}

module.exports = { createRequest, applyHarmonisation };
