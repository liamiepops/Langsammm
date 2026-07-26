//! In-place iterative radix-2 complex FFT.
//!
//! Deliberately dependency-free so the wasm module stays small and so the
//! numerics are inspectable. Sizes here are 1024 to 4096, so the 2x waste of
//! running a complex transform on real input is not worth optimising away.

pub struct Fft {
    n: usize,
    rev: Vec<u32>,
    tw_re: Vec<f32>,
    tw_im: Vec<f32>,
}

impl Fft {
    pub fn new(n: usize) -> Self {
        assert!(n.is_power_of_two() && n >= 4);
        let bits = n.trailing_zeros();
        let mut rev = vec![0u32; n];
        for i in 1..n {
            rev[i] = (rev[i >> 1] >> 1) | (((i & 1) as u32) << (bits - 1));
        }
        let half = n / 2;
        let mut tw_re = vec![0.0f32; half];
        let mut tw_im = vec![0.0f32; half];
        for j in 0..half {
            let a = -2.0 * std::f64::consts::PI * (j as f64) / (n as f64);
            tw_re[j] = a.cos() as f32;
            tw_im[j] = a.sin() as f32;
        }
        Fft { n, rev, tw_re, tw_im }
    }

    pub fn len(&self) -> usize {
        self.n
    }

    pub fn forward(&self, re: &mut [f32], im: &mut [f32]) {
        let n = self.n;
        debug_assert!(re.len() >= n && im.len() >= n);

        for i in 0..n {
            let j = self.rev[i] as usize;
            if j > i {
                re.swap(i, j);
                im.swap(i, j);
            }
        }

        let mut len = 2;
        while len <= n {
            let half = len / 2;
            let stride = n / len;
            let mut base = 0;
            while base < n {
                for j in 0..half {
                    let w_re = self.tw_re[j * stride];
                    let w_im = self.tw_im[j * stride];
                    let a = base + j;
                    let b = a + half;
                    let vr = re[b] * w_re - im[b] * w_im;
                    let vi = re[b] * w_im + im[b] * w_re;
                    re[b] = re[a] - vr;
                    im[b] = im[a] - vi;
                    re[a] += vr;
                    im[a] += vi;
                }
                base += len;
            }
            len <<= 1;
        }
    }

    /// Inverse transform, scaled by 1/n. Uses the conjugate identity.
    pub fn inverse(&self, re: &mut [f32], im: &mut [f32]) {
        let n = self.n;
        for v in im[..n].iter_mut() {
            *v = -*v;
        }
        self.forward(re, im);
        let s = 1.0 / n as f32;
        for i in 0..n {
            re[i] *= s;
            im[i] *= -s;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip() {
        let n = 256;
        let fft = Fft::new(n);
        let mut re: Vec<f32> = (0..n).map(|i| ((i * 37 % 91) as f32) / 91.0 - 0.5).collect();
        let mut im = vec![0.0f32; n];
        let orig = re.clone();
        fft.forward(&mut re, &mut im);
        fft.inverse(&mut re, &mut im);
        for i in 0..n {
            assert!((re[i] - orig[i]).abs() < 1e-4, "bin {i}: {} vs {}", re[i], orig[i]);
            assert!(im[i].abs() < 1e-4);
        }
    }

    #[test]
    fn single_bin_is_a_sinusoid() {
        let n = 64;
        let fft = Fft::new(n);
        let k = 5usize;
        let mut re: Vec<f32> = (0..n)
            .map(|i| (2.0 * std::f32::consts::PI * (k * i) as f32 / n as f32).cos())
            .collect();
        let mut im = vec![0.0f32; n];
        fft.forward(&mut re, &mut im);
        let mag = |i: usize| (re[i] * re[i] + im[i] * im[i]).sqrt();
        assert!((mag(k) - (n as f32) / 2.0).abs() < 1e-2);
        assert!(mag(k + 1) < 1e-2);
    }
}
