// Short-time analysis: Hann-windowed frames every `hop` samples, each frame's spectral peaks
// with their instantaneous frequency (phase vocoder: the phase advance of a bin between two
// frames one hop apart gives its frequency far finer than the bin spacing) and magnitude.
//
// Harmonic / percussive separation at the peaks (Fitzgerald 2010's median filtering, as
// FolkFriend's pitch-class engine does it, but on frames of a few ms): a peak keeps the
// share H^2 / (H^2 + P^2) of its magnitude, H the median of its bin over HPSS_TIME frames,
// P the median of its frame over HPSS_FREQ bins. A strum or a drum is a vertical line, a
// note a horizontal one. With a hop of 5 ms, 9 frames are 48 ms: a strum (1-2 frames) goes,
// a semiquaver stays — FolkFriend's 9 frames of 21 ms (190 ms) erased short notes too.

import { RealFFT } from './fft.ts';

export interface Peaks {
  /** Samples a second, samples between frames, frames. */
  rate: number;
  hop: number;
  frames: number;
  /** Peak k of frame t: index start[t] <= k < start[t + 1]. */
  start: Uint32Array;
  /** Hz, linear magnitude (after the harmonic mask when there is one). */
  freq: Float32Array;
  mag: Float32Array;
  /** Each frame's spectral energy, and its rise from the frame before over bins (positive
   *  log-magnitude differences against the max of the bin and its neighbours a frame
   *  before: SuperFlux, Böck & Widmer 2013 — vibrato does not count as a new partial). */
  energy: Float32Array;
  flux: Float32Array;
  /** Optional (acf): frames x notes (MIDI acfLow..acfHigh) of the enhanced autocorrelation
   *  (Tolonen & Karjalainen 2000, as FolkFriend computes it: |X|^(1/3), transformed back,
   *  negative parts cut), read at each note's period: periodicity, which a missing
   *  fundamental does not weaken. */
  acf?: Float32Array;
  acfLow?: number;
  acfNotes?: number;
}

export interface AnalysisOptions {
  /** Window and hop, samples. */
  size?: number;
  hop?: number;
  /** Peaks kept above the frame's loudest by this many dB. */
  floorDb?: number;
  /** Lowest and highest peak frequency, Hz. */
  fmin?: number;
  fmax?: number;
  /** Harmonic mask: median lengths in frames (odd; 0 = none) and bins (odd). */
  hpssTime?: number;
  hpssFreq?: number;
  /** Enhanced autocorrelation per frame, notes MIDI 40..100. */
  acf?: boolean;
  /** The autocorrelation computed every this many frames (held in between). */
  acfEvery?: number;
  /** Peaks wanted (false: only the energy, flux and autocorrelation). */
  peaks?: boolean;
  /** Called now and then with the share of the frames done. */
  progress?: (ratio: number) => void;
  /** The onset function compares a frame with the one this many frames before (SuperFlux's mu):
   *  overlapping windows a hop apart barely differ, a re-attacked note shows little rise.
   *  0: no onset function (all zeros), for a window read only for its peaks. */
  fluxLag?: number;
  /** Only each frame's this many loudest peaks kept (0: all): measured neutral at 60, and the
   *  analysis of 6 minutes then holds half the peaks. */
  maxPeaks?: number;
}

function median(v: Float64Array, n: number): number {
  // insertion sort of a short array
  for (let i = 1; i < n; i++) { const x = v[i]!; let j = i - 1; while (j >= 0 && v[j]! > x) { v[j + 1] = v[j]!; j--; } v[j + 1] = x; }
  return v[n >> 1]!;
}

export function analyse(pcm: Float32Array, rate: number, o: AnalysisOptions = {}): Peaks {
  const N = o.size ?? 2048, H = o.hop ?? 256;
  const floor = Math.pow(10, -(o.floorDb ?? 50) / 20);
  const fmin = o.fmin ?? 60, fmax = o.fmax ?? 8000;
  const ht = o.hpssTime ?? 0, hf = o.hpssFreq ?? 9;
  const kt = ht > 0 ? ht >> 1 : 0, kf = hf >> 1;
  const fft = new RealFFT(N);
  const win = new Float64Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);
  const frames = Math.max(0, Math.floor((pcm.length - N) / H) + 1);
  const wantPeaks = o.peaks ?? true;
  const maxPeaks = o.maxPeaks ?? 0;
  const x = new Float64Array(N);
  const half = N / 2;
  // rings of the last 2 kt + 2 frames: magnitudes, and the spectra themselves (the phase is
  // only needed at the peaks, of the frame read and the one before)
  const R = 2 * kt + 2;
  const mags = Array.from({ length: R }, () => new Float64Array(half + 1));
  const res = Array.from({ length: R }, () => new Float64Array(half + 1));
  const ims = Array.from({ length: R }, () => new Float64Array(half + 1));
  const wantFlux = (o.fluxLag ?? 1) > 0, lag = Math.max(1, o.fluxLag ?? 1);
  const logRing = Array.from({ length: wantFlux ? lag + 1 : 0 }, () => new Float64Array(half + 1).fill(-20));
  const kmin = Math.max(2, Math.floor((fmin * N) / rate)), kmax = Math.min(half - 2, Math.ceil((fmax * N) / rate));
  const start = new Uint32Array(frames + 1);
  const freqs: number[] = [], magsOut: number[] = [];
  const energy = new Float32Array(frames), flux = new Float32Array(frames);
  const expected = (2 * Math.PI * H) / N; // phase advance of bin k per hop: k * expected
  const tv = new Float64Array(ht || 1), fv = new Float64Array(hf);
  const ACF_LOW = 40, ACF_N = 61;
  const acf = o.acf ? new Float32Array(frames * ACF_N) : undefined;
  const ax = o.acf ? new Float64Array(N) : undefined, are = o.acf ? new Float64Array(half + 1) : undefined, aim = o.acf ? new Float64Array(half + 1) : undefined;
  // each note's lags (samples) at -1/3, 0, +1/3 semitone
  const lags = Array.from({ length: ACF_N * 3 }, (_, j) => rate / (440 * Math.pow(2, (ACF_LOW + Math.floor(j / 3) + ((j % 3) - 1) / 3 - 69) / 12)));
  const peaksOf = (t: number) => {
    const mag = mags[t % R]!, re = res[t % R]!, im = ims[t % R]!, pre = res[(t + R - 1) % R]!, pim = ims[(t + R - 1) % R]!;
    start[t] = freqs.length;
    let max = 0;
    for (let k = kmin; k <= kmax; k++) if (mag[k]! > max) max = mag[k]!;
    const thr = max * floor;
    for (let k = kmin; k <= kmax; k++) {
      const m = mag[k]!;
      if (m < thr || m <= mag[k - 1]! || m < mag[k + 1]!) continue;
      let hz: number;
      if (t > 0) {
        let d = Math.atan2(im[k]!, re[k]!) - Math.atan2(pim[k]!, pre[k]!) - k * expected;
        d -= 2 * Math.PI * Math.round(d / (2 * Math.PI));
        hz = ((k + (d * N) / (2 * Math.PI * H)) * rate) / N;
      } else {
        const a = Math.log(mag[k - 1]! + 1e-12), b = Math.log(m + 1e-12), c = Math.log(mag[k + 1]! + 1e-12);
        hz = ((k + (0.5 * (a - c)) / (a - 2 * b + c || 1)) * rate) / N;
      }
      if (hz < fmin || hz > fmax) continue;
      let w = m;
      if (ht > 0) {
        let c = 0;
        for (let u = Math.max(0, t - kt); u <= Math.min(frames - 1, t + kt); u++) tv[c++] = mags[u % R]![k]!;
        const hm = median(tv, c);
        for (let j = 0; j < hf; j++) fv[j] = mag[Math.min(half, Math.max(0, k - kf + j))]!;
        const pm = median(fv, hf);
        w = m * (hm * hm) / (hm * hm + pm * pm + 1e-20);
      }
      freqs.push(hz); magsOut.push(w);
    }
    // only the frame's maxPeaks loudest kept (those at least as loud as the maxPeaks-th)
    const from = start[t]!, count = freqs.length - from;
    if (maxPeaks > 0 && count > maxPeaks) {
      const loud = magsOut.slice(from).sort((x, y) => y - x)[maxPeaks - 1]!;
      let w = from;
      for (let i = from; i < freqs.length; i++) if (magsOut[i]! >= loud) { freqs[w] = freqs[i]!; magsOut[w] = magsOut[i]!; w++; }
      freqs.length = w; magsOut.length = w;
    }
  };
  for (let f = 0; f < frames; f++) {
    if (o.progress && (f & 511) === 0) o.progress(f / frames);
    const off = f * H;
    for (let i = 0; i < N; i++) x[i] = pcm[off + i]! * win[i]!;
    const re = res[f % R]!, im = ims[f % R]!, mag = mags[f % R]!;
    fft.transform(x, re, im);
    let e = 0;
    for (let k = 0; k <= half; k++) {
      const p = re[k]! * re[k]! + im[k]! * im[k]!;
      mag[k] = Math.sqrt(p);
      e += p;
    }
    energy[f] = e;
    const acfEvery = o.acfEvery ?? 1;
    if (acf && f % acfEvery !== 0) acf.copyWithin(f * ACF_N, (f - 1) * ACF_N, f * ACF_N);
    else if (acf && ax && are && aim) {
      for (let k = 0; k <= half; k++) { const c = Math.cbrt(mag[k]!); ax[k] = c; if (k > 0 && k < half) ax[N - k] = c; }
      fft.transform(ax, are, aim);
      for (let n = 0; n < ACF_N; n++) {
        let best = 0;
        for (let j = 0; j < 3; j++) {
          const L = lags[n * 3 + j]!, i = Math.floor(L), fr = L - i;
          if (i + 1 >= half) continue;
          const v = are[i]! * (1 - fr) + are[i + 1]! * fr;
          if (v > best) best = v;
        }
        acf[f * ACF_N + n] = best;
      }
    }
    let fl = 0;
    if (wantFlux) {
      const logMag = logRing[f % (lag + 1)]!, prevLog = logRing[(f + 1) % (lag + 1)]!; // frame f - lag
      for (let k = kmin - 1; k <= kmax + 1; k++) logMag[k] = Math.log(1e-6 + mag[k]!);
      for (let k = kmin; k <= kmax; k++) {
        const p0 = prevLog[k - 1]!, p1 = prevLog[k]!, p2 = prevLog[k + 1]!;
        const before = p0 > p1 ? (p0 > p2 ? p0 : p2) : (p1 > p2 ? p1 : p2);
        const d = logMag[k]! - before;
        if (d > 0) fl += d;
      }
    }
    flux[f] = wantFlux && f >= lag ? fl : 0;
    if (wantPeaks && f - kt >= 0) peaksOf(f - kt);
  }
  if (wantPeaks) for (let t = Math.max(0, frames - kt); t < frames; t++) peaksOf(t);
  start[frames] = freqs.length;
  return { rate, hop: H, frames, start, freq: Float32Array.from(freqs), mag: Float32Array.from(magsOut), energy, flux, ...(acf ? { acf, acfLow: ACF_LOW, acfNotes: ACF_N } : {}) };
}

/** The recording's tuning, in semitones from A440 (-0.5..0.5): the magnitude-weighted
 *  circular mean of every peak's deviation from the equal-tempered grid. */
export function tuningOf(p: Peaks): number {
  let c = 0, s = 0;
  // a mean over hundreds of thousands of peaks: one in four is plenty
  for (let i = 0; i < p.freq.length; i += 4) {
    const midi = 69 + 12 * Math.log2(p.freq[i]! / 440);
    const a = 2 * Math.PI * (midi - Math.round(midi));
    const w = p.mag[i]!;
    c += w * Math.cos(a); s += w * Math.sin(a);
  }
  return Math.atan2(s, c) / (2 * Math.PI);
}
