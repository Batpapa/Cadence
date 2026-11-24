// ── The note decoder of the hidden transcription ────────────────────────────────────────
// GENERATED from cadence-transcriptor (C:/Perso/IrishMusicExperiments/cadence-transcriptor,
// bench/bundle.js): edit the modules there, then bundle again. Research record and every
// measurement: its JOURNAL.md.
//
// A recording's notes, decoded for writing them down (FolkFriend's decoder stays the
// recogniser's): onsets from a short window every 5 ms, pitch from a long window read over
// whole notes (harmonic summation folded into pitch classes — instruments in different
// registers add up — plus the enhanced autocorrelation), a segmental dynamic programming
// choosing among dense candidate onsets which are note boundaries and what each note is.
// transcription.ts then takes them as it took FolkFriend's (asClassNotes).

// ── fft.ts ──────────────────────────────────────────────────────────────────────────────

// In-place iterative radix-2 FFT on separate real / imaginary arrays, with the twiddles and
// the bit reversal computed once per size; and the FFT of a REAL signal through a complex one
// of half its length (the even samples as real parts, the odd ones as imaginary parts, then
// one butterfly pass to separate them): half the work.

class FFT {
  readonly n: number;
  private readonly cos: Float64Array;
  private readonly sin: Float64Array;
  private readonly rev: Uint32Array;

  constructor(n: number) {
    if (n & (n - 1)) throw new Error('FFT size must be a power of two');
    this.n = n;
    this.cos = new Float64Array(n / 2);
    this.sin = new Float64Array(n / 2);
    for (let k = 0; k < n / 2; k++) {
      this.cos[k] = Math.cos((2 * Math.PI * k) / n);
      this.sin[k] = -Math.sin((2 * Math.PI * k) / n);
    }
    this.rev = new Uint32Array(n);
    const bits = Math.log2(n);
    for (let i = 0; i < n; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
      this.rev[i] = r;
    }
  }

  /** Forward transform of (re, im), in place. */
  transform(re: Float64Array, im: Float64Array): void {
    const n = this.n, rev = this.rev, cs = this.cos, sn = this.sin;
    for (let i = 0; i < n; i++) {
      const j = rev[i]!;
      if (j > i) {
        let t = re[i]!; re[i] = re[j]!; re[j] = t;
        t = im[i]!; im[i] = im[j]!; im[j] = t;
      }
    }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1, step = n / size;
      for (let start = 0; start < n; start += size) {
        for (let k = 0, t = 0; k < half; k++, t += step) {
          const a = start + k, b = a + half;
          const wr = cs[t]!, wi = sn[t]!;
          const br = re[b]!, bi = im[b]!;
          const xr = br * wr - bi * wi, xi = br * wi + bi * wr;
          const ar = re[a]!, ai = im[a]!;
          re[b] = ar - xr; im[b] = ai - xi;
          re[a] = ar + xr; im[a] = ai + xi;
        }
      }
    }
  }
}

/** FFT of a real signal of length n: bins 0..n/2 into (outRe, outIm). */
class RealFFT {
  readonly n: number;
  private readonly half: FFT;
  private readonly zr: Float64Array;
  private readonly zi: Float64Array;
  private readonly wr: Float64Array;
  private readonly wi: Float64Array;

  constructor(n: number) {
    this.n = n;
    this.half = new FFT(n / 2);
    this.zr = new Float64Array(n / 2);
    this.zi = new Float64Array(n / 2);
    this.wr = new Float64Array(n / 2);
    this.wi = new Float64Array(n / 2);
    for (let k = 0; k < n / 2; k++) { this.wr[k] = Math.cos((2 * Math.PI * k) / n); this.wi[k] = -Math.sin((2 * Math.PI * k) / n); }
  }

  /** x: n real samples; outRe / outIm: n / 2 + 1 bins. */
  transform(x: Float64Array, outRe: Float64Array, outIm: Float64Array): void {
    const m = this.n / 2, zr = this.zr, zi = this.zi;
    for (let j = 0; j < m; j++) { zr[j] = x[2 * j]!; zi[j] = x[2 * j + 1]!; }
    this.half.transform(zr, zi);
    // X[k] = E[k] + W^k O[k], E = (Z[k] + conj Z[m-k]) / 2, O = (Z[k] - conj Z[m-k]) / 2i
    outRe[0] = zr[0]! + zi[0]!; outIm[0] = 0;
    outRe[m] = zr[0]! - zi[0]!; outIm[m] = 0;
    for (let k = 1; k < m; k++) {
      const ar = zr[k]!, ai = zi[k]!, br = zr[m - k]!, bi = -zi[m - k]!;
      const er = (ar + br) / 2, ei = (ai + bi) / 2;
      // (Z[k] - conj Z[m-k]) / 2i = ((ai - bi) - i (ar - br)) / 2
      const or = (ai - bi) / 2, oi = -(ar - br) / 2;
      const wr = this.wr[k]!, wi = this.wi[k]!;
      outRe[k] = er + wr * or - wi * oi;
      outIm[k] = ei + wr * oi + wi * or;
    }
  }
}

// ── spectrum.ts ─────────────────────────────────────────────────────────────────────────

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

function analyse(pcm: Float32Array, rate: number, o: AnalysisOptions = {}): Peaks {
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
function tuningOf(p: Peaks): number {
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

// ── salience.ts ─────────────────────────────────────────────────────────────────────────

// Pitch salience by harmonic summation (Klapuri 2006; Salamon & Gómez 2012): each spectral
// peak votes for the fundamentals it could be a harmonic of, h = 1..HARMONICS, the vote
// weighted ALPHA^(h-1) and spread over the semitones within KERNEL of f/h. Then folded into
// the 12 pitch classes: instruments playing the tune in different registers add up instead
// of competing (the user, 2026-11-24), each frame keeping its octave profile.
//
// Also kept, for the octave: the votes of the ODD harmonics only. A note an octave below the
// played one collects every harmonic of it (its even ones), so full sums leave octave
// profiles flat; it has nothing at its own odd multiples (f/2, 3f/2...), the played note has.


interface SalienceOptions {
  /** MIDI range of the fundamentals. */
  low?: number;
  high?: number;
  harmonics?: number;
  alpha?: number;
  /** Magnitude compression of each peak's vote (1 linear, 0.5 square root). */
  beta?: number;
  /** Half-width of the vote, semitones. */
  kernel?: number;
  /** Peaks under the recording's loud peaks (their 99th percentile) by this many dB are left
   *  out: in a silence, a frame's own loudest peak is noise, and so are its hundreds of peaks. */
  floorDb?: number;
  /** Only each frame's this many loudest peaks vote (0: all). */
  maxPeaks?: number;
}

interface Salience {
  frames: number;
  low: number;
  /** frames x notes (MIDI low..high): all harmonics' votes, odd harmonics' votes. */
  notes: number;
  note: Float32Array;
  odd: Float32Array;
}

function salience(p: Peaks, tuning: number, o: SalienceOptions = {}): Salience {
  const low = o.low ?? 40, high = o.high ?? 100;
  const H = o.harmonics ?? 10, alpha = o.alpha ?? 0.9, beta = o.beta ?? 0.5, K = o.kernel ?? 1;
  const S = high - low + 1;
  const note = new Float32Array(p.frames * S), odd = new Float32Array(p.frames * S);
  const weight = new Float64Array(H + 1);
  for (let h = 1; h <= H; h++) weight[h] = Math.pow(alpha, h - 1);
  // the kernel cos^2(pi/2 d), d in [0, 1], tabulated
  const KT = 1024, kern = new Float64Array(KT + 2);
  for (let i = 0; i <= KT + 1; i++) { const c = Math.cos((Math.PI / 2) * Math.min(1, i / KT)); kern[i] = c * c; }
  const lgH = new Float64Array(H + 1);
  for (let h = 1; h <= H; h++) lgH[h] = 12 * Math.log2(h);
  // the recording's level: the 99th percentile of its peak magnitudes (a sample of them)
  let minMag = 0;
  const fdb = o.floorDb ?? 0;
  if (fdb > 0 && p.mag.length) {
    const step = Math.max(1, Math.floor(p.mag.length / 20000));
    const sample: number[] = [];
    for (let i = 0; i < p.mag.length; i += step) sample.push(p.mag[i]!);
    sample.sort((x, y) => x - y);
    minMag = sample[Math.floor(0.99 * (sample.length - 1))]! * Math.pow(10, -fdb / 20);
  }
  const K2 = o.maxPeaks ?? 0;
  const order: number[] = [];
  for (let t = 0; t < p.frames; t++) {
    const row = t * S;
    let floorT = minMag;
    if (K2 > 0 && p.start[t + 1]! - p.start[t]! > K2) {
      // the K2-th loudest peak of the frame sets its floor
      order.length = 0;
      for (let i = p.start[t]!; i < p.start[t + 1]!; i++) order.push(p.mag[i]!);
      order.sort((x, y) => y - x);
      floorT = Math.max(floorT, order[K2 - 1]!);
    }
    for (let i = p.start[t]!; i < p.start[t + 1]!; i++) {
      if (p.mag[i]! < floorT) continue;
      const a = beta === 1 ? p.mag[i]! : beta === 0.5 ? Math.sqrt(p.mag[i]!) : Math.pow(p.mag[i]!, beta);
      const m0 = 69 + 12 * Math.log2(p.freq[i]! / 440) - tuning;
      for (let h = 1; h <= H; h++) {
        const m = m0 - lgH[h]!;
        if (m < low - K) break;
        const lo = Math.max(low, Math.ceil(m - K)), hi = Math.min(high, Math.floor(m + K));
        for (let n = lo; n <= hi; n++) {
          const v = a * weight[h]! * kern[Math.round((Math.abs(m - n) / K) * KT)]!;
          note[row + n - low] += v;
          if (h & 1) odd[row + n - low] += v;
        }
      }
    }
  }
  return { frames: p.frames, low, notes: S, note, odd };
}

/** Each note minus its median over `span` frames around (taken every `stride` frames): what
 *  holds for seconds — a drone, a held chord, the room — is not the melody. In place. */
function removeSustained(x: Float32Array, frames: number, notes: number, span: number, fraction = 1, stride = 100, sub = 8): void {
  if (span <= 0) return;
  const blocks = Math.ceil(frames / stride);
  const med = new Float32Array(blocks * notes);
  const col = new Float32Array(Math.ceil((span + 2) / sub) + 1);
  for (let b = 0; b < blocks; b++) {
    const t = b * stride, lo = Math.max(0, t - (span >> 1)), hi = Math.min(frames, t + (span >> 1) + 1);
    // the median from a subsample of the stretch: every 4th frame
    for (let n = 0; n < notes; n++) {
      let c = 0;
      for (let u = lo; u < hi; u += sub) col[c++] = x[u * notes + n]!;
      med[b * notes + n] = c ? select(col, c, c >> 1) : 0;
    }
  }
  for (let t = 0; t < frames; t++) {
    const b = Math.min(blocks - 1, Math.round(t / stride));
    for (let n = 0; n < notes; n++) { const v = x[t * notes + n]! - fraction * med[b * notes + n]!; x[t * notes + n] = v > 0 ? v : 0; }
  }
}

/** The k-th smallest of v[0..n) (Hoare's selection, v reordered): the median without a sort. */
function select(v: Float32Array, n: number, k: number): number {
  let lo = 0, hi = n - 1;
  while (lo < hi) {
    const pivot = v[(lo + hi) >> 1]!;
    let i = lo, j = hi;
    while (i <= j) {
      while (v[i]! < pivot) i++;
      while (v[j]! > pivot) j--;
      if (i <= j) { const t = v[i]!; v[i] = v[j]!; v[j] = t; i++; j--; }
    }
    if (k <= j) hi = j; else if (k >= i) lo = i; else return v[k]!;
  }
  return v[k]!;
}

/** frames x 12 class salience: the notes summed over octaves. */
function classes(x: Float32Array, frames: number, low: number, notes: number): Float32Array {
  const cls = new Float32Array(frames * 12);
  for (let t = 0; t < frames; t++) for (let n = 0; n < notes; n++) cls[t * 12 + ((low + n) % 12)] += x[t * notes + n]!;
  return cls;
}

// ── onsets.ts ───────────────────────────────────────────────────────────────────────────

// Onset detection functions and peak picking.
//   - broadband: SuperFlux (Böck & Widmer 2013), computed in spectrum.ts on a short window:
//     the attack of a bow, a tongue, a finger, a re-attacked note;
//   - pitch change: how much of the pitch-class distribution is new against LAG frames
//     before (half the L1 distance of the normalised class saliences): a legato change of
//     note, with no attack noise at all.

/** Pitch-change novelty from frames x 12 class saliences. */
function pitchChange(cls: Float32Array, frames: number, lag = 4): Float32Array {
  const out = new Float32Array(frames);
  const norm = (t: number, k: number, s: number) => (s > 0 ? cls[t * 12 + k]! / s : 0);
  const sums = new Float64Array(frames);
  for (let t = 0; t < frames; t++) { let s = 0; for (let k = 0; k < 12; k++) s += cls[t * 12 + k]!; sums[t] = s; }
  for (let t = lag; t < frames; t++) {
    let d = 0;
    for (let k = 0; k < 12; k++) {
      const x = norm(t, k, sums[t]!) - norm(t - lag, k, sums[t - lag]!);
      if (x > 0) d += x;
    }
    out[t - (lag >> 1)] = d;
  }
  return out;
}

/** Each value over the median of the values within `span` frames (a level that adapts). */
function overLocalMedian(x: Float32Array, span: number): Float32Array {
  const n = x.length, out = new Float32Array(n), win: number[] = [];
  const step = Math.max(1, span >> 3);
  let med = 0;
  for (let t = 0; t < n; t++) {
    if (t % step === 0) {
      win.length = 0;
      for (let u = Math.max(0, t - span); u < Math.min(n, t + span); u++) win.push(x[u]!);
      win.sort((a, b) => a - b);
      med = win[win.length >> 1] ?? 0;
    }
    out[t] = Math.max(0, x[t]! - med);
  }
  return out;
}

/** Local maxima within `radius` frames over `threshold` x the function's mean. */
function peaks(x: Float32Array, radius: number, threshold: number): number[] {
  let mean = 0;
  for (const v of x) mean += v;
  mean /= x.length || 1;
  const thr = threshold * mean, out: number[] = [];
  for (let t = 0; t < x.length; t++) {
    const v = x[t]!;
    if (v <= thr) continue;
    let top = true;
    for (let u = Math.max(0, t - radius); u <= Math.min(x.length - 1, t + radius) && top; u++) if (x[u]! > v || (x[u] === v && u < t)) top = false;
    if (top) out.push(t);
  }
  return out;
}

// ── decoder.ts ──────────────────────────────────────────────────────────────────────────

// Segmental note decoder. Candidate onsets (peaks of the onset functions, dense: nearly
// every true onset is among them, with several false ones each) cut the recording; dynamic
// programming chooses which cuts are note boundaries and what each segment is — one of the
// 12 pitch classes or a rest — scoring:
//   - each segment by the salience of its class summed over the WHOLE segment (the pitch
//     read over the note itself, not frame by frame: the note is the long window);
//   - each boundary by its onset strength against a cost (a cut must be earned), a change of
//     class by the interval model (FolkFriend's: steps likelier than leaps), a repeated
//     class only by a real attack (broadband flux);
// a semi-Markov model whose boundaries are restricted to the candidates.


interface DecoderOptions {
  /** Candidate onsets: peak radius (frames), threshold (x mean), pitch-change weight. */
  radius?: number;
  threshold?: number;
  pitchWeight?: number;
  /** Boundary: cost, reward per unit of log(1 + onset strength). */
  cutCost?: number;
  onsetGain?: number;
  /** A repeated class: extra cost, reward per unit of log(1 + broadband flux). */
  repeatCost?: number;
  repeatGain?: number;
  /** A repeated class: reward per unit of the energy dip at the boundary (-log of the least
   *  energy around it over the energy on both sides): a re-attack breathes, a held note not. */
  dipGain?: number;
  /** Interval model weight. */
  intervalWeight?: number;
  /** Floor added to each class share (log of share + floor). */
  floor?: number;
  /** Voicing: frames whose salience is under `restLevel` x the recording's median lean rest. */
  restLevel?: number;
  restSlope?: number;
  /** The recording's level: this percentile of the frames' salience (0.5 = median). */
  levelPct?: number;
  /** Voicing read on the long window's salience or the short window's energy (which sees a
   *  gap of 20 ms between two notes). */
  voicingFrom?: 'salience' | 'energy';
  /** Shortest note (frames) and longest segment searched (frames). */
  minFrames?: number;
  maxFrames?: number;
  /** Shortest silence between notes (frames). */
  minRestFrames?: number;
  /** Sustained sound removed: each note minus its median over this many frames (0: kept). */
  sustainSpan?: number;
  sustainFraction?: number;
  /** Octave profile from all harmonics' votes ('full') or the odd ones ('odd'). */
  octaveFrom?: 'full' | 'odd';
  /** The octave profile raised to this power (sharper for the octave Viterbi downstream). */
  octavePower?: number;
  /** Each octave up divides the profile by this: every partial of a note an octave up is a
   *  partial of the note itself, so the higher one always collects evidence. 1.15 before
   *  transcription.ts kept the line in its register; with that pass, 1.07: dotted dances
   *  66.4 -> 67.3 %, sessions exact 77.2 -> 77.3, tuneset unchanged (1: tuneset -0.2;
   *  0.9: sessions -0.7). */
  octaveDown?: number;
  /** Salience settings (both windows). */
  harmonics?: number;
  alpha?: number;
  beta?: number;
  kernel?: number;
  /** Share of the autocorrelation's class evidence in the frame scores (needs acf). */
  acfWeight?: number;
  /** Peaks this many dB under the recording's loud ones left out of the salience (0: none). */
  peakFloorDb?: number;
  /** Only each frame's this many loudest peaks vote (0: all). */
  maxPeaks?: number;
  /** Frame score of a class: log of its share ('log') or the share itself times 
   *  ('linear', as FolkFriend's lattice adds energies: a frame where the tune dips costs little). */
  emission?: 'log' | 'linear';
  linearGain?: number;
}

export interface Note {
  cls: number;
  /** Seconds. */
  onset: number;
  offset: number;
  /** Mean share of the class over the note. */
  power: number;
  /** The class's salience at each octave from MIDI 48 (4 octaves) over the note. */
  octaves: number[];
}

/** Interval scores between classes, FolkFriend's pitch model (log-probabilities of jumps of
 *  -12..12 semitones; a class step d is the likelier of +d and d - 12). */
const PITCH_MODEL = [-2.6399, -4.3941, -2.9723, -2.1666, -2.3065, -1.1626, -3.7312, -0.6308, -0.6756, -0.3947, -0.2396, -1.3759, 0,
  -1.3005, -0.0, -0.3356, -0.5968, -0.3042, -3.0499, -1.2219, -2.4878, -2.7728, -3.5722, -5.1491, -3.414];
function classStep(from: number, to: number): number {
  const up = (((to - from) % 12) + 12) % 12;
  return Math.max(PITCH_MODEL[12 + up]!, PITCH_MODEL[12 + up - 12]!);
}

/** The settings measured best (cadence-transcriptor/JOURNAL.md, « R6 »): sessions, tuneset,
 *  classical flute and the user's solo recording judged together. */
const DEFAULTS: DecoderOptions = {
  radius: 3, threshold: 0.5, pitchWeight: 0.25, cutCost: 2, onsetGain: 0.9, repeatCost: 8, repeatGain: 0.5,
  intervalWeight: 0, floor: 0.01, restLevel: 0.1, restSlope: 2, levelPct: 0.95, voicingFrom: 'energy',
  minFrames: 10, minRestFrames: 4, maxFrames: 600, sustainSpan: 1875, sustainFraction: 0.5, octaveFrom: 'odd', octavePower: 7,
  octaveDown: 1.07, acfWeight: 0.3, peakFloorDb: 50,
};

/** Short window: for time (onsets, where notes change). Long window: for pitch. */
const SHORT = 2048, LONG = 4096, HOP = 256;

interface Analysis {
  short: Peaks; long: Peaks; tuning: number; rate: number; shortSize?: number; longSize?: number;
  /** The onset function of a window of gridSize samples, for the grid and the bars (when asked). */
  grid?: Float32Array; gridSize?: number;
}

/** Harmonic mask median lengths (frames at HOP, bins): see spectrum.ts. */
interface AnalyseOptions { hpssTime?: number; hpssFreq?: number; acf?: boolean; longHop?: number; acfEvery?: number; fluxLag?: number; maxPeaks?: number; shortSize?: number; longSize?: number; gridSize?: number; progress?: (ratio: number) => void }
const ANALYSIS_DEFAULTS: AnalyseOptions = { hpssTime: 9, hpssFreq: 9, acf: true, longHop: 1024, acfEvery: 1, fluxLag: 4, maxPeaks: 60, shortSize: 1024, longSize: 8192, gridSize: 2048 };

/** The spectral analysis that runs: spectrum.ts's, or the same steps compiled to WebAssembly
 *  (rust/: twice as fast, its results within float rounding — bench/rust-check.js) once a
 *  caller hands it over. */
let analyseImpl: (pcm: Float32Array, rate: number, o: AnalysisOptions) => Peaks = analyse;
export function useAnalysis(impl: (pcm: Float32Array, rate: number, o: AnalysisOptions) => Peaks): void {
  analyseImpl = impl;
}

function analyseAudio(pcm: Float32Array, rate = 48000, options: AnalyseOptions = {}): Analysis {
  const o = { ...ANALYSIS_DEFAULTS, ...options };
  const analyse = analyseImpl;
  // the short window gives time: the onset function (and the autocorrelation); no peaks
  // progress: the short window about 30 % of the work, the grid's 20 %, the long one the rest
  const ss = o.shortSize ?? SHORT, ls = o.longSize ?? LONG;
  const short = analyse(pcm, rate, { size: ss, hop: HOP, acf: o.acf, acfEvery: o.acfEvery, fluxLag: o.fluxLag, peaks: false, progress: o.progress && (r => o.progress!(0.3 * r)) });
  // the bars read accents better on a longer window (measured: 1024 lost 7 points of bars)
  const gs = o.gridSize ?? 0;
  const grid = gs && gs !== ss ? analyse(pcm, rate, { size: gs, hop: HOP, fluxLag: o.fluxLag, peaks: false, progress: o.progress && (r => o.progress!(0.3 + 0.2 * r)) }).flux : undefined;
  // the long window is read for pitch, over whole notes: a coarser hop is enough
  const lh = o.longHop ?? HOP;
  // (no onset function: never read)
  const long = analyse(pcm, rate, { size: ls, hop: lh, fluxLag: 0, hpssTime: o.hpssTime ? Math.max(3, Math.round((o.hpssTime * HOP) / lh) | 1) : 0, hpssFreq: o.hpssFreq, maxPeaks: o.maxPeaks, progress: o.progress && (r => o.progress!(0.5 + 0.5 * r)) });
  return { short, long, tuning: tuningOf(long), rate, shortSize: ss, longSize: ls, ...(grid ? { grid, gridSize: gs } : {}) };
}

interface Prepared { sal: Salience; cls: Float32Array; clsAcf: Float32Array | null }
const prepared = new WeakMap<Analysis, Map<string, Prepared>>();

/** The long window's saliences and class saliences for these settings (kept per analysis). */
function prepare(a: Analysis, o: DecoderOptions): Prepared {
  const key = JSON.stringify([a.long.hop, o.maxPeaks ?? 0, o.peakFloorDb ?? 0, o.sustainSpan ?? 0, o.sustainFraction ?? 1, o.harmonics, o.alpha, o.beta, o.kernel]);
  let m = prepared.get(a);
  if (!m) { m = new Map(); prepared.set(a, m); }
  const hit = m.get(key);
  if (hit) return hit;
  const sal = salience(a.long, a.tuning, { harmonics: o.harmonics, alpha: o.alpha, beta: o.beta, kernel: o.kernel, floorDb: o.peakFloorDb, maxPeaks: o.maxPeaks });
  const span = o.sustainSpan ?? 0;
  if (span > 0) {
    const ls = Math.round((span * HOP) / a.long.hop);
    removeSustained(sal.note, sal.frames, sal.notes, ls, o.sustainFraction ?? 1, Math.max(1, Math.round((100 * HOP) / a.long.hop)));
    removeSustained(sal.odd, sal.frames, sal.notes, ls, o.sustainFraction ?? 1, Math.max(1, Math.round((100 * HOP) / a.long.hop)));
  }
  let clsAcf: Float32Array | null = null;
  if (a.short.acf) {
    const x = Float32Array.from(a.short.acf);
    if (span > 0) removeSustained(x, a.short.frames, a.short.acfNotes!, span, o.sustainFraction ?? 1);
    clsAcf = classes(x, a.short.frames, a.short.acfLow!, a.short.acfNotes!);
  }
  const p = { sal, cls: classes(sal.note, sal.frames, sal.low, sal.notes), clsAcf };
  m.set(key, p);
  return p;
}

function decode(a: Analysis, options: DecoderOptions = {}): Note[] {
  const o = { ...DEFAULTS, ...options };
  const { short } = a;
  const { sal, cls, clsAcf } = prepare(a, o);
  const aw = clsAcf ? (o.acfWeight ?? 0) : 0;
  const hopS = HOP / a.rate;
  // the long-window frame centred nearest each short-window frame
  const lh = a.long.hop;
  const ss = a.shortSize ?? SHORT, ls = a.longSize ?? LONG;
  const longOf = (t: number) => Math.round((t * HOP + ss / 2 - ls / 2) / lh);
  const radius = o.radius!, threshold = o.threshold!, pw = o.pitchWeight!;
  const cutCost = o.cutCost!, onsetGain = o.onsetGain!;
  const repeatCost = o.repeatCost!, repeatGain = o.repeatGain!;
  const iw = o.intervalWeight!, floor = o.floor!;
  const restLevel = o.restLevel!, restSlope = o.restSlope!;
  const minF = o.minFrames ?? 4, maxF = o.maxFrames ?? 600, minRest = Math.min(minF, o.minRestFrames ?? minF);
  let n = short.frames;
  while (n > 0 && longOf(n - 1) >= sal.frames) n--;
  if (n < 8) return [];
  const jOf = new Int32Array(n);
  for (let t = 0; t < n; t++) jOf[t] = longOf(t);
  const clsAt = (t: number, k: number) => (jOf[t]! >= 0 ? cls[jOf[t]! * 12 + k]! : 0);
  // onset functions, mean-normalised
  const norm = (x: Float32Array) => { let m = 0; for (const v of x) m += v; m /= x.length || 1; return x.map(v => v / (m || 1)); };
  const flux = norm(overLocalMedian(short.flux, 40));
  const pc = norm(overLocalMedian(pitchChange(cls, sal.frames, Math.max(1, Math.round((4 * HOP) / lh))), Math.round((40 * HOP) / lh)));
  const odf = new Float32Array(n);
  for (let t = 0; t < n; t++) odf[t] = flux[t]! + pw * (pc[jOf[t]!] ?? 0);
  const cand = peaks(odf, radius, threshold).filter(t => t > 0 && t < n);
  // the energy dip at each frame: least energy within 6 frames against the lower of the most
  // energy 8 to 20 frames before and after
  const en = short.energy, dipGain = o.dipGain ?? 0;
  const dipAt = (t: number): number => {
    if (!(dipGain > 0)) return 0;
    let lo = Infinity, before = 0, after = 0;
    for (let u = Math.max(0, t - 6); u <= Math.min(n - 1, t + 6); u++) lo = Math.min(lo, en[u]!);
    for (let u = Math.max(0, t - 20); u <= t - 8; u++) before = Math.max(before, en[u]!);
    for (let u = t + 8; u <= Math.min(n - 1, t + 20); u++) after = Math.max(after, en[u]!);
    const ref = Math.min(before, after);
    return ref > 0 && lo < ref ? Math.min(5, Math.log(ref / (lo + 1e-12))) : 0;
  };
  const B = [0, ...cand, n]; // boundaries (frames)
  // per-frame emission of each state (12 classes, 12 = rest), prefix-summed
  const tot = new Float64Array(n);
  for (let t = 0; t < n; t++) { let s = 0; for (let k = 0; k < 12; k++) s += clsAt(t, k); tot[t] = s; }
  const byEnergy = o.voicingFrom === 'energy';
  const vx = byEnergy ? Float64Array.from({ length: n }, (_, t) => Math.sqrt(short.energy[t]!)) : tot;
  const sorted = Float64Array.from(vx).sort();
  const level = sorted[Math.min(sorted.length - 1, Math.floor((o.levelPct ?? 0.5) * sorted.length))]! || 1;
  const E = new Float64Array((n + 1) * 13);
  const norm12 = Math.log(1 + 12 * floor);
  const linear = o.emission === 'linear', lg = o.linearGain ?? 20;
  for (let t = 0; t < n; t++) {
    const v = 1 / (1 + Math.pow((restLevel * level) / (vx[t]! + 1e-12), restSlope)); // P(voiced)
    const lv = Math.log(v + 1e-9);
    let ta = 0;
    if (aw > 0) for (let k = 0; k < 12; k++) ta += clsAcf![t * 12 + k]!;
    for (let k = 0; k < 12; k++) {
      let share = tot[t]! > 0 ? clsAt(t, k) / tot[t]! : 1 / 12;
      if (aw > 0) share = (1 - aw) * share + aw * (ta > 0 ? clsAcf![t * 12 + k]! / ta : 1 / 12);
      E[(t + 1) * 13 + k] = E[t * 13 + k]! + (linear ? lg * v * share : lv + Math.log(share + floor) - norm12);
    }
    E[(t + 1) * 13 + 12] = E[t * 13 + 12]! + (linear ? lg * (1 - v) / 12 : Math.log(1 - v + 1e-9) + Math.log(1 / 12));
  }
  const seg = (i: number, j: number, k: number) => E[B[j]! * 13 + k]! - E[B[i]! * 13 + k]!;
  // dynamic programming over boundaries
  const nb = B.length, S = 13;
  const D = new Float64Array(nb * S).fill(-Infinity), back = new Int32Array(nb * S).fill(-1), backK = new Int8Array(nb * S);
  const M = new Float64Array(nb * S).fill(-Infinity), Mk = new Int8Array(nb * S);
  for (let k = 0; k < S; k++) D[k] = 0; // boundary 0: any state may start
  const steps = new Float64Array(S * S);
  for (let q = 0; q < 12; q++) for (let k = 0; k < 12; k++) steps[q * S + k] = q === k ? 0 : iw * classStep(q, k);
  for (let j = 1; j < nb; j++) {
    // M[i][k]: best way to start a segment of state k at boundary i = j - 1
    const i = j - 1;
    if (i === 0) { for (let k = 0; k < S; k++) { M[k] = 0; Mk[k] = -1; } }
    else {
      const t = B[i]!;
      const cut = -cutCost + onsetGain * Math.log(1 + odf[t]!), rep = -repeatCost + repeatGain * Math.log(1 + flux[t]!) + dipGain * dipAt(t);
      for (let k = 0; k < S; k++) {
        let best = -Infinity, arg = 0;
        for (let q = 0; q < S; q++) {
          const d = D[i * S + q]!;
          if (d === -Infinity) continue;
          let v = d + cut;
          if (q === k) { if (k === 12) continue; v += rep; }
          else v += steps[q * S + k]!;
          if (v > best) { best = v; arg = q; }
        }
        M[i * S + k] = best; Mk[i * S + k] = arg;
      }
    }
    // D[j][k]: best segmentation up to boundary j, its last segment of state k
    for (let i2 = j - 1; i2 >= 0; i2--) {
      const len = B[j]! - B[i2]!;
      if (len > maxF) break;
      const inner = j < nb - 1 && i2 > 0;
      if (len < minRest && inner) continue;
      for (let k = 0; k < S; k++) {
        // a note shorter than minFrames is not one; a silence that short is an articulation
        if (k < 12 && len < minF && inner) continue;
        const m = M[i2 * S + k]!;
        if (m === -Infinity) continue;
        const v = m + seg(i2, j, k);
        if (v > D[j * S + k]!) { D[j * S + k] = v; back[j * S + k] = i2; backK[j * S + k] = Mk[i2 * S + k]!; }
      }
    }
  }
  // trace back
  let k = 0;
  for (let q = 1; q < S; q++) if (D[(nb - 1) * S + q]! > D[(nb - 1) * S + k]!) k = q;
  const segs: { i: number; j: number; k: number }[] = [];
  let j = nb - 1;
  while (j > 0) {
    const i = back[j * S + k]!;
    if (i < 0) break;
    segs.push({ i, j, k });
    const pk = backK[j * S + k]!;
    j = i; k = pk < 0 ? 0 : pk;
  }
  segs.reverse();
  // notes, with their octave profile from the long-window saliences
  const out: Note[] = [];
  const low = sal.low, NS = sal.notes, oct = o.octaveFrom === 'odd' ? sal.odd : sal.note;
  const centre = ss / 2 / a.rate;
  for (const s of segs) {
    if (s.k === 12) continue;
    const t0 = B[s.i]!, t1 = B[s.j]!;
    let share = 0;
    const prof = [0, 0, 0, 0];
    for (let t = t0; t < t1; t++) {
      share += tot[t]! > 0 ? clsAt(t, s.k) / tot[t]! : 0;
      const jj = jOf[t]!;
      if (jj < 0) continue;
      for (let o2 = 0; o2 < 4; o2++) {
        const m = 48 + s.k + 12 * o2;
        if (m >= low && m < low + NS) prof[o2] += oct[jj * NS + (m - low)]!;
      }
    }
    const op = o.octavePower ?? 1, od = o.octaveDown ?? 1;
    out.push({ cls: s.k, onset: t0 * hopS + centre, offset: t1 * hopS + centre, power: share / (t1 - t0), octaves: prof.map((x, i) => Math.pow(x / Math.pow(od, i), op)) });
  }
  return out;
}

/** A recording heard: its notes, every setting at its measured best, and its onset function for
 *  the grid (SuperFlux on a window of gridSize samples, a value every HOP samples, each frame
 *  centred `onsetCentre` samples after its start). */
export interface Heard { notes: Note[]; onsets: Float32Array; onsetCentre: number }

export function hear(pcm: Float32Array, rate: number, progress?: (ratio: number) => void): Heard {
  const a = analyseAudio(pcm, rate, { progress });
  return a.grid ? { notes: decode(a), onsets: a.grid, onsetCentre: a.gridSize! / 2 } : { notes: decode(a), onsets: a.short.flux, onsetCentre: (a.shortSize ?? SHORT) / 2 };
}

/** A recording's notes (hear's). */
export function transcribeNotes(pcm: Float32Array, rate: number, progress?: (ratio: number) => void): Note[] {
  return hear(pcm, rate, progress).notes;
}

/** What Cadence's transcription.ts reads for its grid, its repeated notes and its bars:
 *  liveTempo's novelty (`novelty`, one value a frame of `frameLength` samples) and our onset
 *  function brought to those frames (the most of the short frames in each), 0.6 and 0.4, each
 *  over its mean. Measured (cadence-transcriptor/JOURNAL.md): bar lines on a downbeat
 *  50.3 -> 56.6 % (0.5: 57.3, but the user's solo recording then a half bar out), within half
 *  a bar 73.3 -> 75.5 %; the tempo and the metre keep liveTempo's. */
export function gridNovelty(novelty: ArrayLike<number>, heard: Pick<Heard, 'onsets' | 'onsetCentre'>, frameLength: number, weight = 0.4): Float32Array {
  const { onsets, onsetCentre } = heard;
  const ours = new Float32Array(novelty.length);
  for (let g = 0; g < novelty.length; g++) {
    // the short frames centred from a hop into frame g to its end (as measured)
    const lo = Math.ceil((g * frameLength + HOP - onsetCentre) / HOP), hi = Math.floor((g * frameLength + frameLength - onsetCentre) / HOP);
    let m = 0;
    for (let t = lo; t <= hi; t++) if (t >= 0 && t < onsets.length && onsets[t]! > m) m = onsets[t]!;
    ours[g] = m;
  }
  const mean = (x: ArrayLike<number>) => { let s = 0; for (let i = 0; i < x.length; i++) s += x[i]!; return s / (x.length || 1) || 1; };
  const mf = mean(novelty), mo = mean(ours);
  return Float32Array.from(ours, (v, g) => (1 - weight) * novelty[g]! / mf + weight * v / mo);
}

/** Notes as Cadence's transcription.ts reads FolkFriend's (8 values a note: class, first
 *  frame, frames, power, the 4 octaves' energies), at `fps` frames a second; the first frame
 *  and the frames fractional (the onsets are finer than FolkFriend's frames). */
export function asClassNotes(notes: Note[], fps: number): Float32Array {
  const out = new Float32Array(notes.length * 8);
  notes.forEach((n, i) => {
    out.set([n.cls, n.onset * fps, Math.max(1, (n.offset - n.onset) * fps), n.power, ...n.octaves], i * 8);
  });
  return out;
}

/** The rate every setting here was measured at; a recording at another is brought to it
 *  (`resample`): FolkFriend's frames of 1024 samples and these windows then last what they
 *  lasted in the measures. The user's solo recording decoded at 44.1 or 32 kHz came out half
 *  a bar out (with FolkFriend's chain alone too), brought to 48 kHz first, exactly right. */
export const RATE = 48000;

/** `pcm` at `from` samples a second, at `to` (linear interpolation). */
export function resample(pcm: Float32Array, from: number, to = RATE): Float32Array {
  if (from === to) return pcm;
  const out = new Float32Array(Math.floor((pcm.length * to) / from));
  const step = from / to;
  for (let i = 0; i < out.length; i++) {
    const x = i * step, k = Math.floor(x), f = x - k;
    out[i] = (pcm[k] ?? 0) * (1 - f) + (pcm[k + 1] ?? pcm[k] ?? 0) * f;
  }
  return out;
}
