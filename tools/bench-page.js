#!/usr/bin/env node
// Emits design/bench.html: a self-contained page that measures the DSP core in
// whatever browser you open it in.
//
//   node tools/bench-page.js
//
// The wasm is inlined as base64 so the page needs no fetch and works from
// file://, which is what lets the same file run in Chrome and Firefox without a
// server. Open it in both and compare.

const fs = require('fs');
const path = require('path');

const wasmB64 = fs
  .readFileSync(path.join(__dirname, '..', 'extension', 'slowform.wasm'))
  .toString('base64');

const HTML = `<title>Slowform benchmark</title>
<style>
  :root { --bg:#0b0d12; --fg:#e3e7f0; --dim:#868d9e; --rule:#22252e; --card:#12141a;
          --cyan:#5bc0d0; --amber:#f2a54a; --ok:#7fcf9b; --bad:#e08a80; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--fg); padding:40px 24px 80px;
         font:15px/1.6 ui-sans-serif, system-ui, "Segoe UI", Roboto, sans-serif; }
  .shell { max-width:760px; margin:0 auto; }
  h1 { font-size:26px; letter-spacing:-.02em; font-weight:650; margin:0 0 6px; }
  p.lede { color:var(--dim); max-width:64ch; margin:0 0 24px; }
  button { font:600 13px/1 ui-sans-serif, system-ui, sans-serif; color:#0b0d12;
           background:var(--amber); border:0; border-radius:7px; padding:11px 18px;
           cursor:pointer; }
  button:hover { filter:brightness(1.08); }
  button:disabled { opacity:.5; cursor:default; }
  button.ghost { background:#222634; color:var(--fg); }
  .row { display:flex; gap:10px; align-items:center; flex-wrap:wrap; margin-bottom:22px; }
  .env { background:var(--card); border:1px solid var(--rule); border-radius:10px;
         padding:14px 16px; margin-bottom:22px; font-size:13px; }
  .env div { display:flex; gap:10px; }
  .env b { color:var(--dim); font-weight:600; min-width:150px; }
  code, .mono { font-family:ui-monospace,"Cascadia Code",Consolas,monospace;
                font-variant-numeric:tabular-nums; }
  table { width:100%; border-collapse:collapse; margin-bottom:8px; font-size:13.5px; }
  th { text-align:left; font:600 9.5px/1 ui-sans-serif, system-ui, sans-serif;
       letter-spacing:.12em; text-transform:uppercase; color:var(--dim);
       padding:0 10px 8px 0; border-bottom:1px solid var(--rule); }
  th.n, td.n { text-align:right; }
  td { padding:8px 10px 8px 0; border-bottom:1px solid var(--rule); }
  td.mono { font-family:ui-monospace,Consolas,monospace; font-variant-numeric:tabular-nums; }
  .good { color:var(--ok); } .warn { color:var(--bad); }
  h2 { font-size:15px; margin:30px 0 10px; letter-spacing:-.01em; }
  .note { color:var(--dim); font-size:13px; max-width:64ch; }
  #status { color:var(--amber); font-size:13px; min-height:20px; }
</style>

<div class="shell">
  <h1>Slowform benchmark</h1>
  <p class="lede">
    Runs the shipped wasm over 128-sample blocks, the same render quantum an
    AudioWorklet uses, and reports what one second of audio costs. The audio
    thread gets one core, so the percentage is what decides whether playback
    glitches. Open this in Chrome and in Firefox and compare.
  </p>

  <div class="env" id="env"></div>

  <div class="row">
    <button id="go">Run benchmark</button>
    <button id="copy" class="ghost" disabled>Copy results</button>
    <span id="status"></span>
  </div>

  <table id="out" hidden>
    <thead><tr>
      <th>Configuration</th>
      <th class="n">One core</th>
      <th class="n">Realtime</th>
      <th class="n">Per block</th>
    </tr></thead>
    <tbody></tbody>
  </table>

  <h2>Live AudioWorklet</h2>
  <div class="row">
    <button id="live" class="ghost">Run 6s through a real worklet</button>
  </div>
  <div id="livenote" class="note">
    Puts a generated signal through an actual AudioContext and worklet at silent
    output, then reports the load measured on the audio thread. Needs
    <code>performance.now()</code> inside the worklet scope, which not every
    browser exposes; it will say so if unavailable.
  </div>
</div>

<script>
const WASM_B64 = "${wasmB64}";

function wasmBytes() {
  const bin = atob(WASM_B64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const SR = 48000;
const BLOCK = 128;
const SECONDS = 20;

let MODULE = null;
const results = [];

function signal(n) {
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    let v = 0;
    for (let h = 1; h < 60; h++) {
      const f = 120 * h;
      if (f > SR / 2 - 200) break;
      const a = Math.exp(-Math.pow((f - 800) / 300, 2))
              + Math.exp(-Math.pow((f - 2400) / 500, 2)) * 0.5 + 0.01;
      v += a * Math.sin(2 * Math.PI * f * t + h);
    }
    x[i] = v * 0.03;
  }
  return x;
}
const SIG = signal(SR * 2);

function bench(fftSize, opts) {
  const ex = new WebAssembly.Instance(MODULE, {}).exports;
  const proc = ex.sf_new(SR, fftSize);
  const lp = ex.sf_alloc(BLOCK), rp = ex.sf_alloc(BLOCK), pp = ex.sf_alloc(9);
  const ep = ex.sf_alloc(128), op = ex.sf_alloc(128), sp = ex.sf_alloc(3);
  const pv = new Float32Array(ex.memory.buffer, pp, 9);
  pv[0] = 1; pv[1] = 1; pv[2] = 0; pv[3] = 0; pv[4] = 0;
  pv[5] = 500; pv[6] = Math.pow(2, 0.25); pv[7] = 1; pv[8] = 0.99;
  ex.sf_set_params(proc, pp, 9);
  const lv = new Float32Array(ex.memory.buffer, lp, BLOCK);
  const rv = new Float32Array(ex.memory.buffer, rp, BLOCK);

  for (let b = 0; b < 400; b++) {           // warm the JIT
    lv.set(SIG.subarray(0, BLOCK)); rv.set(SIG.subarray(0, BLOCK));
    ex.sf_process(proc, lp, rp, BLOCK);
  }

  const blocks = Math.floor((SR * SECONDS) / BLOCK);
  const snapEvery = opts.snapshot ? Math.round(SR / 15 / BLOCK) : 0;
  const t0 = performance.now();
  for (let b = 0; b < blocks; b++) {
    const off = (b * BLOCK) % (SIG.length - BLOCK);
    lv.set(SIG.subarray(off, off + BLOCK));
    rv.set(SIG.subarray(off, off + BLOCK));
    ex.sf_process(proc, lp, rp, BLOCK);
    if (snapEvery && b % snapEvery === 0) {
      ex.sf_stats(proc, sp, 3);
      ex.sf_snapshot(proc, ep, op, 128);
    }
  }
  const ms = performance.now() - t0;
  const audioMs = (blocks * BLOCK * 1000) / SR;
  return { load: (ms / audioMs) * 100, realtime: audioMs / ms, perBlock: (ms * 1000) / blocks };
}

function addRow(label, r) {
  const tb = document.querySelector('#out tbody');
  const tr = document.createElement('tr');
  const cells = [
    [label, ''],
    [r.load.toFixed(2) + '%', 'n mono ' + (r.load < 25 ? 'good' : 'warn')],
    [r.realtime.toFixed(0) + '\\u00d7', 'n mono'],
    [r.perBlock.toFixed(1) + ' \\u00b5s', 'n mono'],
  ];
  for (const [text, cls] of cells) {
    const td = document.createElement('td');
    td.className = cls;
    td.textContent = text;
    tr.append(td);
  }
  tb.append(tr);
  results.push(label + '  ' + r.load.toFixed(2) + '%  ' + r.realtime.toFixed(0) + 'x  '
               + r.perBlock.toFixed(1) + 'us');
}

const envEl = document.getElementById('env');
function envLine(k, v) {
  const d = document.createElement('div');
  const b = document.createElement('b');
  b.textContent = k;
  const s = document.createElement('span');
  s.className = 'mono';
  s.textContent = v;
  d.append(b, s);
  envEl.append(d);
}

(function describe() {
  let rate = 'unknown';
  try {
    const c = new (window.AudioContext || window.webkitAudioContext)();
    rate = c.sampleRate + ' Hz';
    c.close();
  } catch (e) { /* blocked before a gesture */ }
  envLine('user agent', navigator.userAgent);
  envLine('device audio rate', rate);
  envLine('logical cores', String(navigator.hardwareConcurrency || 'unknown'));
  envLine('benchmark rate', SR + ' Hz stereo, ' + BLOCK + '-sample blocks, ' + SECONDS + 's');
})();

const status = document.getElementById('status');

document.getElementById('go').onclick = async () => {
  const btn = document.getElementById('go');
  btn.disabled = true;
  status.textContent = 'compiling wasm...';
  document.querySelector('#out tbody').textContent = '';
  results.length = 0;
  try {
    MODULE = await WebAssembly.compile(wasmBytes());
  } catch (e) {
    status.textContent = 'wasm compile failed: ' + e.message;
    btn.disabled = false;
    return;
  }
  const jobs = [
    ['window 1024', 1024, {}],
    ['window 2048  (default)', 2048, {}],
    ['window 4096', 4096, {}],
    ['2048, panel plot at 15 Hz', 2048, { snapshot: true }],
  ];
  document.getElementById('out').hidden = false;
  for (const [label, size, opts] of jobs) {
    status.textContent = 'running ' + label + '...';
    await new Promise((r) => setTimeout(r, 30));
    addRow(label, bench(size, opts));
  }
  status.textContent = 'done';
  btn.disabled = false;
  document.getElementById('copy').disabled = false;
};

document.getElementById('copy').onclick = () => {
  const text = [navigator.userAgent, ''].concat(results).join('\\n');
  navigator.clipboard.writeText(text).then(
    () => (status.textContent = 'copied'),
    () => (status.textContent = 'could not copy, select the table instead')
  );
};

// ---- live worklet -------------------------------------------------------

const WORKLET_SRC = \`
class Bench extends AudioWorkletProcessor {
  constructor(o) {
    super();
    const b = o.processorOptions.bytes;
    this.ex = new WebAssembly.Instance(new WebAssembly.Module(b), {}).exports;
    this.p = this.ex.sf_new(sampleRate, 2048);
    this.lp = this.ex.sf_alloc(1024);
    this.rp = this.ex.sf_alloc(1024);
    const pp = this.ex.sf_alloc(9);
    const pv = new Float32Array(this.ex.memory.buffer, pp, 9);
    pv[0]=1;pv[1]=1;pv[2]=0;pv[3]=0;pv[4]=0;pv[5]=500;pv[6]=Math.pow(2,0.25);pv[7]=1;pv[8]=0.99;
    this.ex.sf_set_params(this.p, pp, 9);
    this.lv = new Float32Array(this.ex.memory.buffer, this.lp, 1024);
    this.rv = new Float32Array(this.ex.memory.buffer, this.rp, 1024);
    this.busy = 0; this.frames = 0;
    this.hasClock = typeof performance !== 'undefined' && !!performance.now;
  }
  process(inputs, outputs) {
    const out = outputs[0]; const inp = inputs[0];
    if (!inp || !inp.length) return true;
    const n = out[0].length;
    const t0 = this.hasClock ? performance.now() : 0;
    this.lv.set(inp[0].subarray(0, n));
    this.rv.set((inp.length > 1 ? inp[1] : inp[0]).subarray(0, n));
    this.ex.sf_process(this.p, this.lp, this.rp, n);
    out[0].set(this.lv.subarray(0, n));
    if (out.length > 1) out[1].set(this.rv.subarray(0, n));
    if (this.hasClock) this.busy += performance.now() - t0;
    this.frames += n;
    if (this.frames >= sampleRate) {
      this.port.postMessage({ busy: this.busy, frames: this.frames, hasClock: this.hasClock });
      this.busy = 0; this.frames = 0;
    }
    return true;
  }
}
registerProcessor('bench', Bench);
\`;

document.getElementById('live').onclick = async () => {
  const btn = document.getElementById('live');
  const note = document.getElementById('livenote');
  btn.disabled = true;
  note.textContent = 'starting...';
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    await ctx.resume();
    const url = URL.createObjectURL(new Blob([WORKLET_SRC], { type: 'text/javascript' }));
    await ctx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);

    const len = Math.floor(ctx.sampleRate * 2);
    const buf = ctx.createBuffer(2, len, ctx.sampleRate);
    const s = signal(len);
    buf.copyToChannel(s, 0);
    buf.copyToChannel(s, 1);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;

    const node = new AudioWorkletNode(ctx, 'bench', {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2],
      processorOptions: { bytes: wasmBytes() },
    });
    const mute = ctx.createGain();
    mute.gain.value = 0;
    src.connect(node).connect(mute).connect(ctx.destination);
    src.start();

    const loads = [];
    let clock = true;
    node.port.onmessage = (e) => {
      clock = e.data.hasClock;
      if (clock) loads.push((e.data.busy / ((e.data.frames / ctx.sampleRate) * 1000)) * 100);
      note.textContent = clock
        ? 'measuring... ' + loads.map((v) => v.toFixed(1) + '%').join('  ')
        : 'this browser does not expose performance.now() inside the worklet, so the audio-thread load cannot be timed here. The table above still compares the same wasm work.';
    };

    setTimeout(() => {
      src.stop();
      ctx.close();
      btn.disabled = false;
      if (clock && loads.length) {
        const mean = loads.reduce((a, b) => a + b, 0) / loads.length;
        note.textContent =
          'audio thread load, ' + ctx.sampleRate + ' Hz, window 2048: ' +
          mean.toFixed(2) + '% of one core (per-second samples: ' +
          loads.map((v) => v.toFixed(1)).join(', ') + ')';
        results.push('live worklet  ' + mean.toFixed(2) + '%');
      }
    }, 6000);
  } catch (e) {
    note.textContent = 'failed: ' + (e && e.message ? e.message : e);
    btn.disabled = false;
  }
};
</script>
`;

const out = path.join(__dirname, '..', 'design', 'bench.html');
fs.writeFileSync(out, HTML);
console.log('design/bench.html  ' + Math.round(HTML.length / 1024) + ' KB');
