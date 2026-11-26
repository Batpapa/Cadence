//! The spectral analysis of cadence-transcriptor (src/spectrum.ts), the same steps in Rust
//! for WebAssembly: Hann-windowed frames every `hop` samples; each frame's energy, its
//! SuperFlux onset value against the frame `flux_lag` frames before, optionally its enhanced
//! autocorrelation read at the periods of MIDI notes 40..100, and optionally its spectral
//! peaks (instantaneous frequency from the phase advance over a hop, magnitude after the
//! harmonic/percussive mask). See spectrum.ts for the reasons of each step.
//!
//! Fed a chunk at a time (Analyzer): the recording is never copied whole into the module,
//! whose memory never shrinks.

use rustfft::num_complex::Complex;
use rustfft::{Fft, FftPlanner};
use std::sync::Arc;
use wasm_bindgen::prelude::*;

const ACF_LOW: usize = 40;
const ACF_N: usize = 61;

/// FFT of a real signal of length n through a complex one of n / 2 (spectrum.ts's RealFFT).
struct RealFft {
    n: usize,
    fft: Arc<dyn Fft<f32>>,
    z: Vec<Complex<f32>>,
    scratch: Vec<Complex<f32>>,
    w: Vec<Complex<f32>>,
}

impl RealFft {
    fn new(n: usize) -> RealFft {
        let mut planner = FftPlanner::new();
        let fft = planner.plan_fft_forward(n / 2);
        let scratch = vec![Complex::new(0.0, 0.0); fft.get_inplace_scratch_len()];
        let w = (0..n / 2)
            .map(|k| {
                let a = 2.0 * std::f64::consts::PI * k as f64 / n as f64;
                Complex::new(a.cos() as f32, -a.sin() as f32)
            })
            .collect();
        RealFft { n, fft, z: vec![Complex::new(0.0, 0.0); n / 2], scratch, w }
    }

    /// x: n samples; out: n / 2 + 1 bins, those above `upto` left as they were.
    fn transform(&mut self, x: &[f32], out_re: &mut [f32], out_im: &mut [f32], upto: usize) {
        let m = self.n / 2;
        for j in 0..m {
            self.z[j] = Complex::new(x[2 * j], x[2 * j + 1]);
        }
        self.fft.process_with_scratch(&mut self.z, &mut self.scratch);
        let z = &self.z;
        out_re[0] = z[0].re + z[0].im;
        out_im[0] = 0.0;
        out_re[m] = z[0].re - z[0].im;
        out_im[m] = 0.0;
        for k in 1..m.min(upto + 1) {
            let (ar, ai) = (z[k].re, z[k].im);
            let (br, bi) = (z[m - k].re, -z[m - k].im);
            let (er, ei) = ((ar + br) / 2.0, (ai + bi) / 2.0);
            let (or, oi) = ((ai - bi) / 2.0, -(ar - br) / 2.0);
            let w = self.w[k];
            out_re[k] = er + w.re * or - w.im * oi;
            out_im[k] = ei + w.re * oi + w.im * or;
        }
    }
}

/// Cube root of x >= 0: a first guess from the float's bits, two Newton steps (relative error
/// under 1e-6) — libm's cbrt costs as much as the FFT in WebAssembly.
#[inline(always)]
fn fast_cbrt(x: f32) -> f32 {
    if x <= 0.0 {
        return 0.0;
    }
    let mut y = f32::from_bits(x.to_bits() / 3 + 0x2a51_4067);
    y = y - (y * y * y - x) / (3.0 * y * y);
    y - (y * y * y - x) / (3.0 * y * y)
}

/// Natural log of x > 0 from its exponent and a polynomial of its mantissa (absolute error
/// about 1e-5): enough for log-magnitude differences.
#[inline(always)]
fn fast_ln(x: f32) -> f32 {
    let bits = x.to_bits();
    let e = ((bits >> 23) & 0xff) as i32 - 127;
    let m = f32::from_bits((bits & 0x007f_ffff) | 0x3f80_0000); // [1, 2)
    let t = m - 1.0;
    let p = t * (0.999_999_1 + t * (-0.499_909_5 + t * (0.331_976_5 + t * (-0.240_043_3 + t * (0.164_429_5 + t * (-0.087_369_9 + t * 0.022_978_3))))));
    p + e as f32 * std::f32::consts::LN_2
}

/// atan2(y, x) from a polynomial of the smaller ratio (absolute error about 1e-5 rad, under
/// 1e-4 Hz on a peak's frequency at hop 1024): libm's costs much in WebAssembly.
#[inline(always)]
fn fast_atan2(y: f32, x: f32) -> f32 {
    use std::f32::consts::{FRAC_PI_2, PI};
    let (ax, ay) = (x.abs(), y.abs());
    if ax == 0.0 && ay == 0.0 {
        return 0.0;
    }
    let z = if ax >= ay { ay / ax } else { ax / ay };
    let s = z * z;
    let mut a = z * (0.999_977_26 + s * (-0.332_623_47 + s * (0.193_543_46 + s * (-0.116_432_87 + s * (0.052_653_32 + s * -0.011_721_20)))));
    if ay > ax {
        a = FRAC_PI_2 - a;
    }
    if x < 0.0 {
        a = PI - a;
    }
    if y < 0.0 { -a } else { a }
}

fn median(v: &mut [f32]) -> f32 {
    // insertion sort of a short slice
    for i in 1..v.len() {
        let x = v[i];
        let mut j = i;
        while j > 0 && v[j - 1] > x {
            v[j] = v[j - 1];
            j -= 1;
        }
        v[j] = x;
    }
    v[v.len() / 2]
}

/// One analysis: per frame, energy and onset value; the autocorrelation (frames x 61) and
/// the peaks (frame t's from start[t] to start[t + 1]) when asked for.
#[wasm_bindgen]
pub struct Spectrum {
    frames: usize,
    start: Vec<u32>,
    freq: Vec<f32>,
    mag: Vec<f32>,
    energy: Vec<f32>,
    flux: Vec<f32>,
    acf: Vec<f32>,
}

#[wasm_bindgen]
impl Spectrum {
    pub fn frames(&self) -> usize { self.frames }
    pub fn start(&self) -> Vec<u32> { self.start.clone() }
    pub fn freq(&self) -> Vec<f32> { self.freq.clone() }
    pub fn mag(&self) -> Vec<f32> { self.mag.clone() }
    pub fn energy(&self) -> Vec<f32> { self.energy.clone() }
    pub fn flux(&self) -> Vec<f32> { self.flux.clone() }
    pub fn acf(&self) -> Vec<f32> { self.acf.clone() }
}

/// The analysis fed a chunk at a time: a frame is analysed as soon as its samples are in, its
/// peaks once the frames its harmonic mask reads are.
#[wasm_bindgen]
pub struct Analyzer {
    n: usize, h: usize, half: usize, floor: f32, kt: usize, kf: usize, hpss_time: usize, hpss_freq: usize,
    ring: usize, kmin: usize, kmax: usize, expected: f32, rate: f32, fmin: f32, fmax: f32,
    acf: bool, acf_every: usize, want_peaks: bool, lag: usize, flux_on: bool, max_peaks: usize, upto: usize, loud: Vec<f32>, cand: Vec<(u32, f32, f32, f32)>,
    fft: RealFft, win: Vec<f32>, lags: Vec<f32>,
    mags: Vec<Vec<f32>>, res: Vec<Vec<f32>>, ims: Vec<Vec<f32>>, logs: Vec<Vec<f32>>,
    x: Vec<f32>, ax: Vec<f32>, are: Vec<f32>, aim: Vec<f32>, tv: Vec<f32>, fv: Vec<f32>,
    buf: Vec<f32>, frames: usize,
    start: Vec<u32>, freq: Vec<f32>, mag: Vec<f32>, energy: Vec<f32>, flux: Vec<f32>, acf_out: Vec<f32>,
}

#[wasm_bindgen]
impl Analyzer {
    #[wasm_bindgen(constructor)]
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        rate: f32, size: usize, hop: usize, floor_db: f32, fmin: f32, fmax: f32,
        hpss_time: usize, hpss_freq: usize, acf: bool, acf_every: usize, want_peaks: bool, flux_lag: usize,
        max_peaks: usize,
    ) -> Analyzer {
        let n = size;
        let half = n / 2;
        let kt = if hpss_time > 0 { hpss_time >> 1 } else { 0 };
        let ring = 2 * kt + 2;
        let lag = flux_lag.max(1);
        let kmax = ((fmax * n as f32 / rate).ceil() as usize).min(half - 2);
        // the last bin read: the peaks' harmonic mask reads hpss_freq / 2 bins above kmax
        let upto = if acf { half } else { (kmax + (hpss_freq >> 1) + 1).min(half) };
        let lags = (0..ACF_N * 3)
            .map(|j| {
                let m = (ACF_LOW + j / 3) as f64 + ((j % 3) as f64 - 1.0) / 3.0;
                (rate as f64 / (440.0 * 2f64.powf((m - 69.0) / 12.0))) as f32
            })
            .collect();
        Analyzer {
            n, h: hop, half, floor: 10f32.powf(-floor_db / 20.0), kt, kf: hpss_freq >> 1, hpss_time, hpss_freq,
            ring,
            kmin: ((fmin * n as f32 / rate).floor() as usize).max(2),
            kmax,
            expected: 2.0 * std::f32::consts::PI * hop as f32 / n as f32,
            rate, fmin, fmax, acf, acf_every: acf_every.max(1), want_peaks, lag, flux_on: flux_lag > 0, max_peaks, upto, loud: Vec::new(), cand: Vec::new(),
            fft: RealFft::new(n),
            win: (0..n).map(|i| (0.5 - 0.5 * (2.0 * std::f64::consts::PI * i as f64 / n as f64).cos()) as f32).collect(),
            lags,
            mags: vec![vec![0f32; half + 1]; ring],
            res: vec![vec![0f32; half + 1]; ring],
            ims: vec![vec![0f32; half + 1]; ring],
            logs: vec![vec![-20f32; half + 1]; lag + 1],
            x: vec![0f32; n], ax: vec![0f32; n], are: vec![0f32; half + 1], aim: vec![0f32; half + 1],
            tv: vec![0f32; hpss_time.max(1)], fv: vec![0f32; hpss_freq.max(1)],
            buf: Vec::with_capacity(4 * n), frames: 0,
            start: Vec::new(), freq: Vec::new(), mag: Vec::new(), energy: Vec::new(), flux: Vec::new(), acf_out: Vec::new(),
        }
    }

    /// More samples.
    pub fn push(&mut self, chunk: &[f32]) {
        self.buf.extend_from_slice(chunk);
        let mut off = 0;
        while self.buf.len() - off >= self.n {
            self.frame(off);
            off += self.h;
        }
        self.buf.drain(..off);
    }

    /// The analysis of everything pushed.
    pub fn finish(mut self) -> Spectrum {
        if self.want_peaks && self.frames > 0 {
            let frames = self.frames;
            for t in frames.saturating_sub(self.kt)..frames {
                self.peaks_of(t, frames - 1);
            }
        }
        while self.start.len() <= self.frames {
            self.start.push(self.freq.len() as u32);
        }
        Spectrum { frames: self.frames, start: self.start, freq: self.freq, mag: self.mag, energy: self.energy, flux: self.flux, acf: self.acf_out }
    }
}

impl Analyzer {
    /// The next frame, from the buffered samples at `off`.
    fn frame(&mut self, off: usize) {
        let (n, half, f) = (self.n, self.half, self.frames);
        for i in 0..n {
            self.x[i] = self.buf[off + i] * self.win[i];
        }
        let slot = f % self.ring;
        // without the autocorrelation, only the bins up to the peaks' and the onset function's
        // last are read: the others are never computed, the energy (the one-sided sum of the
        // squared magnitudes) taken from the samples (Parseval)
        let upto = self.upto;
        self.fft.transform(&self.x, &mut self.res[slot], &mut self.ims[slot], upto);
        let mut e = 0f32;
        for k in 0..=upto {
            let p = self.res[slot][k] * self.res[slot][k] + self.ims[slot][k] * self.ims[slot][k];
            self.mags[slot][k] = p.sqrt();
            e += p;
        }
        if upto < half {
            let mut s2 = 0f32;
            for v in &self.x {
                s2 += v * v;
            }
            let (r0, rh) = (self.res[slot][0], self.res[slot][half]);
            e = (n as f32 * s2 + r0 * r0 + rh * rh) / 2.0;
        }
        self.energy.push(e);
        if self.acf {
            if f % self.acf_every != 0 {
                let prev: Vec<f32> = self.acf_out[(f - 1) * ACF_N..f * ACF_N].to_vec();
                self.acf_out.extend_from_slice(&prev);
            } else {
                for k in 0..=half {
                    let c = fast_cbrt(self.mags[slot][k]);
                    self.ax[k] = c;
                    if k > 0 && k < half {
                        self.ax[n - k] = c;
                    }
                }
                self.fft.transform(&self.ax, &mut self.are, &mut self.aim, half);
                for note in 0..ACF_N {
                    let mut best = 0f32;
                    for j in 0..3 {
                        let l = self.lags[note * 3 + j];
                        let i = l.floor() as usize;
                        let fr = l - i as f32;
                        if i + 1 >= half {
                            continue;
                        }
                        let v = self.are[i] * (1.0 - fr) + self.are[i + 1] * fr;
                        if v > best {
                            best = v;
                        }
                    }
                    self.acf_out.push(best);
                }
            }
        }
        // SuperFlux against the frame `lag` before (flux_lag 0: no onset function, all zeros)
        if self.flux_on {
            let cur = f % (self.lag + 1);
            let prev = (f + 1) % (self.lag + 1);
            for k in (self.kmin - 1)..=(self.kmax + 1) {
                self.logs[cur][k] = fast_ln(1e-6 + self.mags[slot][k]);
            }
            let mut fl = 0f32;
            for k in self.kmin..=self.kmax {
                let pl = &self.logs[prev];
                let before = pl[k - 1].max(pl[k]).max(pl[k + 1]);
                let d = self.logs[cur][k] - before;
                if d > 0.0 {
                    fl += d;
                }
            }
            self.flux.push(if f >= self.lag { fl } else { 0.0 });
        } else {
            self.flux.push(0.0);
        }
        self.frames += 1;
        if self.want_peaks && f >= self.kt {
            self.peaks_of(f - self.kt, f);
        }
    }

    /// The peaks of frame `t`, the frames up to `last` analysed.
    fn peaks_of(&mut self, t: usize, last: usize) {
        let ring = self.ring;
        let (n, h, rate, half) = (self.n, self.h, self.rate, self.half);
        while self.start.len() <= t {
            self.start.push(self.freq.len() as u32);
        }
        let mag = &self.mags[t % ring];
        let (re, im) = (&self.res[t % ring], &self.ims[t % ring]);
        let (pre, pim) = (&self.res[(t + ring - 1) % ring], &self.ims[(t + ring - 1) % ring]);
        let mut max = 0f32;
        for k in self.kmin..=self.kmax {
            if mag[k] > max {
                max = mag[k];
            }
        }
        let thr = max * self.floor;
        // the candidates: local maxima above the floor, their frequency in range
        let mut cand = std::mem::take(&mut self.cand);
        cand.clear();
        for k in self.kmin..=self.kmax {
            let m = mag[k];
            if m < thr || m <= mag[k - 1] || m < mag[k + 1] {
                continue;
            }
            let hz = if t > 0 {
                // the phase advance over a hop: the angle of z times the previous frame's
                // conjugate (one atan2 instead of two; equal modulo 2 pi)
                let (cr, ci) = (re[k] * pre[k] + im[k] * pim[k], im[k] * pre[k] - re[k] * pim[k]);
                let mut d = fast_atan2(ci, cr) - k as f32 * self.expected;
                d -= 2.0 * std::f32::consts::PI * (d / (2.0 * std::f32::consts::PI)).round();
                (k as f32 + d * n as f32 / (2.0 * std::f32::consts::PI * h as f32)) * rate / n as f32
            } else {
                let a = (mag[k - 1] + 1e-12).ln();
                let b = (m + 1e-12).ln();
                let c = (mag[k + 1] + 1e-12).ln();
                let den = a - 2.0 * b + c;
                (k as f32 + 0.5 * (a - c) / if den != 0.0 { den } else { 1.0 }) * rate / n as f32
            };
            if hz < self.fmin || hz > self.fmax {
                continue;
            }
            cand.push((k as u32, m, hz, f32::NEG_INFINITY));
        }
        // each candidate's magnitude after the harmonic mask; only the frame's max_peaks loudest
        // kept (those at least as loud as the max_peaks-th). The mask never raises a magnitude:
        // the masked magnitudes of the max_peaks loudest candidates bound the kept ones' from
        // below, and a candidate quieter than that bound is never masked (same peaks, less work).
        let mp = self.max_peaks;
        let capped = mp > 0 && cand.len() > mp;
        let hpss = self.hpss_time > 0;
        let (kt, kf, hf) = (self.kt, self.kf, self.hpss_freq);
        let mask = |k: usize, m: f32, tv: &mut [f32], fv: &mut [f32]| -> f32 {
            if !hpss {
                return m;
            }
            let mut c = 0;
            for u in t.saturating_sub(kt)..=(t + kt).min(last) {
                tv[c] = self.mags[u % ring][k];
                c += 1;
            }
            let hm = median(&mut tv[..c]);
            for j in 0..hf {
                fv[j] = mag[(k + j).saturating_sub(kf).min(half)];
            }
            let pm = median(&mut fv[..hf]);
            m * (hm * hm) / (hm * hm + pm * pm + 1e-20)
        };
        let mut lower = f32::NEG_INFINITY;
        if capped && hpss {
            self.loud.clear();
            self.loud.extend(cand.iter().map(|c| c.1));
            let (_, &mut mth, _) = self.loud.select_nth_unstable_by(mp - 1, |a, b| b.partial_cmp(a).unwrap());
            let mut least = f32::INFINITY;
            for c in cand.iter_mut() {
                if c.1 >= mth {
                    c.3 = mask(c.0 as usize, c.1, &mut self.tv, &mut self.fv);
                    least = least.min(c.3);
                }
            }
            lower = least;
        }
        let mut computed = 0;
        for c in cand.iter_mut() {
            if c.3 == f32::NEG_INFINITY && c.1 >= lower {
                c.3 = mask(c.0 as usize, c.1, &mut self.tv, &mut self.fv);
            }
            if c.3 != f32::NEG_INFINITY {
                computed += 1;
            }
        }
        let mut keep = f32::NEG_INFINITY;
        if capped && computed > mp {
            self.loud.clear();
            self.loud.extend(cand.iter().filter(|c| c.3 != f32::NEG_INFINITY).map(|c| c.3));
            let (_, &mut w, _) = self.loud.select_nth_unstable_by(mp - 1, |a, b| b.partial_cmp(a).unwrap());
            keep = w;
        }
        for c in cand.iter() {
            if c.3 != f32::NEG_INFINITY && c.3 >= keep {
                self.freq.push(c.2);
                self.mag.push(c.3);
            }
        }
        self.cand = cand;
    }
}

/// The whole recording at once (the benches): an Analyzer fed it in one chunk.
#[wasm_bindgen]
#[allow(clippy::too_many_arguments)]
pub fn analyse(
    pcm: &[f32], rate: f32, size: usize, hop: usize, floor_db: f32, fmin: f32, fmax: f32,
    hpss_time: usize, hpss_freq: usize, acf: bool, acf_every: usize, want_peaks: bool, flux_lag: usize,
    max_peaks: usize,
) -> Spectrum {
    let mut a = Analyzer::new(rate, size, hop, floor_db, fmin, fmax, hpss_time, hpss_freq, acf, acf_every, want_peaks, flux_lag, max_peaks);
    a.push(pcm);
    a.finish()
}
