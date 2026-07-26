//! Spectral envelope warping over an STFT.
//!
//! The playback rate change happens outside this code (the browser resamples
//! the media element). All this does is warp the spectral envelope back up by
//! the reciprocal ratio, leaving phase untouched. Because duration and pitch
//! are never altered here, no phase vocoder is needed: the whole effect
//! reduces to a per-bin real gain
//!
//! ```text
//! G[k] = ( E'[k] / E[k] ) ^ e[k]
//! ```
//!
//! where E is the cepstrally smoothed envelope, E'[k] = E[k / rho] is that
//! envelope shifted up by rho, and e[k] is an exponent in [0, 1] carrying the
//! wet amount, the crossover taper and the transient relaxation.
//!
//! With e = 0 the gain is exactly 1 and the analysis/synthesis pair is a
//! perfect-reconstruction Hann WOLA, so an A/B against the unprocessed slowed
//! signal is sample-aligned and free of any level or latency change.

use crate::fft::Fft;
use std::collections::VecDeque;

/// Layout of the parameter block handed across the wasm boundary.
pub const P_MID_WET: usize = 0;
pub const P_SIDE_WET: usize = 1;
pub const P_CROSSOVER_HZ: usize = 2;
pub const P_TRANSIENT: usize = 3;
pub const P_STEREO_MS: usize = 4;
pub const P_ENV_RES_HZ: usize = 5;
pub const P_SHIFT_RATIO: usize = 6;
pub const P_LOUDNESS: usize = 7;
pub const P_CEILING: usize = 8;
pub const P_COUNT: usize = 9;

/// How far above its running mean the spectral flux has to sit before a frame
/// counts as a full transient.
const FLUX_SENSITIVITY: f32 = 2.0;
/// Time constant for the wet/crossover/transient smoothers.
const PARAM_TAU_S: f32 = 0.12;
/// Time constant for the loudness matcher.
const LOUDNESS_TAU_S: f32 = 1.0;
/// Below this mean square the loudness matcher stops updating.
const LOUDNESS_GATE: f32 = 1.0e-8;
/// Warping the envelope upward redistributes energy and can raise crest factor
/// by a couple of dB even with the RMS matched, which would clip at the
/// destination. The ceiling is a parameter so an offline float render can turn
/// it off and hear the effect untouched. Reduction is reported either way.
const LIMIT_RELEASE_S: f32 = 0.15;

/// Frequency range the panel plots over. Fixed so the JS side can derive the
/// axis without being told it.
pub const SNAP_F_LO: f32 = 60.0;
pub const SNAP_F_HI: f32 = 16000.0;
/// Band the depth and wobble statistics are measured over. Matches
/// `tools/gainwobble.js` so the live numbers and the offline tool agree.
const STAT_LO_HZ: f32 = 200.0;
const STAT_HI_HZ: f32 = 6000.0;
/// Bins this far below the loudest bin in the band are ignored, otherwise the
/// statistics are dominated by the ratio of two noise floors.
const STAT_FLOOR: f32 = 1.0e-3;
const STAT_TAU_S: f32 = 1.0;
const DISPLAY_TAU_S: f32 = 0.3;
/// Natural log to dB.
const NEPER_DB: f32 = 8.685_889;
/// Dynamic range of the plotted curves, below the envelope's own peak.
const SNAP_FLOOR_DB: f32 = 72.0;

#[derive(Clone, Copy)]
pub struct Params {
    pub mid_wet: f32,
    pub side_wet: f32,
    pub crossover_hz: f32,
    pub transient: f32,
    pub stereo_ms: bool,
    pub env_res_hz: f32,
    pub shift_ratio: f32,
    pub loudness_match: bool,
    /// Peak ceiling, linear. Zero or less disables it.
    pub ceiling: f32,
}

impl Default for Params {
    fn default() -> Self {
        Params {
            mid_wet: 1.0,
            side_wet: 1.0,
            crossover_hz: 0.0,
            transient: 0.0,
            stereo_ms: false,
            env_res_hz: 500.0,
            shift_ratio: 1.189_207_1, // 2^(3/12)
            loudness_match: true,
            ceiling: 0.99,
        }
    }
}

pub struct Processor {
    n: usize,
    hop: usize,
    sr: f32,
    fft: Fft,
    window: Vec<f32>,
    ola_scale: f32,

    infill: usize,
    inbuf: [Vec<f32>; 2],
    ola: [Vec<f32>; 2],
    outq: [VecDeque<f32>; 2],

    re: Vec<f32>,
    im: Vec<f32>,
    spec_re: [Vec<f32>; 2],
    spec_im: [Vec<f32>; 2],
    mag: [Vec<f32>; 2],
    env: [Vec<f32>; 2],

    prev_mag: Vec<f32>,
    flux_ema: f32,

    taper: Vec<f32>,
    taper_hz: f32,

    p: Params,
    s_mid: f32,
    s_side: f32,
    s_trans: f32,
    param_coef: f32,

    ms_in: f32,
    ms_out: f32,
    gain: f32,
    loud_coef_ref: f32,
    loud_primed: bool,
    limit_gain: f32,

    // Panel telemetry, measured on channel 0 only.
    snap_env: Vec<f32>,
    snap_out: Vec<f32>,
    have_snap: bool,
    wob_m: Vec<f32>,
    wob_m2: Vec<f32>,
    stat_lo: usize,
    stat_hi: usize,
    stat_coef: f32,
    display_coef: f32,
    depth_db: f32,
    wobble_db: f32,
}

impl Processor {
    pub fn new(sample_rate: f32, n: usize) -> Self {
        let n = n.clamp(256, 8192).next_power_of_two();
        let hop = n / 4;
        let half = n / 2;

        // Periodic Hann. Applied on analysis and again on synthesis; with a
        // hop of n/4 the squared window sums to 1.5, hence the 2/3 scale.
        let window: Vec<f32> = (0..n)
            .map(|i| 0.5 - 0.5 * (2.0 * std::f32::consts::PI * i as f32 / n as f32).cos())
            .collect();

        let mut proc = Processor {
            n,
            hop,
            sr: sample_rate,
            fft: Fft::new(n),
            window,
            ola_scale: 1.0 / 1.5,

            infill: 0,
            inbuf: [vec![0.0; n], vec![0.0; n]],
            ola: [vec![0.0; n], vec![0.0; n]],
            outq: [VecDeque::with_capacity(4 * n), VecDeque::with_capacity(4 * n)],

            re: vec![0.0; n],
            im: vec![0.0; n],
            spec_re: [vec![0.0; n], vec![0.0; n]],
            spec_im: [vec![0.0; n], vec![0.0; n]],
            mag: [vec![0.0; half + 1], vec![0.0; half + 1]],
            env: [vec![0.0; half + 1], vec![0.0; half + 1]],

            prev_mag: vec![0.0; half + 1],
            flux_ema: 0.0,

            taper: vec![1.0; half + 1],
            taper_hz: -1.0,

            p: Params::default(),
            s_mid: 0.0,
            s_side: 0.0,
            s_trans: 0.0,
            param_coef: 1.0 - (-(hop as f32) / (sample_rate * PARAM_TAU_S)).exp(),

            ms_in: 0.0,
            ms_out: 0.0,
            gain: 1.0,
            loud_coef_ref: 1.0 / (sample_rate * LOUDNESS_TAU_S),
            loud_primed: false,
            limit_gain: 1.0,

            snap_env: vec![0.0; half + 1],
            snap_out: vec![0.0; half + 1],
            have_snap: false,
            wob_m: vec![0.0; half + 1],
            wob_m2: vec![0.0; half + 1],
            stat_lo: (((STAT_LO_HZ * n as f32) / sample_rate) as usize).max(1),
            stat_hi: (((STAT_HI_HZ * n as f32) / sample_rate) as usize).min(half),
            stat_coef: 1.0 - (-(hop as f32) / (sample_rate * STAT_TAU_S)).exp(),
            display_coef: 1.0 - (-(hop as f32) / (sample_rate * DISPLAY_TAU_S)).exp(),
            depth_db: 0.0,
            wobble_db: 0.0,
        };
        proc.rebuild_taper();
        proc
    }

    /// Algorithmic delay in samples. One analysis window.
    pub fn latency(&self) -> usize {
        self.n
    }

    pub fn set_params(&mut self, p: Params) {
        self.p = p;
        if (p.crossover_hz - self.taper_hz).abs() > 1e-3 {
            self.rebuild_taper();
        }
    }

    fn rebuild_taper(&mut self) {
        let half = self.n / 2;
        let fc = self.p.crossover_hz.max(0.0);
        let bin_hz = self.sr / self.n as f32;
        for k in 0..=half {
            let f = k as f32 * bin_hz;
            self.taper[k] = if fc <= 0.0 || f >= fc {
                1.0
            } else if f <= fc * 0.5 {
                0.0
            } else {
                let x = (f - fc * 0.5) / (fc * 0.5);
                0.5 - 0.5 * (std::f32::consts::PI * x).cos()
            };
        }
        self.taper_hz = fc;
    }

    /// Process one interleaved-by-channel block in place. Both slices must be
    /// the same length.
    pub fn process(&mut self, l: &mut [f32], r: &mut [f32]) {
        let len = l.len().min(r.len());
        if len == 0 {
            return;
        }
        let n = self.n;
        let hop = self.hop;
        let ms = self.p.stereo_ms;

        let mut sum_in = 0.0f32;
        for i in 0..len {
            sum_in += l[i] * l[i] + r[i] * r[i];
        }

        for i in 0..len {
            let (li, ri) = (l[i], r[i]);

            // Drain before filling, so the input-to-output delay is exactly
            // one window rather than one window minus a sample.
            let oa = self.outq[0].pop_front().unwrap_or(0.0);
            let ob = self.outq[1].pop_front().unwrap_or(0.0);
            if ms {
                l[i] = oa + ob;
                r[i] = oa - ob;
            } else {
                l[i] = oa;
                r[i] = ob;
            }

            let (a, b) = if ms {
                ((li + ri) * 0.5, (li - ri) * 0.5)
            } else {
                (li, ri)
            };
            let w = n - hop + self.infill;
            self.inbuf[0][w] = a;
            self.inbuf[1][w] = b;
            self.infill += 1;
            if self.infill == hop {
                self.infill = 0;
                self.frame();
            }
        }

        let mut sum_out = 0.0f32;
        for i in 0..len {
            sum_out += l[i] * l[i] + r[i] * r[i];
        }

        // Loudness match. Slow enough that the n-sample analysis delay between
        // the two measurements does not matter.
        let target = if self.p.loudness_match {
            let inv = len as f32;
            let block_in = sum_in / inv;
            let block_out = sum_out / inv;
            // Both sides have to be live before the matcher engages. For the
            // first window the output is still filling while the input is
            // already loud, and an EMA started from zero would slam the gain
            // to its ceiling and take a second to crawl back.
            if block_in > LOUDNESS_GATE && block_out > LOUDNESS_GATE {
                if self.loud_primed {
                    let a = (len as f32 * self.loud_coef_ref).min(1.0);
                    self.ms_in += (block_in - self.ms_in) * a;
                    self.ms_out += (block_out - self.ms_out) * a;
                } else {
                    self.ms_in = block_in;
                    self.ms_out = block_out;
                    self.loud_primed = true;
                }
            }
            if self.loud_primed && self.ms_out > LOUDNESS_GATE {
                (self.ms_in / self.ms_out).sqrt().clamp(0.5, 2.0)
            } else {
                1.0
            }
        } else {
            1.0
        };

        // One block of look-ahead: the block is already rendered, so its peak
        // is known before anything is written out. The loudness gain ramps
        // across the block, so the requirement is computed against the worst
        // point of that ramp, and the ceiling gain itself is held constant
        // across the block. Ramping the ceiling in would let an early peak
        // through before the reduction had arrived.
        let mut peak = 0.0f32;
        for i in 0..len {
            peak = peak.max(l[i].abs()).max(r[i].abs());
        }
        let ceiling = self.p.ceiling;
        let loud_max = self.gain.max(target);
        let needed = if ceiling > 0.0 && peak * loud_max > ceiling {
            ceiling / (peak * loud_max)
        } else {
            1.0
        };
        if needed < self.limit_gain {
            self.limit_gain = needed;
        } else {
            let rel = 1.0 - (-(len as f32) / (self.sr * LIMIT_RELEASE_S)).exp();
            self.limit_gain += (needed - self.limit_gain) * rel;
        }

        let g0 = self.gain;
        let step = (target - g0) / len as f32;
        for i in 0..len {
            let g = (g0 + step * i as f32) * self.limit_gain;
            l[i] *= g;
            r[i] *= g;
        }
        self.gain = target;
    }

    /// Current limiter gain, 1.0 when it is doing nothing.
    pub fn limiter_gain(&self) -> f32 {
        self.limit_gain
    }

    pub fn depth_db(&self) -> f32 {
        self.depth_db
    }

    pub fn wobble_db(&self) -> f32 {
        self.wobble_db
    }

    /// Writes the envelope before and after the applied gain, in dB, resampled
    /// onto a log-frequency axis from `SNAP_F_LO` to `SNAP_F_HI`. Returns false
    /// if no frame has been analysed yet.
    pub fn snapshot(&self, env: &mut [f32], out: &mut [f32]) -> bool {
        if !self.have_snap {
            return false;
        }
        let points = env.len().min(out.len());
        if points < 2 {
            return false;
        }
        let half = self.n / 2;
        let bins_per_hz = self.n as f32 / self.sr;
        let span = (SNAP_F_HI / SNAP_F_LO).ln();
        for i in 0..points {
            let f = SNAP_F_LO * (span * i as f32 / (points - 1) as f32).exp();
            let x = (f * bins_per_hz).min(half as f32 - 1.0);
            let k = x as usize;
            let t = x - k as f32;
            let lerp = |a: &[f32]| a[k] + (a[k + 1] - a[k]) * t;
            env[i] = lerp(&self.snap_env) * NEPER_DB;
            out[i] = lerp(&self.snap_out) * NEPER_DB;
        }

        // Above the last partial there is no signal, so the envelope there is
        // just the smoothed noise floor and the warp reads a large gain across
        // it. Drawing that would put a wide band of colour over a region
        // nobody can hear. Both curves are floored together so the region
        // closes up instead.
        let mut top = f32::NEG_INFINITY;
        for i in 0..points {
            if env[i] > top {
                top = env[i];
            }
        }
        if top.is_finite() {
            let floor = top - SNAP_FLOOR_DB;
            for i in 0..points {
                env[i] = env[i].max(floor);
                out[i] = out[i].max(floor);
            }
        }
        true
    }

    fn frame(&mut self) {
        let n = self.n;
        let hop = self.hop;
        let half = n / 2;

        self.s_mid += (self.p.mid_wet - self.s_mid) * self.param_coef;
        self.s_side += (self.p.side_wet - self.s_side) * self.param_coef;
        self.s_trans += (self.p.transient - self.s_trans) * self.param_coef;

        // Analysis for both channels first, so the transient detector can see
        // the whole frame before any gain is decided.
        for ch in 0..2 {
            for i in 0..n {
                self.re[i] = self.inbuf[ch][i] * self.window[i];
                self.im[i] = 0.0;
            }
            self.fft.forward(&mut self.re, &mut self.im);
            self.spec_re[ch].copy_from_slice(&self.re);
            self.spec_im[ch].copy_from_slice(&self.im);
            for k in 0..=half {
                self.mag[ch][k] = (self.re[k] * self.re[k] + self.im[k] * self.im[k]).sqrt();
            }
        }

        // Half-wave rectified spectral flux, normalised by frame energy so it
        // is level independent, then compared against its own running mean.
        let mut flux = 0.0f32;
        let mut total = 0.0f32;
        for k in 0..=half {
            let m = self.mag[0][k] + self.mag[1][k];
            let d = m - self.prev_mag[k];
            if d > 0.0 {
                flux += d;
            }
            total += m;
            self.prev_mag[k] = m;
        }
        let fnorm = flux / (total + 1e-12);
        let t = if self.flux_ema > 1e-9 {
            (((fnorm / self.flux_ema) - 1.0) * FLUX_SENSITIVITY).clamp(0.0, 1.0)
        } else {
            0.0
        };
        self.flux_ema += (fnorm - self.flux_ema) * 0.05;
        let relax = 1.0 - t * self.s_trans;

        let rho = self.p.shift_ratio.max(1e-3);
        let q = ((self.sr / self.p.env_res_hz.max(20.0)) as usize).clamp(8, half.saturating_sub(1));

        for ch in 0..2 {
            // Real cepstrum of the log magnitude, lifted to keep only the low
            // quefrencies. q coefficients resolve spectral detail down to
            // about sr/q Hz, which is the "envelope resolution" knob.
            for k in 0..=half {
                self.re[k] = self.mag[ch][k].max(1e-9).ln();
                self.im[k] = 0.0;
            }
            for k in (half + 1)..n {
                self.re[k] = self.re[n - k];
                self.im[k] = 0.0;
            }
            self.fft.inverse(&mut self.re, &mut self.im);
            for m in (q + 1)..(n - q) {
                self.re[m] = 0.0;
            }
            for m in 0..n {
                self.im[m] = 0.0;
            }
            self.fft.forward(&mut self.re, &mut self.im);
            self.env[ch][..=half].copy_from_slice(&self.re[..=half]);

            let wet = if ch == 0 { self.s_mid } else { self.s_side };
            for k in 0..=half {
                // E'(f) = E(f / rho): the envelope value at this bin is the
                // one the original envelope had rho times lower down. rho > 1
                // so the read index never leaves the array.
                let src = k as f32 / rho;
                let i0 = (src.floor() as usize).min(half);
                let i1 = (i0 + 1).min(half);
                let frac = src - i0 as f32;
                let e0 = self.env[ch][i0];
                let warped = e0 + (self.env[ch][i1] - e0) * frac;

                let expo = wet * self.taper[k] * relax;
                let log_gain = (warped - self.env[ch][k]) * expo;
                let g = log_gain.exp().clamp(0.0625, 16.0);

                if ch == 0 {
                    // The panel draws the envelope before and after the gain
                    // that was actually applied, so a half-strength amount
                    // shows a curve sitting half way rather than a full shift.
                    self.snap_env[k] = self.env[ch][k];
                    self.snap_out[k] = self.env[ch][k] + log_gain;
                }

                self.spec_re[ch][k] *= g;
                self.spec_im[ch][k] *= g;
                if k > 0 && k < half {
                    self.spec_re[ch][n - k] *= g;
                    self.spec_im[ch][n - k] *= g;
                }
            }

            if ch == 0 {
                // Depth is how hard the warp is working: the mean over bins of
                // the time-averaged log gain. Wobble is how unsteady it is: the
                // standard deviation over time of that same gain, per bin, then
                // averaged. A steady curve is a timbre change; an unsteady one
                // is modulation, which is what shimmer is.
                let (lo, hi) = (self.stat_lo, self.stat_hi);
                let mut peak = 0.0f32;
                for k in lo..hi {
                    peak = peak.max(self.mag[0][k]);
                }
                let floor = peak * STAT_FLOOR;
                let a = self.stat_coef;
                let mut dsum = 0.0f32;
                let mut wsum = 0.0f32;
                let mut count = 0u32;
                for k in lo..hi {
                    if self.mag[0][k] < floor {
                        continue;
                    }
                    let lg = self.snap_out[k] - self.snap_env[k];
                    self.wob_m[k] += (lg - self.wob_m[k]) * a;
                    self.wob_m2[k] += (lg * lg - self.wob_m2[k]) * a;
                    dsum += self.wob_m[k].abs();
                    wsum += (self.wob_m2[k] - self.wob_m[k] * self.wob_m[k]).max(0.0).sqrt();
                    count += 1;
                }
                if count > 0 {
                    let inv = 1.0 / count as f32;
                    let d = dsum * inv * NEPER_DB;
                    let w = wsum * inv * NEPER_DB;
                    let c = self.display_coef;
                    self.depth_db += (d - self.depth_db) * c;
                    self.wobble_db += (w - self.wobble_db) * c;
                }
                self.have_snap = true;
            }

            self.re.copy_from_slice(&self.spec_re[ch]);
            self.im.copy_from_slice(&self.spec_im[ch]);
            self.fft.inverse(&mut self.re, &mut self.im);

            for i in 0..n {
                self.ola[ch][i] += self.re[i] * self.window[i] * self.ola_scale;
            }
            for i in 0..hop {
                self.outq[ch].push_back(self.ola[ch][i]);
            }
            self.ola[ch].copy_within(hop..n, 0);
            for i in (n - hop)..n {
                self.ola[ch][i] = 0.0;
            }
        }

        for ch in 0..2 {
            self.inbuf[ch].copy_within(hop..n, 0);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(p: &mut Processor, sig: &[f32]) -> (Vec<f32>, Vec<f32>) {
        let mut l = Vec::new();
        let mut r = Vec::new();
        for chunk in sig.chunks(128) {
            let mut a = chunk.to_vec();
            let mut b = chunk.to_vec();
            p.process(&mut a, &mut b);
            l.extend_from_slice(&a);
            r.extend_from_slice(&b);
        }
        (l, r)
    }

    fn tone(n: usize, sr: f32, f: f32) -> Vec<f32> {
        (0..n)
            .map(|i| (2.0 * std::f32::consts::PI * f * i as f32 / sr).sin() * 0.5)
            .collect()
    }

    /// Wet = 0 must be a perfect-reconstruction delay line. This is what makes
    /// the A/B honest.
    #[test]
    fn dry_path_reconstructs() {
        let sr = 48000.0;
        let n = 2048;
        let mut p = Processor::new(sr, n);
        p.set_params(Params {
            mid_wet: 0.0,
            side_wet: 0.0,
            loudness_match: false,
            ..Default::default()
        });
        let sig: Vec<f32> = (0..20000)
            .map(|i| {
                let x = i as f32;
                0.3 * (x * 0.031).sin() + 0.2 * (x * 0.0071).sin() + 0.1 * (x * 0.211).sin()
            })
            .collect();
        let (out, _) = run(&mut p, &sig);
        let lat = p.latency();
        let mut worst = 0.0f32;
        // Skip the first two windows while the smoother settles and the OLA fills.
        for i in (lat + 4096)..sig.len() {
            worst = worst.max((out[i] - sig[i - lat]).abs());
        }
        assert!(worst < 1e-3, "reconstruction error {worst}");
    }

    /// A voiced-like signal (dense harmonics under a formant bump) should have
    /// its spectral peak move up by the shift ratio, while the harmonic
    /// spacing stays put.
    #[test]
    fn envelope_moves_up() {
        let sr = 48000.0;
        let n = 2048;
        let f0 = 150.0;
        let formant = 900.0;
        let bw = 300.0;

        let len = 32768;
        let mut sig = vec![0.0f32; len];
        for h in 1..60 {
            let f = f0 * h as f32;
            if f > sr / 2.0 - 100.0 {
                break;
            }
            let a = (-((f - formant) / bw).powi(2)).exp() + 0.02;
            for (i, s) in sig.iter_mut().enumerate() {
                *s += a * (2.0 * std::f32::consts::PI * f * i as f32 / sr).sin();
            }
        }
        let peak = sig.iter().fold(0.0f32, |m, v| m.max(v.abs()));
        for s in sig.iter_mut() {
            *s /= peak * 2.0;
        }

        let rho = 2.0f32.powf(3.0 / 12.0);
        let mut p = Processor::new(sr, n);
        p.set_params(Params {
            shift_ratio: rho,
            loudness_match: false,
            ..Default::default()
        });
        let (out, _) = run(&mut p, &sig);

        let centroid = |x: &[f32]| -> f32 {
            let fft = Fft::new(4096);
            let mut re = vec![0.0f32; 4096];
            let mut im = vec![0.0f32; 4096];
            for i in 0..4096 {
                let w = 0.5 - 0.5 * (2.0 * std::f32::consts::PI * i as f32 / 4096.0).cos();
                re[i] = x[i] * w;
            }
            fft.forward(&mut re, &mut im);
            let mut num = 0.0;
            let mut den = 0.0;
            for k in 1..2048 {
                let m = (re[k] * re[k] + im[k] * im[k]).sqrt();
                let f = k as f32 * sr / 4096.0;
                if f < 4000.0 {
                    num += f * m;
                    den += m;
                }
            }
            num / den
        };

        let c_in = centroid(&sig[16384..]);
        let c_out = centroid(&out[16384..]);
        let measured = c_out / c_in;
        assert!(
            (measured - rho).abs() < 0.06,
            "centroid ratio {measured}, expected about {rho}"
        );
    }

    /// The loudness matcher must not overshoot while the pipeline is still
    /// filling. With the warp off it has nothing to correct, so the output
    /// peak should not exceed the input peak.
    #[test]
    fn loudness_match_does_not_boost_at_startup() {
        let sr = 48000.0;
        let mut p = Processor::new(sr, 2048);
        p.set_params(Params {
            mid_wet: 0.0,
            side_wet: 0.0,
            loudness_match: true,
            ..Default::default()
        });
        let sig = tone(48000, sr, 220.0); // peaks at 0.5
        let (out, _) = run(&mut p, &sig);
        let peak = out.iter().fold(0.0f32, |m, v| m.max(v.abs()));
        assert!(peak <= 0.52, "output peaked at {peak}, input at 0.5");
    }

    /// A hot input with the warp on full must not leave the ceiling.
    #[test]
    fn output_respects_ceiling() {
        let sr = 48000.0;
        let mut p = Processor::new(sr, 2048);
        p.set_params(Params::default());
        let mut sig = vec![0.0f32; 48000];
        for (i, s) in sig.iter_mut().enumerate() {
            let t = i as f32 / sr;
            *s = 0.7 * (2.0 * std::f32::consts::PI * 55.0 * t).sin()
                + 0.25 * (2.0 * std::f32::consts::PI * 1100.0 * t).sin();
        }
        let (out, _) = run(&mut p, &sig);
        let peak = out.iter().fold(0.0f32, |m, v| m.max(v.abs()));
        assert!(peak <= 1.0, "output peaked at {peak}");
    }

    /// Panel telemetry: nothing before the first frame, then curves that agree
    /// with the amount actually applied.
    #[test]
    fn snapshot_tracks_the_applied_gain() {
        let sr = 48000.0;
        let mut p = Processor::new(sr, 2048);
        let mut a = vec![0.0f32; 128];
        let mut b = vec![0.0f32; 128];
        assert!(!p.snapshot(&mut a, &mut b), "snapshot before any frame");

        let sig: Vec<f32> = (0..48000)
            .map(|i| {
                let t = i as f32 / sr;
                let mut v = 0.0;
                for h in 1..40 {
                    let f = 130.0 * h as f32;
                    let amp = (-((f - 900.0) / 300.0f32).powi(2)).exp() + 0.02;
                    v += amp * (2.0 * std::f32::consts::PI * f * t).sin();
                }
                v * 0.05
            })
            .collect();

        // Full warp: the two curves must differ and depth must be real.
        p.set_params(Params {
            loudness_match: false,
            ceiling: 0.0,
            ..Default::default()
        });
        run(&mut p, &sig);
        assert!(p.snapshot(&mut a, &mut b));
        let spread = a.iter().zip(b.iter()).map(|(x, y)| (x - y).abs()).fold(0.0f32, f32::max);
        assert!(spread > 1.0, "curves barely differ: {spread} dB");
        assert!(p.depth_db() > 1.0, "depth {} dB", p.depth_db());
        // The plotted range is bounded, so a dead top end cannot paint a wide
        // band of colour across a region with no signal in it.
        let lowest = a.iter().chain(b.iter()).fold(f32::INFINITY, |m, v| m.min(*v));
        let highest = a.iter().chain(b.iter()).fold(f32::NEG_INFINITY, |m, v| m.max(*v));
        assert!(
            highest - lowest <= SNAP_FLOOR_DB + 0.01,
            "plotted range {} dB exceeds the floor",
            highest - lowest
        );
        assert!(spread < SNAP_FLOOR_DB, "curve spread {spread} dB");

        // Amount zero: the gain is identically 1, so the curves coincide and
        // depth decays to nothing.
        let mut q = Processor::new(sr, 2048);
        q.set_params(Params {
            mid_wet: 0.0,
            side_wet: 0.0,
            loudness_match: false,
            ceiling: 0.0,
            ..Default::default()
        });
        run(&mut q, &sig);
        assert!(q.snapshot(&mut a, &mut b));
        let spread0 = a.iter().zip(b.iter()).map(|(x, y)| (x - y).abs()).fold(0.0f32, f32::max);
        assert!(spread0 < 1e-3, "curves should coincide, got {spread0} dB");
        assert!(q.depth_db() < 0.05, "depth {} dB", q.depth_db());
        assert!(q.wobble_db() < 0.05, "wobble {} dB", q.wobble_db());
    }

    /// Crossover set above the signal band should leave it alone.
    #[test]
    fn crossover_protects_low_band() {
        let sr = 48000.0;
        let mut p = Processor::new(sr, 2048);
        p.set_params(Params {
            crossover_hz: 1000.0,
            loudness_match: false,
            ..Default::default()
        });
        let sig = tone(32768, sr, 80.0);
        let (out, _) = run(&mut p, &sig);
        let rms = |x: &[f32]| (x.iter().map(|v| v * v).sum::<f32>() / x.len() as f32).sqrt();
        let a = rms(&sig[16384..]);
        let b = rms(&out[16384..]);
        assert!((b / a - 1.0).abs() < 0.05, "level moved by {}", b / a);
    }
}
