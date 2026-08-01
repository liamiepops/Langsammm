// Runs in the page's own realm, because createMediaElementSource has to see
// the page's media elements.
//
// Signal chain: the browser does the resample (playbackRate with
// preservesPitch off), which drops tempo, pitch and spectral envelope together.
// The worklet then warps the envelope back up by the same interval.

(() => {
  if (window.__langsammmLoaded) return;
  window.__langsammmLoaded = true;

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

  const TO_PAGE = 'langsammm:to-page';
  const FROM_PAGE = 'langsammm:from-page';
  const IS_TOP = window.top === window;

  const DEFAULTS = {
    enabled: true,
    semitones: 3, // down
    midWet: 1.0,
    sideWet: 1.0,
    stereoMs: false,
    crossoverHz: 150,
    transient: 0,
    envResHz: 600,
    fftSize: 2048,
    loudnessMatch: true,
    panelOpen: true,
  };

  // Development-only features. `build.ps1 -Release` rewrites this line to
  // false and fails the build if it cannot find it, so nothing gated on it can
  // reach a published build by accident.
  const DEV = true;

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
    window.postMessage({ __langsammm: FROM_PAGE, ...msg }, '*');
  }

  let wasmBytes = null;
  let wasmError = null;
  const wasmWaiters = [];

  window.addEventListener('message', (ev) => {
    if (ev.source !== window) return;
    const d = ev.data;
    if (!d || d.__langsammm !== TO_PAGE) return;

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

  function pushParams(snap) {
    const p = paramBlock();
    if (snap) p.snap = true;
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
    const node = new AudioWorkletNode(c, 'langsammm', {
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
    if (el.__langsammmAttached) return;
    el.__langsammmAttached = true;

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
      if (!el.__langsammmAttached) attach(el);
      else applyRate(el);
    });
  }

  // YouTube rewrites its DOM continuously, so an undebounced observer would run
  // a document-wide query hundreds of times a second. Records without an added
  // element are ignored outright, and the rest collapse into one scan.
  let scanQueued = false;
  function queueScan() {
    if (scanQueued) return;
    scanQueued = true;
    setTimeout(() => {
      scanQueued = false;
      scan();
    }, 300);
  }

  new MutationObserver((records) => {
    for (const r of records) {
      for (const node of r.addedNodes) {
        if (node.nodeType === 1) {
          queueScan();
          return;
        }
      }
    }
  }).observe(document.documentElement, { childList: true, subtree: true });

  // Slow safety net for anything the observer misses.
  setInterval(scan, 3000);
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

  // The mark: one wave whose wavelength grows as it travels, ash handing over
  // to vermilion. Emitted by `node tools/icons.js --svg`, so it comes from the
  // same geometry as the PNGs. Regenerate rather than edit by hand.
  //
  // Built with createElementNS because YouTube enforces Trusted Types and would
  // refuse an innerHTML assignment.
  const MARK_VIEWBOX = '0.7 5.1 22.6 13.8';
  const MARK_RATIO = 22.6 / 13.8;
  const MARK_PATHS = [
    [
      '#a8a29c',
      'M2 12L2.4 8.9L2.8 6.9L3.2 6.5L3.6 7.7L4 10.1L4.4 12.9L4.8 15.4L5.2 17.1L5.6 17.6L6 16.9L6.4 15.1L6.8 12.8L7.2 10.4L7.6 8.3L8 6.9L8.4 6.4L8.8 6.8L9.2 7.9L9.6 9.7L10 11.7L10.4 13.8L10.8 15.5L11.2 16.8',
    ],
    [
      '#d93b2b',
      'M11.2 16.8L11.6 17.5L12 17.5L12.4 16.9L12.8 15.7L13.2 14.2L13.6 12.5L14 10.7L14.4 9.1L14.8 7.8L15.2 6.9L15.6 6.4L16 6.5L16.4 7L16.8 7.9L17.2 9.2L17.6 10.6L18 12.1L18.4 13.6L18.8 15L19.2 16.1L19.6 16.9L20 17.4L20.4 17.6L20.8 17.4L21.2 16.9L21.6 16.1L22 15',
    ],
  ];

  function markSvg(height) {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', MARK_VIEWBOX);
    svg.setAttribute('height', String(height));
    svg.setAttribute('width', String(Math.round(height * MARK_RATIO)));
    svg.setAttribute('aria-hidden', 'true');
    for (const [colour, d] of MARK_PATHS) {
      const p = document.createElementNS(NS, 'path');
      p.setAttribute('d', d);
      p.setAttribute('fill', 'none');
      p.setAttribute('stroke', colour);
      p.setAttribute('stroke-width', '2.6');
      p.setAttribute('stroke-linecap', 'round');
      p.setAttribute('stroke-linejoin', 'round');
      svg.append(p);
    }
    return svg;
  }

  // Amber always means the warped signal, cyan always means the original.
  const CSS = `
:host { all: initial; }
.wrap {
  position: fixed; right: 16px; bottom: 16px; width: 344px; z-index: 2147483647;
  box-sizing: border-box;
  font: 12px/1.45 ui-sans-serif, system-ui, "Segoe UI", Roboto, sans-serif;
  color: #edebe8; background: #16151a; border: 1px solid #33313a;
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
  background: #16151a; border: 1px solid #33313a; border-radius: 8px;
  padding: 7px 10px; cursor: pointer; opacity: .72;
  box-shadow: 0 6px 22px rgba(0,0,0,.5);
  font: 600 9.5px/1 ui-sans-serif, system-ui, "Segoe UI", sans-serif;
  letter-spacing: .12em; text-transform: uppercase; color: #8a8681;
  transition: opacity .12s, color .12s;
}
.launch.show { display: flex; }
.launch:hover { opacity: 1; color: #edebe8; }
.launch svg { display: block; flex: none; }
@media (prefers-reduced-motion: reduce) { .launch { transition: none; } }

.hd { display: flex; align-items: center; gap: 7px; margin-bottom: 10px; }
.hd svg { display: block; flex: none; }
.nm { font-weight: 640; letter-spacing: .015em; margin-right: 1px; }
.sp { flex: 1; }

.chip {
  font: 600 10px/1 ui-monospace, "Cascadia Code", Consolas, monospace;
  font-variant-numeric: tabular-nums; letter-spacing: .04em;
  padding: 4px 6px; border-radius: 4px; background: #26252c; color: #8a8681;
}
.chip.live { color: #d93b2b; background: rgba(217,59,43,.18); }

button {
  font: inherit; color: #edebe8; background: #26252c; border: 1px solid #33313a;
  border-radius: 6px; padding: 3px 8px; cursor: pointer;
}
button:hover { background: #302e36; }
button.on { background: rgba(107,191,138,.22); border-color: #4d8a64; }
select {
  font: 11px/1 ui-sans-serif, system-ui, sans-serif; background: #26252c; color: #edebe8;
  border: 1px solid #33313a; border-radius: 5px; padding: 3px 4px;
}

canvas { display: block; width: 318px; height: 100px; border-radius: 6px; background: #1e1d23; }
.plotwrap { position: relative; }
.key {
  position: absolute; left: 8px; top: 7px; display: flex; gap: 10px; pointer-events: none;
  font: 600 8.5px/1 ui-sans-serif, system-ui, sans-serif; letter-spacing: .09em; text-transform: uppercase;
}
.key i { display: inline-block; width: 7px; height: 2px; margin-right: 4px; vertical-align: middle; }

.ro { display: grid; grid-template-columns: repeat(4, 1fr); gap: 1px; background: #33313a;
      border-radius: 6px; overflow: hidden; margin-top: 10px; }
.ro > div { background: #1e1d23; padding: 6px 7px; }
.ro .k { font: 600 8.5px/1 ui-sans-serif, system-ui, sans-serif; letter-spacing: .1em;
         text-transform: uppercase; color: #8a8681; }
.ro .n { font: 12px/1.3 ui-monospace, "Cascadia Code", Consolas, monospace;
         font-variant-numeric: tabular-nums; margin-top: 3px; color: #edebe8; }
.ro .n.warp { color: #d93b2b; }
.ro .n.quiet { color: #8a8681; }
.ro .n.alert { color: #e8c547; }

.rule { height: 1px; background: #33313a; margin: 11px -13px; }

.ctl { display: flex; align-items: center; gap: 9px; margin: 7px 0; }
.ctl .lb { flex: 1; color: #b3aeaa; font-size: 11.5px; display: flex; align-items: center; gap: 5px; }
.ctl .v { font: 11px/1 ui-monospace, "Cascadia Code", Consolas, monospace;
          font-variant-numeric: tabular-nums; color: #edebe8; width: 54px; text-align: right; }
.ctl.dim .lb, .ctl.dim .v { opacity: .38; }

.q { width: 13px; height: 13px; border-radius: 50%; padding: 0; flex: none;
     border: 1px solid #33313a; background: none; color: #8a8681;
     font: 700 8px/11px ui-sans-serif, system-ui, sans-serif; text-align: center; cursor: help; }
.q:hover { background: #26252c; }
.q.on { border-color: #d93b2b; color: #d93b2b; }

input[type=range] { width: 112px; accent-color: #d93b2b; margin: 0; display: block; }

/* Default marker. Drawn rather than using a datalist, because browsers style
   those inconsistently and the position has to line up with the thumb travel. */
.trk { position: relative; width: 112px; height: 18px; flex: none;
       display: flex; align-items: center; }
.tick { position: absolute; bottom: 0; width: 2px; height: 4px; border-radius: 1px;
        background: #7d7873; pointer-events: none; }
.tick.at { background: #d93b2b; }

.seg { display: flex; background: #26252c; border-radius: 5px; padding: 2px; gap: 2px; }
.seg button { font: 600 10px/1 ui-sans-serif, system-ui, sans-serif; padding: 4px 7px;
              border: none; background: none; color: #8a8681; border-radius: 3px; }
.seg button.sel { background: #3b3941; color: #edebe8; }

/* Floats over the panel instead of sitting in the flow, so opening one does
   not shove every control below it down the panel. */
.tip { position: absolute; left: 13px; right: 13px; z-index: 6; display: none;
       background: #2a282f; border: 1px solid #45424b; border-radius: 7px;
       padding: 8px 10px; font-size: 11px; line-height: 1.45; color: #dedad6;
       box-shadow: 0 10px 28px rgba(0,0,0,.75); }
.tip.show { display: block; }
.tip::before { content: ""; position: absolute; top: -5px; left: var(--ax, 22px);
       width: 8px; height: 8px; background: #2a282f;
       border-left: 1px solid #45424b; border-top: 1px solid #45424b;
       transform: rotate(45deg); }
.tip.above::before { top: auto; bottom: -5px;
       border-left: 0; border-top: 0;
       border-right: 1px solid #45424b; border-bottom: 1px solid #45424b; }

.cmp { margin-top: 11px; width: 100%; border: 1px solid #33313a; background: #26252c;
       border-radius: 6px; padding: 8px; color: #b3aeaa;
       font: 600 10.5px/1 ui-sans-serif, system-ui, sans-serif; letter-spacing: .05em; text-align: center; }
.cmp.held { background: rgba(217,59,43,.22); border-color: #d93b2b; color: #d93b2b; }

.status { margin-top: 9px; color: #e0b96b; font-size: 11px; white-space: pre-line; }
.status:empty { display: none; }

button:focus-visible, select:focus-visible, input:focus-visible { outline: 2px solid #d93b2b; outline-offset: 1px; }
`;

  const TIPS = {
    semitones:
      'How far down the track is taken. The player runs at this ratio with ' +
      'pitch preservation off, which drags the spectral envelope down along ' +
      'with the pitch. The warp lifts the envelope back.',
    midWet:
      'How much of that lift is applied. At 100% the envelope returns the ' +
      'full interval. At zero the two curves coincide and the output is the ' +
      'input exactly.',
    envResHz:
      'The narrowest spectral feature the envelope keeps. Widen it and the ' +
      'envelope smooths out, so the formants stop moving. Narrow it below a ' +
      'sound’s fundamental and the envelope starts tracking that sound’s ' +
      'harmonics, which is the shimmer at the bottom of the range.',
    crossoverHz:
      'Turns the warp off below this frequency, fading in from half of it. ' +
      'This keeps bass from being dragged upward. It does more on tracks ' +
      'with a steep low cut, because the warp follows the spectrum’s slope.',
    transient:
      'Backs the warp off on frames where the spectrum jumps, which is mostly ' +
      'drum hits. It drives the same control amount does, so a strong hit at ' +
      '100% momentarily reaches bypass. Steady material is left alone at any ' +
      'setting.',
    stereoMs:
      'Processes mid and side instead of left and right. Vocals usually sit ' +
      'in the middle, so this aims the warp at them and leaves the sides ' +
      'alone.',
    fftSize:
      'Analysis size. Larger reads the envelope more finely and adds delay, ' +
      'shown to the right. Halve it for video so audio keeps up with the ' +
      'picture.',
    loudnessMatch:
      'Matches the output level back to the input over about a second. ' +
      'Without it the louder setting tends to win a comparison on loudness ' +
      'alone.',
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

    g.strokeStyle = '#2b2930';
    g.lineWidth = 1;
    for (const f of [100, 1000, 10000]) {
      const x = Math.round(xOf(f)) + 0.5;
      g.beginPath();
      g.moveTo(x, PAD);
      g.lineTo(x, H - PAD);
      g.stroke();
    }
    g.fillStyle = '#7d7873';
    g.font = '600 8px ui-sans-serif, system-ui, sans-serif';
    g.fillText('100', xOf(100) + 3, H - 4);
    g.fillText('1k', xOf(1000) + 3, H - 4);
    g.fillText('10k', xOf(10000) + 3, H - 4);

    if (!curveEnv || !curveOut || curveEnv.length < 2) {
      g.fillStyle = '#6e6a66';
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
    g.fillStyle = 'rgba(217,59,43,.22)';
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
    stroke(curveEnv, '#a8a29c', 1.4);
    stroke(curveOut, '#d93b2b', 1.9);
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

  function hideTip() {
    activeTip = null;
    if (!panel) return;
    panel.tip.className = 'tip';
    for (const b of panel.wrap.querySelectorAll('.q')) b.classList.remove('on');
  }

  function tipFor(key, row, q) {
    if (!panel) return;
    if (activeTip === key) {
      hideTip();
      return;
    }
    hideTip();
    activeTip = key;
    q.classList.add('on');

    const tip = panel.tip;
    tip.textContent = TIPS[key] || '';
    tip.className = 'tip show';

    // Measure once it is laid out, then flip above the row if there is no room
    // below it. Rows are direct children of the fixed-position wrap, so
    // offsetTop is already relative to the right box.
    const gap = 6;
    const below = row.offsetTop + row.offsetHeight + gap;
    const height = tip.offsetHeight;
    if (below + height > panel.wrap.clientHeight - gap) {
      tip.className = 'tip show above';
      tip.style.top = Math.max(gap, row.offsetTop - height - gap) + 'px';
    } else {
      tip.style.top = below + 'px';
    }

    // Point the arrow at the button that opened it.
    const wrapBox = panel.wrap.getBoundingClientRect();
    const qBox = q.getBoundingClientRect();
    const x = qBox.left - wrapBox.left + qBox.width / 2 - 13 - 4;
    tip.style.setProperty('--ax', Math.max(8, Math.min(wrapBox.width - 60, x)) + 'px');
  }

  function qButton(key, row) {
    const b = h('button', { class: 'q', title: 'what does this do', 'aria-label': 'explain' }, '?');
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      tipFor(key, row, b);
    });
    return b;
  }

  // Thumb width, needed to line the default marker up with where the thumb
  // actually travels rather than with the raw element box.
  const THUMB = 12;
  const TRACK = 112;

  function slider(key, label, min, max, step, fmt, after) {
    const def = DEFAULTS[key];
    const marked = def > min && def < max;

    const val = h('span', { class: 'v' }, fmt(state[key]));
    const inp = h('input', {
      type: 'range',
      min: String(min),
      max: String(max),
      step: String(step),
      oninput: (e) => {
        let v = parseFloat(e.target.value);
        // Gentle detent on the default, three steps wide either side.
        if (marked && Math.abs(v - def) <= step * 3) {
          v = def;
          e.target.value = String(v);
        }
        state[key] = v;
        val.textContent = fmt(v);
        if (tick) tick.className = v === def ? 'tick at' : 'tick';
        pushParams();
        save();
        if (after) after();
      },
    });
    inp.value = String(state[key]);

    let tick = null;
    if (marked) {
      const frac = (def - min) / (max - min);
      tick = h('span', {
        class: state[key] === def ? 'tick at' : 'tick',
        title: 'default ' + fmt(def),
      });
      tick.style.left = THUMB / 2 + (TRACK - THUMB) * frac - 1 + 'px';
    }
    const track = h('span', { class: 'trk' }, inp, tick);

    const lb = h('span', { class: 'lb' }, label);
    const row = h('div', { class: 'ctl' }, lb, track, val);
    if (TIPS[key]) lb.append(qButton(key, row));
    controls[key] = {
      row,
      set(v) {
        inp.value = String(v);
        val.textContent = fmt(v);
        if (tick) tick.className = v === def ? 'tick at' : 'tick';
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
      h('span', { style: { color: '#a8a29c' } }, h('i', { style: { background: '#a8a29c' } }), 'original'),
      h('span', { style: { color: '#d93b2b' } }, h('i', { style: { background: '#d93b2b' } }), 'warped')
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

    // compare, development builds only
    const cmp = DEV ? h('div', { class: 'cmp' }, '') : null;
    controls._cmp = {
      el: cmp,
      set: () => {
        if (!cmp) return;
        cmp.className = abHeld ? 'cmp held' : 'cmp';
        cmp.textContent = abHeld ? 'SLOWED ONLY' : 'HOLD ALT+A FOR SLOWED ONLY';
      },
    };
    if (cmp) {
      cmp.addEventListener('pointerdown', () => setAb(true));
      cmp.addEventListener('pointerup', () => setAb(false));
      cmp.addEventListener('pointerleave', () => setAb(false));
    }

    const statusEl = h('div', { class: 'status' });
    controls._status = { el: statusEl };

    const wrap = h(
      'div',
      { class: 'wrap' },
      h(
        'div',
        { class: 'hd' },
        markSvg(15),
        h('span', { class: 'nm' }, 'Langsammm'),
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
      slider('envResHz', 'envelope width', 50, 1500, 10, (v) => Math.round(v) + ' Hz'),
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
        title: 'show the Langsammm panel (alt+S)',
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
      'langsammm'
    );

    const tip = h('div', { class: 'tip' });
    wrap.append(tip);

    // Anywhere else in the panel dismisses it.
    wrap.addEventListener('click', (e) => {
      const t = e.target;
      if (t && t.closest && (t.closest('.q') || t.closest('.tip'))) return;
      hideTip();
    });

    root.append(style, wrap, launch);
    (document.body || document.documentElement).append(host);
    panel = { host, wrap, launch, tip };

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
    if (!state.panelOpen) hideTip();
    save();
    syncPanel();
    pushWatch();
    if (state.panelOpen) drawPlot();
  }

  function setAb(on) {
    if (!DEV || abHeld === on) return;
    abHeld = on;
    // No smoothing on this one. Judging a crossfade is not an A/B.
    pushParams(true);
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
    // Everything below draws into a panel nobody is looking at.
    if (!state.panelOpen) return;
    paintMeters();
    const el = controls._status.el;
    let msg = '';
    if (statusMsg) msg = statusMsg;
    else if (wasmError) msg = wasmError;
    else if (ctx && ctx.state === 'suspended') msg = 'audio context suspended, click the page';
    else if (ctx) {
      const fresh = performance.now() - lastLevel.at < 1500;
      // The attached elements are already tracked, so this needs no DOM query.
      const playing = records.some(
        (r) => r.el && !r.el.paused && !r.el.muted && r.el.volume > 0
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
          if (!DEV) return;
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
