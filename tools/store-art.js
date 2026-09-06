#!/usr/bin/env node
// Builds the Chrome Web Store promotional images.
//
//   node tools/store-art.js
//
// These come out as HTML at exact pixel sizes instead of PNGs, because the
// artwork carries the wordmark and nothing here can rasterise type without a
// font library. Open the file, right-click the framed area in devtools and
// choose "Capture node screenshot", which writes the exact pixels.

const fs = require('fs');
const path = require('path');

const MARK_A = 'M2 12L2.4 8.9L2.8 6.9L3.2 6.5L3.6 7.7L4 10.1L4.4 12.9L4.8 15.4L5.2 17.1L5.6 17.6L6 16.9L6.4 15.1L6.8 12.8L7.2 10.4L7.6 8.3L8 6.9L8.4 6.4L8.8 6.8L9.2 7.9L9.6 9.7L10 11.7L10.4 13.8L10.8 15.5L11.2 16.8';
const MARK_B = 'M11.2 16.8L11.6 17.5L12 17.5L12.4 16.9L12.8 15.7L13.2 14.2L13.6 12.5L14 10.7L14.4 9.1L14.8 7.8L15.2 6.9L15.6 6.4L16 6.5L16.4 7L16.8 7.9L17.2 9.2L17.6 10.6L18 12.1L18.4 13.6L18.8 15L19.2 16.1L19.6 16.9L20 17.4L20.4 17.6L20.8 17.4L21.2 16.9L21.6 16.1L22 15';

const mark = (h, w) =>
  `<svg viewBox="0.7 5.1 22.6 13.8" height="${h}" width="${w}" aria-hidden="true">` +
  `<g fill="none" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">` +
  `<path stroke="#a8a29c" d="${MARK_A}"/><path stroke="#d93b2b" d="${MARK_B}"/></g></svg>`;

const word = (cls) =>
  `<span class="word ${cls}">Langsa<i class="m1">m</i><i class="m2">m</i><i class="m3">m</i></span>`;

function page(title, w, h, inner, extraCss) {
  return `<title>${title}</title>
<style>
  body { margin:0; background:#0a0a0c; display:flex; flex-direction:column;
         align-items:center; gap:14px; padding:26px;
         font:13px/1.5 ui-sans-serif, system-ui, "Segoe UI", sans-serif; color:#8e8983; }
  .hint { max-width:${Math.max(w, 460)}px; }
  .hint b { color:#efedea; font-weight:600; }
  .art { width:${w}px; height:${h}px; flex:none; overflow:hidden; position:relative;
         background:#15141a; color:#efedea;
         font-family:ui-sans-serif, system-ui, "Segoe UI", Roboto, sans-serif;
         display:flex; flex-direction:column; justify-content:center; }
  .word { font-weight:680; letter-spacing:-.02em; display:inline-flex; align-items:baseline;
          color:#efedea; }
  .word i { font-style:normal; }
  .word .m1 { letter-spacing:.05em; }
  .word .m2 { letter-spacing:.15em; }
  .word .m3 { letter-spacing:.30em; }
  .rule { position:absolute; left:0; right:0; height:1px; background:#302e38; }
${extraCss}
</style>
<p class="hint">
  <b>${w} &times; ${h}</b>. In devtools, right-click the <b>.art</b> element in the
  Elements panel and choose <b>Capture node screenshot</b>. Set device pixel
  ratio to 1 first, or the capture comes out at double size.
</p>
${inner}
`;
}

const tile = page(
  'Langsammm store tile',
  440,
  280,
  `<div class="art tile">
  <div class="pad">
    ${mark(44, 72)}
    ${word('big')}
    <div class="claim">Slower and lower.<br>The voices stay put.</div>
  </div>
</div>`,
  `  .tile .pad { padding:0 34px; display:flex; flex-direction:column; gap:14px; align-items:flex-start; }
  .tile .word.big { font-size:38px; letter-spacing:-.03em; }
  .tile .claim { font-size:15px; line-height:1.4; color:#8e8983; }
  .tile svg { display:block; }`
);

const marquee = page(
  'Langsammm marquee',
  1400,
  560,
  `<div class="art mq">
  <div class="left">
    ${mark(96, 157)}
    ${word('huge')}
    <div class="claim">Plays music three semitones slower and lower,<br>then puts the voices back.</div>
  </div>
  <div class="right">
    <div class="stat"><b>84.09%</b><span>playback rate</span></div>
    <div class="stat"><b>3.3%</b><span>of one CPU core</span></div>
    <div class="stat"><b>0</b><span>network requests</span></div>
  </div>
</div>`,
  `  .mq { flex-direction:row; align-items:center; gap:0; padding:0 90px; }
  .mq .left { flex:1; display:flex; flex-direction:column; gap:22px; align-items:flex-start; }
  .mq .word.huge { font-size:78px; letter-spacing:-.035em; }
  .mq .claim { font-size:23px; line-height:1.45; color:#8e8983; }
  .mq .right { display:flex; flex-direction:column; gap:26px; padding-left:70px;
               border-left:1px solid #302e38; }
  .mq .stat b { display:block; font:600 34px/1 ui-monospace,"Cascadia Code",Consolas,monospace;
                color:#d93b2b; letter-spacing:-.02em; }
  .mq .stat span { display:block; margin-top:7px; font-size:14px; color:#8e8983;
                   letter-spacing:.02em; }
  .mq svg { display:block; }`
);

const dir = path.join(__dirname, '..', 'design', 'store');
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'tile-440x280.html'), tile);
fs.writeFileSync(path.join(dir, 'marquee-1400x560.html'), marquee);
console.log('design/store/tile-440x280.html');
console.log('design/store/marquee-1400x560.html');
console.log('\nthe 1280x800 screenshot has to be a real capture of the panel on a page');
