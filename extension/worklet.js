// AudioWorklet host for the Rust envelope warper.
//
// The wasm module has no imports and no bindgen glue, which matters here:
// AudioWorkletGlobalScope has no TextDecoder, no fetch and no timers.

const P_MID_WET = 0;
const P_SIDE_WET = 1;
const P_CROSSOVER = 2;
const P_TRANSIENT = 3;
const P_STEREO_MS = 4;
const P_ENV_RES = 5;
const P_SHIFT = 6;
const P_LOUDNESS = 7;
const P_CEILING = 8;
const P_COUNT = 9;

const MAX_BLOCK = 1024;
const LEVEL_INTERVAL = 0.4; // seconds between level reports
const SNAP_POINTS = 128; // plot resolution, log-spaced 60 Hz to 16 kHz
const SNAP_INTERVAL = 1 / 15; // seconds between panel snapshots

class SlowformProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = (options && options.processorOptions) || {};
    this.fftSize = o.fftSize || 2048;
    this.pending = o.params || null;
    this.ready = false;
    this.buf = null;
    this.inAcc = 0;
    this.outAcc = 0;
    this.accN = 0;
    this.snapN = 0;
    this.wantSnap = false;

    this.port.onmessage = (e) => {
      const d = e.data;
      if (!d) return;
      if (d.type === 'wasm') this.boot(d.bytes);
      else if (d.type === 'params') {
        this.pending = d.params;
        this.pushParams();
      } else if (d.type === 'watch') {
        // The plot costs a message every 66 ms, so it only runs while the
        // panel is actually open.
        this.wantSnap = !!d.on;
      }
    };
  }

  boot(bytes) {
    if (this.ready) return;
    try {
      const mod = new WebAssembly.Module(bytes);
      const inst = new WebAssembly.Instance(mod, {});
      this.ex = inst.exports;
      this.proc = this.ex.sf_new(sampleRate, this.fftSize);
      this.lp = this.ex.sf_alloc(MAX_BLOCK);
      this.rp = this.ex.sf_alloc(MAX_BLOCK);
      this.pp = this.ex.sf_alloc(P_COUNT);
      this.ep = this.ex.sf_alloc(SNAP_POINTS);
      this.op = this.ex.sf_alloc(SNAP_POINTS);
      this.sp = this.ex.sf_alloc(3);
      this.ready = true;
      this.pushParams();
      this.port.postMessage({
        type: 'ready',
        latency: this.ex.sf_latency(this.proc) / sampleRate,
        fftSize: this.fftSize,
        sampleRate,
      });
    } catch (err) {
      this.port.postMessage({
        type: 'error',
        message: 'wasm init failed: ' + ((err && err.message) || err),
      });
    }
  }

  views() {
    const b = this.ex.memory.buffer;
    if (this.buf !== b) {
      this.buf = b;
      this.lv = new Float32Array(b, this.lp, MAX_BLOCK);
      this.rv = new Float32Array(b, this.rp, MAX_BLOCK);
      this.pv = new Float32Array(b, this.pp, P_COUNT);
      this.ev = new Float32Array(b, this.ep, SNAP_POINTS);
      this.ov = new Float32Array(b, this.op, SNAP_POINTS);
      this.sv = new Float32Array(b, this.sp, 3);
    }
  }

  sendSnapshot() {
    this.ex.sf_stats(this.proc, this.sp, 3);
    const ok = this.ex.sf_snapshot(this.proc, this.ep, this.op, SNAP_POINTS);
    const msg = {
      type: 'snap',
      depth: this.sv[0],
      wobble: this.sv[1],
      limiter: this.sv[2],
    };
    if (ok) {
      // Copies, because the views point straight into wasm memory. Transferred
      // rather than cloned since the panel takes ownership immediately.
      msg.env = this.ev.slice();
      msg.out = this.ov.slice();
      this.port.postMessage(msg, [msg.env.buffer, msg.out.buffer]);
    } else {
      this.port.postMessage(msg);
    }
  }

  pushParams() {
    if (!this.ready || !this.pending) return;
    this.views();
    const p = this.pending;
    this.pv[P_MID_WET] = p.midWet;
    this.pv[P_SIDE_WET] = p.sideWet;
    this.pv[P_CROSSOVER] = p.crossoverHz;
    this.pv[P_TRANSIENT] = p.transient;
    this.pv[P_STEREO_MS] = p.stereoMs ? 1 : 0;
    this.pv[P_ENV_RES] = p.envResHz;
    this.pv[P_SHIFT] = p.shiftRatio;
    this.pv[P_LOUDNESS] = p.loudnessMatch ? 1 : 0;
    this.pv[P_CEILING] = p.ceiling === undefined ? 0.99 : p.ceiling;
    this.ex.sf_set_params(this.proc, this.pp, P_COUNT);
  }

  process(inputs, outputs) {
    const out = outputs[0];
    if (!out || out.length === 0) return true;
    const n = out[0].length;
    const inp = inputs[0];

    if (!inp || inp.length === 0) {
      for (let c = 0; c < out.length; c++) out[c].fill(0);
      return true;
    }

    const il = inp[0];
    const ir = inp.length > 1 ? inp[1] : inp[0];

    if (!this.ready || n > MAX_BLOCK) {
      out[0].set(il);
      if (out.length > 1) out[1].set(ir);
      return true;
    }

    this.views();
    this.lv.set(il.subarray(0, n));
    this.rv.set(ir.subarray(0, n));
    this.ex.sf_process(this.proc, this.lp, this.rp, n);
    out[0].set(this.lv.subarray(0, n));
    if (out.length > 1) out[1].set(this.rv.subarray(0, n));

    // Level telemetry. Mostly so the panel can tell "nothing is playing" apart
    // from "this element is cross-origin and Web Audio handed us silence".
    for (let i = 0; i < n; i++) {
      this.inAcc += il[i] * il[i];
      this.outAcc += this.lv[i] * this.lv[i];
    }
    this.accN += n;
    if (this.accN >= sampleRate * LEVEL_INTERVAL) {
      this.port.postMessage({
        type: 'level',
        inRms: Math.sqrt(this.inAcc / this.accN),
        outRms: Math.sqrt(this.outAcc / this.accN),
        limiter: this.ex.sf_limiter_gain(this.proc),
      });
      this.inAcc = 0;
      this.outAcc = 0;
      this.accN = 0;
    }

    if (this.wantSnap) {
      this.snapN += n;
      if (this.snapN >= sampleRate * SNAP_INTERVAL) {
        this.snapN = 0;
        this.sendSnapshot();
      }
    }
    return true;
  }
}

registerProcessor('slowform', SlowformProcessor);
