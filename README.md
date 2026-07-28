# Langsammm

Plays audio slowed by three semitones and warps the spectral envelope back up
by the same interval, so the tempo and pitch drop while the timbre stays where
it was.

*Langsam* is the German tempo marking for slowly, roughly 40 to 60 bpm, the one
Mahler used in place of the Italian. The trailing **mmm** does three jobs: it
stretches the word the way the tool stretches the music, it is a hum, and
humming is what a llama does to soothe its cria, which is the nod to Winamp's
"it really whips the llama's ass".

Three Ms, always. Two reads as a typo.

The project directory, the crate, the wasm module and the internal message
channels are all still called `slowform`, which was the working name. None of
that is user-facing, so renaming it is a separate job worth doing only once the
name has settled.

Three semitones down is a playback rate of 2^(-3/12) = **84.09%**. Two
semitones would be 89.09%. The interval is selectable from 1 to 7 in the panel
and everything else is derived from it, so the rate and the warp ratio cannot
disagree.

## How it works

The browser does the resample. Setting `playbackRate` with `preservesPitch`
off drops tempo, pitch and spectral envelope together by the same factor. The
worklet then puts the envelope back.

Because duration and pitch are never altered independently, there is no time
stretching anywhere in the chain. No phase vocoder, no phase locking, no
transient smearing from time-scale modification. The whole effect collapses to
a per-bin real gain applied to the original spectrum with the phases left
alone:

```
G[k] = ( E'[k] / E[k] ) ^ e[k]
```

`E` is the cepstrally smoothed log envelope, `E'[k] = E[k / rho]` is that
envelope moved up by `rho = 2^(3/12)`, and `e[k]` in [0, 1] carries the wet
amount, the crossover taper and the transient relaxation. Setting `e` to zero
makes the gain exactly 1, and since the analysis and synthesis windows form a
perfect-reconstruction Hann WOLA pair, the dry path is a sample-exact delay
line. That is what makes the A/B honest: nothing changes but the effect.

## The four knobs you asked for

| Knob | What it does |
|---|---|
| **amount** | Exponent on the whole gain curve. 100% is the full three-semitone warp. |
| **crossover** | Frequency below which the warp is turned off, with a raised-cosine taper from fc/2 to fc. 0 disables it. Stops the low end being translated upward and thinned. Default 150 Hz. |
| **transient relax** | Half-wave rectified spectral flux, normalised by frame energy and compared against its own running mean, relaxes the exponent toward 0 on transient frames. |
| **stereo M/S** | Switches the two engines from L/R to mid/side, with a separate amount for side. Centre-panned vocals live in mid, so this is a cheap stand-in for source separation. |

There is a fifth worth having: **envelope width**, the cepstral lifter cutoff
expressed in Hz, being the narrowest spectral feature the envelope keeps.
Default 600 Hz, range 50 to 1500.

Both sliders with an interior default carry a tick at that value and a detent
three steps wide either side, so the default can be found by feel without
being hard to leave.

The width is deliberately a constant number of Hz rather than a musical
interval. Harmonics are spaced f0 apart and formants roughly c/2L apart, so
both structures this parameter separates are spaced linearly in frequency. A
constant-interval width would be 59 Hz at 1 kHz and 476 Hz at 8 kHz, which
would fall below f0 through the whole vocal range and comb exactly where voices
sit.

All four of the knobs above are factors of one exponent. `src/stft.rs` computes
`expo = amount × taper[k] × relax`, so they differ only in what they vary over:
amount is constant, the crossover taper varies with frequency, and the
transient relaxation varies with time. That makes **transient relax an
automatic, signal-gated version of amount**, with the polarity reversed. At
100% a fully transient frame sits momentarily at amount 0, and on material with
no transients it does nothing at any setting.

## Tuning notes

Measured on `demo-material.wav` (f0 140 Hz, 117.6 Hz once slowed) with the
loudness matcher and ceiling off, so nothing is masking the effect.
`tools/gainwobble.js` reports how hard the warp is working and how steady the
gain it applies is.

| env_res | envelope shift | gain depth | frame-to-frame wobble |
|---|---|---|---|
| 1500 Hz | 0.23 st | 3.92 dB | 1.98 dB |
| 1000 Hz | | 5.54 dB | 2.50 dB |
| **500 Hz** | **3.32 st** | **6.19 dB** | **2.96 dB** |
| 300 Hz | 3.13 st | 6.12 dB | 3.24 dB |
| 200 Hz | 3.09 st | 6.09 dB | 3.49 dB |
| 150 Hz | 3.05 st | 6.10 dB | 3.56 dB |
| 100 Hz | 2.61 st | 6.00 dB | 4.39 dB |

Depth saturates at about 6.1 dB by 500 Hz and goes no higher, while wobble
keeps climbing. For a faithful formant shift the useful range is roughly 400 to
800.

Below that it stops being a fidelity question and becomes an effect. The gain
curve changes character at a threshold that turns out to be simple: the lifter
keeps `q = sr / width` cepstral coefficients and the pitch period sits at
quefrency `sr / f0`, so the envelope begins absorbing harmonic structure once
**width falls below a source's fundamental**. Past that point the warp is
shifting a harmonic comb off its own harmonics, which is heard as shimmer.

Measured on the same file, whose slowed fundamental is 117.7 Hz:

| width | q | gain rms | range | slope reversals |
|---|---|---|---|---|
| 100 Hz | 480 | 19.65 dB | −45.8 to +48.4 | 54 |
| 150 Hz | 320 | 8.76 dB | −15.1 to +21.5 | 19 |
| 500 Hz | 96 | 8.66 dB | −19.3 to +21.7 | 14 |
| 1000 Hz | 48 | 7.11 dB | −13.2 to +22.1 | 9 |
| 1500 Hz | 32 | 5.12 dB | −5.0 to +14.9 | 4 |
| 4000 Hz | 12 | 4.36 dB | −5.3 to +12.1 | 3 |

The jump between 150 and 100 is that threshold being crossed. The threshold is
per source, so on a mix a setting of 150 combs a vocal while leaving a bass line
alone.

Widening does not approach bypass, which is worth knowing. At 1500 Hz the
formants move only 0.23 st, so the intended effect has gone, but 5 dB rms of
smooth broadband gain remains. True bypass is amount 0, which reconstructs the
input exactly.

The panel shows the same two figures live, computed inside the DSP over the
same 200 Hz to 6 kHz band. It reads about 0.9 dB higher on depth and 0.8 dB
lower on wobble than the table above, because the panel measures the gain curve
the warp intends while `gainwobble.js` measures the ratio of two STFT
magnitudes after reconstruction, which picks up window leakage. The trends
agree exactly, so compare readings against each other rather than across the
two tools. Both settle in about a second after a change.

At 1500 Hz the lifter keeps only 32 cepstral coefficients, so the envelope
cannot resolve anything narrower than a formant group. Warping it produces a
broadband tilt rather than a translation of formant features, which is why the
gain depth is still 3.9 dB while the formants themselves move only 0.23 st.

The crossover is close to a no-op at the default env_res, because the warp
barely acts down there in the first place. Its effect on the 60 to 120 Hz band
is 13.9 dB below the signal at env_res 500 and 39.6 dB below at 1500, against
1.9 dB below at env_res 150. It becomes a real control only at low env_res, or
if you push it above 300 Hz.

## The mark

Two beats, then the same two spread twice as far apart. It shows the resample
rather than the warp, in the same colour language the panel uses: cyan is
before, amber is after.

The gap ratio is 2:1 and the real one is 2^(3/12) = 1.19. A 19% difference is
invisible at any icon size, so it is exaggerated on purpose.

Both sides carry the same number of ticks, which matters. An earlier cut had
three on the left and two on the right, and at 16 px the three merged into a
solid slab, so the mark changed character between 16 and 32. With equal counts,
spacing is the only variable and there is nothing else for the eye to blame the
difference on.

Chrome's guidance shapes the rest. Artwork spans about 75% of the canvas with
the remainder transparent, and there is no tile or edge of its own because the
browser may add one. Small sizes are allowed slightly more of the canvas, or
the mark shrinks into nothing.

```bash
node tools/icons.js               # cut the chosen mark into extension/icons
node tools/icons.js --candidates  # cut every concept for comparison
node tools/icon-sheet.js          # contact sheet, all concepts, all sizes
node tools/icon-compare.js        # the comparison page, with data URIs inlined
```

Geometry for every concept lives in one table at the top of `tools/icons.js`,
and each mark is centred from its own bounding box, so editing a shape cannot
quietly unbalance the composition. PNGs are encoded with zlib directly, so
there is no image library to install. `design/icon-candidates.html` is the
record of what was compared and why.

The same four ticks are drawn as inline SVG in the panel header and the popup.
The panel builds them with `createElementNS` rather than markup, because
YouTube enforces Trusted Types and would reject an `innerHTML` assignment.

## Build

```bash
pwsh build.ps1              # development
pwsh build.ps1 -Release     # also writes dist/chrome-release and dist/firefox-release
```

Runs the Rust tests, builds `wasm32-unknown-unknown`, copies the module into
`extension/`, checks the two manifests against each other, runs the worklet
harness, and assembles `dist/firefox`. With `-Release` it additionally writes
release folders for both browsers with development-only features compiled out. About 40 KB, no imports, no wasm-bindgen. That last part matters:
`AudioWorkletGlobalScope` in Chrome has no `TextDecoder`, so the usual bindgen
glue is a liability there.

## Listening offline

Faster than reloading a browser tab, and it lets you compare two files in an
editor instead of from memory.

```bash
node tools/testsig.js material test-material.wav
node tools/render.js test-material.wav out-dry.wav --amount 0
node tools/render.js test-material.wav out-wet.wav --amount 1
node tools/render.js test-material.wav out-ms.wav --stereo ms --side 0.3 --crossover 150 --transient 0.7
```

Both renders come out the same length and sample aligned, so you can null them
against each other. Options: `--semitones --amount --stereo lr|ms --side
--crossover --transient --envres --fft --noloud --float --ceiling`.

To hear the effect with nothing at all holding the peaks down:

```bash
node tools/render.js in.wav out.wav --amount 1 --ceiling 0 --float
```

`node tools/analyse.js a.wav b.wav` reports the envelope shift between two
files in semitones and confirms the harmonic spacing did not move. Read its
calibration note before trusting the magnitude.

## Installing the extension

The wasm module is a build artifact and is not tracked, so run `build.ps1`
first on a fresh clone or the browser will refuse to load the folder.

**Chrome:**

1. Open `chrome://extensions`
2. Turn on Developer mode
3. Load unpacked, and pick the `extension` folder

**Firefox 128 or later:**

1. Open `about:debugging#/runtime/this-firefox`
2. Load Temporary Add-on, and pick `dist/firefox/manifest.json`

`build.ps1` assembles `dist/firefox` from `extension/` with the Firefox manifest
swapped in. The two builds differ in one thing, described below.

### Why there are two manifests

Getting code into the page's own realm is the one place the browsers genuinely
disagree, and it is not a difference you can paper over.

Chrome governs a script tag injected by a content script using the
**extension's** CSP, so `bridge.js` can inject `page.js` and it runs even on
YouTube. Firefox governs that same injection using the **page's** CSP and blocks
it. That is [bugzilla 1267027](https://bugzilla.mozilla.org/show_bug.cgi?id=1267027),
still open, with the note that the CSP spec says extensions should not be
subject to page policy.

Firefox does exempt a declarative `world: "MAIN"` content script from the page
CSP, from version 128. Mozilla describes that exemption as being unlike
Chrome's behaviour, which implies Chrome's MAIN world *is* subject to page CSP,
so it is not safe to unify on either route. Each build therefore declares the
one that works for it.

`bridge.js` decides which mode it is in by reading its own manifest for a
MAIN-world declaration of `page.js`, so there is no browser sniffing anywhere.
`page.js` reads its base URL off its script tag when injected, and waits for the
bridge to send it when declared, since only `audioWorklet.addModule` needs it
and that path is already async.

`node tools/check-manifests.js` holds the two manifests to agreeing on
everything except those two intended differences, and runs as part of
`build.ps1`.

**Untested in Firefox so far:** whether `addModule` on a `moz-extension:` URL is
itself subject to the page CSP. If it is, the panel will say `worklet blocked`
and the worklet source will need another route in.

Then open YouTube. Panel hotkeys: **alt+S** show or hide, **alt+X** on or off,
and in development builds **alt+A** hold to hear the dry slowed version.

`alt+A` skips the parameter smoother, because judging a crossfade is not an A/B.
Measured on a steady tone it reaches the dry signal to within 60 dB in 34.8 ms
against 857.9 ms smoothed. That is inside one window and is the floor here:
overlap-add sums four windows into every output sample, so no parameter change
can resolve faster than the window length.

It is a testing feature and does not ship. `build.ps1 -Release` rewrites the
`DEV` flag in `page.js` to false, which removes the compare bar and the hotkey,
and the build fails loudly if it cannot find the flag to rewrite.

Closing the panel collapses it to a small pill in the same corner rather than
hiding it completely, so it is always recoverable by clicking. The popup carries
a show or hide control as well, which works even if the page never sees the
hotkey. If the page detaches the panel during navigation it is put back on the
next status tick.

The panel plots the spectral envelope before and after the gain it is applying,
updated at 15 Hz. Cyan is the original envelope, amber is where the warp has
moved it, and the filled area between them is the gain. Under it sit four live
figures: **depth** and **wobble** as described under tuning, **ceiling** showing
any reduction the limiter is making, and **delay** for the current window size.
Every control carries a **?** that opens an explanation of what it does.

Snapshots are only sent while the panel is open, so a closed panel costs
nothing.

## What is verified

Rust tests (`cargo test`):

* `dry_path_reconstructs` confirms amount 0 is a pure delay of exactly one
  window, to within 1e-3.
* `envelope_moves_up` confirms the spectral centroid of a synthetic voiced
  signal moves by 2^(3/12) to within 6%.
* `crossover_protects_low_band` confirms an 80 Hz tone survives a 1000 Hz
  crossover with under 5% level change.
* `loudness_match_does_not_boost_at_startup` covers a bug found during
  bring-up. The output is silent for one window while the input is already
  loud, so an EMA started from zero drove the matcher straight to its +6 dB
  ceiling and took a second to recover. Everything, including the dry path,
  came out 5 dB hot.
* `output_respects_ceiling` covers the second one. Warping the envelope upward
  raised crest factor by about 1.3 dB on a signal with a strong low sine, and
  the first version of the limiter ramped its reduction in across the block,
  so the peak that triggered it escaped before the gain arrived.
* Two FFT tests.

`node tools/worklet-harness.js` runs the real `extension/worklet.js` under a
stubbed `AudioWorkletGlobalScope` and checks it bit for bit against direct wasm
calls. It currently reports zero deviation over 750 blocks. This covers the
parameter index layout, the views into wasm memory and the block handling,
which is where the glue bugs would be.

End to end on rendered files, using an unprocessed reference with formants at
800/2300/3400 Hz and f0 at 140 Hz:

* Playback ratio measured 0.8407 against a target of 0.8409.
* The warp on its own leaves the harmonic spacing at a ratio of exactly 1.0000.
* The warped render's envelope sits within 0.3 st of the unslowed original,
  while the dry render sits well below it.

## Known limits

Spotify, Apple Music and Tidal web players decrypt through EME.
`createMediaElementSource` returns silence for protected media by design, and
working around that is a DMCA 1201 problem, so those sites are out of scope.
YouTube and YouTube Music play through MSE from a blob URL and are fine.

Bandcamp serves a direct cross-origin `<audio src>`, which taints the element
and yields silence. The panel detects this case and says so rather than leaving
you wondering.

The worklet adds one window of delay, 42.7 ms at 2048 and 48 kHz. For
audio-only that is irrelevant. On video it puts audio behind picture by about
that much, which is inside the usual tolerance but audible to some people on
close-ups. Drop the window to 1024 for video.

While the effect is on, the playbackRate is re-asserted on every `ratechange`,
so YouTube's own speed menu will not stick. Turn Slowform off to use it.

Switching between L/R and M/S mid-playback puts one window of mismatched
samples through the analysis buffers and clicks once.

The full warp raises peak level even with RMS matched, by about 1.3 dB on the
synthetic material file. A ceiling at 0.99 catches that, and the panel says so
whenever it is working, so you can tell whether you are hearing the effect or
the limiter. In the browser it is fixed on, because the destination clips
regardless. Offline you can set `--ceiling 0`.

Loading the worklet module from a `chrome-extension:` URL and compiling the
wasm inside the worklet both work on YouTube under its CSP, confirmed on Chrome
2026-07-26. If another site refuses, the panel shows the error, and the fix is
to compile in the content script and hand over a `WebAssembly.Module`.

## Layout

```
src/fft.rs               radix-2 complex FFT, no dependencies
src/stft.rs              envelope warp, transient detection, loudness match
src/lib.rs               C ABI exports for wasm
extension/manifest.json          Chrome
extension/manifest.firefox.json  Firefox, swapped in by build.ps1
extension/icons/         generated by tools/icons.js, tracked
extension/bridge.js      isolated world: couriers wasm, base URL and settings
extension/page.js        page world: media elements, audio graph, panel
extension/worklet.js     AudioWorklet host for the wasm
tools/render.js          offline renderer
tools/analyse.js         envelope shift and pitch measurement
tools/testsig.js         test signal generator
tools/gainwobble.js      how hard the warp works and how steady it is
tools/banddiff.js        octave-band difference between two renders
tools/envsnap.js         dumps one frame's envelope and gain curve as JSON
tools/icons.js           cuts the icon set, with its own PNG encoder
tools/check-manifests.js keeps the Chrome and Firefox manifests in step
tools/worklet-harness.js runs worklet.js under a stubbed worklet scope
design/panel-mockups.html  the three directions the panel was chosen from
```
