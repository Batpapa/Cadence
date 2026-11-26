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

import { analyse, tuningOf, type Peaks, type AnalysisOptions } from './spectrum.ts';
import { salience, removeSustained, classes, type Salience } from './salience.ts';
import { pitchChange, overLocalMedian, peaks } from './onsets.ts';

export interface DecoderOptions {
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
  /** Only each long frame's this many strongest classes kept (0: all), as FolkFriend keeps 5. */
  topClasses?: number;
  /** Share of the analysis' `extra` class view in the frame scores (0: not read). */
  extraWeight?: number;
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

/** The settings measured best (transcriptor's research journal, outside the repo, « R6 »): sessions, tuneset,
 *  classical flute and the user's solo recording judged together — and, since 2026-11-26, the
 *  recogniser's windows too (« Moteur unique »): ONE regime for writing ABC and for recognising.
 *  cutCost 2 -> 1.5: transcription as good (sessions tokens 66.8 -> 67.4, tuneset 84.0 -> 84.2),
 *  the right tune first in 91.8 -> 92.3 % of the windows; an extra class view at 0.2 (when one is
 *  given — in Cadence FolkFriend's cleaned energies, folkfriendView.ts): 92.3 -> 93.2 %, the gain
 *  in the least clear windows (79.0 -> 82.4 %), transcription unchanged within the judges' noise. */
export const DEFAULTS: DecoderOptions = {
  radius: 3, threshold: 0.5, pitchWeight: 0.25, cutCost: 1.5, onsetGain: 0.9, repeatCost: 8, repeatGain: 0.5,
  intervalWeight: 0, floor: 0.01, restLevel: 0.1, restSlope: 2, levelPct: 0.95, voicingFrom: 'energy',
  minFrames: 10, minRestFrames: 4, maxFrames: 600, sustainSpan: 1875, sustainFraction: 0.5, octaveFrom: 'odd', octavePower: 7,
  octaveDown: 1.07, acfWeight: 0.3, peakFloorDb: 50, extraWeight: 0.2,
};

/** Another view of the 12 pitch classes, read beside the decoder's own (option extraWeight):
 *  12 energies a frame, frames of `hop` samples from the recording's first sample. */
export interface ClassView { classes: Float32Array; hop: number }

/** The analysis with a class view attached (or as it is without one). */
export function withView(a: Analysis, view?: ClassView): Analysis {
  if (view) { a.extra = view.classes; a.extraHop = view.hop; }
  return a;
}

/** Short window: for time (onsets, where notes change). Long window: for pitch. */
export const SHORT = 2048, LONG = 4096, HOP = 256;

export interface Analysis {
  short: Peaks; long: Peaks; tuning: number; rate: number; shortSize?: number; longSize?: number;
  /** The onset function of a window of gridSize samples, for the grid and the bars (when asked). */
  grid?: Float32Array; gridSize?: number;
  /** Another view of the pitch classes (optional): 12 energies a frame of `extraHop` samples, the
   *  first frame starting at sample 0 — e.g. FolkFriend's cleaned energies folded to classes. Read
   *  with the weight `extraWeight` (decoder option). */
  extra?: Float32Array; extraHop?: number;
}

/** Harmonic mask median lengths (frames at HOP, bins): see spectrum.ts. */
export interface AnalyseOptions { hpssTime?: number; hpssFreq?: number; acf?: boolean; longHop?: number; acfEvery?: number; fluxLag?: number; maxPeaks?: number; shortSize?: number; longSize?: number; gridSize?: number; progress?: (ratio: number) => void }
export const ANALYSIS_DEFAULTS: AnalyseOptions = { hpssTime: 9, hpssFreq: 9, acf: true, longHop: 1024, acfEvery: 1, fluxLag: 4, maxPeaks: 60, shortSize: 1024, longSize: 8192, gridSize: 2048 };

/** The spectral analysis that runs: spectrum.ts's, or the same steps compiled to WebAssembly
 *  (rust/: twice as fast, its results within float rounding — bench/rust-check.js) once a
 *  caller hands it over. */
let analyseImpl: (pcm: Float32Array, rate: number, o: AnalysisOptions) => Peaks = analyse;
export function useAnalysis(impl: (pcm: Float32Array, rate: number, o: AnalysisOptions) => Peaks): void {
  analyseImpl = impl;
}

export function analyseAudio(pcm: Float32Array, rate = 48000, options: AnalyseOptions = {}): Analysis {
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

export function decode(a: Analysis, options: DecoderOptions = {}): Note[] {
  const o = { ...DEFAULTS, ...options };
  const { short } = a;
  const { sal, clsAcf } = prepare(a, o);
  let { cls } = prepare(a, o);
  const topK = o.topClasses ?? 0;
  if (topK > 0 && topK < 12) {
    // the weaker classes of each frame silenced
    cls = Float32Array.from(cls);
    const order = new Int8Array(12);
    for (let j = 0; j < sal.frames; j++) {
      for (let k = 0; k < 12; k++) order[k] = k;
      order.sort((p, q) => cls[j * 12 + q]! - cls[j * 12 + p]!);
      for (let r = topK; r < 12; r++) cls[j * 12 + order[r]!] = 0;
    }
  }
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
  // the extra class view: the frame of it under each short frame's centre
  const xw = a.extra && a.extraHop ? (o.extraWeight ?? 0) : 0;
  const xFrames = xw > 0 ? Math.floor(a.extra!.length / 12) : 0;
  for (let t = 0; t < n; t++) {
    const v = 1 / (1 + Math.pow((restLevel * level) / (vx[t]! + 1e-12), restSlope)); // P(voiced)
    const lv = Math.log(v + 1e-9);
    let ta = 0;
    if (aw > 0) for (let k = 0; k < 12; k++) ta += clsAcf![t * 12 + k]!;
    let xf = -1, tx = 0;
    if (xw > 0) {
      xf = Math.min(xFrames - 1, Math.floor((t * HOP + ss / 2) / a.extraHop!));
      for (let k = 0; k < 12; k++) tx += a.extra![xf * 12 + k]!;
    }
    for (let k = 0; k < 12; k++) {
      let share = tot[t]! > 0 ? clsAt(t, k) / tot[t]! : 1 / 12;
      if (aw > 0) share = (1 - aw) * share + aw * (ta > 0 ? clsAcf![t * 12 + k]! / ta : 1 / 12);
      if (xw > 0) share = (1 - xw) * share + xw * (tx > 0 ? a.extra![xf * 12 + k]! / tx : 1 / 12);
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

export function hear(pcm: Float32Array, rate: number, progress?: (ratio: number) => void, view?: ClassView): Heard {
  const a = withView(analyseAudio(pcm, rate, { progress }), view);
  return a.grid ? { notes: decode(a), onsets: a.grid, onsetCentre: a.gridSize! / 2 } : { notes: decode(a), onsets: a.short.flux, onsetCentre: (a.shortSize ?? SHORT) / 2 };
}

/** A recording's notes (hear's). */
export function transcribeNotes(pcm: Float32Array, rate: number, progress?: (ratio: number) => void, view?: ClassView): Note[] {
  return hear(pcm, rate, progress, view).notes;
}

/** What Cadence's transcription.ts reads for its grid, its repeated notes and its bars:
 *  liveTempo's novelty (`novelty`, one value a frame of `frameLength` samples) and our onset
 *  function brought to those frames (the most of the short frames in each), 0.6 and 0.4, each
 *  over its mean. Measured (transcriptor's research journal, outside the repo): bar lines on a downbeat
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
