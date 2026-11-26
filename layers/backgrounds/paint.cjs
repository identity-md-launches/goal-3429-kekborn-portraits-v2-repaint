'use strict';
/**
 * Kekborn court backdrops: deterministic procedural painter.
 *
 *   node layers/backgrounds/paint.cjs [name ...]
 *
 * Writes layers/backgrounds/<name>.png (2048x2560 straight RGBA8). Every pixel of the
 * frame aperture [144,1904) x [144,2368) is opaque; everything outside it is fully
 * transparent (RGBA 0,0,0,0). No varnish, craquelure or frame shadow is painted here:
 * those belong to the compositor's single shared finishing pass.
 *
 * Same code + same Node version = byte-identical PNGs (seeded from sha256 of the name;
 * no Math.random, no clock).
 */
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const zlib = require('node:zlib');

// Compact straight-RGBA8 PNG writer: per-row adaptive filter (min sum of |residual|),
// zlib level 9. Fully deterministic for a given Node/zlib build; decodes with src/raster.
const CRC = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; return c; });
function crc32(buf) { let c = -1; for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; }
function chunk(type, body) {
  const len = Buffer.alloc(4); len.writeUInt32BE(body.length);
  const tb = Buffer.concat([Buffer.from(type, 'ascii'), body]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(tb));
  return Buffer.concat([len, tb, crc]);
}
function encodePNG({ width, height, data }) {
  const rb = width * 4, raw = Buffer.alloc((rb + 1) * height), cand = [0, 1, 2, 3, 4].map(() => Buffer.alloc(rb));
  let off = 0;
  for (let y = 0; y < height; y++) {
    const s = y * rb; let best = 0, bestSum = Infinity;
    for (let f = 0; f < 5; f++) {
      const c = cand[f]; let sum = 0;
      for (let x = 0; x < rb; x++) {
        const i = s + x, a = x >= 4 ? data[i - 4] : 0, b = y ? data[i - rb] : 0, d = y && x >= 4 ? data[i - rb - 4] : 0;
        let p;
        if (f === 0) p = 0; else if (f === 1) p = a; else if (f === 2) p = b; else if (f === 3) p = (a + b) >> 1;
        else { const pp = a + b - d, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - d); p = pa <= pb && pa <= pc ? a : pb <= pc ? b : d; }
        const v = (data[i] - p) & 255; c[x] = v; sum += v < 128 ? v : 256 - v;
      }
      if (sum < bestSum) { bestSum = sum; best = f; }
    }
    raw[off++] = best; cand[best].copy(raw, off); off += rb;
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9, memLevel: 9, strategy: zlib.constants.Z_DEFAULT_STRATEGY })), chunk('IEND', Buffer.alloc(0))]);
}

const W = 2048, H = 2560;
const AX0 = 144, AY0 = 144, AX1 = 1904, AY1 = 2368; // aperture, x1/y1 exclusive
const AW = AX1 - AX0, AH = AY1 - AY0;
const CELL = 2; // export cell size in master pixels (see step 4 of paintRoom)

// ---- palette (style guide §3) --------------------------------------------------------
const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const P = {
  umber: hex('#32251F'), forest: hex('#253E32'), moss: hex('#657044'), oxblood: hex('#682F38'),
  ochre: hex('#B48A47'), gold: hex('#C9A45A'), bone: hex('#D7C7A3'), night: hex('#14100D'),
  warm: hex('#3A2D25'), deepVert: hex('#17281F'), silverShadow: hex('#5E625F'), oak: hex('#6B4A2B'),
};
const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const scale = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const clamp01 = (t) => (t < 0 ? 0 : t > 1 ? 1 : t);
const smooth = (e0, e1, x) => { const t = clamp01((x - e0) / (e1 - e0)); return t * t * (3 - 2 * t); };

// ---- deterministic randomness ----------------------------------------------------------
function seedFrom(name) { return createHash('sha256').update('kekborn-background:' + name).digest().readUInt32LE(0); }
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function hash2(ix, iy, s) {
  let h = Math.imul(ix, 374761393) ^ Math.imul(iy, 668265263) ^ Math.imul(s, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177); h ^= h >>> 16; return (h >>> 0) / 4294967296;
}
function vnoise(x, y, s) {
  const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
  const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy);
  const a = hash2(ix, iy, s), b = hash2(ix + 1, iy, s), c = hash2(ix, iy + 1, s), d = hash2(ix + 1, iy + 1, s);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
function fbm(x, y, s, oct = 4) { let t = 0, amp = 0.5, f = 1, n = 0; for (let i = 0; i < oct; i++) { t += amp * vnoise(x * f, y * f, s + i * 101); n += amp; amp *= 0.5; f *= 2.03; } return t / n; }

// ---- room underpaintings: f(x, y) -> [r,g,b] (absolute master coordinates) ------------
const ROOMS = {
  'umber-hall': {
    description: 'A dim great hall of lime plaster over umber: mottled, damp-stained plaster in umber and backdrop-warm, a faint ochre wash where the light falls, and a dark timber dado with a worn cap rail low behind the shoulders.',
    dim: 1.0, hatch: [38, -52], accent: P.ochre,
    paint(x, y, s) {
      const big = fbm(x / 340, y / 340, s), mid = fbm(x / 70, y / 70, s + 7, 3);
      let c = mix(P.umber, P.warm, clamp01(big * 1.4 - 0.2));
      c = mix(c, P.ochre, 0.06 * smooth(0.45, 0.8, mid));
      const damp = smooth(0.58, 0.72, fbm(x / 520 + 9, y / 260, s + 3)); c = scale(c, 1 - 0.18 * damp);
      if (y > 2040) { // timber dado
        const grain = fbm(x / 400, y / 14, s + 21, 3);
        let wd = mix(scale(P.oak, 0.55), P.umber, 0.5 + 0.3 * grain);
        if (y < 2076) wd = mix(wd, P.ochre, 0.18 * (1 - (y - 2040) / 36));
        c = mix(c, wd, smooth(2040, 2050, y));
      }
      return c;
    },
  },
  'green-arras': {
    description: 'A worn verdure tapestry (arras) of forest and deep vert hung in heavy vertical folds, with faded millefleur sprigs in moss, ochre and oxblood, threadbare patches showing the warp, and a faded oxblood-and-ochre border along the top.',
    dim: 0.95, hatch: [80, -10], accent: P.moss,
    paint(x, y, s) {
      const ph = x / 135 * Math.PI * 2 + fbm(x / 400, y / 600, s) * 5;
      const fold = 0.82 + 0.22 * Math.sin(ph) + 0.08 * Math.sin(ph * 2.1 + 1.3);
      let c = mix(P.deepVert, P.forest, clamp01(0.35 + 0.6 * fbm(x / 260, y / 260, s + 5)));
      // faded millefleur sprigs on a jittered 130px grid
      const gx = Math.floor(x / 130), gy = Math.floor(y / 130);
      const cx = (gx + 0.25 + 0.5 * hash2(gx, gy, s)) * 130, cy = (gy + 0.25 + 0.5 * hash2(gx, gy, s + 1)) * 130;
      const d = Math.hypot(x - cx, (y - cy) * 1.3);
      if (d < 26) {
        const pick = hash2(gx, gy, s + 2); const fc = pick < 0.45 ? P.moss : pick < 0.8 ? P.ochre : P.oxblood;
        const petals = 0.5 + 0.5 * Math.cos(Math.atan2(y - cy, x - cx) * 5);
        c = mix(c, fc, 0.34 * (1 - d / 26) * (0.4 + 0.6 * petals));
      }
      // weave: fine horizontal weft ribs
      c = scale(c, 0.95 + 0.05 * Math.sin(y * Math.PI * 2 / 7 + vnoise(x / 30, y / 30, s) * 2));
      // threadbare patches
      const worn = smooth(0.6, 0.74, fbm(x / 180, y / 180, s + 11));
      c = mix(c, mix(P.umber, P.bone, 0.18), 0.35 * worn);
      if (y < 290) { // border band
        const b = mix(scale(P.oxblood, 0.75), P.ochre, 0.25 + 0.25 * Math.sin(x / 40));
        c = mix(c, b, 0.7 * (1 - smooth(250, 290, y)));
      }
      return scale(c, fold);
    },
  },
  'oxblood-chamber': {
    description: 'A close privy chamber hung with oxblood wool-velvet damask: a faint ogee pomegranate repeat, vertical panel seams, pile rubbed thin and brownish where it has worn, sinking into umber at the edges.',
    dim: 0.82, hatch: [35, -55], accent: P.oxblood,
    paint(x, y, s) {
      let c = mix(P.umber, P.oxblood, clamp01(0.45 + 0.5 * (fbm(x / 300, y / 300, s) - 0.5) * 2));
      const ogee = Math.sin(x * Math.PI * 2 / 220 + Math.sin(y * Math.PI * 2 / 320) * 1.3) * Math.sin(y * Math.PI * 2 / 320);
      const motif = smooth(0.42, 0.62, Math.abs(ogee));
      c = mix(c, scale(P.oxblood, 1.12), 0.35 * motif);
      const seamX = ((x - AX0) % 440 + 440) % 440; // panel seams
      if (seamX < 10) c = scale(c, 0.72 + 0.03 * seamX); else if (seamX < 18) c = scale(c, 1.06);
      const worn = smooth(0.58, 0.75, fbm(x / 150, y / 220, s + 13));
      c = mix(c, mix(P.umber, P.ochre, 0.25), 0.4 * worn);
      return c;
    },
  },
  'stone-apse': {
    description: 'A chapel apse of cool grey-umber ashlar: a round-headed niche behind the head with radial voussoirs, coursed blocks each a slightly different stone, dark worn mortar joints, and the concave inner wall catching the light on its right side.',
    dim: 0.88, hatch: [30, -60], accent: P.silverShadow,
    paint(x, y, s) {
      const NX = 900, NY = 1100, R = 560, RO = 660;
      const dx = x - NX, dy = y - NY, r = Math.hypot(dx, dy);
      const inNiche = y < NY ? r < R : Math.abs(dx) < R;
      const onArch = y < NY && r >= R && r < RO;
      const stone = mix(P.umber, P.silverShadow, 0.42);
      let c, jointDist, blockId;
      if (onArch) { // voussoirs
        const ang = Math.atan2(dy, dx); const k = Math.floor((ang + Math.PI) / (Math.PI / 13));
        const a0 = -Math.PI + k * Math.PI / 13;
        jointDist = Math.min(Math.abs(ang - a0) * r, Math.abs(ang - a0 - Math.PI / 13) * r, r - R, RO - r);
        blockId = 500 + k; c = scale(stone, 1.05);
      } else {
        const ch = 150, row = Math.floor(y / ch), off = (row % 2) * 130, bw = 260;
        const col = Math.floor((x + off) / bw);
        jointDist = Math.min(y - row * ch, (row + 1) * ch - y, x + off - col * bw, (col + 1) * bw - (x + off));
        blockId = row * 97 + col; c = stone;
      }
      c = scale(c, 0.86 + 0.24 * hash2(blockId, 3, s) + 0.18 * (fbm(x / 90, y / 90, s + 4) - 0.5));
      c = mix(c, P.night, 0.55 * (1 - smooth(2, 11, jointDist)));
      if (inNiche) { // concave: shade toward the left inner wall, lit on the right inner wall
        const t = clamp01((dx + R) / (2 * R));
        c = scale(c, 0.8 + 0.25 * Math.sin(t * Math.PI * 0.9) + 0.06 * t);
      } else if (!onArch && y < NY + 900) {
        c = scale(c, 0.9);
      }
      return c;
    },
  },
  'oak-gallery': {
    description: 'A long gallery wainscoted in dark oak: raised-and-fielded panels framed by stiles and rails, upper-left bevels catching light and lower-right bevels in shadow, long vertical grain in the stiles and panels, and a heavy cornice in shadow along the top.',
    dim: 0.78, hatch: [88, 40], accent: P.oak,
    paint(x, y, s) {
      const base = mix(scale(P.oak, 0.6), P.umber, 0.45);
      const px = ((x - AX0 + 60) % 440 + 440) % 440, py = ((y - 300) % 620 + 620) % 620;
      const stile = 70, rail = 80, bev = 46;
      let c, grainScale;
      if (y < 300) { // cornice
        const band = Math.floor((y - AY0) / 40);
        c = scale(base, 0.7 + 0.12 * (band % 2) + 0.08 * hash2(band, 0, s)); grainScale = [500, 10];
      } else if (px < stile || py < rail) { c = scale(base, 0.95); grainScale = px < stile ? [12, 380] : [380, 12]; }
      else {
        const ix = px - stile, iy = py - rail, iw = 440 - stile, ih = 620 - rail;
        const e = Math.min(ix, iy, iw - ix, ih - iy);
        grainScale = [14, 420];
        if (e < bev) { // bevel: which side?
          const m = Math.min(ix, iy, iw - ix, ih - iy);
          const lit = (m === ix || m === iy) ? 1.28 : 0.62; c = scale(base, lit);
        } else c = scale(base, 1.04);
        if (e < 5) c = scale(c, 0.6);
      }
      const g = fbm(x / grainScale[0], y / grainScale[1], s + 31, 3);
      c = scale(c, 0.82 + 0.36 * g);
      return c;
    },
  },
};

// ---- painting ------------------------------------------------------------------------
const HEAD = [820, 860];          // light pool centre, behind and up-left of the head
const BANNER = [1380, 144, 1880, 1000]; // banner hang zone (upper right): lower contrast

function lightAt(x, y) {
  const d2 = (x - HEAD[0]) ** 2 + ((y - HEAD[1]) * 0.85) ** 2;
  const pool = 0.32 * Math.exp(-d2 / (2 * 430 * 430));
  const grad = 0.12 * (1 - clamp01(((x - AX0) / AW + (y - AY0) / AH) / 2)); // upper-left key
  const e = Math.min(x - AX0, AX1 - 1 - x, y - AY0, AY1 - 1 - y);
  const vig = 0.6 + 0.4 * smooth(0, 280, e);
  return (0.8 + pool + grad) * vig;
}
function bannerWeight(x, y) {
  const [x0, y0, x1, y1] = BANNER, f = 90;
  return smooth(x0 - f, x0 + f, x) * (1 - smooth(x1 - f, x1 + f, x)) * (1 - smooth(y1 - f, y1 + f, y)) * smooth(y0 - 200, y0, y);
}

function boxBlur(src, w, h, r) { // separable box blur on Float32 RGB, 2 passes
  const tmp = new Float32Array(src.length), out = new Float32Array(src.length);
  for (let pass = 0; pass < 2; pass++) {
    const a = pass === 0 ? src : out;
    for (let y = 0; y < h; y++) for (let c = 0; c < 3; c++) {
      let acc = 0; const row = y * w;
      for (let x = -r; x <= r; x++) acc += a[(row + Math.min(w - 1, Math.max(0, x))) * 3 + c];
      for (let x = 0; x < w; x++) {
        tmp[(row + x) * 3 + c] = acc / (2 * r + 1);
        acc += a[(row + Math.min(w - 1, x + r + 1)) * 3 + c] - a[(row + Math.max(0, x - r)) * 3 + c];
      }
    }
    for (let x = 0; x < w; x++) for (let c = 0; c < 3; c++) {
      let acc = 0;
      for (let y = -r; y <= r; y++) acc += tmp[(Math.min(h - 1, Math.max(0, y)) * w + x) * 3 + c];
      for (let y = 0; y < h; y++) {
        out[(y * w + x) * 3 + c] = acc / (2 * r + 1);
        acc += tmp[(Math.min(h - 1, y + r + 1) * w + x) * 3 + c] - tmp[(Math.max(0, y - r) * w + x) * 3 + c];
      }
    }
  }
  return out;
}

function stroke(cv, base, rnd, cx, cy, ang, L, Wd, alpha, tint) {
  const ca = Math.cos(ang), sa = Math.sin(ang);
  const bx = Math.ceil(Math.abs(ca) * L / 2 + Math.abs(sa) * Wd / 2) + 1, by = Math.ceil(Math.abs(sa) * L / 2 + Math.abs(ca) * Wd / 2) + 1;
  const ix = Math.min(AW - 1, Math.max(0, Math.round(cx - AX0))), iy = Math.min(AH - 1, Math.max(0, Math.round(cy - AY0)));
  const bi = (iy * AW + ix) * 3;
  const vj = 1 + (rnd() - 0.5) * 0.3;
  let col = [base[bi] * vj, base[bi + 1] * vj, base[bi + 2] * vj];
  col = mix(col, tint, 0.05 + rnd() * 0.07);
  const nb = Math.max(3, Math.round(Wd / 3));
  const bristle = new Float32Array(nb), shade = new Float32Array(nb), dry = new Float32Array(nb);
  for (let k = 0; k < nb; k++) { bristle[k] = 0.45 + 0.55 * rnd(); shade[k] = 0.8 + 0.4 * rnd(); dry[k] = 0.55 + 0.45 * rnd(); }
  const bend = (rnd() - 0.5) * 0.25; // slight curve
  // impasto: the edge of the stroke facing the upper-left key light is a touch lighter
  const facing = (-sa * -1 + ca * -1) > 0 ? -1 : 1;
  for (let y = Math.max(AY0, Math.floor(cy - by)); y < Math.min(AY1, Math.ceil(cy + by)); y++) {
    for (let x = Math.max(AX0, Math.floor(cx - bx)); x < Math.min(AX1, Math.ceil(cx + bx)); x++) {
      const dx = x - cx, dy = y - cy;
      const u = dx * ca + dy * sa; let v = -dx * sa + dy * ca;
      const un = u / L + 0.5; if (un < 0 || un > 1) continue;
      v -= bend * Wd * (4 * (un - 0.5) * (un - 0.5) - 0.33);
      const vn = v / Wd + 0.5; if (vn < 0 || vn > 1) continue;
      const k = Math.min(nb - 1, Math.floor(vn * nb));
      if (un > dry[k]) continue;
      const taper = smooth(0, 0.12, un) * (1 - smooth(dry[k] - 0.12, dry[k], un)) * smooth(0, 0.18, vn) * (1 - smooth(0.82, 1, vn));
      const a = alpha * taper * bristle[k] * (1 - 0.35 * un);
      if (a <= 0.002) continue;
      const o = ((y - AY0) * AW + (x - AX0)) * 3, sh = shade[k] * (1 + 0.12 * facing * (vn - 0.5));
      cv[o] += (col[0] * sh - cv[o]) * a; cv[o + 1] += (col[1] * sh - cv[o + 1]) * a; cv[o + 2] += (col[2] * sh - cv[o + 2]) * a;
    }
  }
}

function paintRoom(name) {
  const room = ROOMS[name], seed = seedFrom(name), rnd = rng(seed), s = seed & 0xffff;
  // 1. lit underpainting
  const base = new Float32Array(AW * AH * 3);
  for (let y = AY0; y < AY1; y++) for (let x = AX0; x < AX1; x++) {
    const c = room.paint(x, y, s), l = lightAt(x, y) * room.dim, o = ((y - AY0) * AW + (x - AX0)) * 3;
    const vigMix = 1 - smooth(0, 200, Math.min(x - AX0, AX1 - 1 - x, y - AY0, AY1 - 1 - y));
    const cc = mix(scale(c, l), P.night, 0.45 * vigMix);
    base[o] = cc[0]; base[o + 1] = cc[1]; base[o + 2] = cc[2];
  }
  // 2. canvas starts as a softened underpainting, then loose cross-hatched strokes on top
  const cv = boxBlur(base, AW, AH, 10);
  const passes = [
    { n: 2200, L: [90, 170], Wd: [28, 50], a: [0.4, 0.7] },
    { n: 9000, L: [50, 110], Wd: [14, 26], a: [0.4, 0.75] },
    { n: 14000, L: [22, 48], Wd: [6, 12], a: [0.35, 0.7] },
  ];
  for (const p of passes) for (let i = 0; i < p.n; i++) {
    let cx = AX0 + rnd() * AW, cy = AY0 + rnd() * AH;
    if (p === passes[2] && rnd() < 0.5) { // small strokes gather in the light pool
      cx = HEAD[0] + (rnd() + rnd() + rnd() - 1.5) * 700; cy = HEAD[1] + (rnd() + rnd() + rnd() - 1.5) * 700;
    }
    const fam = room.hatch[rnd() < 0.55 ? 0 : 1];
    const ang = (fam + (rnd() - 0.5) * 24) * Math.PI / 180;
    stroke(cv, base, rnd, cx, cy, ang, p.L[0] + rnd() * (p.L[1] - p.L[0]), p.Wd[0] + rnd() * (p.Wd[1] - p.Wd[0]), p.a[0] + rnd() * (p.a[1] - p.a[0]), room.accent);
  }
  // 3. lower contrast behind the banner: pull towards the local mean
  const mean = boxBlur(cv, AW, AH, 40);
  for (let y = AY0; y < AY1; y++) for (let x = AX0; x < AX1; x++) {
    const w = 0.5 * bannerWeight(x, y); if (w <= 0) continue;
    const o = ((y - AY0) * AW + (x - AX0)) * 3;
    for (let c = 0; c < 3; c++) cv[o + c] = mean[o + c] + (cv[o + c] - mean[o + c]) * (1 - w);
  }
  // 4. export: opaque aperture, clear outside. Paint is laid down in 2x2 "canvas cells"
  // (box mean of the cell, replicated) so the layer stays well under the size budget; the
  // compositor's full-resolution varnish/craquelure pass supplies the fine grain on top.
  const data = Buffer.alloc(W * H * 4);
  for (let y = AY0; y < AY1; y += CELL) for (let x = AX0; x < AX1; x += CELL) {
    const ny = Math.min(CELL, AY1 - y), nx = Math.min(CELL, AX1 - x);
    for (let c = 0; c < 3; c++) {
      let sum = 0;
      for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) sum += cv[((y + j - AY0) * AW + (x + i - AX0)) * 3 + c];
      const v = Math.max(0, Math.min(255, Math.round(sum / (nx * ny))));
      for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) data[((y + j) * W + x + i) * 4 + c] = v;
    }
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) data[((y + j) * W + x + i) * 4 + 3] = 255;
  }
  return encodePNG({ width: W, height: H, data });
}

module.exports = { ROOMS, paintRoom, APERTURE: { x0: AX0, y0: AY0, x1: AX1, y1: AY1 } };

if (require.main === module) {
  const names = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(ROOMS);
  for (const n of names) {
    if (!ROOMS[n]) throw new Error('unknown room ' + n);
    const png = paintRoom(n);
    fs.writeFileSync(path.join(__dirname, n + '.png'), png);
    console.log(n, png.length, createHash('sha256').update(png).digest('hex'));
  }
}
