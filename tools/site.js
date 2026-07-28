#!/usr/bin/env node
// Builds site/index.html: a self-contained landing page with the real wasm
// inlined, so the demo on the page is the shipping DSP and not a recording.
//
//   node tools/site.js

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const wasmB64 = fs.readFileSync(path.join(ROOT, 'extension', 'slowform.wasm')).toString('base64');

// A real analysis frame, so the plot on the page is measured rather than drawn.
const F = [60,64,68,72,77,82,87,93,99,105,112,119,127,135,144,153,163,173,185,196,209,223,237,252,268,286,304,324,344,367,390,415,442,471,501,533,568,604,643,684,728,775,825,878,935,995,1059,1128,1200,1277,1360,1447,1541,1640,1745,1858,1977,2105,2240,2385,2538,2702,2876,3061,3258,3468,3691,3929,4182,4451,4738,5043,5368,5713,6081,6473,6890,7333,7806,8308,8843,9413,10019,10664,11351,12082,12860,13689,14570,15508];
const ENV = [9.4,9.2,8.9,8.5,8.1,7.6,7.2,6.6,6,5.3,4.6,3.8,2.9,2,0.9,-0.2,-1.3,-2.5,-3.8,-5,-6.3,-7.4,-8.5,-9.4,-10.1,-10.5,-10.5,-9.9,-8.9,-7.2,-4.9,-2,1.4,5.1,9,12.7,15.8,17.9,18.8,18.2,16.2,13,9.1,4.8,0.5,-3.8,-8.3,-12.7,-16.2,-17,-13.7,-6.6,1.3,6.2,7.3,7.7,9.5,9.4,4.3,-0.6,-0.3,0.1,-0.8,-0.7,-5.7,-12.3,-20.6,-28.4,-30.7,-32.8,-35.3,-39,-36.9,-33.3,-31.7,-31.5,-31.7,-31.6,-31.9,-32.2,-33,-35.1,-40.1,-36.5,-34.9,-33.8,-34.2,-35.1,-38,-41.3];
const WRP = [10,9.8,9.6,9.4,9,8.7,8.4,8,7.5,7,6.5,5.9,5.2,4.4,3.6,2.7,1.7,0.7,-0.4,-1.6,-2.8,-4,-5.3,-6.5,-7.7,-8.7,-9.6,-10.2,-10.4,-10.3,-9.7,-8.5,-6.8,-4.3,-1.3,2.2,6,9.9,13.4,16.3,18.3,18.8,17.8,15.6,12.2,8.1,3.9,-0.4,-4.8,-9.3,-13.6,-16.6,-16.6,-12.4,-4.8,2.7,6.7,7.3,8,9.8,8.6,2.9,-0.9,0,-0.2,-0.7,-1.3,-7.4,-13.7,-22.9,-29,-31.5,-32.8,-36.4,-39.4,-35.1,-33.6,-31.8,-31,-31.1,-31.3,-31.6,-32.1,-32.8,-35.6,-40,-36.3,-34.2,-34.1,-33.9];

const MARK_A = 'M2 12L2.4 8.9L2.8 6.9L3.2 6.5L3.6 7.7L4 10.1L4.4 12.9L4.8 15.4L5.2 17.1L5.6 17.6L6 16.9L6.4 15.1L6.8 12.8L7.2 10.4L7.6 8.3L8 6.9L8.4 6.4L8.8 6.8L9.2 7.9L9.6 9.7L10 11.7L10.4 13.8L10.8 15.5L11.2 16.8';
const MARK_B = 'M11.2 16.8L11.6 17.5L12 17.5L12.4 16.9L12.8 15.7L13.2 14.2L13.6 12.5L14 10.7L14.4 9.1L14.8 7.8L15.2 6.9L15.6 6.4L16 6.5L16.4 7L16.8 7.9L17.2 9.2L17.6 10.6L18 12.1L18.4 13.6L18.8 15L19.2 16.1L19.6 16.9L20 17.4L20.4 17.6L20.8 17.4L21.2 16.9L21.6 16.1L22 15';

const mark = (h) => `<svg class="mark" viewBox="0.7 5.1 22.6 13.8" height="${h}" width="${Math.round((h * 22.6) / 13.8)}" aria-hidden="true"><g fill="none" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path stroke="var(--ash)" d="${MARK_A}"/><path stroke="var(--verm)" d="${MARK_B}"/></g></svg>`;

const HTML = `<title>Langsammm</title>
<style>
  :root {
    --ground:#15141a; --raised:#1d1c23; --rule:#302e38;
    --ink:#efedea; --dim:#8e8983;
    --ash:#a8a29c; --verm:#d93b2b;
    --measure:64ch;
  }
  @media (prefers-color-scheme: light) {
    :root { --ground:#f4f2ef; --raised:#ffffff; --rule:#dedad4;
            --ink:#191715; --dim:#6b655e; --ash:#6e6862; --verm:#bf3222; }
  }
  :root[data-theme="light"] { --ground:#f4f2ef; --raised:#ffffff; --rule:#dedad4;
            --ink:#191715; --dim:#6b655e; --ash:#6e6862; --verm:#bf3222; }
  :root[data-theme="dark"] { --ground:#15141a; --raised:#1d1c23; --rule:#302e38;
            --ink:#efedea; --dim:#8e8983; --ash:#a8a29c; --verm:#d93b2b; }

  * { box-sizing:border-box; }
  html { -webkit-text-size-adjust:100%; }
  body {
    margin:0; background:var(--ground); color:var(--ink);
    font:16px/1.65 ui-sans-serif, system-ui, "Segoe UI", Roboto, sans-serif;
    -webkit-font-smoothing:antialiased;
  }
  .wrap { max-width:920px; margin:0 auto; padding:0 24px; }
  section { padding:0 0 76px; }
  a { color:var(--verm); text-underline-offset:3px; }
  code, .num {
    font-family:ui-monospace,"Cascadia Code","SF Mono",Consolas,monospace;
    font-variant-numeric:tabular-nums;
  }

  /* ---- wordmark: tracking widens across the trailing Ms, so the name
         stretches the way the tool stretches music */
  .word { font-weight:680; letter-spacing:-.02em; display:inline-flex; align-items:baseline; }
  .word i { font-style:normal; }
  .word .m1 { letter-spacing:.04em; }
  .word .m2 { letter-spacing:.13em; }
  .word .m3 { letter-spacing:.26em; }

  header.top { padding:26px 0 0; }
  header.top .wrap { display:flex; align-items:center; gap:11px; }
  header.top .word { font-size:17px; }
  header.top .sp { flex:1; }
  header.top a { color:var(--dim); text-decoration:none; font-size:13.5px; }
  header.top a:hover { color:var(--ink); }

  .hero { padding:64px 0 0; }
  h1 { margin:0; font-size:clamp(38px,7.5vw,74px); line-height:1.02;
       letter-spacing:-.035em; font-weight:700; text-wrap:balance; }
  h1 .word { font-size:inherit; }
  .claim { margin:22px 0 0; font-size:clamp(17px,2.3vw,21px); line-height:1.45;
           color:var(--dim); max-width:30ch; text-wrap:balance; }
  .claim b { color:var(--ink); font-weight:600; }

  /* ---- demo */
  .demo { margin:44px 0 0; border:1px solid var(--rule); border-radius:14px;
          background:var(--raised); padding:22px; }
  .demo .lbl { font:600 10px/1 ui-sans-serif,system-ui,sans-serif; letter-spacing:.14em;
               text-transform:uppercase; color:var(--dim); }
  .states { display:grid; grid-template-columns:repeat(3,1fr); gap:8px; margin:14px 0 0; }
  @media (max-width:620px){ .states { grid-template-columns:1fr; } }
  .states button {
    font:inherit; text-align:left; cursor:pointer; color:var(--ink);
    background:transparent; border:1px solid var(--rule); border-radius:10px;
    padding:13px 14px; display:flex; flex-direction:column; gap:5px;
    transition:border-color .12s, background .12s;
  }
  .states button:hover { border-color:var(--dim); }
  .states button[aria-pressed="true"] { border-color:var(--verm);
    background:color-mix(in srgb, var(--verm) 12%, transparent); }
  .states .t { font-weight:620; font-size:14.5px; }
  .states .d { font-size:12px; color:var(--dim); font-family:ui-monospace,Consolas,monospace; }
  .states button[aria-pressed="true"] .t { color:var(--verm); }
  .transport { display:flex; align-items:center; gap:14px; margin:16px 0 0; flex-wrap:wrap; }
  .play {
    font:620 14px/1 ui-sans-serif,system-ui,sans-serif; cursor:pointer;
    background:var(--verm); color:#fff; border:0; border-radius:9px; padding:12px 20px;
  }
  .play:hover { filter:brightness(1.07); }
  .hint { font-size:12.5px; color:var(--dim); }

  /* ---- plot */
  .plot { margin:16px 0 0; border-top:1px solid var(--rule); padding-top:16px; }
  canvas { display:block; width:100%; height:150px; }
  .key { display:flex; gap:18px; margin:10px 0 0;
         font:600 10px/1 ui-sans-serif,system-ui,sans-serif; letter-spacing:.1em;
         text-transform:uppercase; color:var(--dim); }
  .key i { display:inline-block; width:14px; height:2px; margin-right:6px; vertical-align:middle; }

  h2 { font-size:clamp(22px,3vw,28px); letter-spacing:-.022em; font-weight:660;
       margin:0 0 16px; text-wrap:balance; }
  p { max-width:var(--measure); margin:0 0 16px; }
  .dim { color:var(--dim); }

  .pair { display:grid; grid-template-columns:1fr 1fr; gap:26px; }
  @media (max-width:720px){ .pair { grid-template-columns:1fr; } }
  .pair h3 { font-size:15px; font-weight:640; margin:0 0 8px; letter-spacing:-.01em; }
  .pair p { font-size:14.5px; margin:0; color:var(--dim); }
  .pair .tag { font:600 10px/1 ui-sans-serif,system-ui,sans-serif; letter-spacing:.13em;
               text-transform:uppercase; display:block; margin:0 0 9px; }
  .tag.a { color:var(--ash); }
  .tag.b { color:var(--verm); }

  .facts { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr));
           gap:1px; background:var(--rule); border:1px solid var(--rule);
           border-radius:12px; overflow:hidden; }
  .facts div { background:var(--ground); padding:16px 17px; }
  .facts .n { font:22px/1.1 ui-monospace,Consolas,monospace; font-variant-numeric:tabular-nums;
              letter-spacing:-.02em; }
  .facts .k { font-size:12.5px; color:var(--dim); margin-top:6px; }

  .note { border-left:2px solid var(--verm); padding:2px 0 2px 15px;
          max-width:var(--measure); color:var(--dim); font-size:14.5px; }

  footer { border-top:1px solid var(--rule); padding:26px 0 60px; color:var(--dim);
           font-size:13px; }
  footer .wrap { display:flex; gap:16px; flex-wrap:wrap; align-items:center; }
  footer .sp { flex:1; }

  :focus-visible { outline:2px solid var(--verm); outline-offset:2px; border-radius:4px; }
  @media (prefers-reduced-motion: reduce){ * { transition:none !important; } }
</style>

<header class="top">
  <div class="wrap">
    ${mark(17)}
    <span class="word">Langsa<i class="m1">m</i><i class="m2">m</i><i class="m3">m</i></span>
    <span class="sp"></span>
    <a href="https://github.com/liamiepops/Langsammm">Source</a>
  </div>
</header>

<section class="hero">
  <div class="wrap">
    <h1>Everything heavier.<br>Nobody sounds drunk.</h1>
    <p class="claim">
      Plays music three semitones down. <b>Slower and lower, with the voices
      left alone.</b>
    </p>

    <div class="demo">
      <div class="lbl">Hear it</div>
      <div class="states" id="states">
        <button data-mode="orig" aria-pressed="false">
          <span class="t">Original</span><span class="d">100%</span>
        </button>
        <button data-mode="slow" aria-pressed="false">
          <span class="t">Slowed only</span><span class="d">84.09%</span>
        </button>
        <button data-mode="warp" aria-pressed="true">
          <span class="t">Langsammm</span><span class="d">84.09% &middot; formants held</span>
        </button>
      </div>
      <div class="transport">
        <button class="play" id="play">Play</button>
        <span class="hint" id="hint">Switch while it plays. Nothing is pre-rendered, this is the extension's own code running here.</span>
      </div>

      <div class="plot">
        <canvas id="plot" width="1600" height="300"></canvas>
        <div class="key">
          <span style="color:var(--ash)"><i style="background:var(--ash)"></i>where the slowdown left it</span>
          <span style="color:var(--verm)"><i style="background:var(--verm)"></i>where Langsammm puts it back</span>
        </div>
      </div>
    </div>
  </div>
</section>

<section>
  <div class="wrap">
    <h2>Slowing music breaks voices</h2>
    <div class="pair">
      <div>
        <span class="tag a">What slowing does</span>
        <h3>Pitch falls, and the singer's body falls with it</h3>
        <p>Play a record slowly and the pitch drops, which is the point. But the
        resonances of the throat and mouth drop by the same amount, and those
        are set by anatomy, not by the note. The result is a singer who sounds
        physically larger and slightly drunk.</p>
      </div>
      <div>
        <span class="tag b">What Langsammm does</span>
        <h3>It puts the body back</h3>
        <p>The pitch stays down where you wanted it. The resonances are lifted
        back to where they started, so the voice keeps its own size and
        character. You get the weight without the smear.</p>
      </div>
    </div>
  </div>
</section>

<section>
  <div class="wrap">
    <h2>Cheap, because of what it refuses to do</h2>
    <p class="dim">Most pitch shifters hold the tempo fixed, which forces them to
    stretch time internally, and time stretching is where the cost and the
    smearing come from. Langsammm lets the tempo fall. Nothing is ever
    stretched, so the whole effect reduces to one gain curve applied per frame
    with the phases untouched.</p>
    <div class="facts">
      <div><div class="n">3.3%</div><div class="k">of one CPU core</div></div>
      <div><div class="n">40 KB</div><div class="k">of WebAssembly</div></div>
      <div><div class="n">43 ms</div><div class="k">of added delay</div></div>
      <div><div class="n">0</div><div class="k">network requests</div></div>
    </div>
  </div>
</section>

<section>
  <div class="wrap">
    <h2>Getting it</h2>
    <p class="note">Not in the Chrome or Firefox stores yet. The source is
    public and builds in one command, so you can load it unpacked today.
    Store listings will land here when they exist.</p>
    <p class="dim" style="margin-top:18px">Works on YouTube, YouTube Music,
    SoundCloud and Bandcamp. It cannot work on Spotify or Apple Music, whose
    players hand the browser encrypted audio that no extension is permitted to
    touch.</p>
  </div>
</section>

<footer>
  <div class="wrap">
    ${mark(15)}
    <span>Langsammm</span>
    <span class="sp"></span>
    <span><em>langsam</em>, slowly. The extra letters are a hum.</span>
  </div>
</footer>

<script>
const WASM_B64="${wasmB64}";
const F=${JSON.stringify(F)},ENV=${JSON.stringify(ENV)},WRP=${JSON.stringify(WRP)};

/* ---------- plot: real envelope before and after the warp ---------- */
(function(){
  const cv=document.getElementById('plot');
  if(!cv||!cv.getContext) return;
  function draw(){
    const g=cv.getContext('2d');
    const r=Math.min(2,window.devicePixelRatio||1);
    const W=cv.clientWidth,H=150;
    cv.width=Math.round(W*r); cv.height=Math.round(H*r);
    g.setTransform(r,0,0,r,0,0);
    const cs=getComputedStyle(document.documentElement);
    const ash=cs.getPropertyValue('--ash').trim(),verm=cs.getPropertyValue('--verm').trim(),
          rule=cs.getPropertyValue('--rule').trim(),dim=cs.getPropertyValue('--dim').trim();
    const PAD=8,lo=Math.log(F[0]),hi=Math.log(F[F.length-1]);
    const X=f=>PAD+((Math.log(f)-lo)/(hi-lo))*(W-PAD*2);
    const DB_HI=22,DB_LO=-44;
    const Y=d=>PAD+(1-(Math.min(DB_HI,Math.max(DB_LO,d))-DB_LO)/(DB_HI-DB_LO))*(H-PAD*2-14);
    g.clearRect(0,0,W,H);
    g.strokeStyle=rule; g.lineWidth=1;
    [100,1000,10000].forEach(f=>{const x=Math.round(X(f))+.5;
      g.beginPath();g.moveTo(x,PAD);g.lineTo(x,H-PAD-14);g.stroke();});
    g.fillStyle=dim; g.font='600 10px ui-sans-serif, system-ui, sans-serif';
    g.fillText('100 Hz',X(100)+5,H-6); g.fillText('1 kHz',X(1000)+5,H-6); g.fillText('10 kHz',X(10000)+5,H-6);
    const path=a=>{g.beginPath();a.forEach((d,i)=>{const x=X(F[i]),y=Y(d);i?g.lineTo(x,y):g.moveTo(x,y);});};
    g.beginPath();
    WRP.forEach((d,i)=>{const x=X(F[i]),y=Y(d);i?g.lineTo(x,y):g.moveTo(x,y);});
    for(let i=ENV.length-1;i>=0;i--) g.lineTo(X(F[i]),Y(ENV[i]));
    g.closePath(); g.fillStyle=verm+'2e'; g.fill();
    g.lineJoin='round'; g.lineCap='round';
    path(ENV); g.strokeStyle=ash; g.lineWidth=1.6; g.stroke();
    path(WRP); g.strokeStyle=verm; g.lineWidth=2.2; g.stroke();
  }
  draw();
  addEventListener('resize',draw);
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change',draw);
  new MutationObserver(draw).observe(document.documentElement,{attributes:true,attributeFilter:['data-theme']});
})();

/* ---------- demo ---------- */
const WORKLET=\`
class W extends AudioWorkletProcessor{
  constructor(o){super();
    const b=o.processorOptions.bytes;
    this.ex=new WebAssembly.Instance(new WebAssembly.Module(b),{}).exports;
    this.p=this.ex.sf_new(sampleRate,2048);
    this.lp=this.ex.sf_alloc(1024); this.rp=this.ex.sf_alloc(1024);
    this.pp=this.ex.sf_alloc(9);
    this.set(1);
    this.lv=new Float32Array(this.ex.memory.buffer,this.lp,1024);
    this.rv=new Float32Array(this.ex.memory.buffer,this.rp,1024);
    this.port.onmessage=e=>{this.set(e.data.amount);this.ex.sf_snap(this.p);};
  }
  set(a){
    const pv=new Float32Array(this.ex.memory.buffer,this.pp,9);
    pv[0]=a;pv[1]=a;pv[2]=150;pv[3]=0;pv[4]=0;pv[5]=600;pv[6]=Math.pow(2,.25);pv[7]=1;pv[8]=0.99;
    this.ex.sf_set_params(this.p,this.pp,9);
  }
  process(i,o){
    const inp=i[0],out=o[0];
    if(!inp||!inp.length){for(const c of out)c.fill(0);return true;}
    const n=out[0].length;
    this.lv.set(inp[0].subarray(0,n));
    this.rv.set((inp.length>1?inp[1]:inp[0]).subarray(0,n));
    this.ex.sf_process(this.p,this.lp,this.rp,n);
    out[0].set(this.lv.subarray(0,n));
    if(out.length>1)out[1].set(this.rv.subarray(0,n));
    return true;
  }
}
registerProcessor('w',W);\`;

function wasmBytes(){
  const s=atob(WASM_B64),a=new Uint8Array(s.length);
  for(let i=0;i<s.length;i++)a[i]=s.charCodeAt(i);
  return a;
}

// A sung vowel that moves between /a/, /i/ and /u/. Synthesised rather than
// recorded, so the page stays self-contained, and formants are exactly the
// thing being demonstrated.
const VOWELS=[[730,1090,2440],[270,2290,3010],[300,870,2240],[730,1090,2440]];
function phrase(ctx){
  const sr=ctx.sampleRate,dur=3.6,n=Math.floor(sr*dur);
  const buf=ctx.createBuffer(2,n,sr),L=buf.getChannelData(0),R=buf.getChannelData(1);
  let ph=0;
  for(let i=0;i<n;i++){
    const t=i/sr,u=t/dur;
    const f0=142*Math.pow(2,-0.18*u)+2.5*Math.sin(2*Math.PI*4.6*t);
    const seg=Math.min(VOWELS.length-2,Math.floor(u*(VOWELS.length-1)));
    const fr=u*(VOWELS.length-1)-seg;
    const Fm=[0,1,2].map(k=>VOWELS[seg][k]+(VOWELS[seg+1][k]-VOWELS[seg][k])*fr);
    let v=0;
    for(let h=1;h*f0<sr/2-500;h++){
      const f=f0*h;
      let a=0.012;
      a+=Math.exp(-Math.pow((f-Fm[0])/95,2));
      a+=0.62*Math.exp(-Math.pow((f-Fm[1])/130,2));
      a+=0.28*Math.exp(-Math.pow((f-Fm[2])/190,2));
      a*=Math.pow(f0/f,0.42);
      v+=a*Math.sin(2*Math.PI*f*t+h*2.399);
    }
    const env=Math.min(1,u*14)*Math.min(1,(1-u)*10);
    ph=v*0.052*env;
    L[i]=ph; R[i]=ph*0.94;
  }
  return buf;
}

let ctx=null,src=null,node=null,playing=false,mode='warp';
const RATE=Math.pow(2,-3/12);
const play=document.getElementById('play'),hint=document.getElementById('hint');

function apply(){
  if(!src)return;
  src.playbackRate.value = mode==='orig' ? 1 : RATE;
  if(node) node.port.postMessage({amount: mode==='warp' ? 1 : 0});
}

document.getElementById('states').addEventListener('click',e=>{
  const b=e.target.closest('button'); if(!b)return;
  mode=b.dataset.mode;
  for(const x of e.currentTarget.querySelectorAll('button'))
    x.setAttribute('aria-pressed',String(x===b));
  apply();
});

play.addEventListener('click',async()=>{
  if(playing){ stop(); return; }
  play.disabled=true; hint.textContent='Starting…';
  try{
    ctx=new (window.AudioContext||window.webkitAudioContext)();
    await ctx.resume();
    const url=URL.createObjectURL(new Blob([WORKLET],{type:'text/javascript'}));
    await ctx.audioWorklet.addModule(url); URL.revokeObjectURL(url);
    node=new AudioWorkletNode(ctx,'w',{numberOfInputs:1,numberOfOutputs:1,
      outputChannelCount:[2],processorOptions:{bytes:wasmBytes()}});
    src=ctx.createBufferSource(); src.buffer=phrase(ctx); src.loop=true;
    src.connect(node).connect(ctx.destination);
    apply(); src.start();
    playing=true; play.textContent='Stop';
    hint.textContent='Switch while it plays. Nothing is pre-rendered, this is the extension\\'s own code running here.';
  }catch(err){
    hint.textContent='Could not start audio: '+((err&&err.message)||err);
  }
  play.disabled=false;
});

function stop(){
  try{ src&&src.stop(); ctx&&ctx.close(); }catch(e){}
  src=null;node=null;ctx=null;playing=false;
  play.textContent='Play';
}
</script>
`;

const dir = path.join(ROOT, 'site');
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'index.html'), HTML);
console.log('site/index.html  ' + Math.round(HTML.length / 1024) + ' KB');
