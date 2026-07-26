#!/usr/bin/env node
// Measures what the warp actually did to a rendered pair.
//
//   node tools/analyse.js dry.wav wet.wav
//
// Two numbers matter. The spectral envelope should move up by the shift
// interval, and the harmonic spacing should not move at all. Both are measured
// without peak picking: the envelope shift comes from cross-correlating the two
// log-envelopes on a log-frequency axis, and the pitch comes from the cepstral
// peak quefrency.

const fs = require('fs');

function readMono(file) {
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
  const out = new Float64Array(n);
  const full = 32768;
  for (let i = 0; i < n; i++) {
    const o = i * ch * by;
    out[i] = fmt === 3 ? data.readFloatLE(o) : data.readInt16LE(o) / full;
  }
  return { x: out, rate: b.readUInt32LE(24) };
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

/// Averaged magnitude spectrum, bins 0..N/2.
function welch(x, off) {
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  const acc = new Float64Array(N / 2 + 1);
  let frames = 0;
  for (let s = off; s + N < x.length; s += N / 2) {
    re.fill(0);
    im.fill(0);
    for (let i = 0; i < N; i++) re[i] = x[s + i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N));
    fft(re, im, N);
    for (let k = 0; k <= N / 2; k++) acc[k] += Math.hypot(re[k], im[k]);
    frames++;
  }
  for (let k = 0; k < acc.length; k++) acc[k] /= frames || 1;
  return acc;
}

/// Real cepstrum of a log magnitude spectrum, length N.
function cepstrum(spec) {
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  for (let k = 0; k <= N / 2; k++) re[k] = Math.log(Math.max(spec[k], 1e-12));
  for (let k = N / 2 + 1; k < N; k++) re[k] = re[N - k];
  fft(re, im, N);
  for (let i = 0; i < N; i++) re[i] /= N;
  return re;
}

/// Cepstrally smoothed log envelope, same lifter idea as the DSP core.
function logEnvelope(spec, q) {
  const c = cepstrum(spec);
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  for (let m = 0; m <= q; m++) {
    re[m] = c[m];
    if (m > 0) re[N - m] = c[N - m];
  }
  fft(re, im, N);
  return re.subarray(0, N / 2 + 1);
}

/// Sample a log-magnitude curve onto a log-frequency grid.
function onLogF(env, sr, fLo, fHi, M) {
  const out = new Float64Array(M);
  const d = Math.log(fHi / fLo) / (M - 1);
  for (let i = 0; i < M; i++) {
    const f = fLo * Math.exp(i * d);
    const x = (f * N) / sr;
    const k = Math.floor(x);
    const t = x - k;
    const a = env[Math.min(k, N / 2)];
    const b = env[Math.min(k + 1, N / 2)];
    out[i] = a + (b - a) * t;
  }
  return { y: out, d };
}

/// Subtract the best-fit straight line. The broadband spectral tilt is a ramp,
/// and correlating a ramp against a shifted copy of itself peaks near zero lag
/// whatever the true shift is. Removing it leaves the formant structure, which
/// is the thing that actually carries the shift.
function detrend(v) {
  const n = v.length;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    sx += i;
    sy += v[i];
    sxx += i * i;
    sxy += i * v[i];
  }
  const slope = (n * sxy - sx * sy) / (n * sxx - sx * sx);
  const icept = (sy - slope * sx) / n;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = v[i] - (slope * i + icept);
  return out;
}

/// Lag L maximising the normalised correlation of ref[i - L] against
/// shifted[i]. Positive L means `shifted` sits above `ref` on the axis.
/// Normalising over the overlap stops short overlaps from scoring highly.
function bestLag(ref, shifted, maxLag) {
  const a = detrend(ref);
  const b = detrend(shifted);
  const score = (lag) => {
    let num = 0;
    let da = 0;
    let db = 0;
    let n = 0;
    for (let i = 0; i < b.length; i++) {
      const j = i - lag;
      if (j < 0 || j >= a.length) continue;
      num += a[j] * b[i];
      da += a[j] * a[j];
      db += b[i] * b[i];
      n++;
    }
    if (n < b.length / 2) return -Infinity;
    const den = Math.sqrt(da * db);
    return den > 0 ? num / den : -Infinity;
  };
  let best = 0;
  let bv = -Infinity;
  for (let lag = -maxLag; lag <= maxLag; lag++) {
    const v = score(lag);
    if (v > bv) {
      bv = v;
      best = lag;
    }
  }
  const y0 = score(best - 1);
  const y1 = bv;
  const y2 = score(best + 1);
  const denom = y0 - 2 * y1 + y2;
  const adj = denom !== 0 ? (0.5 * (y0 - y2)) / denom : 0;
  return best + Math.max(-1, Math.min(1, adj));
}

/// Pitch from the cepstral peak.
function pitch(spec, sr) {
  const c = cepstrum(spec);
  const lo = Math.floor(sr / 500);
  const hi = Math.min(Math.floor(sr / 50), N / 2);
  let bi = lo;
  let bv = -Infinity;
  for (let m = lo; m < hi; m++) {
    if (c[m] > bv) {
      bv = c[m];
      bi = m;
    }
  }
  return sr / bi;
}

const [fa, fb] = process.argv.slice(2);
if (!fa || !fb) {
  console.error('usage: node tools/analyse.js dry.wav wet.wav');
  process.exit(1);
}

const A = readMono(fa);
const B = readMono(fb);
const sr = A.rate;
const off = Math.min(20000, Math.floor(A.x.length / 4));

const specA = welch(A.x, off);
const specB = welch(B.x, off);

// q = sr / envelope resolution, matching the default 500 Hz in the DSP but
// scaled to this transform size.
const q = Math.round(N / (sr / 500));
const envA = logEnvelope(specA, q);
const envB = logEnvelope(specB, q);

const M = 900;
const ga = onLogF(envA, sr, 200, 8000, M);
const gb = onLogF(envB, sr, 200, 8000, M);
const lag = bestLag(ga.y, gb.y, Math.round(Math.log(2) / ga.d));
const semis = (12 * lag * ga.d) / Math.log(2);

const pa = pitch(specA, sr);
const pb = pitch(specB, sr);

console.log('envelope shift    ' + semis.toFixed(3) + ' st   (ratio ' + Math.pow(2, semis / 12).toFixed(4) + ')');
console.log('pitch             ' + pa.toFixed(2) + ' Hz -> ' + pb.toFixed(2) + ' Hz   (ratio ' + (pb / pa).toFixed(4) + ')');
console.log(
  '\nCalibration note: this estimator is exact at zero lag but compresses large\n' +
    'shifts, because the parts of the spectrum with no formant structure match\n' +
    'best at lag zero and dilute the correlation. Measured against a synthetic\n' +
    'pair built exactly 3 st apart it reads about 1.9 st. So use it this way:\n' +
    '  analyse original.wav warped.wav   -> should read close to 0\n' +
    'rather than trusting the magnitude of a large reported shift.'
);
