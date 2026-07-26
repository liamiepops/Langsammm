// Runs in the page's own realm, because createMediaElementSource has to see
// the page's media elements.
//
// Signal chain: the browser does the resample (playbackRate with
// preservesPitch off), which drops tempo, pitch and spectral envelope together.
// The worklet then warps the envelope back up by the same interval.

(() => {
  if (window.__slowformLoaded) return;
  window.__slowformLoaded = true;

  // Chrome loads this by injected script tag, which carries the base URL on the
  // tag itself. Firefox loads it as a MAIN-world content script, where there is
  // no tag to read, so the bridge has to send the URL over instead. Only
  // ensureModule needs it, and that is already async, so it waits.
  let BASE = (document.currentScript && document.currentScript.dataset.base) || null;
  const baseWaiters = [];

  function baseUrl() {
    return BASE ? Promise.resolve(BASE) : new Promise((res) => baseWaiters.push(res));
  }

  function setBase(b) {
    if (BASE || !b) return;
    BASE = b;
    baseWaiters.splice(0).forEach((f) => f(BASE));
  }

  const TO_PAGE = 'slowform:to-page';
  const FROM_PAGE = 'slowform:from-page';
  const IS_TOP = window.top === window;

  const DEFAULTS = {
    enabled: true,
    semitones: 3, // down
    midWet: 1.0,
    sideWet: 1.0,
    stereoMs: false,
    crossoverHz: 0,
    transient: 0,
    envResHz: 500,
    fftSize: 2048,
    loudnessMatch: true,
    panelOpen: true,
  };

  const state = Object.assign({}, DEFAULTS);
  let abHeld = false;

  // Declared up here rather than beside the panel code, so that an early
  // failure in the audio path can report itself before the UI has been built.
  let panel = null;
  const controls = {};
  let statusMsg = null;
  let activeTip = null;

  function setStatus(msg) {
    statusMsg = msg;
  }

  // ---------------------------------------------------------------- messaging

  function toBridge(msg) {
    window.postMessage({ __slowform: FROM_PAGE, ...msg }, '*');
  }

  let wasmBytes = null;
  let wasmError = null;
  const wasmWaiters = [];

  window.addEventListener('message', (ev) => {
    if (ev.source !== window) return;
    const d = ev.data;
    if (!d || d.__slowform !== TO_PAGE) return;

    if (d.type === 'settings') {
      if (d.settings) {
        Object.assign(state, d.settings);
        syncPanel();
        pushParams();
        pushWatch();
        rescanRates();
      }
    } else if (d.type === 'base') {
      setBase(d.base);
    } else if (d.type === 'wasm') {
      wasmBytes = d.bytes;
      wasmWaiters.splice(0).forEach((f) => f(wasmBytes));
    } else if (d.type === 'wasm-error') {
      wasmError = d.message;
      setStatus('wasm fetch failed: ' + d.message);
    }
  });

  // Two content scripts at document_start have no guaranteed order, and under
  // the MAIN-world route this one may well win. Keep asking until the bridge
  // answers rather than assuming it was listening.
  toBridge({ type: 'hello' });
  let helloTries = 0;
  const helloTimer = setInterval(() => {
    if ((BASE && wasmBytes) || ++helloTries > 25) {
      clearInterval(helloTimer);
      if (!BASE && !wasmError) setStatus('extension bridge did not respond');
      return;
    }
    toBridge({ type: 'hello' });
  }, 120);

  let saveTimer = null;
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      const s = {};
      for (const k of Object.keys(DEFAULTS)) s[k] = state[k];
      toBridge({ type: 'save', settings: s });
    }, 250);
  }

  function waitForWasm() {
    if (wasmBytes) return Promise.resolve(wasmBytes);
    return new Promise((res) => wasmWaiters.push(res));
  }

  // ------------------------------------------------------------------- params

  function rateOf() {
    return Math.pow(2, -state.semitones / 12);
  }

  function paramBlock() {
    const dry = abHeld || !state.enabled;
    return {
      midWet: dry ? 0 : state.midWet,
      sideWet: dry ? 0 : state.stereoMs ? state.sideWet : state.midWet,
      crossoverHz: state.crossoverHz,
      transient: state.transient,
      stereoMs: state.stereoMs,
      envResHz: state.envResHz,
      shiftRatio: Math.pow(2, state.semitones / 12),
      loudnessMatch: state.loudnessMatch,
      // Fixed in the browser. The destination clips, so there is nothing to
      // gain from letting this off the leash here.
      ceiling: 0.99,
    };
  }

  function pushParams() {
    const p = paramBlock();
    for (const rec of records) {
      if (rec.node) rec.node.port.postMessage({ type: 'params', params: p });
    }
  }

  // The plot costs a message every 66 ms per node, so it is only requested
  // while the panel is on screen.
  function pushWatch() {
    const on = !!(state.panelOpen && IS_TOP);
    for (const rec of records) {
      if (rec.node) rec.node.port.postMessage({ type: 'watch', on });
    }
  }

  // -------------------------------------------------------------------- audio

  let ctx = null;
  let modulePromise = null;
  const records = [];
  let lastLevel = { inRms: 0, outRms: 0, at: 0 };
  let latencyS = 0;
  const meters = { depth: 0, wobble: 0, limiter: 1, at: 0 };
  let curveEnv = null;
  let curveOut = null;

  function getCtx() {
    if (!ctx) {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      const resume = () => {
        if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      };
      window.addEventListener('pointerdown', resume, true);
      window.addEventListener('keydown', resume, true);
    }
    return ctx;
  }

  function ensureModule(c) {
    if (!modulePromise) {
      modulePromise = baseUrl()
        .then((b) => c.audioWorklet.addModule(b + 'worklet.js'))
        .catch((e) => {
          modulePromise = null;
          throw e;
        });
    }
    return modulePromise;
  }

  // `owner` returns the media element this node is fed by. A page can hold
  // several, and a silent one posting snapshots would fight the audible one
  // for the plot.
  function buildNode(c, owner) {
    const node = new AudioWorkletNode(c, 'slowform', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      channelCount: 2,
      channelCountMode: 'explicit',
      channelInterpretation: 'speakers',
      processorOptions: { fftSize: state.fftSize, params: paramBlock() },
    });
    node.port.onmessage = (e) => {
      const d = e.data;
      if (!d) return;
      if (d.type === 'ready') {
        latencyS = d.latency;
        setStatus(null);
        node.port.postMessage({ type: 'watch', on: !!(state.panelOpen && IS_TOP) });
      } else if (d.type === 'snap') {
        const el = owner && owner();
        if (el && el.paused) return;
        meters.depth = d.depth;
        meters.wobble = d.wobble;
        meters.limiter = d.limiter;
        meters.at = performance.now();
        if (d.env) {
          curveEnv = d.env;
          curveOut = d.out;
        }
        drawPlot();
        paintMeters();
      } else if (d.type === 'level') {
        lastLevel = {
          inRms: d.inRms,
          outRms: d.outRms,
          limiter: d.limiter === undefined ? 1 : d.limiter,
          at: performance.now(),
        };
      } else if (d.type === 'error') {
        setStatus(d.message);
      }
    };
    waitForWasm().then((bytes) => {
      node.port.postMessage({ type: 'wasm', bytes: bytes.slice(0) });
    });
    return node;
  }

  async function attach(el) {
    if (el.__slowformAttached) return;
    el.__slowformAttached = true;

    let c;
    try {
      c = getCtx();
      await ensureModule(c);
    } catch (e) {
      setStatus('worklet blocked: ' + ((e && e.message) || e));
      return;
    }

    let src;
    try {
      src = c.createMediaElementSource(el);
    } catch (e) {
      setStatus('cannot tap element: ' + ((e && e.message) || e));
      return;
    }

    const node = buildNode(c, () => el);
    src.connect(node);
    node.connect(c.destination);

    const rec = { el, src, node };
    records.push(rec);

    el.addEventListener('ratechange', () => applyRate(el));
    el.addEventListener('play', () => {
      if (c.state === 'suspended') c.resume().catch(() => {});
      applyRate(el);
    });
    applyRate(el);
  }

  // Changing the window size needs a fresh processor, so the node is rebuilt
  // and reconnected in place.
  function rebuildNodes() {
    if (!ctx) return;
    for (const rec of records) {
      try {
        rec.src.disconnect();
        rec.node.disconnect();
      } catch (e) {
        /* already gone */
      }
      rec.node = buildNode(ctx, () => rec.el);
      rec.src.connect(rec.node);
      rec.node.connect(ctx.destination);
    }
  }

  let settingRate = false;
  function applyRate(el) {
    const target = state.enabled ? rateOf() : 1;
    try {
      el.preservesPitch = false;
      el.mozPreservesPitch = false;
      el.webkitPreservesPitch = false;
    } catch (e) {
      /* not all engines expose all three */
    }
    if (settingRate) return;
    if (Math.abs(el.playbackRate - target) > 1e-4) {
      settingRate = true;
      try {
        el.playbackRate = target;
      } catch (e) {
        /* some players clamp */
      }
      settingRate = false;
    }
  }

  function rescanRates() {
    document.querySelectorAll('video,audio').forEach(applyRate);
  }

  function scan() {
    document.querySelectorAll('video,audio').forEach((el) => {
      if (!el.__slowformAttached) attach(el);
      else applyRate(el);
    });
  }

  new MutationObserver(() => scan()).observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
  setInterval(scan, 1000);
  scan();

  // ----------------------------------------------------------------------- ui

  function h(tag, attrs, ...kids) {
    const e = document.createElement(tag);
    for (const k in attrs || {}) {
      const v = attrs[k];
      if (k === 'style') Object.assign(e.style, v);
      else if (k.slice(0, 2) === 'on') e.addEventListener(k.slice(2).toLowerCase(), v);
      else e.setAttribute(k, v);
    }
    for (const c of kids) {
      if (c == null || c === false) continue;
      e.append(typeof c === 'object' ? c : String(c));
    }
    return e;
  }

  // The mark, matching tools/icons.js: two beats, then the same two spread
  // apart. Built with createElementNS rather than innerHTML because YouTube
  // enforces Trusted Types and would refuse the markup.
  function markSvg(height) {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '1.5 3 23 18');
    svg.setAttribute('height', String(height));
    svg.setAttribute('width', String(Math.round((height * 23) / 18)));
    svg.setAttribute('aria-hidden', 'true');
    const tick = (x, colour) => {
      const l = document.createElementNS(NS, 'line');
      l.setAttribute('x1', String(x));
      l.setAttribute('x2', String(x));
      l.setAttribute('y1', '4.5');
      l.setAttribute('y2', '19.5');
      l.setAttribute('stroke', colour);
      l.setAttribute('stroke-width', '3');
      l.setAttribute('stroke-linecap', 'round');
      return l;
    };
    svg.append(tick(3, '#5bc0d0'));
    svg.append(tick(7, '#5bc0d0'));
    svg.append(tick(15, '#f2a54a'));
    svg.append(tick(23, '#f2a54a'));
    return svg;
  }

  // Amber always means the warped signal, cyan always means the original.
  const CSS = `
:host { all: initial; }
.wrap {
  position: fixed; right: 16px; bottom: 16px; width: 344px; z-index: 2147483647;
  box-sizing: border-box;
  font: 12px/1.45 ui-sans-serif, system-ui, "Segoe UI", Roboto, sans-serif;
  color: #e3e7f0; background: #101219; border: 1px solid #2a2f3b;
  border-radius: 10px; box-shadow: 0 10px 40px rgba(0,0,0,.6);
  padding: 11px 13px 13px; user-select: none;
}
.wrap.closed { display: none; }
.wrap * { box-sizing: border-box; }

/* Collapsed state. Never disappears entirely, so the panel is always
   recoverable without knowing the hotkey. */
.launch {
  position: fixed; right: 16px; bottom: 16px; z-index: 2147483647;
  display: none; align-items: center; gap: 7px; box-sizing: border-box;
  background: #101219; border: 1px solid #2a2f3b; border-radius: 8px;
  padding: 7px 10px; cursor: pointer; opacity: .72;
  box-shadow: 0 6px 22px rgba(0,0,0,.5);
  font: 600 9.5px/1 ui-sans-serif, system-ui, "Segoe UI", sans-serif;
  letter-spacing: .12em; text-transform: uppercase; color: #7f879a;
  transition: opacity .12s, color .12s;
}
.launch.show { display: flex; }
.launch:hover { opacity: 1; color: #e3e7f0; }
.launch svg { display: block; flex: none; }
@media (prefers-reduced-motion: reduce) { .launch { transition: none; } }

.hd { display: flex; align-items: center; gap: 7px; margin-bottom: 10px; }
.hd svg { display: block; flex: none; }
.nm { font-weight: 640; letter-spacing: .015em; margin-right: 1px; }
.sp { flex: 1; }

.chip {
  font: 600 10px/1 ui-monospace, "Cascadia Code", Consolas, monospace;
  font-variant-numeric: tabular-nums; letter-spacing: .04em;
  padding: 4px 6px; border-radius: 4px; background: #222634; color: #7f879a;
}
.chip.live { color: #f2a54a; background: rgba(242,165,74,.16); }

button {
  font: inherit; color: #e3e7f0; background: #222634; border: 1px solid #2a2f3b;
  border-radius: 6px; padding: 3px 8px; cursor: pointer;
}
button:hover { background: #2c3140; }
button.on { background: rgba(107,191,138,.22); border-color: #4d8a64; }
select {
  font: 11px/1 ui-sans-serif, system-ui, sans-serif; background: #222634; color: #e3e7f0;
  border: 1px solid #2a2f3b; border-radius: 5px; padding: 3px 4px;
}

canvas { display: block; width: 318px; height: 100px; border-radius: 6px; background: #191c25; }
.plotwrap { position: relative; }
.key {
  position: absolute; left: 8px; top: 7px; display: flex; gap: 10px; pointer-events: none;
  font: 600 8.5px/1 ui-sans-serif, system-ui, sans-serif; letter-spacing: .09em; text-transform: uppercase;
}
.key i { display: inline-block; width: 7px; height: 2px; margin-right: 4px; vertical-align: middle; }

.ro { display: grid; grid-template-columns: repeat(4, 1fr); gap: 1px; background: #2a2f3b;
      border-radius: 6px; overflow: hidden; margin-top: 10px; }
.ro > div { background: #191c25; padding: 6px 7px; }
.ro .k { font: 600 8.5px/1 ui-sans-serif, system-ui, sans-serif; letter-spacing: .1em;
         text-transform: uppercase; color: #7f879a; }
.ro .n { font: 12px/1.3 ui-monospace, "Cascadia Code", Consolas, monospace;
         font-variant-numeric: tabular-nums; margin-top: 3px; color: #e3e7f0; }
.ro .n.warp { color: #f2a54a; }
.ro .n.quiet { color: #7f879a; }
.ro .n.alert { color: #e06a5f; }

.rule { height: 1px; background: #2a2f3b; margin: 11px -13px; }

.ctl { display: flex; align-items: center; gap: 9px; margin: 7px 0; }
.ctl .lb { flex: 1; color: #b6bccb; font-size: 11.5px; display: flex; align-items: center; gap: 5px; }
.ctl .v { font: 11px/1 ui-monospace, "Cascadia Code", Consolas, monospace;
          font-variant-numeric: tabular-nums; color: #e3e7f0; width: 54px; text-align: right; }
.ctl.dim .lb, .ctl.dim .v { opacity: .38; }

.q { width: 13px; height: 13px; border-radius: 50%; padding: 0; flex: none;
     border: 1px solid #2a2f3b; background: none; color: #7f879a;
     font: 700 8px/11px ui-sans-serif, system-ui, sans-serif; text-align: center; cursor: help; }
.q:hover { background: #222634; }
.q.on { border-color: #f2a54a; color: #f2a54a; }

input[type=range] { width: 112px; accent-color: #f2a54a; margin: 0; }

.seg { display: flex; background: #222634; border-radius: 5px; padding: 2px; gap: 2px; }
.seg button { font: 600 10px/1 ui-sans-serif, system-ui, sans-serif; padding: 4px 7px;
              border: none; background: none; color: #7f879a; border-radius: 3px; }
.seg button.sel { background: #343a4a; color: #e3e7f0; }

.tip { position: relative; background: #262b38; border: 1px solid #3a4152; border-radius: 7px;
       padding: 8px 10px; font-size: 11px; line-height: 1.45; color: #d3d8e4;
       box-shadow: 0 6px 20px rgba(0,0,0,.55); margin: 6px 0 2px; }
.tip::before { content: ""; position: absolute; top: -5px; left: 22px; width: 8px; height: 8px;
       background: #262b38; border-left: 1px solid #3a4152; border-top: 1px solid #3a4152;
       transform: rotate(45deg); }

.cmp { margin-top: 11px; width: 100%; border: 1px solid #2a2f3b; background: #222634;
       border-radius: 6px; padding: 8px; color: #b6bccb;
       font: 600 10.5px/1 ui-sans-serif, system-ui, sans-serif; letter-spacing: .05em; text-align: center; }
.cmp.held { background: rgba(242,165,74,.2); border-color: #f2a54a; color: #f2a54a; }

.status { margin-top: 9px; color: #e0b96b; font-size: 11px; white-space: pre-line; }
.status:empty { display: none; }

button:focus-visible, select:focus-visible, input:focus-visible { outline: 2px solid #f2a54a; outline-offset: 1px; }
`;

  const TIPS = {
    semitones:
      'How far down the audio is taken. The player is set to this ratio with ' +
      'pitch preservation off, so tempo, pitch and the spectral envelope all ' +
      'drop together. The warp then lifts only the envelope back.',
    midWet:
      'Exponent on the whole gain curve. At 100% the envelope is lifted the ' +
      'full interval. Lower values land part way, and the amber curve above ' +
      'moves with it.',
    envResHz:
      'How much detail the envelope is allowed to contain. Watch the two ' +
      'numbers above as you drag: past a point depth stops rising while ' +
      'wobble keeps climbing, and that extra wobble is what you hear as ' +
      'shimmer.',
    crossoverHz:
      'Turns the warp off below this frequency, tapering in from half of it. ' +
      'At the default envelope resolution the warp barely acts down there ' +
      'anyway, so expect little to change until you go above 300 Hz.',
    transient:
      'Eases the warp off on frames where spectral flux jumps above its ' +
      'running mean, which is most drum hits. It gives back some of the ' +
      'effect on those frames in exchange for cleaner transients.',
    stereoMs:
      'M/S runs the two engines on mid and side rather than left and right. ' +
      'Centre-panned vocals live in mid, so this is a cheap stand-in for ' +
      'separating them out.',
    fftSize:
      'STFT size. Larger resolves the envelope better and adds delay, shown ' +
      'on the right. Halve it for video so the audio does not lag the picture.',
    loudnessMatch:
      'Matches output level back to input over about a second, so holding ' +
      'alt+A compares timbre rather than volume.',
  };

  // ------------------------------------------------------------------ the plot

  const F_LO = 60;
  const F_HI = 16000;
  let plotCtx = null;
  let plotDpr = 1;
  let smoothTop = null;

  function drawPlot() {
    if (!plotCtx || !panel || !state.panelOpen) return;
    const g = plotCtx;
    const W = 318;
    const H = 100;
    const PAD = 6;

    g.clearRect(0, 0, W, H);

    const span = Math.log(F_HI / F_LO);
    const xOf = (f) => PAD + (Math.log(f / F_LO) / span) * (W - PAD * 2);

    g.strokeStyle = '#242835';
    g.lineWidth = 1;
    for (const f of [100, 1000, 10000]) {
      const x = Math.round(xOf(f)) + 0.5;
      g.beginPath();
      g.moveTo(x, PAD);
      g.lineTo(x, H - PAD);
      g.stroke();
    }
    g.fillStyle = '#5a6172';
    g.font = '600 8px ui-sans-serif, system-ui, sans-serif';
    g.fillText('100', xOf(100) + 3, H - 4);
    g.fillText('1k', xOf(1000) + 3, H - 4);
    g.fillText('10k', xOf(10000) + 3, H - 4);

    if (!curveEnv || !curveOut || curveEnv.length < 2) {
      g.fillStyle = '#4a5162';
      g.font = '600 9px ui-sans-serif, system-ui, sans-serif';
      g.fillText('waiting for audio', PAD + 6, H / 2);
      return;
    }

    // The envelope is an absolute level, so the window follows the signal.
    // Smoothed, otherwise the whole plot jumps with every bass note.
    let top = -Infinity;
    for (let i = 0; i < curveEnv.length; i++) if (curveEnv[i] > top) top = curveEnv[i];
    if (!isFinite(top)) top = 0;
    smoothTop = smoothTop === null ? top : smoothTop + (top - smoothTop) * 0.15;

    const hi = smoothTop + 8;
    const lo = hi - 68;
    const n = curveEnv.length;
    const xAt = (i) => PAD + (i / (n - 1)) * (W - PAD * 2);
    const yAt = (d) => {
      const t = (Math.min(hi, Math.max(lo, d)) - lo) / (hi - lo);
      return PAD + (1 - t) * (H - PAD * 2);
    };

    // Amber fill between the two curves is the gain actually being applied.
    g.beginPath();
    for (let i = 0; i < n; i++) {
      const x = xAt(i);
      const y = yAt(curveOut[i]);
      if (i) g.lineTo(x, y);
      else g.moveTo(x, y);
    }
    for (let i = n - 1; i >= 0; i--) g.lineTo(xAt(i), yAt(curveEnv[i]));
    g.closePath();
    g.fillStyle = 'rgba(242,165,74,.20)';
    g.fill();

    g.lineJoin = 'round';
    g.lineCap = 'round';
    const stroke = (arr, colour, width) => {
      g.beginPath();
      for (let i = 0; i < n; i++) {
        const x = xAt(i);
        const y = yAt(arr[i]);
        if (i) g.lineTo(x, y);
        else g.moveTo(x, y);
      }
      g.strokeStyle = colour;
      g.lineWidth = width;
      g.stroke();
    };
    stroke(curveEnv, '#5bc0d0', 1.4);
    stroke(curveOut, '#f2a54a', 1.9);
  }

  function paintMeters() {
    if (!controls._ro || !panel) return;
    const fresh = performance.now() - meters.at < 1200;
    const r = controls._ro;
    r.depth.textContent = fresh ? meters.depth.toFixed(1) + ' dB' : '--';
    r.depth.className = 'n warp';
    r.wobble.textContent = fresh ? meters.wobble.toFixed(1) + ' dB' : '--';
    const lim = meters.limiter === undefined ? 1 : meters.limiter;
    const red = lim < 0.999 ? 20 * Math.log10(lim) : 0;
    r.ceiling.textContent = red < -0.05 ? red.toFixed(1) + ' dB' : '0.0 dB';
    r.ceiling.className = red < -0.05 ? 'n alert' : 'n quiet';
    r.delay.textContent = latencyS ? Math.round(latencyS * 1000) + ' ms' : '--';
  }

  // -------------------------------------------------------------- panel build

  function tipFor(key, row) {
    if (activeTip === key) {
      activeTip = null;
    } else {
      activeTip = key;
    }
    const existing = panel.wrap.querySelector('.tip');
    if (existing) existing.remove();
    for (const b of panel.wrap.querySelectorAll('.q')) b.classList.remove('on');
    if (activeTip === key) {
      const tip = h('div', { class: 'tip' }, TIPS[key] || '');
      row.after(tip);
      const q = row.querySelector('.q');
      if (q) q.classList.add('on');
    }
  }

  function qButton(key, row) {
    return h(
      'button',
      {
        class: 'q',
        title: 'what does this do',
        'aria-label': 'explain',
        onclick: () => tipFor(key, row),
      },
      '?'
    );
  }

  function slider(key, label, min, max, step, fmt, after) {
    const val = h('span', { class: 'v' }, fmt(state[key]));
    const inp = h('input', {
      type: 'range',
      min: String(min),
      max: String(max),
      step: String(step),
      oninput: (e) => {
        state[key] = parseFloat(e.target.value);
        val.textContent = fmt(state[key]);
        pushParams();
        save();
        if (after) after();
      },
    });
    inp.value = String(state[key]);
    const lb = h('span', { class: 'lb' }, label);
    const row = h('div', { class: 'ctl' }, lb, inp, val);
    if (TIPS[key]) lb.append(qButton(key, row));
    controls[key] = {
      row,
      set(v) {
        inp.value = String(v);
        val.textContent = fmt(v);
      },
    };
    return row;
  }

  function buildPanel() {
    const host = h('div', {});
    host.style.setProperty('all', 'initial');
    const root = host.attachShadow({ mode: 'open' });
    const style = h('style');
    style.textContent = CSS;

    const pct = (v) => Math.round(v * 100) + '%';

    // header
    const chip = h('span', { class: 'chip live' }, '');
    controls._chip = {
      set: () =>
        (chip.textContent =
          '−' + state.semitones + ' st · ' + (rateOf() * 100).toFixed(2) + '%'),
    };
    const power = h(
      'button',
      {
        onclick: () => {
          state.enabled = !state.enabled;
          rescanRates();
          pushParams();
          save();
          syncPanel();
        },
      },
      'on'
    );
    controls.enabled = { set: (v) => (power.className = v ? 'on' : '') };

    // plot
    const cv = h('canvas');
    const key = h(
      'div',
      { class: 'key' },
      h('span', { style: { color: '#5bc0d0' } }, h('i', { style: { background: '#5bc0d0' } }), 'original'),
      h('span', { style: { color: '#f2a54a' } }, h('i', { style: { background: '#f2a54a' } }), 'warped')
    );

    // readouts
    const cell = (label, cls) => {
      const n = h('div', { class: 'n ' + cls }, '--');
      return { el: h('div', {}, h('div', { class: 'k' }, label), n), n };
    };
    const cDepth = cell('depth', 'warp');
    const cWob = cell('wobble', '');
    const cCeil = cell('ceiling', 'quiet');
    const cLat = cell('delay', 'quiet');
    controls._ro = { depth: cDepth.n, wobble: cWob.n, ceiling: cCeil.n, delay: cLat.n };

    // interval
    const semSel = h('select', {
      onchange: (e) => {
        state.semitones = parseFloat(e.target.value);
        rescanRates();
        pushParams();
        save();
        syncPanel();
      },
    });
    for (let s = 1; s <= 7; s++) semSel.append(h('option', { value: String(s) }, '−' + s + ' st'));
    semSel.value = String(state.semitones);
    controls.semitones = { set: (v) => (semSel.value = String(v)) };
    const semLb = h('span', { class: 'lb' }, 'interval');
    const semVal = h('span', { class: 'v' }, '');
    controls._semVal = { set: () => (semVal.textContent = (rateOf() * 100).toFixed(2) + '%') };
    const semRow = h('div', { class: 'ctl' }, semLb, semSel, semVal);
    semLb.append(qButton('semitones', semRow));

    // stereo mode
    const lrBtn = h('button', { onclick: () => setMs(false) }, 'L / R');
    const msBtn = h('button', { onclick: () => setMs(true) }, 'M / S');
    function setMs(v) {
      state.stereoMs = v;
      pushParams();
      save();
      syncPanel();
    }
    controls.stereoMs = {
      set: (v) => {
        lrBtn.className = v ? '' : 'sel';
        msBtn.className = v ? 'sel' : '';
      },
    };
    const msLb = h('span', { class: 'lb' }, 'stereo');
    const msRow = h(
      'div',
      { class: 'ctl' },
      msLb,
      h('div', { class: 'seg' }, lrBtn, msBtn),
      h('span', { class: 'v' }, '')
    );
    msLb.append(qButton('stereoMs', msRow));

    const sideRow = slider('sideWet', 'side amount', 0, 1, 0.01, pct);

    // window size
    const fftSel = h('select', {
      onchange: (e) => {
        state.fftSize = parseInt(e.target.value, 10);
        save();
        curveEnv = null;
        curveOut = null;
        smoothTop = null;
        rebuildNodes();
      },
    });
    for (const n of [1024, 2048, 4096]) fftSel.append(h('option', { value: String(n) }, String(n)));
    fftSel.value = String(state.fftSize);
    controls.fftSize = { set: (v) => (fftSel.value = String(v)) };
    const fftLb = h('span', { class: 'lb' }, 'window');
    const fftRow = h('div', { class: 'ctl' }, fftLb, fftSel, h('span', { class: 'v' }, ''));
    fftLb.append(qButton('fftSize', fftRow));

    // loudness match
    const loudBtn = h(
      'button',
      {
        onclick: () => {
          state.loudnessMatch = !state.loudnessMatch;
          pushParams();
          save();
          syncPanel();
        },
      },
      'on'
    );
    controls.loudnessMatch = { set: (v) => (loudBtn.className = v ? 'on' : '') };
    const loudLb = h('span', { class: 'lb' }, 'loudness match');
    const loudRow = h('div', { class: 'ctl' }, loudLb, loudBtn, h('span', { class: 'v' }, ''));
    loudLb.append(qButton('loudnessMatch', loudRow));

    // compare
    const cmp = h('div', { class: 'cmp' }, '');
    controls._cmp = {
      el: cmp,
      set: () => {
        cmp.className = abHeld ? 'cmp held' : 'cmp';
        cmp.textContent = abHeld ? 'SLOWED ONLY' : 'HOLD ALT+A FOR SLOWED ONLY';
      },
    };
    cmp.addEventListener('pointerdown', () => setAb(true));
    cmp.addEventListener('pointerup', () => setAb(false));
    cmp.addEventListener('pointerleave', () => setAb(false));

    const statusEl = h('div', { class: 'status' });
    controls._status = { el: statusEl };

    const wrap = h(
      'div',
      { class: 'wrap' },
      h(
        'div',
        { class: 'hd' },
        markSvg(15),
        h('span', { class: 'nm' }, 'Slowform'),
        chip,
        h('span', { class: 'sp' }),
        power,
        h(
          'button',
          { onclick: () => togglePanel(false), title: 'collapse (alt+S)', 'aria-label': 'collapse' },
          '×'
        )
      ),
      h('div', { class: 'plotwrap' }, cv, key),
      h(
        'div',
        { class: 'ro' },
        cDepth.el,
        cWob.el,
        cCeil.el,
        cLat.el
      ),
      h('div', { class: 'rule' }),
      semRow,
      slider('midWet', 'amount', 0, 1, 0.01, pct),
      slider('envResHz', 'envelope res', 150, 1500, 25, (v) => Math.round(v) + ' Hz'),
      slider('crossoverHz', 'crossover', 0, 400, 5, (v) => (v <= 0 ? 'off' : Math.round(v) + ' Hz')),
      slider('transient', 'transient relax', 0, 1, 0.01, pct),
      msRow,
      sideRow,
      fftRow,
      loudRow,
      cmp,
      statusEl
    );
    controls._sideRow = sideRow;

    const launch = h(
      'div',
      {
        class: 'launch',
        title: 'show the Slowform panel (alt+S)',
        role: 'button',
        tabindex: '0',
        onclick: () => togglePanel(true),
        onkeydown: (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            togglePanel(true);
          }
        },
      },
      markSvg(12),
      'slowform'
    );

    root.append(style, wrap, launch);
    (document.body || document.documentElement).append(host);
    panel = { host, wrap, launch };

    plotDpr = Math.min(2, window.devicePixelRatio || 1);
    cv.width = Math.round(318 * plotDpr);
    cv.height = Math.round(100 * plotDpr);
    plotCtx = cv.getContext('2d');
    if (plotCtx) plotCtx.scale(plotDpr, plotDpr);

    syncPanel();
    drawPlot();
  }

  function syncPanel() {
    if (!panel) return;
    for (const k of Object.keys(DEFAULTS)) {
      if (controls[k] && controls[k].set) controls[k].set(state[k]);
    }
    controls._chip.set();
    controls._semVal.set();
    controls._cmp.set();
    controls._sideRow.className = state.stereoMs ? 'ctl' : 'ctl dim';
    panel.wrap.className = state.panelOpen ? 'wrap' : 'wrap closed';
    panel.launch.className = state.panelOpen ? 'launch' : 'launch show';
    paintMeters();
  }

  function togglePanel(open) {
    state.panelOpen = open === undefined ? !state.panelOpen : open;
    save();
    syncPanel();
    pushWatch();
    if (state.panelOpen) drawPlot();
  }

  function setAb(on) {
    if (abHeld === on) return;
    abHeld = on;
    pushParams();
    if (controls._cmp) controls._cmp.set();
  }

  function refreshStatus() {
    if (!panel) return;
    // A single-page app that replaces body content would take the panel with
    // it, and then toggling would flip a flag with nothing left on screen to
    // show. Put it back rather than leaving the user with no way in.
    if (!panel.host.isConnected) {
      (document.body || document.documentElement).append(panel.host);
    }
    paintMeters();
    const el = controls._status.el;
    let msg = '';
    if (statusMsg) msg = statusMsg;
    else if (wasmError) msg = wasmError;
    else if (ctx && ctx.state === 'suspended') msg = 'audio context suspended, click the page';
    else if (ctx) {
      const fresh = performance.now() - lastLevel.at < 1500;
      const playing = Array.prototype.some.call(
        document.querySelectorAll('video,audio'),
        (m) => !m.paused && !m.muted && m.volume > 0
      );
      if (playing && fresh && lastLevel.inRms < 1e-5) {
        msg = 'element is playing but the tap is silent, probably cross-origin media';
      }
    }
    el.textContent = msg;
  }

  if (IS_TOP) {
    const start = () => {
      if (!panel) buildPanel();
      setInterval(refreshStatus, 400);
    };
    if (document.body) start();
    else document.addEventListener('DOMContentLoaded', start, { once: true });

    window.addEventListener(
      'keydown',
      (e) => {
        if (!e.altKey || e.ctrlKey || e.metaKey) return;
        const k = e.key.toLowerCase();
        if (k === 's') {
          togglePanel();
        } else if (k === 'a') {
          if (!e.repeat) setAb(true);
        } else if (k === 'x') {
          state.enabled = !state.enabled;
          rescanRates();
          pushParams();
          save();
          syncPanel();
        } else return;
        e.preventDefault();
        e.stopPropagation();
      },
      true
    );

    // Alt-tabbing out mid-compare means keyup never arrives, which would leave
    // the warp off while the panel still claims it is on.
    window.addEventListener('blur', () => setAb(false));
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) setAb(false);
    });

    window.addEventListener(
      'keyup',
      (e) => {
        if (e.key.toLowerCase() === 'a' || e.key === 'Alt') setAb(false);
      },
      true
    );
  }
})();
