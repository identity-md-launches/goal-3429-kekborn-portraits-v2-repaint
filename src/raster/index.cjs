'use strict';

const { createHash } = require('node:crypto');
const { decodePNG, encodePNG, pixelBytes, validateImage } = require('./png.cjs');

const MASTER_WIDTH = 2048;
const MASTER_HEIGHT = 2560;
const FRAME_APERTURE = Object.freeze({ x: 144, y: 144, width: 1760, height: 2224 });

// Finish strengths are display-space amounts, except craquelure (mask bytes).
const GLAZE_STRENGTH = 0.16;
const GLAZE_TINT = Object.freeze([180, 120, 64]);
const BRUSH_STRENGTH = 0.03;
const CANVAS_WEAVE_WEIGHT = 0.30;
const STROKE_RELIEF_WEIGHT = 0.70;
const VARNISH_STRENGTH = 0.06;
const VARNISH_HIGHLIGHT_STRENGTH = 0.01;
const VARNISH_TINT = Object.freeze([224, 184, 112]);
const CRAQUELURE_STRENGTH = 24;
const CRAQUELURE_TINT = Object.freeze([42, 30, 23]);
const FRAME_SHADOW_STRENGTH = 0.23;
const FRAME_SHADOW_FADE = 44; // master pixels
const FINISH_STAGES = Object.freeze(['glaze', 'brush', 'varnish', 'craquelure', 'frameShadow']);

/**
 * Raster = { width, height, data: Uint8Array }. Buffer is also accepted.
 * Pixels are tightly packed, straight (unpremultiplied) RGBA8 in row-major order.
 * Origin is top left, x increases rightward and y increases downward. RGB math
 * uses the stored display values directly. Export layers in a common sRGB space.
 *
 * All calls are synchronous:
 * createImage(width = 2048, height = 2560) -> zero-filled Raster
 * decodePNG(bytes: Uint8Array, target?: Uint8Array) -> Raster
 * composite(destination: Raster, source: Raster, rect?) -> destination
 * finish(image: Raster, seed: Uint8Array, stages?: object) -> image
 * encodePNG(image: Raster) -> Buffer
 *
 * Composite mutates destination. Call in back-to-front order and release each
 * decoded source after use. For equal-size layers, pass an optional scratch
 * target to decodePNG with exactly width * height * 4 bytes. It becomes the
 * returned raster's data and can be reused after compositing. Destination,
 * decode target and PNG input must have disjoint storage when used together.
 * rect = { x, y, width, height } in integer destination pixels, right/bottom
 * exclusive. It defaults to the source's natural size at (0,0). Placement clips
 * to the canvas and uses center-aligned, alpha-weighted bilinear interpolation.
 *
 * Call finish exactly once after the last layer, then encode. Finish mutates RGB
 * in place and preserves alpha. In order: warm shadow glaze, seeded canvas weave
 * and brush relief, #E0B870 varnish, fine #2A1E17 craquelure, top/left rail shadow.
 * Optional boolean stage switches allow comparisons; all default to true.
 * Fully transparent pixels retain their hidden RGB samples as well.
 * The aperture scales proportionally on non-master rasters used for previews.
 * PNG decoding preserves RGB samples without applying embedded color profiles.
 * Encoding writes RGBA8 with no ancillary chunks or time-dependent metadata.
 */
function createImage(width = MASTER_WIDTH, height = MASTER_HEIGHT) {
  return { width, height, data: Buffer.alloc(pixelBytes(width, height)) };
}

// Inputs can be fractional when sampling a resized layer. Round only on write.
function over(data, offset, red, green, blue, alpha) {
  if (alpha === 0) return;
  const under = data[offset + 3] * (1 - alpha / 255);
  const combined = alpha + under;
  if (under === 0) {
    data[offset] = Math.round(red);
    data[offset + 1] = Math.round(green);
    data[offset + 2] = Math.round(blue);
  } else {
    data[offset] = Math.round((red * alpha + data[offset] * under) / combined);
    data[offset + 1] = Math.round((green * alpha + data[offset + 1] * under) / combined);
    data[offset + 2] = Math.round((blue * alpha + data[offset + 2] * under) / combined);
  }
  data[offset + 3] = Math.round(combined);
}

function samplingAxis(start, end, origin, extent, sourceSize) {
  return Array.from({ length: end - start }, (_, i) => {
    const center = (start + i - origin + 0.5) * sourceSize / extent - 0.5;
    const position = Math.max(0, Math.min(sourceSize - 1, center));
    const first = Math.floor(position);
    return [first, Math.min(first + 1, sourceSize - 1), position - first];
  });
}

function blendScaled(destination, source, bounds, rect) {
  const { left, top, right, bottom } = bounds;
  const columns = samplingAxis(left, right, rect.x, rect.width, source.width);
  const rows = samplingAxis(top, bottom, rect.y, rect.height, source.height);
  const pixels = source.data;
  for (let y = top; y < bottom; y++) {
    const [y0, y1, v] = rows[y - top];
    let dest = (y * destination.width + left) * 4;
    for (const [x0, x1, u] of columns) {
      const a = (y0 * source.width + x0) * 4;
      const b = (y0 * source.width + x1) * 4;
      const c = (y1 * source.width + x0) * 4;
      const d = (y1 * source.width + x1) * 4;
      const wa = (1 - u) * (1 - v) * pixels[a + 3];
      const wb = u * (1 - v) * pixels[b + 3];
      const wc = (1 - u) * v * pixels[c + 3];
      const wd = u * v * pixels[d + 3];
      const alpha = wa + wb + wc + wd;
      if (alpha > 0 && (alpha >= 0.5 || destination.data[dest + 3] > 0)) {
        const red = (wa * pixels[a] + wb * pixels[b] + wc * pixels[c] + wd * pixels[d]) / alpha;
        const green = (wa * pixels[a + 1] + wb * pixels[b + 1] +
          wc * pixels[c + 1] + wd * pixels[d + 1]) / alpha;
        const blue = (wa * pixels[a + 2] + wb * pixels[b + 2] +
          wc * pixels[c + 2] + wd * pixels[d + 2]) / alpha;
        over(destination.data, dest, red, green, blue, alpha);
      }
      dest += 4;
    }
  }
}

function composite(destination, source, rect = { x: 0, y: 0, width: source.width, height: source.height }) {
  validateImage(destination);
  validateImage(source);
  const { x, y, width, height } = rect;
  if (![x, y, width, height, x + width, y + height].every(Number.isSafeInteger) ||
      width < 1 || height < 1) throw new RangeError('Expected an integer placement rectangle');
  const left = Math.max(0, x);
  const top = Math.max(0, y);
  const right = Math.min(destination.width, x + width);
  const bottom = Math.min(destination.height, y + height);
  if (left >= right || top >= bottom) return destination;

  const dest = destination.data;
  const pixels = source.data;
  if (dest.buffer === pixels.buffer &&
      dest.byteOffset < pixels.byteOffset + pixels.byteLength &&
      pixels.byteOffset < dest.byteOffset + dest.byteLength) {
    throw new TypeError('Source and destination storage must be disjoint');
  }

  if (width === source.width && height === source.height) {
    for (let row = top; row < bottom; row++) {
      let from = ((row - y) * width + left - x) * 4;
      let to = (row * destination.width + left) * 4;
      for (let col = left; col < right; col++, from += 4, to += 4) {
        over(dest, to, pixels[from], pixels[from + 1], pixels[from + 2], pixels[from + 3]);
      }
    }
  } else {
    blendScaled(destination, source, { left, top, right, bottom }, rect);
  }
  return destination;
}

function seededRandom(seed, domain = 'kekborn/craquelure/v1\0') {
  const digest = createHash('sha256').update(domain).update(seed).digest();
  let state = digest.readUInt32LE(0);
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), state | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 0x100000000;
  };
}

// Stamp a fine, antialiased line into a one-byte-per-pixel mask. Max coverage
// keeps intersections from becoming darker than the surrounding cracks.
function trace(mask, width, height, x0, y0, x1, y1, strength) {
  const steps = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) * 2));
  for (let i = 0; i <= steps; i++) {
    const x = x0 + (x1 - x0) * i / steps;
    const y = y0 + (y1 - y0) * i / steps;
    for (let row = Math.max(0, Math.floor(y)); row <= Math.min(height - 1, Math.ceil(y)); row++) {
      for (let col = Math.max(0, Math.floor(x)); col <= Math.min(width - 1, Math.ceil(x)); col++) {
        const weight = Math.max(0, 1 - Math.hypot(x - col, y - row) / 0.9);
        const index = row * width + col;
        mask[index] = Math.max(mask[index], Math.round(strength * weight));
      }
    }
  }
}

function crackMask(width, height, seed) {
  const random = seededRandom(seed);
  const spacing = Math.max(8, Math.round(Math.min(width, height) / 38));
  const columns = Math.ceil(width / spacing) + 2;
  const rows = Math.ceil(height / spacing) + 2;
  const nodes = Array.from({ length: rows }, (_, row) =>
    Array.from({ length: columns }, (_, col) => ({
      x: (col - 0.5 + (random() - 0.5) * 0.82) * spacing,
      y: (row - 0.5 + (random() - 0.5) * 0.82) * spacing,
    })));
  const mask = new Uint8Array(width * height);
  function link(start, end) {
    const middleX = (start.x + end.x) / 2 + (random() - 0.5) * spacing * 0.27;
    const middleY = (start.y + end.y) / 2 + (random() - 0.5) * spacing * 0.27;
    const strength = 10 + random() * (CRAQUELURE_STRENGTH - 10);
    trace(mask, width, height, start.x, start.y, middleX, middleY, strength);
    trace(mask, width, height, middleX, middleY, end.x, end.y, strength);
  }
  for (let row = 0; row < rows - 1; row++) {
    for (let col = 0; col < columns - 1; col++) {
      const start = nodes[row][col];
      if (random() < 0.76) link(start, nodes[row][col + 1]);
      if (random() < 0.76) link(start, nodes[row + 1][col]);
      if (random() < 0.21) link(start, nodes[row + 1][col + 1]);
    }
  }
  return mask;
}

// A small seeded height field gives elongated, slanted stroke relief. Its
// directional derivative lights the slopes facing the upper-left key. This is
// surface texture only: the painted forms and their brushwork come from layers.
function brushTexture(width, height, seed) {
  const random = seededRandom(seed, 'kekborn/brush/v1\0');
  const strokeWidth = 18;
  const strokeLength = 72;
  const slant = 0.28;
  const columns = Math.ceil((MASTER_WIDTH + slant * MASTER_HEIGHT) / strokeWidth) + 3;
  const rows = Math.ceil(MASTER_HEIGHT / strokeLength) + 3;
  const heights = Float32Array.from({ length: columns * rows }, () => random() * 2 - 1);
  const phaseX = random() * Math.PI * 2;
  const phaseY = random() * Math.PI * 2;
  const scaleX = width / MASTER_WIDTH;
  const scaleY = height / MASTER_HEIGHT;
  // Fade out undersampled weave and relief instead of making preview moire.
  const resolved = (period, scale) => Math.max(0, Math.min(1, (period * scale - 2) / 2));
  const warpFade = resolved(6, scaleX);
  const weftFade = resolved(7, scaleY);
  const reliefFade = resolved(strokeWidth / (1 + slant), Math.min(scaleX, scaleY));
  const warp = Float32Array.from({ length: width }, (_, x) =>
    Math.sin((x + 0.5) / scaleX * Math.PI * 2 / 6 + phaseX) * warpFade);
  const weft = Float32Array.from({ length: height }, (_, y) =>
    Math.sin((y + 0.5) / scaleY * Math.PI * 2 / 7 + phaseY) * weftFade);
  const slopeX = (1 + slant) / strokeWidth;
  const slopeY = 1 / strokeLength;
  // Cubic interpolation's slope is bounded by 3 for heights in [-1,1].
  const normalise = 3 * (slopeX + slopeY);
  return (x, y, masterX, masterY) => {
    const u = (masterX + slant * masterY) / strokeWidth + 1;
    const v = masterY / strokeLength + 1;
    const col = Math.floor(u);
    const row = Math.floor(v);
    const tx = u - col;
    const ty = v - row;
    const sx = tx * tx * (3 - 2 * tx);
    const sy = ty * ty * (3 - 2 * ty);
    const i = row * columns + col;
    const a = heights[i];
    const b = heights[i + 1];
    const c = heights[i + columns];
    const d = heights[i + columns + 1];
    const du = ((b - a) * (1 - sy) + (d - c) * sy) * 6 * tx * (1 - tx);
    const dv = ((c - a) * (1 - sx) + (d - b) * sx) * 6 * ty * (1 - ty);
    const relief = (du * slopeX + dv * slopeY) / normalise * reliefFade;
    const weave = (warp[x] + weft[y]) / 2;
    return CANVAS_WEAVE_WEIGHT * weave + STROKE_RELIEF_WEIGHT * relief;
  };
}

function finish(image, seed, stages = {}) {
  validateImage(image);
  if (!(seed instanceof Uint8Array) || seed.length === 0) {
    throw new TypeError('Expected nonempty seed bytes');
  }
  if (!stages || typeof stages !== 'object' || Array.isArray(stages) ||
      Object.keys(stages).some(key => !FINISH_STAGES.includes(key) || typeof stages[key] !== 'boolean')) {
    throw new TypeError('Expected boolean finish stage switches');
  }
  const enabled = Object.fromEntries(FINISH_STAGES.map(key => [key, stages[key] !== false]));
  const { width, height, data } = image;
  const cracks = enabled.craquelure ? crackMask(width, height, seed) : null;
  const brush = enabled.brush ? brushTexture(width, height, seed) : null;
  const scaleX = width / MASTER_WIDTH;
  const scaleY = height / MASTER_HEIGHT;
  const { x: left, y: top, width: apertureWidth, height: apertureHeight } = FRAME_APERTURE;
  const right = left + apertureWidth;
  const bottom = top + apertureHeight;
  for (let y = 0; y < height; y++) {
    const masterY = (y + 0.5) / scaleY;
    for (let x = 0; x < width; x++) {
      const pixel = y * width + x;
      const i = pixel * 4;
      if (!data[i + 3]) continue;
      const masterX = (x + 0.5) / scaleX;
      // The rails cast inward only from the top and left. Right/bottom bounds
      // clip the shadow to the opening; they do not cast another shadow.
      const inside = masterX >= left && masterX < right && masterY >= top && masterY < bottom;
      const distance = Math.min(masterX - left, masterY - top);
      let shadow = 1;
      if (enabled.frameShadow && inside && distance < FRAME_SHADOW_FADE) {
        const t = 1 - distance / FRAME_SHADOW_FADE;
        shadow -= FRAME_SHADOW_STRENGTH * t * t * (3 - 2 * t);
      }
      // Display-space luminance of the pristine paint, independent of coverage.
      const luminance = (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / 255;
      const darkWeight = (1 - luminance) ** 2;
      // 1. A transparent ochre/umber multiply deepens and warms shadow paint.
      const glaze = enabled.glaze ? GLAZE_STRENGTH * darkWeight : 0;
      let red = data[i] * (1 - glaze + glaze * GLAZE_TINT[0] / 255);
      let green = data[i + 1] * (1 - glaze + glaze * GLAZE_TINT[1] / 255);
      let blue = data[i + 2] * (1 - glaze + glaze * GLAZE_TINT[2] / 255);
      // 2. Neutral lightness relief, bounded by +/-3%, protects black and white.
      const texture = 1 + (brush ? BRUSH_STRENGTH * brush(x, y, masterX, masterY) *
        4 * luminance * (1 - luminance) : 0);
      red *= texture;
      green *= texture;
      blue *= texture;
      // 3. Warm varnish yellows highlights without an additive amber wash.
      const varnish = enabled.varnish ? VARNISH_STRENGTH + VARNISH_HIGHLIGHT_STRENGTH * luminance ** 2 : 0;
      red *= 1 - varnish + varnish * VARNISH_TINT[0] / 255;
      green *= 1 - varnish + varnish * VARNISH_TINT[1] / 255;
      blue *= 1 - varnish + varnish * VARNISH_TINT[2] / 255;
      // 4. Fine warm cracks; crossings use maximum coverage, never extra ink.
      const crack = cracks ? cracks[pixel] / 255 * darkWeight : 0;
      red += (CRAQUELURE_TINT[0] - red) * crack;
      green += (CRAQUELURE_TINT[1] - green) * crack;
      blue += (CRAQUELURE_TINT[2] - blue) * crack;
      // 5. The frame shadow sits over the finished surface. Round only here.
      data[i] = Math.max(0, Math.min(255, Math.round(red * shadow)));
      data[i + 1] = Math.max(0, Math.min(255, Math.round(green * shadow)));
      data[i + 2] = Math.max(0, Math.min(255, Math.round(blue * shadow)));
    }
  }
  return image;
}

module.exports = {
  MASTER_WIDTH, MASTER_HEIGHT, FRAME_APERTURE,
  GLAZE_STRENGTH, GLAZE_TINT, BRUSH_STRENGTH, CANVAS_WEAVE_WEIGHT, STROKE_RELIEF_WEIGHT,
  VARNISH_STRENGTH, VARNISH_HIGHLIGHT_STRENGTH, VARNISH_TINT,
  CRAQUELURE_STRENGTH, CRAQUELURE_TINT, FRAME_SHADOW_STRENGTH, FRAME_SHADOW_FADE,
  createImage, decodePNG, composite, finish, encodePNG,
};
