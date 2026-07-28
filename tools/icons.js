#!/usr/bin/env node
// Generates the extension icons, and the candidate set used to choose between
// designs.
//
//   node tools/icons.js               cut the chosen concept into extension/icons
//   node tools/icons.js --candidates  cut every concept into design/icon-candidates
//
// Chrome's guidance drives the geometry here. Artwork occupies about 75% of the
// canvas with the rest transparent, there is no edge or tile around it because
// the browser may add its own, and it has to hold up on both light and dark
// toolbars. Anything that is not legible at 16 px is a redesign rather than a
// scale-down, so every concept is cut at 16 first and judged there.
//
// PNGs are encoded here with zlib, so there is no image dependency to install.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// ------------------------------------------------------------------- palette

// Named for what they mean, so a palette change cannot make the names lie.
//
// Chosen against two numbers that pull against each other. A mark has to sit on
// a white toolbar and a near-black one, and solving for equal contrast on both
// puts the ideal luminance at 0.208, worth 4.06:1 either way. Surviving
// greyscale needs the pair pushed apart in luminance, which costs contrast on
// one ground or the other. This pair sits at the knee: worst case 2.53:1 across
// both, with a luminance gap of 0.185. The teal and orange it replaced measured
// 2.05 and 0.018, so it is better on both counts.
const CYAN = [0xa8, 0xa2, 0x9c]; // ash, the original envelope
const AMBER = [0xd9, 0x3b, 0x2b]; // vermilion, where the warp puts it
const SLATE = [0x8a, 0x86, 0x81]; // structure, never meaning

// ------------------------------------------------------------------ concepts
// Everything is drawn in a 24 x 24 design box. Shapes paint in order.

/// Raised-cosine bump, used wherever a spectral envelope is drawn.
function hill(cx, halfW, peak, base, n = 64) {
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const x = cx - halfW + (2 * halfW * i) / n;
    const t = (x - cx) / halfW;
    pts.push([x, base - peak * 0.5 * (1 + Math.cos(Math.PI * t))]);
  }
  return pts;
}

/// A wave whose wavelength grows linearly from lam0 to lam1 across the span.
///
/// Integrating 2*pi/lambda(x) with lambda linear in x gives a logarithm, which
/// keeps the phase rate finite everywhere. A power law such as sqrt(t) does
/// not: its derivative is unbounded at the start, so the left edge collapses
/// into a solid block.
function decelWave(x0, x1, yMid, amp, lam0, lam1, n = 200) {
  const L = x1 - x0;
  const k = (2 * Math.PI * L) / (lam1 - lam0);
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const phase = k * Math.log((lam0 + (lam1 - lam0) * t) / lam0);
    pts.push([x0 + L * t, yMid - amp * Math.sin(phase)]);
  }
  return pts;
}

const WAVE = decelWave(2, 22, 12, 5.6, 4.2, 10.5);
const WAVE_SPLIT = Math.round(WAVE.length * 0.46);

const CONCEPTS = {
  arch: {
    title: 'Twin arch',
    blurb: 'One arch, and the same arch lifted. The current mark, retooled to Chrome’s padding and with the tile removed.',
    shapes: [
      { kind: 'arc', cx: 8.5, cy: 19.5, r: 5.5, w: 3.0, colour: CYAN },
      { kind: 'arc', cx: 14.5, cy: 13, r: 5.5, w: 3.0, colour: AMBER },
    ],
  },

  mass: {
    title: 'Solid and outline',
    blurb: 'A filled envelope and the outline of the same envelope, lifted. Filled mass is the shape that best survives being scaled to 16 px.',
    shapes: [
      { kind: 'fill', pts: hill(8.5, 6.5, 11, 20), base: 20, colour: CYAN },
      { kind: 'poly', pts: hill(15.5, 6.5, 11, 15), w: 2.6, colour: AMBER },
    ],
  },

  spectrum: {
    title: 'Moved peak',
    blurb: 'A bar spectrum whose peak has moved up and to the right. The most familiar audio idiom of the set.',
    shapes: [
      { kind: 'bar', x: 3.5, y0: 20, y1: 14.0, w: 3.0, colour: CYAN },
      { kind: 'bar', x: 7.6, y0: 20, y1: 9.5, w: 3.0, colour: CYAN },
      { kind: 'bar', x: 11.7, y0: 20, y1: 12.5, w: 3.0, colour: CYAN },
      { kind: 'bar', x: 15.8, y0: 20, y1: 6.0, w: 3.0, colour: AMBER },
      { kind: 'bar', x: 19.9, y0: 20, y1: 11.0, w: 3.0, colour: AMBER },
    ],
  },

  ticks: {
    title: 'Two-speed grid',
    blurb:
      'The resample rather than the warp: the same two beats, spread twice as far apart. Equal counts on each side, so spacing is the only variable and the eye has nothing else to attribute the difference to. One row of full-height ticks, because stacking two rows halves the vertical resolution and the mark collapses at 16 px.',
    shapes: [
      { kind: 'bar', x: 3.0, y0: 4.5, y1: 19.5, w: 3.0, colour: CYAN },
      { kind: 'bar', x: 7.0, y0: 4.5, y1: 19.5, w: 3.0, colour: CYAN },
      { kind: 'bar', x: 15.0, y0: 4.5, y1: 19.5, w: 3.0, colour: AMBER },
      { kind: 'bar', x: 23.0, y0: 4.5, y1: 19.5, w: 3.0, colour: AMBER },
    ],
  },

  lift: {
    title: 'Arch and rise',
    blurb: 'An envelope with a caret rising off it. The least ambiguous of the set about which way things move, and the least specific about what is moving.',
    shapes: [
      { kind: 'arc', cx: 12, cy: 20, r: 7, w: 3.2, colour: CYAN },
      { kind: 'poly', pts: [[6.5, 9.5], [12, 4], [17.5, 9.5]], w: 3.2, colour: AMBER },
    ],
  },

  stretch: {
    title: 'Stretched Ll',
    blurb: 'The two L letters the name is built on, drawn as ticks with feet. The second foot is stretched, so the letterform itself is the slowdown.',
    shapes: [
      { kind: 'poly', pts: [[5, 3.5], [5, 17], [10, 17]], w: 3, colour: CYAN },
      { kind: 'poly', pts: [[14, 3.5], [14, 17], [22, 17]], w: 3, colour: AMBER },
    ],
  },

  ritard: {
    title: 'Ritardando',
    blurb: 'One wave whose wavelength grows as it travels, cyan handing over to amber. It is a sound wave, it is a rocking motion, and it is the tempo dropping, all in one stroke.',
    shapes: [
      { kind: 'poly', pts: WAVE.slice(0, WAVE_SPLIT + 1), w: 2.6, colour: CYAN },
      { kind: 'poly', pts: WAVE.slice(WAVE_SPLIT), w: 2.6, colour: AMBER },
    ],
  },

  llama: {
    title: 'Llama',
    blurb: 'Head and neck in profile as a filled silhouette, ears picked out in amber. The most literal reading of the name, and the one that asks the most of 16 px.',
    shapes: [
      {
        kind: 'polyfill',
        colour: CYAN,
        pts: [
          [7.6, 22], [8.6, 14], [10.2, 8.4], [11.4, 6.2], [15.0, 6.4],
          [19.6, 8.2], [20.8, 10.6], [18.4, 11.6], [14.6, 11.2],
          [12.4, 14.5], [11.6, 22],
        ],
      },
      { kind: 'ellipse', cx: 11.6, cy: 3.4, rx: 1.5, ry: 3.4, rot: -14, colour: AMBER },
      { kind: 'ellipse', cx: 15.2, cy: 3.6, rx: 1.5, ry: 3.4, rot: 11, colour: AMBER },
    ],
  },

  faders: {
    title: 'Down and up',
    blurb: 'Two faders, one lowered and one raised: pitch down, formants up. The two opposing motions are the whole idea, and dots on lines read at any size.',
    shapes: [
      { kind: 'bar', x: 8.5, y0: 3.5, y1: 20.5, w: 1.8, colour: SLATE },
      { kind: 'bar', x: 15.5, y0: 3.5, y1: 20.5, w: 1.8, colour: SLATE },
      { kind: 'disc', cx: 8.5, cy: 16.5, r: 3.4, colour: CYAN },
      { kind: 'disc', cx: 15.5, cy: 7.5, r: 3.4, colour: AMBER },
    ],
  },
};

/// Which concept `extension/icons` is cut from.
///
/// The gap ratio in `ticks` is 2:1. The real one is 2^(3/12) = 1.19, which is
/// invisible at any icon size, so it is exaggerated deliberately.
const CHOSEN = 'ritard';

// ----------------------------------------------------------------- rasteriser

function sdSegment(px, py, ax, ay, bx, by) {
  const vx = bx - ax;
  const vy = by - ay;
  const wx = px - ax;
  const wy = py - ay;
  const len2 = vx * vx + vy * vy;
  const t = len2 > 0 ? Math.max(0, Math.min(1, (wx * vx + wy * vy) / len2)) : 0;
  return Math.hypot(px - (ax + vx * t), py - (ay + vy * t));
}

/// True if the point is painted by this shape, in design units.
function hits(shape, x, y) {
  switch (shape.kind) {
    case 'arc': {
      // Upper half circle with round caps.
      const d =
        y <= shape.cy
          ? Math.abs(Math.hypot(x - shape.cx, y - shape.cy) - shape.r)
          : Math.min(
              Math.hypot(x - (shape.cx - shape.r), y - shape.cy),
              Math.hypot(x - (shape.cx + shape.r), y - shape.cy)
            );
      return d <= shape.w / 2;
    }
    case 'poly': {
      let d = Infinity;
      for (let i = 0; i + 1 < shape.pts.length; i++) {
        const a = shape.pts[i];
        const b = shape.pts[i + 1];
        d = Math.min(d, sdSegment(x, y, a[0], a[1], b[0], b[1]));
        if (d <= shape.w / 2) return true;
      }
      return d <= shape.w / 2;
    }
    case 'fill': {
      const pts = shape.pts;
      if (x < pts[0][0] || x > pts[pts.length - 1][0]) return false;
      // Curve is sampled on a uniform x grid, so the index is direct.
      const span = pts[pts.length - 1][0] - pts[0][0];
      const f = ((x - pts[0][0]) / span) * (pts.length - 1);
      const i = Math.min(pts.length - 2, Math.max(0, Math.floor(f)));
      const t = f - i;
      const top = pts[i][1] + (pts[i + 1][1] - pts[i][1]) * t;
      return y >= top && y <= shape.base;
    }
    case 'bar':
      return sdSegment(x, y, shape.x, shape.y0, shape.x, shape.y1) <= shape.w / 2;
    case 'disc':
      return Math.hypot(x - shape.cx, y - shape.cy) <= shape.r;
    case 'polyfill': {
      // Ray casting. Lets a silhouette be described by its outline.
      const p = shape.pts;
      let inside = false;
      for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
        const yi = p[i][1];
        const yj = p[j][1];
        if (yi > y !== yj > y) {
          const t = (y - yi) / (yj - yi);
          if (x < p[i][0] + t * (p[j][0] - p[i][0])) inside = !inside;
        }
      }
      return inside;
    }
    case 'ellipse': {
      const a = ((shape.rot || 0) * Math.PI) / 180;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      const dx = x - shape.cx;
      const dy = y - shape.cy;
      const u = (dx * ca + dy * sa) / shape.rx;
      const v = (-dx * sa + dy * ca) / shape.ry;
      return u * u + v * v <= 1;
    }
    default:
      return false;
  }
}

function boundsOf(shapes) {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  const grow = (ax, ay, bx, by) => {
    x0 = Math.min(x0, ax);
    y0 = Math.min(y0, ay);
    x1 = Math.max(x1, bx);
    y1 = Math.max(y1, by);
  };
  for (const s of shapes) {
    const half = (s.w || 0) / 2;
    switch (s.kind) {
      case 'arc':
        grow(s.cx - s.r - half, s.cy - s.r - half, s.cx + s.r + half, s.cy + half);
        break;
      case 'poly':
        for (const p of s.pts) grow(p[0] - half, p[1] - half, p[0] + half, p[1] + half);
        break;
      case 'polyfill':
        for (const p of s.pts) grow(p[0], p[1], p[0], p[1]);
        break;
      case 'fill':
        for (const p of s.pts) grow(p[0], p[1], p[0], p[1]);
        grow(x0, s.base, x1, s.base);
        break;
      case 'bar':
        grow(s.x - half, Math.min(s.y0, s.y1) - half, s.x + half, Math.max(s.y0, s.y1) + half);
        break;
      case 'disc':
        grow(s.cx - s.r, s.cy - s.r, s.cx + s.r, s.cy + s.r);
        break;
      case 'ellipse': {
        // Conservative box, so a rotation cannot clip the shape.
        const r = Math.max(s.rx, s.ry);
        grow(s.cx - r, s.cy - r, s.cx + r, s.cy + r);
        break;
      }
      default:
        break;
    }
  }
  return { x0, y0, w: x1 - x0, h: y1 - y0 };
}

const SUPERSAMPLE = 8;
/// Fraction of the canvas the artwork spans. Chrome asks for 96 of 128.
const SAFE = 0.75;

function render(size, shapes) {
  const ss = SUPERSAMPLE;
  const n = size * ss;
  const acc = new Float64Array(size * size * 4);

  const b = boundsOf(shapes);
  // Small icons get a little more room, or the mark shrinks into nothing.
  const safe = size <= 20 ? 0.92 : size <= 32 ? 0.84 : SAFE;
  const scale = (size * safe) / Math.max(b.w, b.h);
  const offX = (size - b.w * scale) / 2 - b.x0 * scale;
  const offY = (size - b.h * scale) / 2 - b.y0 * scale;

  for (let py = 0; py < n; py++) {
    const dy = ((py + 0.5) / ss - offY) / scale;
    for (let px = 0; px < n; px++) {
      const dx = ((px + 0.5) / ss - offX) / scale;

      let colour = null;
      for (const s of shapes) if (hits(s, dx, dy)) colour = s.colour;
      if (!colour) continue;

      const o = (((py / ss) | 0) * size + ((px / ss) | 0)) * 4;
      acc[o] += colour[0] * 255;
      acc[o + 1] += colour[1] * 255;
      acc[o + 2] += colour[2] * 255;
      acc[o + 3] += 255;
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

const SIZES = [16, 32, 48, 128];

function cut(shapes, dir, prefix) {
  fs.mkdirSync(dir, { recursive: true });
  const written = [];
  for (const size of SIZES) {
    const png = encodePng(size, render(size, shapes));
    const file = path.join(dir, `${prefix}${size}.png`);
    fs.writeFileSync(file, png);
    written.push({ size, file, bytes: png.length });
  }
  return written;
}

module.exports = { CONCEPTS, CHOSEN, SIZES, render, encodePng };

/// Emits the chosen mark as inline SVG, so the copies in the panel and the
/// popup are generated from the same geometry as the PNGs instead of being
/// redrawn by hand and drifting.
function svgFor(name, every = 4) {
  const c = CONCEPTS[name];
  const b = boundsOf(c.shapes);
  const r = (v) => Math.round(v * 10) / 10;
  const parts = [];
  for (const s of c.shapes) {
    const col = '#' + s.colour.map((v) => v.toString(16).padStart(2, '0')).join('');
    if (s.kind === 'poly') {
      const pts = s.pts.filter((_, i) => i % every === 0 || i === s.pts.length - 1);
      const d = pts.map((p, i) => (i ? 'L' : 'M') + r(p[0]) + ' ' + r(p[1])).join('');
      parts.push({ d, col, w: s.w });
    } else if (s.kind === 'bar') {
      parts.push({ d: 'M' + r(s.x) + ' ' + r(s.y0) + 'L' + r(s.x) + ' ' + r(s.y1), col, w: s.w });
    } else {
      throw new Error('svgFor does not handle shape kind: ' + s.kind);
    }
  }
  return {
    viewBox: [r(b.x0), r(b.y0), r(b.w), r(b.h)].join(' '),
    ratio: b.w / b.h,
    parts,
  };
}

if (require.main === module) {
  const root = path.join(__dirname, '..');
  if (process.argv.includes('--svg')) {
    const name = process.argv[process.argv.indexOf('--svg') + 1] || CHOSEN;
    const s = svgFor(name);
    console.log(JSON.stringify({ name, ...s }, null, 2));
  } else if (process.argv.includes('--candidates')) {
    for (const [name, c] of Object.entries(CONCEPTS)) {
      const out = cut(c.shapes, path.join(root, 'design', 'icon-candidates', name), 'icon');
      console.log(name.padEnd(10) + c.title.padEnd(20) + out.map((w) => w.bytes + 'B').join('  '));
    }
  } else {
    const c = CONCEPTS[CHOSEN];
    if (!c) throw new Error('unknown concept: ' + CHOSEN);
    for (const w of cut(c.shapes, path.join(root, 'extension', 'icons'), 'icon')) {
      console.log(`icons/icon${w.size}.png  ${w.size}x${w.size}  ${w.bytes} bytes`);
    }
  }
}
