#!/usr/bin/env node
// Generates the extension icons.
//
//   node tools/icons.js
//
// The mark is the same arch drawn twice: cyan where the resample left the
// spectral envelope, amber where the warp puts it back. Same shape, moved up.
// That is the whole product in two strokes, and it survives being 16 px wide.
//
// Written as a generator rather than hand-drawn files so the geometry stays in
// one place and the set can be re-cut at any size. PNGs are encoded here with
// zlib, so there is no image dependency to install.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// ------------------------------------------------------------------ geometry
// All in a 24 x 24 design box, matching the inline SVG in the panel and popup.

const ARCS = [
  { cx: 8.5, cy: 19.5, r: 5.5, colour: [0x5b, 0xc0, 0xd0] }, // original
  { cx: 14.5, cy: 13, r: 5.5, colour: [0xf2, 0xa5, 0x4a] }, // warped, lifted
];
const STROKE = 2.8;

// The arcs are written at whatever coordinates read well as geometry, then
// centred in the design box from their own bounds. Hand-balancing the numbers
// instead means every tweak to the shape silently shifts the composition.
const BOUNDS = (() => {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const a of ARCS) {
    x0 = Math.min(x0, a.cx - a.r - STROKE / 2);
    x1 = Math.max(x1, a.cx + a.r + STROKE / 2);
    y0 = Math.min(y0, a.cy - a.r - STROKE / 2);
    y1 = Math.max(y1, a.cy + STROKE / 2);
  }
  return { x0, y0, w: x1 - x0, h: y1 - y0 };
})();

const BG_TOP = [0x1c, 0x21, 0x2c];
const BG_BOT = [0x0d, 0x0f, 0x15];

/// Distance from a point to an upper half-circle, in design units.
function arcDistance(x, y, a) {
  if (y <= a.cy) {
    return Math.abs(Math.hypot(x - a.cx, y - a.cy) - a.r);
  }
  // Past the ends, fall back to the nearest cap so round caps come out round.
  return Math.min(Math.hypot(x - (a.cx - a.r), y - a.cy), Math.hypot(x - (a.cx + a.r), y - a.cy));
}

function roundedRectInside(x, y, w, h, r) {
  const dx = Math.max(r - x, 0, x - (w - r));
  const dy = Math.max(r - y, 0, y - (h - r));
  if (dx > 0 && dy > 0) return Math.hypot(dx, dy) <= r;
  return x >= 0 && y >= 0 && x <= w && y <= h;
}

/// Renders one icon at `size`, supersampled and box filtered.
function render(size, opts) {
  const ss = 4;
  const n = size * ss;
  const acc = new Float64Array(size * size * 4);

  // Padding scales with the icon: small icons need proportionally less, or the
  // mark shrinks into nothing.
  const pad = size <= 20 ? size * 0.1 : size * 0.16;
  const inner = size - pad * 2;
  const scale = inner / Math.max(BOUNDS.w, BOUNDS.h);
  const radius = size * 0.22;
  const stroke = (STROKE * scale) / 2;
  // Offsets that put the mark's own bounding box in the middle of the tile.
  const offX = (size - BOUNDS.w * scale) / 2 - BOUNDS.x0 * scale;
  const offY = (size - BOUNDS.h * scale) / 2 - BOUNDS.y0 * scale;

  for (let py = 0; py < n; py++) {
    for (let px = 0; px < n; px++) {
      const sx = (px + 0.5) / ss;
      const sy = (py + 0.5) / ss;

      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;

      if (opts.tile && roundedRectInside(sx, sy, size, size, radius)) {
        const t = sy / size;
        r = BG_TOP[0] + (BG_BOT[0] - BG_TOP[0]) * t;
        g = BG_TOP[1] + (BG_BOT[1] - BG_TOP[1]) * t;
        b = BG_TOP[2] + (BG_BOT[2] - BG_TOP[2]) * t;
        a = 255;
      }

      // Design-box coordinates.
      const dx = (sx - offX) / scale;
      const dy = (sy - offY) / scale;
      for (const arc of ARCS) {
        if (arcDistance(dx, dy, arc) * scale <= stroke) {
          r = arc.colour[0];
          g = arc.colour[1];
          b = arc.colour[2];
          a = 255;
        }
      }

      const o = (((py / ss) | 0) * size + ((px / ss) | 0)) * 4;
      acc[o] += r * a;
      acc[o + 1] += g * a;
      acc[o + 2] += b * a;
      acc[o + 3] += a;
    }
  }

  const out = Buffer.alloc(size * size * 4);
  const per = ss * ss;
  for (let i = 0; i < size * size; i++) {
    const alpha = acc[i * 4 + 3];
    out[i * 4 + 3] = Math.round(alpha / per);
    if (alpha > 0) {
      out[i * 4] = Math.round(acc[i * 4] / alpha);
      out[i * 4 + 1] = Math.round(acc[i * 4 + 1] / alpha);
      out[i * 4 + 2] = Math.round(acc[i * 4 + 2] / alpha);
    }
  }
  return out;
}

// ----------------------------------------------------------------- png output

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePng(size, rgba) {
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ------------------------------------------------------------------------ run

const dir = path.join(__dirname, '..', 'extension', 'icons');
fs.mkdirSync(dir, { recursive: true });

for (const size of [16, 32, 48, 128]) {
  const png = encodePng(size, render(size, { tile: true }));
  const file = path.join(dir, `icon${size}.png`);
  fs.writeFileSync(file, png);
  console.log(`icons/icon${size}.png  ${size}x${size}  ${png.length} bytes`);
}
