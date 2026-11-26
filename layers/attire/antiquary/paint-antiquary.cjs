'use strict';
// Deterministic painter for the Kekborn antiquary court ensemble.
// Usage (from the repository root): node layers/attire/antiquary/paint-antiquary.cjs
// Writes the three layer PNGs beside this file and catalog/attire-antiquary.json.
// Registration: template/bust.svg (2048x2560). Fit reference: layers/skins/moss.png.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const R = require('../../../src/raster/index.cjs');

const ROOT = path.resolve(__dirname, '../../..');
const W = 2048, H = 2560, N = W * H;
const AP = { x0: 144, y0: 144, x1: 1904, y1: 2368 }; // frame aperture, x1/y1 exclusive
const CROP_Y1 = 2354;                                  // 4:5 crop bottom with margin

// ---------- palette (style-guide §3) ----------
const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const P = {
  umber: hex('#32251F'), forest: hex('#253E32'), moss: hex('#657044'), oxblood: hex('#682F38'),
  ochre: hex('#B48A47'), gold: hex('#C9A45A'), bone: hex('#D7C7A3'), night: hex('#14100D'),
  backWarm: hex('#3A2D25'), deepVert: hex('#17281F'),
};
const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
function ramp(stops, v) {
  v = Math.max(0, Math.min(0.9999, v)) * (stops.length - 1);
  const i = Math.floor(v);
  return mix(stops[i], stops[i + 1], v - i);
}

// ---------- seeded randomness ----------
function rng(label) {
  const h = createHash('sha256').update('kekborn-antiquary:' + label).digest();
  let s = h.readUInt32LE(0);
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function valueNoise(label, cell) {
  const r = rng('noise:' + label);
  const gw = Math.ceil(W / cell) + 2, gh = Math.ceil(H / cell) + 2;
  const g = new Float32Array(gw * gh).map(() => r());
  return (x, y) => {
    const fx = x / cell, fy = y / cell, ix = Math.floor(fx), iy = Math.floor(fy);
    let tx = fx - ix, ty = fy - iy;
    tx = tx * tx * (3 - 2 * tx); ty = ty * ty * (3 - 2 * ty);
    const a = g[iy * gw + ix], b = g[iy * gw + ix + 1], c = g[(iy + 1) * gw + ix], d = g[(iy + 1) * gw + ix + 1];
    return a + (b - a) * tx + (c - a) * ty + (a - b - c + d) * tx * ty;
  };
}

// ---------- geometry ----------
function bez(p0, p1, p2, p3, n = 24) {
  const out = [];
  for (let i = 1; i <= n; i++) {
    const t = i / n, u = 1 - t;
    out.push([u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
      u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1]]);
  }
  return out;
}
function ellipsePts(cx, cy, rx, ry, rot = 0, n = 96) {
  const c = Math.cos(rot), s = Math.sin(rot);
  return Array.from({ length: n }, (_, i) => {
    const a = (i / n) * Math.PI * 2, x = Math.cos(a) * rx, y = Math.sin(a) * ry;
    return [cx + x * c - y * s, cy + x * s + y * c];
  });
}
function fillPoly(pts, into = new Uint8Array(N)) {
  let y0 = Infinity, y1 = -Infinity;
  for (const p of pts) { y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]); }
  y0 = Math.max(0, Math.floor(y0)); y1 = Math.min(H - 1, Math.ceil(y1));
  for (let y = y0; y <= y1; y++) {
    const yc = y + 0.5, xs = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      if ((a[1] <= yc) !== (b[1] <= yc)) xs.push(a[0] + ((yc - a[1]) / (b[1] - a[1])) * (b[0] - a[0]));
    }
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const xa = Math.max(0, Math.round(xs[k])), xb = Math.min(W, Math.round(xs[k + 1]));
      into.fill(1, y * W + xa, y * W + xb);
    }
  }
  return into;
}
function boxBlur(src, r) {
  r = Math.max(1, Math.round(r));
  const tmp = new Float32Array(N), out = new Float32Array(N), d = 2 * r + 1;
  for (let y = 0; y < H; y++) {
    let acc = 0; const o = y * W;
    for (let x = -r; x <= r; x++) acc += src[o + Math.min(W - 1, Math.max(0, x))];
    for (let x = 0; x < W; x++) {
      tmp[o + x] = acc / d;
      acc += src[o + Math.min(W - 1, x + r + 1)] - src[o + Math.max(0, x - r)];
    }
  }
  for (let x = 0; x < W; x++) {
    let acc = 0;
    for (let y = -r; y <= r; y++) acc += tmp[Math.min(H - 1, Math.max(0, y)) * W + x];
    for (let y = 0; y < H; y++) {
      out[y * W + x] = acc / d;
      acc += tmp[Math.min(H - 1, y + r + 1) * W + x] - tmp[Math.max(0, y - r) * W + x];
    }
  }
  return out;
}
const gauss = (src, r) => boxBlur(boxBlur(boxBlur(src, r), r), r);
// painterly coverage: soft, slightly broken edge, clipped to the aperture
function coverage(bin, label, soft = 2, rough = 0.18) {
  const f = new Float32Array(N);
  for (let i = 0; i < N; i++) f[i] = bin[i];
  const b = boxBlur(boxBlur(f, soft), soft), nz = valueNoise('edge:' + label, 9);
  const out = new Float32Array(N);
  for (let y = AP.y0; y < AP.y1; y++) for (let x = AP.x0; x < AP.x1; x++) {
    const i = y * W + x, v = b[i];
    if (v <= 0) continue;
    out[i] = v >= 1 ? 1 : Math.max(0, Math.min(1, (v - 0.5 + (nz(x, y) - 0.5) * rough) * 2.4 + 0.5));
  }
  return out;
}
function bboxOf(cov) {
  let x0 = W, y0 = H, x1 = 0, y1 = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (cov[y * W + x] > 0) {
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  return { x0, y0, x1: x1 + 1, y1: y1 + 1 };
}
// Lambert shade from a height field, key light from the upper left (style-guide §5)
const LIGHT = (() => { const v = [-0.62, -0.62, 0.48], m = Math.hypot(...v); return v.map((c) => c / m); })();
function shadeMap(height, k) {
  const out = new Float32Array(N);
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
    const i = y * W + x, gx = (height[i + 1] - height[i - 1]) * k, gy = (height[i + W] - height[i - W]) * k;
    const m = Math.hypot(gx, gy, 1);
    out[i] = Math.max(0, (-gx * LIGHT[0] - gy * LIGHT[1] + LIGHT[2]) / m);
  }
  return out;
}

// ---------- layer + brush ----------
class Layer {
  constructor() { this.c = new Float32Array(N * 3); this.a = new Float32Array(N); }
  over(i, col, al) {
    if (al <= 0) return;
    const a0 = this.a[i], ao = al + a0 * (1 - al), j = i * 3;
    for (let k = 0; k < 3; k++) this.c[j + k] = (col[k] * al + this.c[j + k] * a0 * (1 - al)) / ao;
    this.a[i] = ao;
  }
  tint(i, col, t) { const j = i * 3; for (let k = 0; k < 3; k++) this.c[j + k] += (col[k] - this.c[j + k]) * t; }
  toRaster() {
    const img = R.createImage();
    for (let i = 0; i < N; i++) {
      const a = Math.round(Math.min(1, this.a[i]) * 255);
      if (a === 0) continue;
      const q = i * 4, j = i * 3;
      img.data[q] = Math.max(0, Math.min(255, Math.round(this.c[j])));
      img.data[q + 1] = Math.max(0, Math.min(255, Math.round(this.c[j + 1])));
      img.data[q + 2] = Math.max(0, Math.min(255, Math.round(this.c[j + 2])));
      img.data[q + 3] = a;
    }
    return img;
  }
}
/**
 * Paint a region: an underpainting from o.color(x,y,i), then oriented bristle dabs
 * clipped to the coverage. o: { color, dir(x,y), len:[a,b], wid:[a,b], density, jit, op }
 */
function paintRegion(L, cov, label, o) {
  const bb = bboxOf(cov), r = rng('dabs:' + label), nz = valueNoise('under:' + label, 23);
  let area = 0;
  for (let y = bb.y0; y < bb.y1; y++) for (let x = bb.x0; x < bb.x1; x++) {
    const i = y * W + x, c = cov[i];
    if (c <= 0) continue;
    area++;
    const col = o.color(x, y, i), n = (nz(x, y) - 0.5) * (o.jit * 0.6);
    L.over(i, [col[0] + n, col[1] + n * 0.95, col[2] + n * 0.85], c);
  }
  const meanLen = (o.len[0] + o.len[1]) / 2, meanWid = (o.wid[0] + o.wid[1]) / 2;
  const count = Math.round((area * o.density) / (meanLen * meanWid));
  for (let k = 0; k < count; k++) {
    let x = 0, y = 0, ok = false;
    for (let t = 0; t < 12 && !ok; t++) {
      x = bb.x0 + r() * (bb.x1 - bb.x0); y = bb.y0 + r() * (bb.y1 - bb.y0);
      ok = cov[(y | 0) * W + (x | 0)] > 0.5;
    }
    if (!ok) continue;
    const base = o.color(x | 0, y | 0, (y | 0) * W + (x | 0)), lj = (r() - 0.5) * o.jit;
    const col = [base[0] + lj + (r() - 0.5) * o.jit * 0.3, base[1] + lj + (r() - 0.5) * o.jit * 0.3, base[2] + lj * 0.9 + (r() - 0.5) * o.jit * 0.3];
    const ang = o.dir(x, y) + (r() - 0.5) * 0.45;
    const len = o.len[0] + r() * (o.len[1] - o.len[0]), wid = o.wid[0] + r() * (o.wid[1] - o.wid[0]);
    const ca = Math.cos(ang), sa = Math.sin(ang), ext = Math.ceil(len) + 1;
    const freq = 2.2 + r() * 1.6, ph = r() * 6.28, op = o.op * (0.6 + r() * 0.4);
    for (let yy = Math.max(bb.y0, Math.floor(y - ext)); yy < Math.min(bb.y1, Math.ceil(y + ext)); yy++) {
      for (let xx = Math.max(bb.x0, Math.floor(x - ext)); xx < Math.min(bb.x1, Math.ceil(x + ext)); xx++) {
        const i = yy * W + xx, c = cov[i];
        if (c <= 0) continue;
        const dx = xx - x, dy = yy - y, u = (dx * ca + dy * sa) / len, v = (-dx * sa + dy * ca) / wid;
        const d = u * u + v * v;
        if (d >= 1) continue;
        // bristle grooves across the stroke, dry-brush taper at the tail
        const bristle = 0.62 + 0.38 * Math.sin(v * wid * freq * 0.5 + ph);
        const taper = u > 0 ? 1 - u * u * 0.6 : 1;
        L.tint(i, col, op * Math.sqrt(1 - d) * bristle * taper * c);
      }
    }
  }
}
// small hard dab (metal speculars, gold thread)
function dab(L, x, y, rx, ry, ang, col, op, clip) {
  const ca = Math.cos(ang), sa = Math.sin(ang), ext = Math.ceil(Math.max(rx, ry)) + 1;
  for (let yy = Math.floor(y - ext); yy <= Math.ceil(y + ext); yy++) for (let xx = Math.floor(x - ext); xx <= Math.ceil(x + ext); xx++) {
    if (xx < AP.x0 || xx >= AP.x1 || yy < AP.y0 || yy >= AP.y1) continue;
    const i = yy * W + xx, dx = xx - x, dy = yy - y, u = (dx * ca + dy * sa) / rx, v = (-dx * sa + dy * ca) / ry, d = u * u + v * v;
    if (d >= 1) continue;
    const al = op * Math.min(1, (1 - d) * 2.5) * (clip ? clip[i] : 1);
    if (clip) L.tint(i, col, al); else L.over(i, col, al);
  }
}
function curveDabs(L, pts, step, rx, ry, colFn, op, r, clip) {
  let carry = 0;
  for (let k = 0; k + 1 < pts.length; k++) {
    const a = pts[k], b = pts[k + 1], seg = Math.hypot(b[0] - a[0], b[1] - a[1]), ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
    for (let s = carry; s < seg; s += step) {
      const t = s / seg, j = (r() - 0.5) * 2;
      dab(L, a[0] + (b[0] - a[0]) * t + j, a[1] + (b[1] - a[1]) * t + j, rx * (0.7 + r() * 0.5), ry, ang, colFn(r()), op * (0.6 + r() * 0.4), clip);
      carry = s + step - seg;
    }
  }
}

// ---------- reference skin (fit target) ----------
const skin = R.decodePNG(fs.readFileSync(path.join(ROOT, 'layers/skins/moss.png')));
const skinBin = new Float32Array(N);
for (let i = 0; i < N; i++) skinBin[i] = skin.data[i * 4 + 3] > 96 ? 1 : 0;

// collar line: shoulder peaks and the neck opening ellipse (978,1600) rx 210 ry 64
function topEdge(x) {
  if (x < 365) return 1748;
  if (x < 768) return 1760 + ((x - 365) / (768 - 365)) * (1606 - 1760);
  if (x <= 1188) { const t = (x - 978) / 210; return 1600 + 64 * Math.sqrt(Math.max(0, 1 - t * t)); }
  if (x < 1575) return 1606 + ((x - 1188) / (1575 - 1188)) * (1712 - 1606);
  return 1712;
}

// =====================================================================
// 1. attire-front.antiquary-doublet
// =====================================================================
function paintDoublet() {
  const L = new Layer();
  // body silhouette = template shoulder mass ∪ reference skin body (dilated 14 px), below the collar line
  const tmpl = fillPoly([[768, 1600], ...bez([768, 1600], [640, 1640], [470, 1690], [365, 1760]),
    ...bez([365, 1760], [270, 1830], [210, 1960], [190, 2120]), [176, 2368], [1872, 2368],
    ...bez([1872, 2368], [1856, 2140], [1830, 1930], [1730, 1770]).slice(0, -1), [1730, 1770],
    ...bez([1730, 1770], [1660, 1730], [1600, 1716], [1575, 1712]),
    ...bez([1575, 1712], [1440, 1662], [1290, 1622], [1188, 1600])]);
  const dil = boxBlur(skinBin, 14);
  const body = new Uint8Array(N);
  for (let y = 1580; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x;
    if ((tmpl[i] || dil[i] > 0.01) && y >= topEdge(x) - 18) body[i] = 1;
  }
  const bodyCov = coverage(body, 'body', 2, 0.25);

  // height field: rounded torso + shoulder masses + diagonal cloth folds
  const hb = new Float32Array(N); for (let i = 0; i < N; i++) hb[i] = body[i];
  const h = gauss(hb, 46), foldN = valueNoise('fold', 140), foldN2 = valueNoise('fold2', 60);
  for (let y = 1560; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x; if (!body[i]) continue;
    const sh = Math.exp(-(((x - 420) / 230) ** 2 + ((y - 1900) / 260) ** 2)) * 0.35 + Math.exp(-(((x - 1590) / 260) ** 2 + ((y - 1860) / 280) ** 2)) * 0.45;
    const fold = Math.sin((x - y * 0.55) / 38 + foldN(x, y) * 6) * 0.05 * foldN2(x, y);
    h[i] += sh + fold;
  }
  const sh = shadeMap(h, 9);
  const nz = valueNoise('doublet-tone', 180);
  const umberStops = [P.night, mix(P.night, P.umber, 0.6), P.umber, mix(P.umber, P.ochre, 0.22), mix(P.umber, P.ochre, 0.42), mix(P.umber, P.bone, 0.45)];
  const vDoublet = (x, y, i) => {
    let v = sh[i] * 0.82 + (nz(x, y) - 0.5) * 0.12;
    v -= Math.max(0, (y - 2150) / 900) * 0.25;   // falls into shadow toward the lower rail
    v += Math.max(0, (1100 - x) / 4000);          // warmer on the lit (left) side
    return v;
  };
  paintRegion(L, bodyCov, 'doublet', {
    color: (x, y, i) => ramp(umberStops, vDoublet(x, y, i)),
    dir: (x, y) => 0.95 + Math.sin(x / 260) * 0.25, len: [26, 64], wid: [9, 20], density: 2.2, jit: 30, op: 0.6,
  });

  // armhole seams and sleeve heads (darker seam with a lit lip on the up-left side)
  const sr = rng('seams');
  const seamFar = bez([520, 1712], [470, 1880], [430, 2100], [420, 2366], 40);
  const seamNear = bez([1430, 1672], [1500, 1860], [1560, 2100], [1600, 2366], 40);
  for (const s of [seamFar, seamNear]) {
    curveDabs(L, s, 5, 9, 4, () => P.night, 0.55, sr, bodyCov);
    curveDabs(L, s.map((p) => [p[0] - 8, p[1] - 3]), 6, 8, 2.5, () => mix(P.umber, P.ochre, 0.45), 0.35, sr, bodyCov);
  }
  // pinked slashes on the upper sleeves showing oxblood lining
  for (const [cx, cy, n] of [[400, 1960, 4], [1620, 1930, 4]]) {
    for (let k = 0; k < n; k++) {
      const x = cx + (k - 1.5) * 44 + (sr() - 0.5) * 6, y = cy + k * 30;
      dab(L, x, y, 26, 5, 1.25, mix(P.oxblood, P.night, 0.25), 0.85, bodyCov);
      dab(L, x - 2, y - 3, 18, 2.2, 1.25, mix(P.oxblood, P.bone, 0.25), 0.55, bodyCov);
    }
  }

  // ---- ochre waistcoat in the open front ----
  const wc = fillPoly([[790, 1626], [1166, 1626], [1132, 1880], [1104, 2366], [706, 2366], [760, 1880]]);
  for (let i = 0; i < N; i++) if (!body[i]) wc[i] = 0;
  const wcCov = coverage(wc, 'waistcoat', 2, 0.15);
  const hw = new Float32Array(N); for (let i = 0; i < N; i++) hw[i] = wc[i];
  const hwb = gauss(hw, 40), wn = valueNoise('wc-fold', 90);
  for (let i = 0; i < N; i++) if (wc[i]) { const x = i % W, y = (i / W) | 0; hwb[i] += Math.sin(x / 31 + wn(x, y) * 5) * 0.03 + h[i] * 0.6; }
  const shw = shadeMap(hwb, 9);
  const ochreStops = [mix(P.ochre, P.umber, 0.75), mix(P.ochre, P.umber, 0.45), mix(P.ochre, P.umber, 0.18), P.ochre, mix(P.ochre, P.bone, 0.4)];
  paintRegion(L, wcCov, 'waistcoat', {
    color: (x, y, i) => ramp(ochreStops, shw[i] * 0.9 - Math.max(0, (y - 2100) / 1000) * 0.3 + (wn(x, y) - 0.5) * 0.1),
    dir: () => 1.45, len: [22, 50], wid: [8, 15], density: 2.2, jit: 28, op: 0.55,
  });
  // brocade dabs (moss thread) on the waistcoat
  const br = rng('brocade');
  for (let k = 0; k < 520; k++) {
    const x = 720 + br() * 440, y = 1700 + br() * 660, i = (y | 0) * W + (x | 0);
    if (wcCov[i] < 0.9) continue;
    dab(L, x, y, 5 + br() * 4, 2.2, br() * 3.14, mix(P.moss, P.ochre, 0.3 + br() * 0.3), 0.35, wcCov);
  }
  // centre front line and gold-leaf buttons (centre line leans left for the three-quarter turn)
  const cf = (y) => 968 - ((y - 1660) / 700) * 46;
  curveDabs(L, Array.from({ length: 30 }, (_, k) => [cf(1680 + k * 23) + 18, 1680 + k * 23]), 5, 7, 2.5, () => mix(P.ochre, P.umber, 0.7), 0.5, br, wcCov);
  for (let y = 1990; y < 2350; y += 106) {
    const x = cf(y) - 2;
    dab(L, x + 4, y + 5, 15, 13, 0, mix(P.night, P.umber, 0.3), 0.55, wcCov);           // cast shadow down-right
    dab(L, x, y, 14, 13, 0, mix(P.gold, P.umber, 0.35), 1, wcCov);
    dab(L, x - 1, y - 1, 11, 10, 0, P.gold, 0.9, wcCov);
    dab(L, x - 5, y - 5, 4.5, 3, -0.7, mix(P.bone, P.gold, 0.2), 0.95, wcCov);          // specular upper-left
  }
  // waistcoat pocket welt
  curveDabs(L, bez([780, 2190], [830, 2180], [880, 2178], [905, 2184], 12), 5, 7, 4, () => mix(P.ochre, P.umber, 0.6), 0.7, br, wcCov);

  // ---- lapels: turned umber edges with oxblood facing and gold-thread trim ----
  const lapL = [[790, 1626], [760, 1880], [706, 2366]], lapR = [[1166, 1626], [1132, 1880], [1104, 2366]];
  const lap = new Uint8Array(N);
  fillPoly([[742, 1640], [790, 1626], [760, 1880], [706, 2366], [646, 2366], [705, 1880]], lap);
  fillPoly([[1166, 1626], [1222, 1650], [1186, 1880], [1162, 2366], [1104, 2366], [1132, 1880]], lap);
  for (let i = 0; i < N; i++) if (!body[i]) lap[i] = 0;
  const lapCov = coverage(lap, 'lapel', 1.5, 0.12);
  paintRegion(L, lapCov, 'lapel', {
    color: (x, y, i) => ramp([mix(P.oxblood, P.night, 0.55), mix(P.oxblood, P.night, 0.2), P.oxblood, mix(P.oxblood, P.bone, 0.25)], sh[i] * 0.95 - (x > 1000 ? 0.18 : 0)),
    dir: () => 1.5, len: [16, 40], wid: [5, 10], density: 1.6, jit: 14, op: 0.5,
  });
  const tr = rng('trim');
  const goldThread = (t) => ramp([mix(P.gold, P.umber, 0.45), P.ochre, P.gold, mix(P.gold, P.bone, 0.35)], t);
  for (const line of [lapL, lapR]) {
    const pts = []; for (let k = 0; k + 1 < line.length; k++) pts.push(...bez(line[k], line[k], line[k + 1], line[k + 1], 20));
    curveDabs(L, pts, 9, 6, 2.6, (t) => goldThread(0.25 + t * 0.6), 0.85, tr, body.map((v) => v) && bodyCov);
  }

  // ---- standing collar band along the collar line ----
  const col = new Uint8Array(N);
  const colPts = [];
  for (let x = 330; x <= 1640; x += 6) colPts.push([x, topEdge(x) - 14]);
  for (let x = 1640; x >= 330; x -= 6) colPts.push([x, topEdge(x) + 30 + (x > 768 && x < 1188 ? 0 : 6)]);
  fillPoly(colPts, col);
  for (let i = 0; i < N; i++) if (!body[i]) col[i] = 0;
  const colCov = coverage(col, 'collar', 1.5, 0.15);
  paintRegion(L, colCov, 'collar', {
    color: (x, y, i) => ramp(umberStops, sh[i] * 0.7 + 0.18 - (y - topEdge(x) + 14) / 160),
    dir: (x) => Math.atan2(topEdge(x + 10) - topEdge(x - 10), 20), len: [18, 40], wid: [5, 9], density: 1.6, jit: 12, op: 0.55,
  });
  const lip = []; for (let x = 340; x <= 1630; x += 8) lip.push([x, topEdge(x) - 12]);
  curveDabs(L, lip, 8, 6, 2.4, (t) => goldThread(0.2 + t * 0.7), 0.8, tr, colCov);
  const lip2 = []; for (let x = 340; x <= 1630; x += 8) lip2.push([x, topEdge(x) + 27]);
  curveDabs(L, lip2, 6, 8, 3, () => P.night, 0.5, tr, bodyCov);

  // ---- bone cravat: stock band over the neck opening, knot and falling jabot ----
  const cr = new Uint8Array(N);
  const stock = [];
  for (let k = 0; k <= 48; k++) { const t = -1 + k / 24; stock.push([978 + t * 222, 1548 + 46 * Math.sqrt(1 - t * t)]); }
  for (let k = 48; k >= 0; k--) { const t = -1 + k / 24; stock.push([978 + t * 222, 1606 + 70 * Math.sqrt(1 - t * t)]); }
  fillPoly(stock, cr);
  fillPoly([[890, 1640], [1066, 1636], [1096, 1730], [1082, 1840], [1050, 1960], [990, 1990], [918, 1972], [870, 1860], [862, 1740]], cr);
  const crCov = coverage(cr, 'cravat', 2, 0.22);
  const hc = new Float32Array(N); for (let i = 0; i < N; i++) hc[i] = cr[i];
  const hcb = gauss(hc, 26), cn = valueNoise('cravat', 50);
  for (let i = 0; i < N; i++) if (cr[i]) {
    const x = i % W, y = (i / W) | 0;
    const w = Math.max(0, Math.min(1, (y - 1625) / 50));                                      // smooth hand-over stock -> jabot
    hcb[i] += (1 - w) * Math.sin(y / 11 + cn(x, y) * 3) * 0.035;                             // wrapped folds of the stock
    hcb[i] += w * Math.sin((x - 978) / 15 + Math.sin(y / 34) * 2.2 + cn(x, y) * 4) * 0.09;  // jabot ruffles
    hcb[i] += Math.exp(-(((x - 972) / 60) ** 2 + ((y - 1648) / 42) ** 2)) * 0.25;              // knot
  }
  const shc = shadeMap(hcb, 8);
  const boneStops = [mix(P.bone, P.forest, 0.55), mix(P.bone, P.umber, 0.38), mix(P.bone, P.ochre, 0.35), P.bone, mix(P.bone, [236, 226, 200], 0.6)];
  paintRegion(L, crCov, 'cravat', {
    color: (x, y, i) => ramp(boneStops, shc[i] * 0.95 + (x < 960 ? 0.06 : -0.04) - Math.max(0, y - 1880) / 600),
    dir: (x, y) => (y < 1650 ? 0.08 : 1.45 + Math.sin(y / 40) * 0.25), len: [14, 34], wid: [5, 10], density: 2.2, jit: 24, op: 0.55,
  });
  // knot pin: a small garnet cabochon
  dab(L, 974, 1652, 12, 14, 0, mix(P.night, P.oxblood, 0.4), 0.95, crCov);
  dab(L, 972, 1650, 9, 11, 0, hex('#8E1F2B'), 0.95, crCov);
  dab(L, 968, 1645, 3.2, 2.4, -0.7, P.bone, 0.9, crCov);
  // cast shadow of the jowl onto the top of the stock (soft, down-right)
  for (let y = 1534; y < 1600; y++) for (let x = 760; x < 1200; x++) {
    const i = y * W + x; if (crCov[i] <= 0 || !skinBin[i - 16 * W - 8]) continue;
    L.tint(i, mix(P.forest, P.night, 0.5), 0.28 * (1 - (y - 1534) / 66));
  }
  return L;
}

// =====================================================================
// 2. accessory.antiquary-monocle (ring ≈190 px at the near eye, chain to the near shoulder)
// =====================================================================
function paintMonocle() {
  const L = new Layer(), cx = 1040, cy = 912, rO = 96, rI = 83, r = rng('monocle');
  // glass: faint bone tint, soft window reflection upper-left
  for (let y = cy - rI; y <= cy + rI; y++) for (let x = cx - rI; x <= cx + rI; x++) {
    const d = Math.hypot(x - cx, y - cy); if (d > rI) continue;
    const i = y * W + x, e = Math.min(1, (rI - d) / 2);
    const refl = Math.max(0, 1 - Math.hypot((x - (cx - 30)) / 46, (y - (cy - 36)) / 26)) ** 1.5;
    L.over(i, mix(P.bone, [236, 226, 200], refl), (0.07 + refl * 0.3) * e);
  }
  // ring: painted gold leaf, lit at the upper left, ochre bounce and umber at lower right
  const stops = [mix(P.umber, P.night, 0.3), mix(P.gold, P.umber, 0.55), P.ochre, P.gold, mix(P.gold, P.bone, 0.55)];
  for (let y = cy - rO - 2; y <= cy + rO + 2; y++) for (let x = cx - rO - 2; x <= cx + rO + 2; x++) {
    const d = Math.hypot(x - cx, y - cy); if (d < rI - 1 || d > rO + 1) continue;
    const i = y * W + x, cover = Math.min(1, d - (rI - 1), rO + 1 - d);
    const ang = Math.atan2(y - cy, x - cx), across = (d - (rI + rO) / 2) / ((rO - rI) / 2);
    const facing = Math.cos(ang - (-3 * Math.PI / 4));       // +1 at upper-left
    const bevel = across < 0 ? -across * 0.35 : -across * 0.2;
    L.over(i, ramp(stops, 0.5 + facing * 0.35 + bevel + (r() - 0.5) * 0.08), cover);
  }
  // brush dabs around the ring, sharp specular dabs facing up-left
  for (let k = 0; k < 140; k++) {
    const a = r() * Math.PI * 2, rr = rI + 2 + r() * (rO - rI - 4), f = Math.cos(a + 3 * Math.PI / 4);
    dab(L, cx + Math.cos(a) * rr, cy + Math.sin(a) * rr, 7 + r() * 6, 2, a + Math.PI / 2, ramp(stops, 0.5 + f * 0.4 + (r() - 0.5) * 0.2), 0.5, null);
  }
  for (let a = -2.75; a < -1.65; a += 0.07) dab(L, cx + Math.cos(a) * (rO - 4), cy + Math.sin(a) * (rO - 4), 6, 1.8, a + Math.PI / 2, mix(P.bone, [236, 226, 200], 0.5), 0.75 * (0.6 + r() * 0.4), null);
  // eyelet at the lower right of the ring
  const ex = cx + rO * Math.cos(0.72), ey = cy + rO * Math.sin(0.72);
  dab(L, ex + 3, ey + 4, 11, 11, 0, mix(P.night, P.umber, 0.4), 0.45, null);
  dab(L, ex + 4, ey + 6, 10, 10, 0, mix(P.gold, P.umber, 0.4), 1, null);
  dab(L, ex + 4, ey + 6, 4.5, 4.5, 0, mix(P.umber, P.night, 0.4), 1, null);
  dab(L, ex + 1, ey + 3, 3, 2, -0.7, mix(P.gold, P.bone, 0.5), 0.9, null);
  // fine chain: catenary-like fall from the eyelet to a gold stud on the near shoulder of the doublet
  const a0 = [ex + 6, ey + 14], a1 = [1420, 1702];
  const chain = bez(a0, [a0[0] + 30, a0[1] + 520], [1240, 1700], a1, 240);
  let acc = 0, link = 0;
  for (let k = 0; k + 1 < chain.length; k++) {
    const p = chain[k], q = chain[k + 1], seg = Math.hypot(q[0] - p[0], q[1] - p[1]);
    acc += seg;
    if (acc < 10) continue;
    acc = 0; link++;
    const ang = Math.atan2(q[1] - p[1], q[0] - p[0]);
    const lit = 0.55 + 0.3 * Math.sin(link * 1.7) + (r() - 0.5) * 0.1;
    dab(L, p[0] + 2, p[1] + 3, 7, 4, ang, mix(P.night, P.umber, 0.3), 0.35, null);        // shadow on the skin/cloth below
    if (link % 2) { dab(L, p[0], p[1], 7.5, 4.2, ang, ramp(stops, lit), 0.95, null); dab(L, p[0], p[1], 3.5, 1.6, ang, mix(P.umber, P.night, 0.5), 0.9, null); }
    else dab(L, p[0], p[1], 6, 2.2, ang, ramp(stops, lit + 0.1), 0.95, null);
    if (r() < 0.35) dab(L, p[0] - 2, p[1] - 2, 2, 1.2, ang, mix(P.gold, P.bone, 0.6), 0.85, null);
  }
  // stud holding the chain
  dab(L, a1[0] + 4, a1[1] + 5, 17, 15, 0, mix(P.night, P.umber, 0.3), 0.5, null);
  dab(L, a1[0], a1[1], 16, 15, 0, mix(P.gold, P.umber, 0.4), 1, null);
  dab(L, a1[0] - 1, a1[1] - 1, 12, 11, 0, P.gold, 0.9, null);
  dab(L, a1[0] - 6, a1[1] - 6, 4.5, 3, -0.7, mix(P.bone, P.gold, 0.2), 0.95, null);
  return L;
}

// =====================================================================
// 3. prop-front.antiquary-scroll (held low on the left, curling parchment, wax seal)
// =====================================================================
function paintScroll() {
  const L = new Layer(), r = rng('scroll');
  const A = [238, 2196], B = [664, 2034], rad = 40;   // roll axis
  const ax = B[0] - A[0], ay = B[1] - A[1], al = Math.hypot(ax, ay), ux = ax / al, uy = ay / al, nx = -uy, ny = ux; // n points down-right side
  const parchStops = [mix(P.ochre, P.umber, 0.55), mix(P.ochre, P.umber, 0.2), P.ochre, mix(P.ochre, P.bone, 0.55), P.bone, mix(P.bone, [236, 226, 200], 0.5)];

  // hanging sheet, unrolled from the roll down toward the lower rail, with its lower edge curling back
  const sheet = new Uint8Array(N);
  const sTop0 = [A[0] + 40 * ux + nx * 20, A[1] + 40 * uy + ny * 20], sTop1 = [B[0] - 40 * ux + nx * 20, B[1] - 40 * uy + ny * 20];
  const sheetPts = [sTop0, sTop1, ...bez(sTop1, [sTop1[0] + 34, sTop1[1] + 120], [sTop1[0] + 30, 2240], [sTop1[0] + 12, 2300], 16),
    ...bez([sTop1[0] + 12, 2300], [520, 2336], [400, 2342], [300, 2320], 20), ...bez([300, 2320], [276, 2300], [270, 2270], sTop0, 12)];
  fillPoly(sheetPts, sheet);
  for (let i = 0; i < N; i++) { const y = (i / W) | 0; if (y >= CROP_Y1) sheet[i] = 0; }
  const sheetCov = coverage(sheet, 'sheet', 2, 0.3);
  const sn = valueNoise('sheet', 70);
  paintRegion(L, sheetCov, 'sheet', {
    color: (x, y) => {
      const t = (y - 2080) / 260;                     // further from the roll = turned slightly away from the light
      const wave = Math.sin((x - y * 0.3) / 55 + sn(x, y) * 3) * 0.08;
      return ramp(parchStops, 0.78 - t * 0.28 + wave + (x < 420 ? 0.06 : -0.02));
    },
    dir: () => 1.35, len: [14, 36], wid: [5, 10], density: 1.8, jit: 16, op: 0.5,
  });
  // faded umber script lines on the sheet
  for (let row = 0; row < 6; row++) {
    const yA = 2150 + row * 28, x0 = 300 + row * 4, x1 = 600 - row * 10;
    let x = x0;
    while (x < x1) {
      const wlen = 18 + r() * 40, y = yA - (x - 300) * 0.18 + Math.sin(x / 9) * 1.5;
      curveDabs(L, [[x, y], [x + wlen, y - wlen * 0.18]], 3, 3, 1.3, () => mix(P.umber, P.ochre, 0.25), 0.55, r, sheetCov);
      x += wlen + 10 + r() * 14;
    }
  }
  // curl at the lower edge (a thin roll seen from below, shadowed)
  const curl = bez([sTop1[0] + 12, 2300], [520, 2336], [400, 2342], [300, 2320], 40);
  for (const [k, p] of curl.entries()) {
    if (p[1] >= CROP_Y1 - 8) continue;
    dab(L, p[0], p[1] - 4, 14, 9, -0.12, ramp(parchStops, 0.35 + (k % 3) * 0.05), 0.9, null);
    dab(L, p[0] - 2, p[1] - 9, 10, 2.5, -0.12, ramp(parchStops, 0.85), 0.55, null);
  }

  // the roll: a cylinder, lit along its upper-left side, strokes along the axis
  const roll = new Uint8Array(N);
  fillPoly([[A[0] + nx * rad, A[1] + ny * rad], [B[0] + nx * rad, B[1] + ny * rad], [B[0] - nx * rad, B[1] - ny * rad], [A[0] - nx * rad, A[1] - ny * rad]], roll);
  fillPoly(ellipsePts(B[0], B[1], 16, rad, Math.atan2(uy, ux)), roll);
  const rollCov = coverage(roll, 'roll', 1.5, 0.12);
  paintRegion(L, rollCov, 'roll', {
    color: (x, y) => {
      const t = ((x - A[0]) * nx + (y - A[1]) * ny) / rad;       // -1 upper-left side … +1 lower-right side
      return ramp(parchStops, 0.9 - (t + 1) * 0.36 + Math.sin(((x - A[0]) * ux + (y - A[1]) * uy) / 40) * 0.03);
    },
    dir: () => Math.atan2(uy, ux), len: [20, 50], wid: [4, 9], density: 1.8, jit: 14, op: 0.5,
  });
  // spiral end of the roll at the far (left) end, facing the viewer
  const endE = ellipsePts(A[0], A[1], 18, rad, Math.atan2(uy, ux));
  const endBin = fillPoly(endE); const endCov = coverage(endBin, 'rollend', 1, 0.05);
  paintRegion(L, endCov, 'rollend', { color: () => ramp(parchStops, 0.45), dir: () => 0.3, len: [6, 12], wid: [3, 5], density: 1.4, jit: 10, op: 0.5 });
  for (let s = 0; s < 3; s++) {
    const pts = []; for (let a = 0; a < Math.PI * 2; a += 0.15) { const rr = (rad - 6) * (1 - s * 0.3) * (1 - a / 30); pts.push([A[0] + Math.cos(a) * rr * 0.42 * ux - Math.sin(a) * rr * nx, A[1] + Math.cos(a) * rr * 0.42 * uy - Math.sin(a) * rr * ny]); }
    curveDabs(L, pts, 3, 3, 1.4, () => mix(P.ochre, P.umber, 0.6), 0.7, r, endCov);
  }
  // cast shadow of the roll onto the sheet (down-right)
  for (let k = 0; k < 60; k++) {
    const t = k / 60, x = A[0] + ax * t + nx * (rad + 10), y = A[1] + ay * t + ny * (rad + 10);
    dab(L, x, y, 16, 8, Math.atan2(uy, ux), mix(P.umber, P.ochre, 0.3), 0.12, sheetCov);
  }
  // ribbon and wax seal (oxblood) hanging from the roll onto the sheet
  const seal = [470, 2214];
  for (const [dx, w] of [[-14, 1], [14, -1]]) {
    const rib = bez([seal[0] + dx * 0.3, seal[1]], [seal[0] + dx * 1.2, seal[1] + 40], [seal[0] + dx * 2.2 - 10, seal[1] + 70], [seal[0] + dx * 5 + w * 6 - 12, Math.min(CROP_Y1 - 14, seal[1] + 118)], 30);
    curveDabs(L, rib, 4, 7, 6, (t) => mix(P.forest, P.night, t * 0.3), 0.9, r, null);
    curveDabs(L, rib.map((p) => [p[0] - 3, p[1] - 1]), 5, 6, 1.6, () => mix(P.forest, P.moss, 0.6), 0.55, r, null);
  }
  dab(L, seal[0] + 7, seal[1] + 9, 50, 46, 0.2, mix(P.night, P.umber, 0.2), 0.45, null);      // shadow
  const sealBin = fillPoly(ellipsePts(seal[0], seal[1], 46, 42, 0.2, 40).map(([x, y], k) => [x + Math.sin(k * 2.3) * 3, y + Math.cos(k * 1.7) * 3]));
  const sealCov = coverage(sealBin, 'seal', 1.2, 0.1);
  const sealStops = [mix(P.oxblood, P.night, 0.6), mix(P.oxblood, P.night, 0.3), P.oxblood, hex('#8E1F2B'), mix(P.oxblood, P.bone, 0.35)];
  paintRegion(L, sealCov, 'seal', {
    color: (x, y) => { const d = Math.hypot(x - seal[0], y - seal[1]) / 36, f = -((x - seal[0]) + (y - seal[1])) / 50; return ramp(sealStops, 0.5 + f * 0.35 - Math.max(0, d - 0.7) * 0.4); },
    dir: () => 0.7, len: [6, 14], wid: [3, 6], density: 1.4, jit: 10, op: 0.5,
  });
  // pressed ring and device (a small frog-foot sigil) in the wax
  const ring = ellipsePts(seal[0], seal[1], 28, 26, 0.2, 48); ring.push(ring[0]);
  curveDabs(L, ring.slice(0, 26), 3, 3, 1.6, () => mix(P.oxblood, P.night, 0.6), 0.75, r, sealCov);
  curveDabs(L, ring.slice(26), 3, 3, 1.4, () => mix(P.oxblood, P.bone, 0.4), 0.6, r, sealCov);
  for (const a of [-2.2, -1.57, -0.94]) curveDabs(L, [[seal[0], seal[1] + 8], [seal[0] + Math.cos(a) * 14, seal[1] + 8 + Math.sin(a) * 14]], 2, 2.5, 1.5, () => mix(P.oxblood, P.night, 0.55), 0.8, r, sealCov);
  dab(L, seal[0] - 16, seal[1] - 15, 6, 3, -0.7, mix(P.bone, P.oxblood, 0.25), 0.8, sealCov);       // wet specular upper-left
  return L;
}

// ---------- export ----------
function main() {
  const outDir = __dirname, assets = [];
  const jobs = [
    ['attire-front', 'antiquary-doublet', paintDoublet, 'Umber doublet with oxblood-faced lapels, gold-thread trim and slashed sleeves, open over an ochre waistcoat with gold-leaf buttons; bone linen stock and jabot cravat with a garnet pin closing the neck opening.'],
    ['accessory', 'antiquary-monocle', paintMonocle, 'Gold-leaf monocle ring (~192 px) centred on the near eye (1040,912) with a faint glass reflection, and a fine gold chain falling to a stud on the near shoulder (1420,1702).'],
    ['prop-front', 'antiquary-scroll', paintScroll, 'Rolled parchment held low at the lower left, its sheet hanging and curling at the lower edge, faded script, forest ribbon and an oxblood wax seal.'],
  ];
  for (const [slot, name, fn, description] of jobs) {
    const id = `${slot}.${name}`, rel = `layers/attire/antiquary/${id}.png`;
    const png = R.encodePNG(fn().toRaster());
    fs.writeFileSync(path.join(outDir, `${id}.png`), png);
    assets.push({ id, slot, name, category: 'antiquary', path: rel, width: W, height: H, format: 'png-rgba8',
      sha256: createHash('sha256').update(png).digest('hex'), description });
    console.log(id, png.length);
  }
  fs.writeFileSync(path.join(ROOT, 'catalog/attire-antiquary.json'), JSON.stringify({ schema: 'kekborn-assets@1', assets }, null, 2) + '\n');
}
main();
