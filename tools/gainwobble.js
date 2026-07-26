#!/usr/bin/env node
// How much gain is applied, and how steady it is.
//
//   node tools/gainwobble.js dry.wav wet.wav
//
// Files must be sample aligned, which renders from render.js are. Computes the
// per-frame per-bin gain the warp applied, then reports two things:
//
//   depth   mean |log gain|, in dB. How hard the warp is working.
//   wobble  standard deviation over time of the log gain, per bin, averaged.
//           This is the part that is not a fixed filter. A steady gain curve
//           is heard as a timbre change. A fluctuating one is heard as
//           modulation, which is what shimmer and phasiness are.

const fs = require('fs');

function read(file) {
  const b = fs.readFileSync(file);
  const ch = b.readUInt16LE(22);
  const bits = b.readUInt16LE(34);
  const fmt = b.readUInt16LE(20);
  let pos = 12;
  let data = null;
  while (pos + 8 <= b.length) {
    const id = b.toString('ascii', pos, pos + 4);
    const sz = b.readUInt32LE(pos + 4);
    if (id === 'data') data = b.subarray(pos + 8, pos + 8 + sz);
    pos += 8 + sz + (sz & 1);
  }
  const by = bits >> 3;
  const n = Math.floor(data.length / (by * ch));
  const x = new Float64Array(n);
  const full = 32768;
  for (let i = 0; i < n; i++) {
    const o = i * ch * by;
    x[i] = fmt === 3 ? data.readFloatLE(o) : data.readInt16LE(o) / full;
  }
  return { x, rate: b.readUInt32LE(24) };
}

function fft(re, im, n) {
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i];
      re[i] = re[j];
      re[j] = t;
      t = im[i];
      im[i] = im[j];
      im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < len / 2; k++) {
        const wr = Math.cos(ang * k);
        const wi = Math.sin(ang * k);
        const a = i + k;
        const b = a + len / 2;
        const vr = re[b] * wr - im[b] * wi;
        const vi = re[b] * wi + im[b] * wr;
        re[b] = re[a] - vr;
        im[b] = im[a] - vi;
        re[a] += vr;
        im[a] += vi;
      }
    }
  }
}

const N = 2048;
const HOP = 512;

function frames(x) {
  const out = [];
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  for (let s = 0; s + N < x.length; s += HOP) {
    re.fill(0);
    im.fill(0);
    for (let i = 0; i < N; i++) re[i] = x[s + i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N));
    fft(re, im, N);
    const mag = new Float64Array(N / 2 + 1);
    for (let k = 0; k <= N / 2; k++) mag[k] = Math.hypot(re[k], im[k]);
    out.push(mag);
  }
  return out;
}

const [fa, fb] = process.argv.slice(2);
if (!fa || !fb) {
  console.error('usage: node tools/gainwobble.js dry.wav wet.wav');
  process.exit(1);
}
const A = read(fa);
const B = read(fb);
const fa2 = frames(A.x);
const fb2 = frames(B.x);
const nf = Math.min(fa2.length, fb2.length);
const rate = A.rate;

const kLo = Math.round((200 * N) / rate);
const kHi = Math.round((6000 * N) / rate);

// Only look at bins that actually carry signal, otherwise the gain is a ratio
// of two noise floors.
const floor = (() => {
  let peak = 0;
  for (let f = 0; f < nf; f++) for (let k = kLo; k < kHi; k++) peak = Math.max(peak, fa2[f][k]);
  return peak * 1e-3;
})();

let depthSum = 0;
let depthN = 0;
let wobbleSum = 0;
let wobbleN = 0;

for (let k = kLo; k < kHi; k++) {
  const vals = [];
  for (let f = 0; f < nf; f++) {
    if (fa2[f][k] < floor) continue;
    vals.push(Math.log(fb2[f][k] / fa2[f][k]));
  }
  if (vals.length < 8) continue;
  const mean = vals.reduce((s, v) => s + v, 0) / vals.length;
  let va = 0;
  for (const v of vals) va += (v - mean) * (v - mean);
  const sd = Math.sqrt(va / vals.length);
  depthSum += Math.abs(mean);
  depthN++;
  wobbleSum += sd;
  wobbleN++;
}

const toDb = (nat) => (20 * nat) / Math.LN10;
console.log(
  'depth  ' +
    toDb(depthSum / depthN).toFixed(2) +
    ' dB     wobble  ' +
    toDb(wobbleSum / wobbleN).toFixed(2) +
    ' dB'
);
