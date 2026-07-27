//! wasm entry points for the Slowform envelope warper.
//!
//! Plain `extern "C"` exports, no wasm-bindgen. The consumer is an
//! AudioWorkletGlobalScope, which in Chrome lacks TextDecoder and friends, so
//! the usual bindgen glue is a liability there. Everything crosses the
//! boundary as f32 pointers into linear memory.

pub mod fft;
pub mod stft;

use stft::{Params, Processor, P_COUNT};

/// Leak a zeroed f32 buffer and return the pointer. Called a handful of times
/// at startup and never freed, which keeps `memory.buffer` stable so the JS
/// side can hold on to its views.
#[no_mangle]
pub extern "C" fn sf_alloc(len: usize) -> *mut f32 {
    let mut v = vec![0.0f32; len];
    let p = v.as_mut_ptr();
    std::mem::forget(v);
    p
}

#[no_mangle]
pub extern "C" fn sf_new(sample_rate: f32, fft_size: usize) -> *mut Processor {
    Box::into_raw(Box::new(Processor::new(sample_rate, fft_size)))
}

#[no_mangle]
pub extern "C" fn sf_delete(p: *mut Processor) {
    if !p.is_null() {
        unsafe { drop(Box::from_raw(p)) };
    }
}

#[no_mangle]
pub extern "C" fn sf_latency(p: *mut Processor) -> usize {
    if p.is_null() {
        return 0;
    }
    unsafe { (*p).latency() }
}

/// Current output-ceiling gain. 1.0 means the limiter is doing nothing, which
/// is what you want during a listening test.
#[no_mangle]
pub extern "C" fn sf_limiter_gain(p: *mut Processor) -> f32 {
    if p.is_null() {
        return 1.0;
    }
    unsafe { (*p).limiter_gain() }
}

/// Jump the smoothed parameters to their targets, for A/B switching.
#[no_mangle]
pub extern "C" fn sf_snap(p: *mut Processor) {
    if !p.is_null() {
        unsafe { (*p).snap_params() };
    }
}

/// Writes `[depth_db, wobble_db, limiter_gain]`.
#[no_mangle]
pub extern "C" fn sf_stats(p: *mut Processor, ptr: *mut f32, len: usize) {
    if p.is_null() || ptr.is_null() || len < 3 {
        return;
    }
    unsafe {
        let v = std::slice::from_raw_parts_mut(ptr, 3);
        v[0] = (*p).depth_db();
        v[1] = (*p).wobble_db();
        v[2] = (*p).limiter_gain();
    }
}

/// Fills two `points`-long buffers with the envelope before and after the
/// applied gain, in dB, on a log-frequency axis. Returns 1 on success.
#[no_mangle]
pub extern "C" fn sf_snapshot(
    p: *mut Processor,
    env_ptr: *mut f32,
    out_ptr: *mut f32,
    points: usize,
) -> u32 {
    if p.is_null() || env_ptr.is_null() || out_ptr.is_null() || points < 2 || points > 1024 {
        return 0;
    }
    unsafe {
        let env = std::slice::from_raw_parts_mut(env_ptr, points);
        let out = std::slice::from_raw_parts_mut(out_ptr, points);
        if (*p).snapshot(env, out) {
            1
        } else {
            0
        }
    }
}

/// `ptr` points at `P_COUNT` floats laid out per the `P_*` constants in
/// `stft`. Booleans travel as 0.0 or 1.0.
#[no_mangle]
pub extern "C" fn sf_set_params(p: *mut Processor, ptr: *const f32, len: usize) {
    if p.is_null() || ptr.is_null() || len < P_COUNT {
        return;
    }
    let v = unsafe { std::slice::from_raw_parts(ptr, P_COUNT) };
    let params = Params {
        mid_wet: v[stft::P_MID_WET].clamp(0.0, 2.0),
        side_wet: v[stft::P_SIDE_WET].clamp(0.0, 2.0),
        crossover_hz: v[stft::P_CROSSOVER_HZ].clamp(0.0, 2000.0),
        transient: v[stft::P_TRANSIENT].clamp(0.0, 1.0),
        stereo_ms: v[stft::P_STEREO_MS] >= 0.5,
        env_res_hz: v[stft::P_ENV_RES_HZ].clamp(50.0, 4000.0),
        shift_ratio: v[stft::P_SHIFT_RATIO].clamp(0.25, 4.0),
        loudness_match: v[stft::P_LOUDNESS] >= 0.5,
        ceiling: v[stft::P_CEILING].clamp(0.0, 4.0),
    };
    unsafe { (*p).set_params(params) };
}

#[no_mangle]
pub extern "C" fn sf_process(p: *mut Processor, lp: *mut f32, rp: *mut f32, len: usize) {
    if p.is_null() || lp.is_null() || rp.is_null() || len == 0 {
        return;
    }
    unsafe {
        let l = std::slice::from_raw_parts_mut(lp, len);
        let r = std::slice::from_raw_parts_mut(rp, len);
        (*p).process(l, r);
    }
}
