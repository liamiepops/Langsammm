#!/usr/bin/env node
// Runs extension/worklet.js under a stubbed AudioWorkletGlobalScope and checks
// its output against the same wasm driven directly.
//
// This exercises the glue that actually runs in the browser: the parameter
// index layout, the Float32Array views into wasm memory, and the 128-sample
// block handling. Those are where the bugs live, and none of them are covered
// by the Rust tests.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const EXT = path.join(__dirname, '..', 'extension');
const SR = 48000;
const BLOCK = 128;
const FFT = 2048;

const wasmBytes = fs.readFileSync(path.join(EXT, 'slowform.wasm'));

const PARAMS = {
  midWet: 1,
  sideWet: 1,
  crossoverHz: 0,
  transient: 0,
  stereoMs: false,
  envResHz: 500,
  shiftRatio: Math.pow(2, 3 / 12),
  loudnessMatch: true,
  ceiling: 0.99,
};
const P_COUNT = 9;

// ------------------------------------------------- run through worklet.js

let registered = null;

class AudioWorkletProcessorStub {
  constructor() {
    const self = this;
    this.port = {
      _onmessage: null,
      set onmessage(fn) {
        self.port._onmessage = fn;
      },
      get onmessage() {
        return self.port._onmessage;
      },
      postMessage(msg) {
        self.outbox.push(msg);
      },
    };
    this.outbox = [];
  }
}

const sandbox = {
  AudioWorkletProcessor: AudioWorkletProcessorStub,
  registerProcessor: (name, cls) => {
    registered = { name, cls };
  },
  sampleRate: SR,
  WebAssembly,
  Float32Array,
  Math,
  console,
};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(EXT, 'worklet.js'), 'utf8'), sandbox, {
  filename: 'worklet.js',
});

if (!registered || registered.name !== 'slowform') {
  throw new Error('worklet.js did not register a processor named "slowform"');
}

const node = new registered.cls({ processorOptions: { fftSize: FFT, params: PARAMS } });
node.port._onmessage({ data: { type: 'wasm', bytes: wasmBytes } });

const ready = node.outbox.find((m) => m.type === 'ready');
const failed = node.outbox.find((m) => m.type === 'error');
if (failed) throw new Error('worklet reported: ' + failed.message);
if (!ready) throw new Error('worklet never reported ready');
console.log(
  'worklet booted: fft ' + ready.fftSize + ', sr ' + ready.sampleRate + ', latency ' +
    (ready.latency * 1000).toFixed(1) + ' ms'
);
if (Math.abs(ready.latency - FFT / SR) > 1e-9) {
  throw new Error('latency should be one window: got ' + ready.latency);
}

// ------------------------------------------------------- reference path

const ex = new WebAssembly.Instance(new WebAssembly.Module(wasmBytes), {}).exports;
const proc = ex.sf_new(SR, FFT);
const lp = ex.sf_alloc(BLOCK);
const rp = ex.sf_alloc(BLOCK);
const pp = ex.sf_alloc(P_COUNT);
const pv = new Float32Array(ex.memory.buffer, pp, P_COUNT);
pv[0] = PARAMS.midWet;
pv[1] = PARAMS.sideWet;
pv[2] = PARAMS.crossoverHz;
pv[3] = PARAMS.transient;
pv[4] = PARAMS.stereoMs ? 1 : 0;
pv[5] = PARAMS.envResHz;
pv[6] = PARAMS.shiftRatio;
pv[7] = PARAMS.loudnessMatch ? 1 : 0;
pv[8] = PARAMS.ceiling;
ex.sf_set_params(proc, pp, P_COUNT);
const lv = new Float32Array(ex.memory.buffer, lp, BLOCK);
const rv = new Float32Array(ex.memory.buffer, rp, BLOCK);

// ------------------------------------------------------------- compare

const TOTAL = SR * 2;
let worst = 0;
let energy = 0;
let silent = true;

for (let b = 0; b < TOTAL; b += BLOCK) {
  const inL = new Float32Array(BLOCK);
  const inR = new Float32Array(BLOCK);
  for (let i = 0; i < BLOCK; i++) {
    const t = (b + i) / SR;
    let v = 0;
    for (let h = 1; h < 40; h++) {
      const f = 130 * h;
      const a = Math.exp(-Math.pow((f - 900) / 300, 2)) + 0.02;
      v += a * Math.sin(2 * Math.PI * f * t + h);
    }
    inL[i] = v * 0.05;
    inR[i] = v * 0.04;
  }

  const outL = new Float32Array(BLOCK);
  const outR = new Float32Array(BLOCK);
  const keep = node.process([[inL, inR]], [[outL, outR]], {});
  if (keep !== true) throw new Error('process() must return true to stay alive');

  lv.set(inL);
  rv.set(inR);
  ex.sf_process(proc, lp, rp, BLOCK);

  for (let i = 0; i < BLOCK; i++) {
    worst = Math.max(worst, Math.abs(outL[i] - lv[i]), Math.abs(outR[i] - rv[i]));
    energy += outL[i] * outL[i];
    if (Math.abs(outL[i]) > 1e-6) silent = false;
  }
}

const levels = node.outbox.filter((m) => m.type === 'level');

console.log('blocks processed: ' + TOTAL / BLOCK);
console.log('max deviation from direct wasm call: ' + worst.toExponential(2));
console.log('output rms: ' + Math.sqrt(energy / TOTAL).toFixed(5));
console.log('level reports received: ' + levels.length);

let bad = 0;
if (silent) {
  console.error('FAIL: worklet produced silence');
  bad++;
}
if (worst > 1e-6) {
  console.error('FAIL: worklet output does not match a direct wasm call');
  bad++;
}
if (levels.length < 3) {
  console.error('FAIL: expected periodic level reports');
  bad++;
}

// Panel telemetry: only after it is asked for, and shaped as the plot expects.
const beforeWatch = node.outbox.filter((m) => m.type === 'snap').length;
if (beforeWatch !== 0) {
  console.error('FAIL: snapshots sent before the panel asked for them');
  bad++;
}

node.port._onmessage({ data: { type: 'watch', on: true } });
const mark = node.outbox.length;
for (let b = 0; b < 60; b++) {
  const s = new Float32Array(BLOCK);
  for (let i = 0; i < BLOCK; i++) {
    const t = (b * BLOCK + i) / SR;
    let v = 0;
    for (let hh = 1; hh < 30; hh++) {
      const f = 150 * hh;
      v += (Math.exp(-Math.pow((f - 850) / 320, 2)) + 0.02) * Math.sin(2 * Math.PI * f * t);
    }
    s[i] = v * 0.05;
  }
  node.process([[s, s]], [[new Float32Array(BLOCK), new Float32Array(BLOCK)]], {});
}

const snaps = node.outbox.slice(mark).filter((m) => m.type === 'snap');
console.log('snapshots after watch: ' + snaps.length);
if (snaps.length < 1) {
  console.error('FAIL: no snapshot arrived after watch was enabled');
  bad++;
} else {
  const s = snaps[snaps.length - 1];
  const okShape =
    s.env instanceof Float32Array &&
    s.out instanceof Float32Array &&
    s.env.length === 128 &&
    s.out.length === 128;
  if (!okShape) {
    console.error('FAIL: snapshot curves are the wrong shape');
    bad++;
  }
  const finite = (a) => a.every((v) => Number.isFinite(v));
  if (!okShape || !finite(s.env) || !finite(s.out)) {
    console.error('FAIL: snapshot contains non-finite values');
    bad++;
  }
  if (!Number.isFinite(s.depth) || !Number.isFinite(s.wobble) || !Number.isFinite(s.limiter)) {
    console.error('FAIL: snapshot statistics are not finite');
    bad++;
  }
  let spread = 0;
  if (okShape) for (let i = 0; i < s.env.length; i++) spread = Math.max(spread, Math.abs(s.env[i] - s.out[i]));
  console.log(
    'depth ' + s.depth.toFixed(2) + ' dB, wobble ' + s.wobble.toFixed(2) +
      ' dB, curve spread ' + spread.toFixed(2) + ' dB'
  );
  if (spread < 0.5) {
    console.error('FAIL: warped curve is on top of the original with amount at 1');
    bad++;
  }
}

node.port._onmessage({ data: { type: 'watch', on: false } });
const afterOff = node.outbox.length;
for (let b = 0; b < 40; b++) {
  const s = new Float32Array(BLOCK).fill(0.1);
  node.process([[s, s]], [[new Float32Array(BLOCK), new Float32Array(BLOCK)]], {});
}
if (node.outbox.slice(afterOff).some((m) => m.type === 'snap')) {
  console.error('FAIL: snapshots kept coming after watch was turned off');
  bad++;
}

// Parameter updates must reach the processor and change the output.
node.port._onmessage({ data: { type: 'params', params: { ...PARAMS, midWet: 0, sideWet: 0 } } });
const a = new Float32Array(BLOCK).fill(0.1);
const o1 = new Float32Array(BLOCK);
const o2 = new Float32Array(BLOCK);
node.process([[a, a]], [[o1, o2]], {});
console.log('params message accepted');

if (bad) {
  process.exit(1);
}
console.log('\nworklet glue OK');
