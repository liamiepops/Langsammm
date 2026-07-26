#!/usr/bin/env node
// Builds a contact sheet of every icon concept so they can be judged where it
// matters: small, and against both toolbar colours.
//
//   node tools/icon-sheet.js
//
// One row per concept. Left group is a dark toolbar, middle group is a light
// one, then 128, then the 16 px cut magnified so the pixel structure is
// visible. Nearest neighbour on the magnification, because the point is to see
// exactly which pixels survived.

const fs = require('fs');
const path = require('path');
const { CONCEPTS, render, encodePng } = require('./icons.js');

const DARK = [0x20, 0x21, 0x24]; // Chrome dark toolbar
const LIGHT = [0xff, 0xff, 0xff]; // Chrome light toolbar
const PAPER = [0x0b, 0x0d, 0x12]; // sheet background
const GRID = [0x2a, 0x2f, 0x3b];

const SMALL = [16, 32, 48];
const MAG = 6;

const PAD = 16;
const GAP = 14;
const GROUP_GAP = 26;
const ROW_H = 138;

function groupWidth(sizes) {
  return sizes.reduce((s, v) => s + v, 0) + GAP * (sizes.length - 1);
}

const COL_DARK = PAD;
const COL_LIGHT = COL_DARK + groupWidth(SMALL) + GROUP_GAP;
const COL_BIG = COL_LIGHT + groupWidth(SMALL) + GROUP_GAP;
const COL_MAG = COL_BIG + 128 + GROUP_GAP;
const W = COL_MAG + 16 * MAG + PAD;
const H = PAD + Object.keys(CONCEPTS).length * ROW_H + PAD;

const canvas = Buffer.alloc(W * H * 4);
for (let i = 0; i < W * H; i++) {
  canvas[i * 4] = PAPER[0];
  canvas[i * 4 + 1] = PAPER[1];
  canvas[i * 4 + 2] = PAPER[2];
  canvas[i * 4 + 3] = 255;
}

function fillRect(x0, y0, w, h, colour) {
  for (let y = y0; y < y0 + h; y++) {
    if (y < 0 || y >= H) continue;
    for (let x = x0; x < x0 + w; x++) {
      if (x < 0 || x >= W) continue;
      const o = (y * W + x) * 4;
      canvas[o] = colour[0];
      canvas[o + 1] = colour[1];
      canvas[o + 2] = colour[2];
      canvas[o + 3] = 255;
    }
  }
}

/// Alpha-composite an RGBA icon onto the sheet, optionally magnified.
function blit(rgba, size, dx, dy, mag) {
  const m = mag || 1;
  for (let y = 0; y < size * m; y++) {
    for (let x = 0; x < size * m; x++) {
      const s = (((y / m) | 0) * size + ((x / m) | 0)) * 4;
      const a = rgba[s + 3] / 255;
      if (a <= 0) continue;
      const px = dx + x;
      const py = dy + y;
      if (px < 0 || py < 0 || px >= W || py >= H) continue;
      const o = (py * W + px) * 4;
      for (let c = 0; c < 3; c++) {
        canvas[o + c] = Math.round(rgba[s + c] * a + canvas[o + c] * (1 - a));
      }
    }
  }
}

const names = Object.keys(CONCEPTS);
names.forEach((name, row) => {
  const shapes = CONCEPTS[name].shapes;
  const top = PAD + row * ROW_H;
  const mid = top + ROW_H / 2;

  // hairline between rows
  if (row > 0) fillRect(PAD, top - GAP, W - PAD * 2, 1, GRID);

  // dark toolbar group
  let x = COL_DARK;
  fillRect(x - 8, mid - 34, groupWidth(SMALL) + 16, 68, DARK);
  for (const size of SMALL) {
    blit(render(size, shapes), size, x, Math.round(mid - size / 2));
    x += size + GAP;
  }

  // light toolbar group
  x = COL_LIGHT;
  fillRect(x - 8, mid - 34, groupWidth(SMALL) + 16, 68, LIGHT);
  for (const size of SMALL) {
    blit(render(size, shapes), size, x, Math.round(mid - size / 2));
    x += size + GAP;
  }

  // full size, on the sheet background
  blit(render(128, shapes), 128, COL_BIG, Math.round(mid - 64));

  // 16 px magnified, on dark
  fillRect(COL_MAG - 4, mid - 16 * MAG / 2 - 4, 16 * MAG + 8, 16 * MAG + 8, DARK);
  blit(render(16, shapes), 16, COL_MAG, Math.round(mid - (16 * MAG) / 2), MAG);
});

const out = path.join(__dirname, '..', 'design', 'icon-contact.png');
fs.writeFileSync(out, encodePng2(W, H, canvas));
console.log('design/icon-contact.png  ' + W + 'x' + H);
console.log('rows, top to bottom: ' + names.join(', '));

// encodePng in icons.js assumes a square; this one takes both dimensions.
function encodePng2(w, h, rgba) {
  const zlib = require('zlib');
  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const CRC = (() => {
    const t = new Int32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[i] = c;
    }
    return t;
  })();
  const crc32 = (buf) => {
    let c = -1;
    for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body), 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
