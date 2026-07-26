#!/usr/bin/env node
// Test signal generator.
//
//   node tools/testsig.js tone out.wav      stationary voiced-like tone, two
//                                           formants, no noise. Use this one
//                                           for verification.
//   node tools/testsig.js material out.wav  same tone plus hi-hat-ish bursts
//                                           and a low sine. Use this one for
//                                           listening to transient behaviour.

const fs = require('fs');

const SR = 48000;
const SECONDS = 6;

function writeWav(file, chans) {
  const n = chans[0].length;
  const nch = chans.length;
  const dataLen = n * nch * 2;
  const b = Buffer.alloc(44 + dataLen);
  b.write('RIFF', 0, 'ascii');
  b.writeUInt32LE(36 + dataLen, 4);
  b.write('WAVE', 8, 'ascii');
  b.write('fmt ', 12, 'ascii');
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(nch, 22);
  b.writeUInt32LE(SR, 24);
  b.writeUInt32LE(SR * nch * 2, 28);
  b.writeUInt16LE(nch * 2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36, 'ascii');
  b.writeUInt32LE(dataLen, 40);
  let o = 44;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < nch; c++) {
      const q = Math.max(-1, Math.min(1, chans[c][i]));
      b.writeInt16LE(Math.round(q * 32767), o);
      o += 2;
    }
  }
  fs.writeFileSync(file, b);
}

const F0 = 140;
const FORMANTS = [
  { f: 800, bw: 260, a: 1.0 },
  { f: 2300, bw: 420, a: 0.55 },
  { f: 3400, bw: 600, a: 0.2 },
];

function voiced(n, fScale) {
  const s = fScale || 1;
  const x = new Float64Array(n);
  for (let h = 1; h * F0 < SR / 2 - 200; h++) {
    const f = F0 * h;
    let a = 0.008;
    for (const fm of FORMANTS) a += fm.a * Math.exp(-Math.pow((f - fm.f * s) / (fm.bw * s), 2));
    a *= Math.pow(F0 / f, 0.35); // gentle source tilt
    const ph = (h * 2.399) % (2 * Math.PI); // fixed, non-aligned phases
    for (let i = 0; i < n; i++) x[i] += a * Math.sin((2 * Math.PI * f * i) / SR + ph);
  }
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(x[i]));
  for (let i = 0; i < n; i++) x[i] /= peak;
  return x;
}

const mode = process.argv[2] || 'tone';
const out = process.argv[3] || (mode === 'tone' ? 'test-tone.wav' : 'test-material.wav');
// Optional third argument scales the formant frequencies without touching f0.
// Used to build a ground-truth pair for checking the analyser itself.
const fScale = process.argv[4] ? parseFloat(process.argv[4]) : 1;
const n = SR * SECONDS;
const base = voiced(n, fScale);

const L = new Float64Array(n);
const R = new Float64Array(n);

for (let i = 0; i < n; i++) {
  L[i] = base[i] * 0.4;
  R[i] = base[i] * 0.36;
}

if (mode === 'material') {
  let seed = 12345;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x3fffffff - 1;
  };
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    // hat every 250 ms
    const ph = i % (SR / 4);
    if (ph < SR / 40) {
      const env = Math.exp(-ph / (SR / 300));
      const v = rnd() * 0.35 * env;
      L[i] += v;
      R[i] += v * 0.8;
    }
    // sub sine, to hear what the crossover protects
    const sub = Math.sin(2 * Math.PI * 55 * t) * 0.25;
    L[i] += sub;
    R[i] += sub;
  }
}

// Leave headroom. The warp can add a few dB in places, and a clipped test
// signal tells you nothing about the algorithm.
let peak = 0;
for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
const norm = 0.6 / (peak || 1);
for (let i = 0; i < n; i++) {
  L[i] *= norm;
  R[i] *= norm;
}

writeWav(out, [L, R]);
console.log('wrote ' + out + '  ' + mode + '  ' + SECONDS + 's  f0 ' + F0 + ' Hz  formants ' + FORMANTS.map((f) => f.f).join('/') + ' Hz');
