# Langsammm

A browser extension that plays music three semitones slower and lower, then
puts the voices back.

Slowing audio down drops the pitch, which is the point. It also drags the
resonances of the singer's throat and mouth down by the same amount, and those
resonances come from anatomy instead of from the note being sung. That is why
slowed music sounds bloated and slurred. Langsammm lifts the spectral envelope
back where it started while leaving the pitch down.

Three semitones is a playback rate of 2^(-3/12), or 84.09%. The interval is
selectable from one to seven in the panel, and the warp ratio is derived from
the same constant, so the two cannot drift apart.

*Langsam* is the German tempo marking for slowly, the one Mahler wrote instead
of the Italian. The trailing **mmm** stretches the word the way the tool
stretches the music, and it is also a hum. Llamas hum to settle their young,
which is the nod to Winamp. Three Ms, always; two reads as a typo.

## How it works

The browser does the resample. Setting `playbackRate` with `preservesPitch` off
drops tempo, pitch and spectral envelope together by one factor. An
AudioWorklet then lifts the envelope back.

Duration and pitch are never altered independently, so nothing in the chain
stretches time. There is no phase vocoder, no phase locking, and none of the
transient smearing that time-scale modification brings with it. What remains is
a per-bin real gain applied to the original spectrum, with the phases
untouched:

```
G[k] = ( E'[k] / E[k] ) ^ e[k]
```

`E` is the cepstrally smoothed log envelope. `E'[k] = E[k / rho]` is that same
envelope moved up by `rho = 2^(3/12)`. The exponent `e[k]` lies in [0, 1] and
carries the amount, the crossover taper and the transient relaxation.

Set `e` to zero and the gain becomes exactly 1. The analysis and synthesis
windows form a perfect-reconstruction Hann WOLA pair, so at that setting the
output is the input delayed by one window and nothing else. An A/B comparison
therefore changes the effect and leaves everything else alone.

## Controls

| Control | Effect |
|---|---|
| **amount** | Exponent on the whole gain curve. 100% applies the full three-semitone lift. Zero is an exact bypass. |
| **envelope width** | Cepstral lifter cutoff in Hz, being the narrowest spectral feature the envelope keeps. Default 600, range 50 to 1500. |
| **crossover** | Frequency below which the warp is switched off, tapering in from half of it with a raised cosine. Default 150 Hz. Keeps bass from being translated upward. |
| **transient relax** | Half-wave rectified spectral flux, normalised by frame energy and compared against its own running mean, relaxes the exponent on transient frames. |
| **stereo M/S** | Runs the two engines on mid and side instead of left and right, with a separate amount for side. Centre-panned vocals sit in mid, so this is a cheap stand-in for source separation. |

Four of those are factors of a single exponent. `src/stft.rs` computes
`expo = amount × taper[k] × relax`, and they differ only in what they vary
over: amount is constant, the crossover taper varies with frequency, and the
transient relaxation varies with time. Transient relax is therefore an
automatic, signal-gated version of amount with the polarity reversed. At 100% a
fully transient frame sits momentarily at amount 0, and material without
transients is left alone at any setting.

Sliders whose default falls inside their range carry a tick at that value and a
detent three steps wide either side.

### Why envelope width is measured in Hz

Both structures this parameter has to separate are spaced linearly in
frequency. Harmonics sit f0 apart, and formants come from a resonating tube of
length L, so they sit roughly c/2L apart. A constant musical interval would
span 59 Hz at 1 kHz and 476 Hz at 8 kHz, which falls below f0 across the whole
vocal range and combs precisely where voices are.

## Tuning

Measured on `demo-material.wav`, f0 140 Hz and 117.6 Hz once slowed, with the
loudness matcher and the ceiling switched off so neither masks the result.

| envelope width | envelope shift | gain depth | frame-to-frame wobble |
|---|---|---|---|
| 1500 Hz | 0.23 st | 3.92 dB | 1.98 dB |
| 1000 Hz | | 5.54 dB | 2.50 dB |
| **500 Hz** | **3.32 st** | **6.19 dB** | **2.96 dB** |
| 300 Hz | 3.13 st | 6.12 dB | 3.24 dB |
| 200 Hz | 3.09 st | 6.09 dB | 3.49 dB |
| 150 Hz | 3.05 st | 6.10 dB | 3.56 dB |
| 100 Hz | 2.61 st | 6.00 dB | 4.39 dB |

Depth saturates near 6.1 dB by 500 Hz and climbs no further, while wobble keeps
rising. For a faithful formant shift the useful range runs from about 400 to
800 Hz.

Below that the parameter stops being about fidelity and becomes an effect. The
lifter keeps `q = sr / width` cepstral coefficients, and the pitch period sits
at quefrency `sr / f0`, so the envelope starts absorbing harmonic structure
once **width falls below a source's fundamental**. Past that point the warp is
shifting a harmonic comb off its own harmonics, heard as shimmer.

| width | q | gain rms | range | slope reversals |
|---|---|---|---|---|
| 100 Hz | 480 | 19.65 dB | −45.8 to +48.4 | 54 |
| 150 Hz | 320 | 8.76 dB | −15.1 to +21.5 | 19 |
| 500 Hz | 96 | 8.66 dB | −19.3 to +21.7 | 14 |
| 1000 Hz | 48 | 7.11 dB | −13.2 to +22.1 | 9 |
| 1500 Hz | 32 | 5.12 dB | −5.0 to +14.9 | 4 |
| 4000 Hz | 12 | 4.36 dB | −5.3 to +12.1 | 3 |

The jump between 150 and 100 is that threshold being crossed. It is per source,
so on a mix a setting of 150 will comb a vocal and leave a bass line alone.

Widening never reaches bypass. At 1500 Hz the lifter keeps 32 coefficients, too
few to resolve anything narrower than a formant group, so the warp becomes a
broadband tilt: 5 dB rms of gain remains while the formants themselves move
0.23 st. Amount 0 is the only exact bypass.

The crossover barely registers at the default width, because the warp already
does little down there. Its effect on the 60 to 120 Hz band sits 13.9 dB below
the signal at width 500 and 39.6 dB below at 1500, against 1.9 dB below at
width 150. It earns its place on material with a steep low cut, where the warp
follows that slope.

The panel reports depth and wobble live, computed inside the DSP over the same
200 Hz to 6 kHz band. It reads about 0.9 dB higher on depth and 0.8 dB lower on
wobble than the table above, because the panel measures the gain curve the warp
intends while `gainwobble.js` measures the ratio of two STFT magnitudes after
reconstruction and picks up window leakage. The trends agree, so compare
readings against each other and not across the two tools. Both settle in about
a second.

## The panel

A panel appears in the lower right of any page the extension runs on. It plots
the spectral envelope before and after the gain being applied, at 15 Hz.
**Ash** is where the slowdown left the envelope, **vermilion** is where the
warp has put it back, and the area between them is the gain. Snapshots stop
when the panel is closed.

Four figures sit underneath. **Depth** and **wobble** are described above.
**Ceiling** shows any reduction the limiter is making. **Delay** shows the
current window's latency. Every control has a **?** that opens an explanation.

Hotkeys are **alt+S** to show or hide and **alt+X** to switch the effect off.
Development builds add **alt+A**, held down, to hear the slowed signal without
the warp.

Closing the panel collapses it to a small pill in the same corner instead of
hiding it, so it can always be recovered by clicking. The popup carries a show
control as well, which works even when the page never sees the keystroke. If
the page detaches the panel during navigation, the next status tick puts it
back.

`alt+A` skips the parameter smoother. Measured on a steady tone it reaches the
dry signal to within 60 dB in 34.8 ms, against 857.9 ms smoothed. That is
inside one window and is the floor for this architecture, since overlap-add
sums four windows into every output sample.

That hotkey is for testing and does not ship. `build.ps1 -Release` rewrites the
`DEV` flag in `page.js` to false, which removes the compare bar and the
shortcut. The build fails loudly if it cannot find the flag to rewrite.

## Sets

Settings can follow the music instead of staying global. Three layers, checked
in order.

**Defaults.** What plays when nothing else applies.

**Per-track memory.** Press **remember** in the panel and this track keeps its
own settings. It gets them back next time, wherever it is reached from. The key
comes from the URL, so a video reached through a playlist, a radio mix or a
timestamped link resolves to the same entry.

**Sets.** An ordered list of tracks, each carrying its own parameters, editable
at the extension's Sets page and exportable as JSON. Make a set active, play a
track, dial it in, and press **add** to capture it as it sounds. The panel shows
which set is running, the position in it, what comes next, and previous and next
buttons. With auto-advance on, the tab moves to the next track when one ends.

The panel always says where the sliders are being saved, so an edit never lands
somewhere unexpected. A track inside the running set writes to the set item, a
remembered track writes to its own entry, anything else writes to defaults.

New settings are pushed with the smoother skipped, so a track starts under its
own parameters instead of gliding into them across the first fifth of a second.
The push happens on `loadstart`, which fires before any media data arrives.

Adverts are detected and the effect stands down for their duration, so an
advert plays at normal speed and does not leave the loudness matcher in a state
the next track inherits.

Two limitations. A Bandcamp album plays from one URL, so every track on it
shares a single entry. And auto-advance navigates the tab, which inherits
whatever YouTube does about unavailable videos and blocked autoplay, so it is
best effort.

## The mark

One wave whose wavelength grows as it travels, ash handing over to vermilion.
It reads as a sound wave, as a rocking motion, and as a tempo falling away.

Wavelength grows linearly across the span, which puts a logarithm in the phase
and keeps the rate finite everywhere. A power law such as the square root of
position has an unbounded derivative at the start, and the left edge collapses
into a solid block.

The palette is ash `#A8A29C` for the original signal and vermilion `#D93B2B`
for the warped one, on warm charcoal. Both must survive a white toolbar and a
near-black one. Solving for equal contrast on the two grounds puts the ideal
luminance at 0.208, worth 4.06:1 either way, but surviving greyscale needs the
pair pushed apart in luminance, which costs contrast on one ground. This pair
sits at the knee: 2.53:1 worst case with a luminance gap of 0.185. An earlier
teal and orange scheme measured 2.05 and 0.018, so it was indistinguishable
without colour.

```bash
node tools/icons.js               # cut the chosen mark into extension/icons
node tools/icons.js --candidates  # cut every concept for comparison
node tools/icons.js --svg         # emit the mark as inline SVG path data
node tools/icon-sheet.js          # contact sheet, all concepts, all sizes
node tools/icon-compare.js        # comparison page, data URIs inlined
```

Geometry for every concept lives in one table at the top of `tools/icons.js`,
and each mark is centred from its own bounding box, so editing a shape cannot
quietly unbalance the composition. PNGs are encoded with zlib directly, so
there is no image library to install.

The same wave appears as inline SVG in the panel header and the popup, emitted
by `--svg` from that table. Regenerate it instead of editing the path by hand.
The panel builds the element with `createElementNS`, because YouTube enforces
Trusted Types and rejects an `innerHTML` assignment.

## Build

```bash
pwsh build.ps1              # development
pwsh build.ps1 -Release     # also writes dist/chrome-release and dist/firefox-release
pwsh build.ps1 -Package     # a clean build, then the two zips AMO wants
```

Every run compiles the Rust tests, builds for `wasm32-unknown-unknown`, copies
the module into `extension/`, checks the two manifests against each other, runs
the worklet harness, and assembles `dist/firefox`.

The module comes out around 40 KB with no imports and no wasm-bindgen. That
last part matters: `AudioWorkletGlobalScope` in Chrome has no `TextDecoder`, so
the usual bindgen glue is a liability there.

`-Package` cleans first. An incremental build and a clean build of identical
source produce different bytes, while two clean builds agree exactly, so
anything meant to be reproduced from a fresh checkout has to come from a clean
tree. The toolchain is pinned in `rust-toolchain.toml` for the same reason.

## Installing

The wasm module is a build artifact and is not tracked, so run `build.ps1`
before loading a fresh clone.

**Chrome:** open `chrome://extensions`, turn on Developer mode, choose Load
unpacked and pick the `extension` folder.

**Firefox 128 or later:** open `about:debugging#/runtime/this-firefox`, choose
Load Temporary Add-on and pick `dist/firefox/manifest.json`.

### Why there are two manifests

Getting code into the page's own realm is the one place the browsers genuinely
disagree.

Chrome governs a script tag injected by a content script using the
**extension's** CSP, so `bridge.js` can inject `page.js` and it runs even on
YouTube. Firefox governs that same injection using the **page's** CSP and
blocks it, which is [bugzilla 1267027](https://bugzilla.mozilla.org/show_bug.cgi?id=1267027),
still open.

Firefox does exempt a declarative `world: "MAIN"` content script from page CSP,
from version 128. Mozilla describes that exemption as being unlike Chrome's
behaviour, which implies Chrome's MAIN world is subject to page CSP, so
unifying on either route would be a guess. Each build declares the one known to
work for it.

`bridge.js` picks its mode by reading its own manifest for a MAIN-world
declaration of `page.js`, so nothing sniffs the browser. `page.js` takes its
base URL from the script tag when injected and from the bridge when declared,
since only `audioWorklet.addModule` needs it and that path is already async.

`tools/check-manifests.js` holds the two files to agreeing on everything except
those two differences, and runs as part of every build.

## Listening offline

Quicker than reloading a browser tab, and it lets two files be compared in an
editor instead of from memory.

```bash
node tools/testsig.js material test-material.wav
node tools/render.js test-material.wav out-dry.wav --amount 0
node tools/render.js test-material.wav out-wet.wav --amount 1
node tools/render.js test-material.wav out-ms.wav --stereo ms --side 0.3 --transient 0.7
```

Renders come out the same length and sample aligned, so they can be nulled
against each other. Options are `--semitones --amount --stereo lr|ms --side
--crossover --transient --envres --fft --noloud --float --ceiling`.

To hear the effect with nothing holding the peaks down:

```bash
node tools/render.js in.wav out.wav --amount 1 --ceiling 0 --float
```

`node tools/analyse.js a.wav b.wav` reports the envelope shift between two
files in semitones and confirms the harmonic spacing has not moved. Read its
calibration note before trusting the magnitude of a large shift.

`node tools/bench.js` measures what a second of audio costs. On a 2026 desktop
the default window runs at 3.3% of one core, about 30 times realtime, in a
1.3 MB wasm heap. Window size barely matters, because doubling it doubles the
per-frame cost and halves the frame rate, so the total grows with log n.
`node tools/bench-page.js` writes the same benchmark as a self-contained page
for comparing browsers.

## What is verified

`cargo test` covers the DSP:

* `dry_path_reconstructs` confirms amount 0 is a pure delay of exactly one
  window, to within 1e-3.
* `envelope_moves_up` confirms the spectral centroid of a synthetic voiced
  signal moves by 2^(3/12) to within 6%.
* `crossover_protects_low_band` confirms an 80 Hz tone survives a 1000 Hz
  crossover with under 5% level change.
* `snapshot_tracks_the_applied_gain` confirms the panel plot follows the gain
  actually applied and collapses onto one curve at amount 0.
* `loudness_match_does_not_boost_at_startup` guards a bug found during
  bring-up. Output is silent for one window while input is already loud, so an
  EMA started from zero drove the matcher to its +6 dB ceiling and took a
  second to recover. Everything came out 5 dB hot, including the dry path.
* `output_respects_ceiling` guards a second one. Warping the envelope upward
  raised crest factor by about 1.3 dB on a signal with a strong low sine, and
  the first limiter ramped its reduction in across the block, so the peak that
  triggered it escaped before the gain arrived.
* Two FFT tests.

`node tools/worklet-harness.js` runs the real `extension/worklet.js` under a
stubbed `AudioWorkletGlobalScope` and compares it against direct wasm calls. It
reports zero deviation over 750 blocks, which covers the parameter index
layout, the views into wasm memory and the block handling.

End to end on rendered files, against an unprocessed reference with formants at
800, 2300 and 3400 Hz and f0 at 140 Hz:

* Playback ratio measured 0.8407 against a target of 0.8409.
* The warp leaves harmonic spacing at a ratio of exactly 1.0000.
* The warped render's envelope sits within 0.3 st of the unslowed original,
  while the dry render sits well below it.

## Known limits

Spotify, Apple Music and Tidal decrypt through EME.
`createMediaElementSource` returns silence for protected media by design, and
working around that is a DMCA 1201 problem, so those sites are out of scope.
YouTube and YouTube Music play through MSE from a blob URL and work.

Bandcamp serves a direct cross-origin `<audio src>`, which taints the element
and yields silence. The panel detects that case and says so.

The worklet adds one window of delay, 42.7 ms at 2048 and 48 kHz. For audio
alone that is irrelevant. On video it puts sound behind picture by about that
much, which sits inside the usual tolerance and is audible to some people on
close-ups. Halve the window for video.

While the effect is on, `playbackRate` is re-asserted on every `ratechange`, so
YouTube's own speed menu will not stick. Switch Langsammm off to use it.

Switching between L/R and M/S mid-playback sends one window of mismatched
samples through the analysis buffers and clicks once.

The full warp raises peak level even with RMS matched, by about 1.3 dB on the
synthetic material file. A ceiling at 0.99 catches it and the panel reports
whenever it is working, so the limiter cannot be mistaken for the effect. In
the browser it is fixed on because the destination clips regardless. Offline,
`--ceiling 0` removes it.

## Publishing

`REVIEWERS.md` is written for AMO reviewers and covers the build environment,
the two commands that reproduce the binary, and what the WebAssembly module can
and cannot reach. `build.ps1 -Package` produces the add-on zip and the source
zip that accompanies it, along with a `SHA256SUMS` taken from a clean build.

`browser_specific_settings.gecko.data_collection_permissions` is set to
`["none"]`, which AMO has required of new extensions since 3 November 2025.
There are no runtime network requests and `storage` holds nothing beyond the
slider positions.

## Layout

```
src/fft.rs               radix-2 complex FFT, no dependencies
src/stft.rs              envelope warp, transient detection, loudness match
src/lib.rs               C ABI exports for wasm

extension/manifest.json          Chrome
extension/manifest.firefox.json  Firefox, swapped in by build.ps1
extension/bridge.js      isolated world: couriers wasm, base URL and settings
extension/page.js        page world: media elements, audio graph, panel
extension/worklet.js     AudioWorklet host for the wasm
extension/sets.html      the set editor, an extension page
extension/sets.js        its logic, talks to chrome.storage directly
extension/icons/         generated by tools/icons.js, tracked

tools/render.js          offline renderer
tools/analyse.js         envelope shift and pitch measurement
tools/testsig.js         test signal generator
tools/gainwobble.js      how hard the warp works and how steady it is
tools/banddiff.js        octave-band difference between two renders
tools/envsnap.js         dumps one frame's envelope and gain curve as JSON
tools/bench.js           cost per second of audio
tools/bench-page.js      the same benchmark as a page, for comparing browsers
tools/icons.js           cuts the icon set, with its own PNG encoder
tools/icon-sheet.js      contact sheet for judging marks at 16 px
tools/icon-compare.js    the comparison page marks were chosen from
tools/check-manifests.js keeps the Chrome and Firefox manifests in step
tools/worklet-harness.js runs worklet.js under a stubbed worklet scope
tools/playlist-test.js   track identity and set storage shape
tools/site.js            builds the landing page, wasm inlined

design/panel-mockups.html  the three directions the panel was chosen from
```

The repository directory is still named `slowform`, which was the working name.
Nothing depends on it.
