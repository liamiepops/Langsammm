#!/usr/bin/env node
// Octave-band difference between two renders.
//
//   node tools/banddiff.js a.wav b.wav
//
// Both files must be the same length and sample aligned, which renders from
// render.js are. Reports, per band, the level of each file and the level of
// the difference signal relative to file A. A difference far below the signal
// means the setting you changed did nothing in that band.

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

const N = 8192;

function bandEnergy(x, rate, edges) {
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  const acc = new Float64Array(edges.length - 1);
  let frames = 0;
  for (let s = 0; s + N < x.length; s += N) {
    re.fill(0);
    im.fill(0);
    for (let i = 0; i < N; i++) re[i] = x[s + i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N));
    fft(re, im, N);
    for (let bnd = 0; bnd < edges.length - 1; bnd++) {
      const k0 = Math.max(1, Math.round((edges[bnd] * N) / rate));
      const k1 = Math.min(N / 2, Math.round((edges[bnd + 1] * N) / rate));
      let e = 0;
      for (let k = k0; k < k1; k++) e += re[k] * re[k] + im[k] * im[k];
      acc[bnd] += e;
    }
    frames++;
  }
  for (let i = 0; i < acc.length; i++) acc[i] /= frames || 1;
  return acc;
}

const [fa, fb] = process.argv.slice(2);
if (!fa || !fb) {
  console.error('usage: node tools/banddiff.js a.wav b.wav');
  process.exit(1);
}
const A = read(fa);
const B = read(fb);
const n = Math.min(A.x.length, B.x.length);
const d = new Float64Array(n);
for (let i = 0; i < n; i++) d[i] = A.x[i] - B.x[i];

const edges = [20, 60, 120, 250, 500, 1000, 2000, 4000, 8000, 16000];
const ea = bandEnergy(A.x.subarray(0, n), A.rate, edges);
const ed = bandEnergy(d, A.rate, edges);

const db = (v) => (v > 0 ? (10 * Math.log10(v)).toFixed(1) : '-inf');
console.log('band'.padEnd(14) + 'A level'.padStart(10) + 'diff'.padStart(10) + '   diff re A');
for (let i = 0; i < ea.length; i++) {
  const rel = ea[i] > 0 ? 10 * Math.log10(ed[i] / ea[i]) : 0;
  const label = edges[i] + '-' + edges[i + 1] + ' Hz';
  console.log(
    label.padEnd(14) +
      db(ea[i]).padStart(10) +
      db(ed[i]).padStart(10) +
      '   ' +
      rel.toFixed(1) +
      ' dB' +
      (rel < -40 ? '   (inaudible)' : rel > -12 ? '   <-- big' : '')
  );
}
