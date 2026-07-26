#!/usr/bin/env node
// Builds design/icon-candidates.html: every concept at real size against both
// toolbar colours, in greyscale, and magnified.
//
//   node tools/icon-compare.js
//
// The PNGs are embedded as data URIs so the page is self-contained and can be
// published as-is.

const fs = require('fs');
const path = require('path');
const { CONCEPTS, render, encodePng } = require('./icons.js');

// Assessment lives here rather than in the geometry table: it is a judgement
// about the comparison, not a property of the mark.
const NOTES = {
  arch: {
    role: 'current',
    at16: 'weak',
    verdict:
      'The two arcs merge into one blob at 16 px and colour is the only thing left carrying the difference. It also shipped with a full-bleed tile, which Chrome’s guidance advises against.',
  },
  mass: {
    role: 'alternative',
    at16: 'strong',
    verdict:
      'Filled mass is the shape that best survives downscaling, and pairing solid against outline keeps the two states separable without leaning on colour. The only candidate that actually depicts an envelope and its shifted copy while still reading small.',
  },
  spectrum: {
    role: 'alternative',
    at16: 'strong',
    verdict:
      'The most legible of the set and the most conventional. Reads instantly as an analyser, which is both why it works and why it is the least ownable: a great deal of audio software already looks like this.',
  },
  ticks: {
    role: 'alternative',
    at16: 'good',
    verdict:
      'Legible once it became a single row, but the meaning did not follow. At 16 px it reads as a barcode rather than beats spread apart, so it communicates less than it costs.',
  },
  lift: {
    role: 'alternative',
    at16: 'strong',
    verdict:
      'Clean at every size and unambiguous about direction. It says something rises without saying what, so it would sit equally well on any pitch tool.',
  },
  faders: {
    role: 'alternative',
    at16: 'good',
    verdict:
      'The only one showing both motions at once, which is the truest summary of what the tool does. At 16 px the tracks fade out and it reduces to two dots at different heights, and that still carries the idea.',
  },
};

const ORDER = ['mass', 'faders', 'lift', 'spectrum', 'ticks'];

function dataUri(size, shapes, grey) {
  let rgba = render(size, shapes);
  if (grey) {
    rgba = Buffer.from(rgba);
    for (let i = 0; i < rgba.length; i += 4) {
      const l = Math.round(0.2126 * rgba[i] + 0.7152 * rgba[i + 1] + 0.0722 * rgba[i + 2]);
      rgba[i] = l;
      rgba[i + 1] = l;
      rgba[i + 2] = l;
    }
  }
  return 'data:image/png;base64,' + encodePng(size, rgba).toString('base64');
}

function specimen(shapes) {
  const at = (s, grey) => `<img src="${dataUri(s, shapes, grey)}" width="${s}" height="${s}" alt="">`;
  return `
      <div class="spec">
        <div class="grp dark"><span class="gl">dark toolbar</span><div class="ico">${at(16)}${at(32)}${at(48)}</div></div>
        <div class="grp light"><span class="gl">light toolbar</span><div class="ico">${at(16)}${at(32)}${at(48)}</div></div>
        <div class="grp plain"><span class="gl">no colour</span><div class="ico">${at(16, true)}${at(32, true)}${at(48, true)}</div></div>
        <div class="grp plain"><span class="gl">16 px magnified</span><div class="ico"><img class="mag" src="${dataUri(16, shapes)}" width="96" height="96" alt=""></div></div>
        <div class="grp plain big"><span class="gl">128</span><div class="ico">${at(128)}</div></div>
      </div>`;
}

function card(name, index) {
  const c = CONCEPTS[name];
  const n = NOTES[name];
  const eyebrow = n.role === 'current' ? 'Currently shipped' : 'Alternative ' + index;
  return `
    <section class="card${n.role === 'current' ? ' is-current' : ''}">
      <header>
        <div class="eyebrow">${eyebrow}</div>
        <h2>${c.title}</h2>
        <span class="pill p-${n.at16}">16 px: ${n.at16}</span>
      </header>
      ${specimen(c.shapes)}
      <p class="blurb">${c.blurb}</p>
      <p class="verdict">${n.verdict}</p>
    </section>`;
}

const HTML = `<title>Slowform icon: five alternatives</title>
<style>
  :root {
    --bg: #f5f6f8; --fg: #14161b; --dim: #5b6273; --rule: #dadde4; --card: #fff;
    --accent: #a8620d; --cyan: #1f7f8f;
  }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #0a0b0f; --fg: #e3e7f0; --dim: #868d9e; --rule: #22252e; --card: #11131a;
            --accent: #f2a54a; --cyan: #5bc0d0; }
  }
  :root[data-theme="dark"] { --bg: #0a0b0f; --fg: #e3e7f0; --dim: #868d9e; --rule: #22252e;
            --card: #11131a; --accent: #f2a54a; --cyan: #5bc0d0; }
  :root[data-theme="light"] { --bg: #f5f6f8; --fg: #14161b; --dim: #5b6273; --rule: #dadde4;
            --card: #fff; --accent: #a8620d; --cyan: #1f7f8f; }

  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--fg);
         font: 15px/1.6 ui-sans-serif, system-ui, "Segoe UI", Roboto, sans-serif;
         -webkit-font-smoothing: antialiased; }
  .shell { max-width: 1000px; margin: 0 auto; padding: 56px 24px 90px; }

  .eyebrow { font: 600 10px/1 ui-sans-serif, system-ui, sans-serif; letter-spacing: .14em;
             text-transform: uppercase; color: var(--dim); }
  h1 { font-size: clamp(27px, 4vw, 38px); line-height: 1.1; letter-spacing: -.022em;
       font-weight: 650; margin: 12px 0 0; text-wrap: balance; max-width: 22ch; }
  .lede { max-width: 66ch; color: var(--dim); margin: 18px 0 0; }
  .lede strong { color: var(--fg); font-weight: 600; }

  .rules { margin: 30px 0 0; padding: 18px 20px; border: 1px solid var(--rule);
           border-radius: 10px; background: var(--card); display: grid;
           grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 15px 26px; }
  .rules div { font-size: 13px; line-height: 1.5; }
  .rules b { display: block; font: 600 10px/1.7 ui-sans-serif, system-ui, sans-serif;
             letter-spacing: .12em; text-transform: uppercase; color: var(--dim); }

  .cards { margin-top: 44px; display: flex; flex-direction: column; gap: 22px; }
  .card { border: 1px solid var(--rule); border-radius: 12px; background: var(--card);
          padding: 20px 22px 22px; }
  .card.is-current { border-style: dashed; opacity: .92; }
  .card header { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; }
  .card h2 { font-size: 19px; letter-spacing: -.012em; font-weight: 640; margin: 4px 0 0; flex: 1; }

  .pill { font: 600 10px/1 ui-sans-serif, system-ui, sans-serif; letter-spacing: .09em;
          text-transform: uppercase; padding: 5px 8px; border-radius: 20px; white-space: nowrap; }
  .p-strong { background: color-mix(in srgb, #4e9c6b 26%, transparent); color: #4e9c6b; }
  .p-good { background: color-mix(in srgb, #b58a2b 26%, transparent); color: #b58a2b; }
  .p-weak { background: color-mix(in srgb, #c1584e 26%, transparent); color: #c1584e; }
  @media (prefers-color-scheme: dark) {
    .p-strong { color: #7fcf9b; } .p-good { color: #e0b96b; } .p-weak { color: #e08a80; }
  }

  .spec { margin: 18px 0 0; display: flex; flex-wrap: wrap; gap: 10px; align-items: stretch; }
  .grp { border: 1px solid var(--rule); border-radius: 9px; padding: 8px 12px 11px;
         display: flex; flex-direction: column; gap: 8px; }
  .grp.dark { background: #202124; border-color: #303136; }
  .grp.light { background: #fff; border-color: #dcdfe4; }
  .gl { font: 600 8.5px/1 ui-sans-serif, system-ui, sans-serif; letter-spacing: .1em;
        text-transform: uppercase; color: var(--dim); }
  .grp.dark .gl { color: #8b919d; }
  .grp.light .gl { color: #767c88; }
  .ico { display: flex; align-items: flex-end; gap: 14px; flex: 1; }
  .ico img { display: block; }
  img.mag { image-rendering: pixelated; }
  .grp.big .ico img { width: 128px; height: 128px; }

  .blurb { max-width: 66ch; font-size: 14px; margin: 18px 0 0; }
  .verdict { max-width: 66ch; font-size: 13.5px; color: var(--dim); margin: 9px 0 0;
             border-left: 2px solid var(--accent); padding-left: 13px; }

  .close { margin-top: 56px; border-top: 1px solid var(--rule); padding-top: 28px; }
  .close h2 { font-size: 20px; letter-spacing: -.014em; margin: 0 0 12px; }
  .close p { max-width: 66ch; font-size: 14.5px; }
  .close strong { color: var(--fg); }
  a { color: var(--cyan); }
  ol.src { max-width: 66ch; font-size: 13px; color: var(--dim); }
</style>

<div class="shell">
  <div class="eyebrow">Slowform &middot; toolbar icon</div>
  <h1>Five alternatives, judged small</h1>
  <p class="lede">
    Chrome asks for <strong>96&times;96 of artwork in a 128 canvas</strong> with the
    rest transparent, no edge or tile of its own because the browser may add one,
    and it has to hold up on both toolbar colours. The guidance is also blunt
    about method: if a mark is not legible at its minimum size, redesign it
    rather than scaling it down. So every candidate here was cut at 16 px first
    and judged there, and two of them were reworked after failing that test.
  </p>

  <div class="rules">
    <div><b>Why greyscale</b>Cyan against amber survives most colour vision deficiency, but a mark that needs colour to be understood is a weaker mark. The third strip removes it.</div>
    <div><b>Why magnified</b>Nearest neighbour on the 16 px cut, so you can see exactly which pixels survived rather than guessing.</div>
    <div><b>What stayed fixed</b>Cyan is always where the resample left the envelope, amber is always where the warp puts it. Same language as the panel.</div>
    <div><b>Reproducible</b>All six come from one geometry table in <code>tools/icons.js</code>, centred from their own bounds, encoded with zlib and no image library.</div>
  </div>

  <div class="cards">
${card('arch', 0)}
${ORDER.map((n, i) => card(n, i + 1)).join('\n')}
  </div>

  <div class="close">
    <h2>Where I would land</h2>
    <p>
      <strong>Solid and outline.</strong> It is the only candidate that depicts
      the actual operation, an envelope and a shifted copy of itself, while still
      being readable at 16 px, and it is the one that survives the greyscale
      strip most convincingly because the two states differ in fill rather than
      only in hue. <strong>Down and up</strong> is the runner-up and the better
      choice if you would rather the mark describe what the listener gets than
      what the code does. <strong>Moved peak</strong> is the safe option: the
      most legible thing here and the least yours.
    </p>
    <p>
      The one I would not keep is the current twin arch. It is the weakest of the
      six at the size that matters most.
    </p>
    <ol class="src">
      <li><a href="https://developer.chrome.com/docs/webstore/images">Supplying Images, Chrome for Developers</a></li>
      <li><a href="https://developer.chrome.com/docs/extensions/reference/manifest/icons">Manifest: Icons, Chrome for Developers</a></li>
    </ol>
  </div>
</div>
`;

const out = path.join(__dirname, '..', 'design', 'icon-candidates.html');
fs.writeFileSync(out, HTML);
console.log('design/icon-candidates.html  ' + Math.round(HTML.length / 1024) + ' KB');
