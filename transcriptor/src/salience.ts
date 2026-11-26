// Pitch salience by harmonic summation (Klapuri 2006; Salamon & Gómez 2012): each spectral
// peak votes for the fundamentals it could be a harmonic of, h = 1..HARMONICS, the vote
// weighted ALPHA^(h-1) and spread over the semitones within KERNEL of f/h. Then folded into
// the 12 pitch classes: instruments playing the tune in different registers add up instead
// of competing (the user, 2026-11-24), each frame keeping its octave profile.
//
// Also kept, for the octave: the votes of the ODD harmonics only. A note an octave below the
// played one collects every harmonic of it (its even ones), so full sums leave octave
// profiles flat; it has nothing at its own odd multiples (f/2, 3f/2...), the played note has.

import type { Peaks } from './spectrum.ts';

export interface SalienceOptions {
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

export interface Salience {
  frames: number;
  low: number;
  /** frames x notes (MIDI low..high): all harmonics' votes, odd harmonics' votes. */
  notes: number;
  note: Float32Array;
  odd: Float32Array;
}

export function salience(p: Peaks, tuning: number, o: SalienceOptions = {}): Salience {
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
export function removeSustained(x: Float32Array, frames: number, notes: number, span: number, fraction = 1, stride = 100, sub = 8): void {
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
export function classes(x: Float32Array, frames: number, low: number, notes: number): Float32Array {
  const cls = new Float32Array(frames * 12);
  for (let t = 0; t < frames; t++) for (let n = 0; n < notes; n++) cls[t * 12 + ((low + n) % 12)] += x[t * notes + n]!;
  return cls;
}
