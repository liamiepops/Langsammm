#!/usr/bin/env node
// Dumps the real envelope, the warped envelope and the resulting gain curve
// for one analysis frame, as JSON. Used to build UI mockups against the actual
// shape rather than an invented one.
//
//   node tools/envsnap.js slowed.wav [--envres 500] [--semitones 3] [--at 2.0]

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

const args = process.argv.slice(2);
const file = args[0];
const opt = { envres: 500, semitones: 3, at: 2.0 };
for (let i = 1; i < args.length; i++) {
  if (args[i].startsWith('--')) opt[args[i].slice(2)] = parseFloat(args[++i]);
}
if (!file) {
  console.error('usage: node tools/envsnap.js slowed.wav [--envres 500] [--at 2.0]');
  process.exit(1);
}

const N = 2048;
const { x, rate } = read(file);
const start = Math.min(Math.floor(opt.at * rate), x.length - N - 1);

const re = new Float64Array(N);
const im = new Float64Array(N);
for (let i = 0; i < N; i++) re[i] = x[start + i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N));
fft(re, im, N);

const half = N / 2;
const mag = new Float64Array(half + 1);
for (let k = 0; k <= half; k++) mag[k] = Math.hypot(re[k], im[k]);

// cepstrum of the log magnitude
const cr = new Float64Array(N);
const ci = new Float64Array(N);
for (let k = 0; k <= half; k++) cr[k] = Math.log(Math.max(mag[k], 1e-9));
for (let k = half + 1; k < N; k++) cr[k] = cr[N - k];
fft(cr, ci, N);
for (let i = 0; i < N; i++) cr[i] /= N;

const q = Math.round(rate / opt.envres);
const er = new Float64Array(N);
const ei = new Float64Array(N);
for (let m = 0; m <= q; m++) {
  er[m] = cr[m];
  if (m > 0) er[N - m] = cr[N - m];
}
fft(er, ei, N);

const rho = Math.pow(2, opt.semitones / 12);
const env = new Float64Array(half + 1);
const warped = new Float64Array(half + 1);
for (let k = 0; k <= half; k++) env[k] = er[k];
for (let k = 0; k <= half; k++) {
  const src = k / rho;
  const i0 = Math.min(Math.floor(src), half);
  const i1 = Math.min(i0 + 1, half);
  warped[k] = env[i0] + (env[i1] - env[i0]) * (src - i0);
}

// sample onto a log-frequency axis for plotting
const M = 180;
const fLo = 60;
const fHi = 16000;
const out = { rate, envres: opt.envres, semitones: opt.semitones, f: [], mag: [], env: [], warped: [], gainDb: [] };
const toDb = (nat) => (20 * nat) / Math.LN10;
for (let i = 0; i < M; i++) {
  const f = fLo * Math.pow(fHi / fLo, i / (M - 1));
  const kx = (f * N) / rate;
  const k = Math.min(Math.floor(kx), half - 1);
  const t = kx - k;
  const lerp = (a) => a[k] + (a[k + 1] - a[k]) * t;
  out.f.push(+f.toFixed(1));
  out.mag.push(+toDb(Math.log(Math.max(lerp(mag), 1e-9))).toFixed(2));
  out.env.push(+toDb(lerp(env)).toFixed(2));
  out.warped.push(+toDb(lerp(warped)).toFixed(2));
  out.gainDb.push(+toDb(lerp(warped) - lerp(env)).toFixed(2));
}
console.log(JSON.stringify(out));
