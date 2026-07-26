#!/usr/bin/env node
// Measures the cost of the DSP core.
//
//   node tools/bench.js [seconds]
//
// Feeds audio through sf_process in 128-sample blocks, the same render quantum
// an AudioWorklet uses, and reports how much of one core a second of audio
// costs. The audio thread's whole budget is one core, so the percentage is the
// number that decides whether playback glitches.

const fs = require('fs');
const path = require('path');

const SR = 48000;
const BLOCK = 128;
const SECONDS = parseFloat(process.argv[2]) || 30;

const wasm = fs.readFileSync(path.join(__dirname, '..', 'extension', 'slowform.wasm'));
const mod = new WebAssembly.Module(wasm);

function makeSignal(n) {
  // Dense harmonics under two formants, so the cepstrum has real work to do.
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    let v = 0;
    for (let h = 1; h < 60; h++) {
      const f = 120 * h;
      if (f > SR / 2 - 200) break;
      const a = Math.exp(-Math.pow((f - 800) / 300, 2)) + Math.exp(-Math.pow((f - 2400) / 500, 2)) * 0.5 + 0.01;
      v += a * Math.sin(2 * Math.PI * f * t + h);
    }
    x[i] = v * 0.03;
  }
  return x;
}

const signal = makeSignal(SR * 2);

function run(fftSize, opts) {
  const ex = new WebAssembly.Instance(mod, {}).exports;
  const proc = ex.sf_new(SR, fftSize);
  const lp = ex.sf_alloc(BLOCK);
  const rp = ex.sf_alloc(BLOCK);
  const pp = ex.sf_alloc(9);
  const ep = ex.sf_alloc(128);
  const op = ex.sf_alloc(128);
  const sp = ex.sf_alloc(3);

  const pv = new Float32Array(ex.memory.buffer, pp, 9);
  pv[0] = 1;
  pv[1] = 1;
  pv[2] = opts.crossover ? 150 : 0;
  pv[3] = opts.transient ? 0.7 : 0;
  pv[4] = opts.ms ? 1 : 0;
  pv[5] = opts.envres || 500;
  pv[6] = Math.pow(2, 3 / 12);
  pv[7] = opts.loud === false ? 0 : 1;
  pv[8] = 0.99;
  ex.sf_set_params(proc, pp, 9);

  const lv = new Float32Array(ex.memory.buffer, lp, BLOCK);
  const rv = new Float32Array(ex.memory.buffer, rp, BLOCK);

  const totalBlocks = Math.floor((SR * SECONDS) / BLOCK);
  const snapEvery = opts.snapshot ? Math.round(SR / 15 / BLOCK) : 0;

  // Warm up the JIT before timing.
  for (let b = 0; b < 400; b++) {
    lv.set(signal.subarray(0, BLOCK));
    rv.set(signal.subarray(0, BLOCK));
    ex.sf_process(proc, lp, rp, BLOCK);
  }

  const t0 = process.hrtime.bigint();
  for (let b = 0; b < totalBlocks; b++) {
    const off = (b * BLOCK) % (signal.length - BLOCK);
    lv.set(signal.subarray(off, off + BLOCK));
    rv.set(signal.subarray(off, off + BLOCK));
    ex.sf_process(proc, lp, rp, BLOCK);
    if (snapEvery && b % snapEvery === 0) {
      ex.sf_stats(proc, sp, 3);
      ex.sf_snapshot(proc, ep, op, 128);
    }
  }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;

  const audioMs = (totalBlocks * BLOCK * 1000) / SR;
  return {
    ms,
    load: (ms / audioMs) * 100,
    realtime: audioMs / ms,
    heapKb: ex.memory.buffer.byteLength / 1024,
  };
}

const row = (label, r) =>
  label.padEnd(34) +
  (r.load.toFixed(2) + '%').padStart(8) +
  (r.realtime.toFixed(0) + 'x').padStart(9) +
  (Math.round(r.heapKb) + ' KB').padStart(10);

console.log(`${SECONDS}s of 48 kHz stereo, 128-sample blocks, node ${process.version}\n`);
console.log('configuration'.padEnd(34) + 'one core'.padStart(8) + 'realtime'.padStart(9) + 'wasm heap'.padStart(10));
console.log('-'.repeat(61));

console.log(row('window 1024', run(1024, {})));
console.log(row('window 2048  (default)', run(2048, {})));
console.log(row('window 4096', run(4096, {})));
console.log('-'.repeat(61));
console.log(row('2048, panel plot at 15 Hz', run(2048, { snapshot: true })));
console.log(row('2048, mid/side mode', run(2048, { ms: true })));
console.log(row('2048, crossover + transient on', run(2048, { crossover: true, transient: true })));
console.log(row('2048, loudness match off', run(2048, { loud: false })));
console.log(row('2048, envelope res 150 Hz', run(2048, { envres: 150 })));
console.log('-'.repeat(61));

const frames = SR / (2048 / 4);
console.log(
  `\nat window 2048 that is ${frames.toFixed(1)} frames/s, ` +
    `8 transforms per frame (4 per channel), ${(frames * 8).toFixed(0)} FFTs/s`
);
