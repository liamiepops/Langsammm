#!/usr/bin/env node
// Offline renderer. Same wasm core as the extension, so what you hear here is
// what the browser will do.
//
//   node tools/render.js in.wav out.wav [options]
//
// Render the plain slowed reference with --amount 0 and the warped version
// with --amount 1, then compare the two files.

const fs = require('fs');
const path = require('path');

// ------------------------------------------------------------------- wav i/o

function readWav(buf) {
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('not a RIFF/WAVE file');
  }
  let pos = 12;
  let fmt = null;
  let data = null;
  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    const body = buf.subarray(pos + 8, pos + 8 + size);
    if (id === 'fmt ') {
      fmt = {
        format: body.readUInt16LE(0),
        channels: body.readUInt16LE(2),
        rate: body.readUInt32LE(4),
        bits: body.readUInt16LE(14),
      };
      if (fmt.format === 0xfffe && size >= 26) fmt.format = body.readUInt16LE(24);
    } else if (id === 'data') {
      data = body;
    }
    pos += 8 + size + (size & 1);
  }
  if (!fmt || !data) throw new Error('missing fmt or data chunk');

  const { channels, bits, format } = fmt;
  const bytes = bits >> 3;
  const frames = Math.floor(data.length / (bytes * channels));
  const out = [];
  for (let c = 0; c < channels; c++) out.push(new Float32Array(frames));

  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) {
      const o = (i * channels + c) * bytes;
      let v;
      if (format === 3) {
        v = bytes === 8 ? data.readDoubleLE(o) : data.readFloatLE(o);
      } else if (bits === 16) {
        v = data.readInt16LE(o) / 32768;
      } else if (bits === 24) {
        v = ((data[o] | (data[o + 1] << 8) | (data[o + 2] << 24 >> 8)) << 8) / 2147483648;
      } else if (bits === 32) {
        v = data.readInt32LE(o) / 2147483648;
      } else if (bits === 8) {
        v = (data[o] - 128) / 128;
      } else {
        throw new Error('unsupported bit depth ' + bits);
      }
      out[c][i] = v;
    }
  }
  return { rate: fmt.rate, channels: out };
}

function writeWav(file, rate, chans, float) {
  const n = chans[0].length;
  const nch = chans.length;
  const bytes = float ? 4 : 2;
  const dataLen = n * nch * bytes;
  const buf = Buffer.alloc(44 + dataLen);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataLen, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(float ? 3 : 1, 20);
  buf.writeUInt16LE(nch, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * nch * bytes, 28);
  buf.writeUInt16LE(nch * bytes, 32);
  buf.writeUInt16LE(bytes * 8, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataLen, 40);

  let o = 44;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < nch; c++) {
      const v = chans[c][i];
      if (float) {
        buf.writeFloatLE(v, o);
      } else {
        const q = Math.max(-1, Math.min(1, v));
        buf.writeInt16LE(Math.round(q * 32767), o);
      }
      o += bytes;
    }
  }
  fs.writeFileSync(file, buf);
}

// ------------------------------------------------------------------ resample

// Catmull-Rom. rate < 1 means we read the source slowly, so this is pure
// interpolation and there is nothing to alias.
function resample(x, rate) {
  const outLen = Math.floor(x.length / rate);
  const y = new Float32Array(outLen);
  const at = (i) => x[Math.max(0, Math.min(x.length - 1, i))];
  for (let j = 0; j < outLen; j++) {
    const t = j * rate;
    const i = Math.floor(t);
    const f = t - i;
    const p0 = at(i - 1);
    const p1 = at(i);
    const p2 = at(i + 1);
    const p3 = at(i + 2);
    const a = -0.5 * p0 + 1.5 * p1 - 1.5 * p2 + 0.5 * p3;
    const b = p0 - 2.5 * p1 + 2 * p2 - 0.5 * p3;
    const c = -0.5 * p0 + 0.5 * p2;
    y[j] = ((a * f + b) * f + c) * f + p1;
  }
  return y;
}

// ----------------------------------------------------------------------- cli

const args = process.argv.slice(2);
const positional = [];
const opt = {
  semitones: 3,
  amount: 1,
  stereo: 'lr',
  side: 1,
  crossover: 0,
  transient: 0,
  envres: 500,
  fft: 2048,
  loud: true,
  float: false,
  ceiling: 0.99,
};
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--noloud') opt.loud = false;
  else if (a === '--float') opt.float = true;
  else if (a.startsWith('--')) opt[a.slice(2)] = args[++i];
  else positional.push(a);
}
if (positional.length < 2) {
  console.error(
    'usage: node tools/render.js in.wav out.wav [--semitones 3] [--amount 1]\n' +
      '       [--stereo lr|ms] [--side 1] [--crossover 0] [--transient 0]\n' +
      '       [--envres 500] [--fft 2048] [--noloud] [--float] [--ceiling 0.99]\n\n' +
      'Use --ceiling 0 --float to hear the effect with nothing holding the peaks down.'
  );
  process.exit(1);
}
const num = (v) => (typeof v === 'number' ? v : parseFloat(v));

const semitones = num(opt.semitones);
const rate = Math.pow(2, -semitones / 12);
const shiftRatio = 1 / rate;

// --------------------------------------------------------------------- render

const wasmPath = path.join(__dirname, '..', 'extension', 'slowform.wasm');
const mod = new WebAssembly.Module(fs.readFileSync(wasmPath));
const ex = new WebAssembly.Instance(mod, {}).exports;

const input = readWav(fs.readFileSync(positional[0]));
let chans = input.channels.map((c) => resample(c, rate));
if (chans.length === 1) chans = [chans[0], Float32Array.from(chans[0])];
if (chans.length > 2) chans = chans.slice(0, 2);

const proc = ex.sf_new(input.rate, num(opt.fft));
const BLOCK = 128;
const lp = ex.sf_alloc(BLOCK);
const rp = ex.sf_alloc(BLOCK);
const P_COUNT = 9;
const pp = ex.sf_alloc(P_COUNT);
const mem = () => ex.memory.buffer;

const pv = new Float32Array(mem(), pp, P_COUNT);
pv[0] = num(opt.amount); // mid / L wet
pv[1] = opt.stereo === 'ms' ? num(opt.side) : num(opt.amount); // side / R wet
pv[2] = num(opt.crossover);
pv[3] = num(opt.transient);
pv[4] = opt.stereo === 'ms' ? 1 : 0;
pv[5] = num(opt.envres);
pv[6] = shiftRatio;
pv[7] = opt.loud ? 1 : 0;
pv[8] = num(opt.ceiling);
ex.sf_set_params(proc, pp, P_COUNT);

const lv = new Float32Array(mem(), lp, BLOCK);
const rv = new Float32Array(mem(), rp, BLOCK);
const n = chans[0].length;
const outL = new Float32Array(n);
const outR = new Float32Array(n);

for (let i = 0; i < n; i += BLOCK) {
  const m = Math.min(BLOCK, n - i);
  lv.set(chans[0].subarray(i, i + m));
  rv.set(chans[1].subarray(i, i + m));
  if (m < BLOCK) {
    lv.fill(0, m);
    rv.fill(0, m);
  }
  ex.sf_process(proc, lp, rp, m);
  outL.set(lv.subarray(0, m), i);
  outR.set(rv.subarray(0, m), i);
}

// Undo the analysis delay so the output lines up with a --amount 0 render
// sample for sample.
const lat = ex.sf_latency(proc);
const trimL = outL.subarray(lat);
const trimR = outR.subarray(lat);

let peak = 0;
for (let i = 0; i < trimL.length; i++) {
  peak = Math.max(peak, Math.abs(trimL[i]), Math.abs(trimR[i]));
}

writeWav(positional[1], input.rate, [trimL, trimR], opt.float);

console.log(
  [
    positional[1],
    `${(rate * 100).toFixed(2)}% speed, pitch -${semitones} st, envelope +${
      num(opt.amount) > 0 ? semitones : 0
    } st`,
    `amount ${num(opt.amount)}  stereo ${opt.stereo}  crossover ${num(opt.crossover)} Hz  ` +
      `transient ${num(opt.transient)}  envres ${num(opt.envres)} Hz  fft ${num(opt.fft)}`,
    `peak ${peak.toFixed(3)}   ceiling gain ${ex.sf_limiter_gain(proc).toFixed(3)}`,
    (() => {
      const sp = ex.sf_alloc(3);
      ex.sf_stats(proc, sp, 3);
      const s = new Float32Array(ex.memory.buffer, sp, 3);
      return `depth ${s[0].toFixed(2)} dB   wobble ${s[1].toFixed(2)} dB`;
    })(),
  ].join('\n  ')
);
