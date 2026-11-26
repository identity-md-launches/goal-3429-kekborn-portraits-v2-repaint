'use strict';

const { createHash } = require('node:crypto');
const { decodePNG, encodePNG, pixelBytes, validateImage } = require('./png.cjs');

const MASTER_WIDTH = 2048;
const MASTER_HEIGHT = 2560;
const FRAME_APERTURE = Object.freeze({ x: 144, y: 144, width: 1760, height: 2224 });

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
 * finish(image: Raster, seed: Uint8Array) -> image
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
 * in place, preserves alpha, and uses the supplied seed bytes for crack geometry.
 * It multiplies a restrained #E0B870 varnish, blends fine #2A1E17 cracks with
 * visibility weighted toward dark paint, then casts the top/left rail shadow
 * inward. Fully transparent pixels retain their hidden RGB samples as well.
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

function seededRandom(seed) {
  const digest = createHash('sha256').update('kekborn/craquelure/v1\0').update(seed).digest();
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
    const strength = 10 + random() * 14;
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

function finish(image, seed) {
  validateImage(image);
  if (!(seed instanceof Uint8Array) || seed.length === 0) {
    throw new TypeError('Expected nonempty seed bytes');
  }
  const { width, height, data } = image;
  const cracks = crackMask(width, height, seed);
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
      if (inside && distance < 44) {
        const t = 1 - distance / 44;
        shadow -= 0.23 * t * t * (3 - 2 * t);
      }
      // Display-space luminance of the pristine paint, independent of coverage.
      // A little extra multiply in highlights gives the varnish its yellowing
      // without an additive wash lifting the darks or erasing brushwork.
      const luminance = (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / 255;
      const varnish = 0.06 + 0.01 * luminance * luminance;
      const crack = cracks[pixel] / 255 * (1 - luminance) ** 2;
      const red = data[i] * (1 - varnish + varnish * 224 / 255);
      const green = data[i + 1] * (1 - varnish + varnish * 184 / 255);
      const blue = data[i + 2] * (1 - varnish + varnish * 112 / 255);
      data[i] = Math.round((red + (42 - red) * crack) * shadow);
      data[i + 1] = Math.round((green + (30 - green) * crack) * shadow);
      data[i + 2] = Math.round((blue + (23 - blue) * crack) * shadow);
    }
  }
  return image;
}

module.exports = { MASTER_WIDTH, MASTER_HEIGHT, FRAME_APERTURE, createImage, decodePNG, composite, finish, encodePNG };
