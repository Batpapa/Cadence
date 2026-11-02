// ── The tempo of what is being played, without the score ─────────────────────
// LiveBPM's idea (2026-11-01, the user): a tempo read off the microphone,
// every second, whatever is being played. Not the tempo FolkFriend picks for
// each window: that one is a quantisation grid in steps of 5, capped at
// FF_TEMPO_MAX_BPM — reels played at 210 came out at 175 in the median, and a
// window was within 6 % of the truth one time in five.
//
// Here: a novelty curve from FolkFriend's per-frame pitch energies (the rise
// of the pitch distribution, so a slurred change of note counts — a fiddle or
// a flute has no attack for an onset detector to hear — plus the rise of the
// energy, for repeated notes), its autocorrelation over the last seconds, and
// the quaver period whose multiples it repeats at best. In quavers: the metre,
// and so the beat, is only known once the tune is recognised (beatOf).
//
// Measured on 265 annotated tunes of seven sessions (2026-11-01), against
// the offline score alignment, an estimate a second: over 12 s, 83 % within
// 2 % and 88 % within 4 % (reels 92 %, jigs 94 %, slides 91 %, slip jigs
// 80 %); over 8 s, 78 / 84 %; over 4 s, 54 / 64 %. Hornpipes, polkas,
// waltzes, mazurkas and marches are often off by half again (×1.5): the swing
// of a hornpipe, the crotchets of a waltz. When right, 0.7 crotchet a minute
// off in the median. The constants below are that first try's, not tuned —
// but for what is shown (TEMPO_OPTIONS' comment). As shown, the bench gives
// (experiments/tempo/bench.mjs): a tempo on 69 % of the readings in tunes,
// within 4 % on 95 % of those; on 7 % of the readings between tunes. A tune's
// median, against its passes over its annotated span: within 4 % for 97 %
// of the 194 tunes where that truth and the alignment agree.
//
// Self-contained on purpose, like liveFollow.ts: Node runs it as it is for
// the bench (experiments/tempo/).

/** Pitch energies per frame in FolkFriend's features (`take_features`). */
const PITCHES = 48;

export interface TempoOptions {
  /** Seconds the estimate looks back over. */
  windowSeconds: number;
  /** Seconds heard before a first estimate. */
  minSeconds: number;
  /** Quaver rates looked at, per second: crotchets 100 to 300 a minute. */
  minRate: number;
  maxRate: number;
  /** Multiples of the quaver period the comb adds up. */
  multiples: number;
  /** Longest lag of the autocorrelation, seconds. */
  maxLagSeconds: number;
  /** The pull towards session tempi, against octave slips: a penalty in the
   *  square of the octaves from `priorRate`, times the curve's variance. */
  priorWeight: number;
  priorRate: number;
  /** The share of the curve's variance repeating at the quaver period an
   *  estimate needs to count — talk, noise and silence repeat little. Two
   *  thresholds: `minStrength` while nothing is shown, `keepStrength` for an
   *  estimate within `tolerance` of the tempo shown. */
  minStrength: number;
  keepStrength: number;
  /** A pulse is shown when `agree` of the last `last` estimates that count
   *  lie within `tolerance` of their median — which is the value shown. */
  last: number;
  agree: number;
  tolerance: number;
}

// What is shown (experiments/tempo/bench.mjs, 2026-11-01): one strength
// alone either hid the tempo (0.12: shown on 16 % of the readings in tunes)
// or claimed one over talk (0.03: on 39 % of the readings between tunes,
// where some music is played too). Asking the last estimates to agree as
// well: 0.04 and 4 of 5 within 3 % show a tempo on 67 % of the readings in
// tunes, right within 4 % on 95 % of those, and on 7 % of the readings
// between tunes. The live test then showed holes of 20 s in a reel whose
// estimates were all right (422-426 for 423) but weak for a few seconds:
// keeping a tempo takes less than finding one. 0.05 to find, 0.01 to keep:
// shown on 74.5 % of the readings in tunes, right on 95.2 %, and on 6.4 %
// between tunes — better on all three (0.04/0.02: 75.4, 94.9, 9.3).
export const TEMPO_OPTIONS: TempoOptions = {
  windowSeconds: 12,
  minSeconds: 8,
  minRate: 3.3,
  maxRate: 10,
  multiples: 16,
  maxLagSeconds: 4,
  priorWeight: 0.15,
  priorRate: 200 / 30,
  minStrength: 0.05,
  keepStrength: 0.01,
  last: 5,
  agree: 4,
  tolerance: 0.03,
};

export interface TempoEstimate {
  /** Quavers per second. */
  rate: number;
  /** How much of the curve repeats at that period, about 0 to 1. */
  strength: number;
}

/** One frame's novelty, from the previous frame's normalised pitches (`prev`,
 *  updated in place) and log energy. */
function noveltyOf(frame: Float32Array, at: number, prev: Float32Array, prevLog: number): { value: number; log: number } {
  let e = 0;
  for (let p = 0; p < PITCHES; p++) e += frame[at + p]!;
  let flux = 0;
  for (let p = 0; p < PITCHES; p++) {
    const x = e > 0 ? frame[at + p]! / e : 0;
    if (x > prev[p]!) flux += x - prev[p]!;
    prev[p] = x;
  }
  const log = Math.log(1e-6 + e);
  return { value: flux + 0.5 * Math.max(0, log - prevLog), log };
}

/** The novelty curve of a stream of FolkFriend's features: one value per
 *  frame, each knowing the frame before. */
export class Novelty {
  private readonly prev = new Float32Array(PITCHES);
  private prevLog = 0;

  reset(): void {
    this.prev.fill(0);
    this.prevLog = 0;
  }

  /** Frames × 48 pitch energies, oldest first: their novelty. */
  of(features: Float32Array): Float32Array {
    const out = new Float32Array(Math.floor(features.length / PITCHES));
    for (let i = 0; i < out.length; i++) {
      const { value, log } = noveltyOf(features, i * PITCHES, this.prev, this.prevLog);
      this.prevLog = log;
      out[i] = value;
    }
    return out;
  }
}

const lerp = (a: Float64Array, x: number): number => {
  const i = Math.floor(x), f = x - i;
  return i + 1 < a.length ? a[i]! * (1 - f) + a[i + 1]! * f : 0;
};

/** The quaver rate of a novelty curve. Null when it is flat. */
export function estimateRate(nov: ArrayLike<number>, fps: number, opt: TempoOptions = TEMPO_OPTIONS): TempoEstimate | null {
  const n = nov.length;
  let mean = 0;
  for (let t = 0; t < n; t++) mean += nov[t]!;
  mean /= n;
  const maxLag = Math.min(n - 1, Math.round(opt.maxLagSeconds * fps));
  if (maxLag < fps / opt.minRate) return null;
  const ac = new Float64Array(maxLag + 1);
  for (let L = 0; L <= maxLag; L++) {
    let s = 0;
    for (let t = L; t < n; t++) s += (nov[t]! - mean) * (nov[t - L]! - mean);
    ac[L] = s / (n - L);
  }
  if (!(ac[0]! > 0)) return null;
  let best = -Infinity, bestP = 0, bestComb = 0;
  for (let P = fps / opt.maxRate; P <= fps / opt.minRate; P += 0.02) {
    let s = 0, k = 0;
    for (let m = 1; m * P <= maxLag && m <= opt.multiples; m++) { s += lerp(ac, m * P); k++; }
    const comb = s / k;
    const score = comb - opt.priorWeight * ac[0]! * Math.log2(fps / P / opt.priorRate) ** 2;
    if (score > best) { best = score; bestP = P; bestComb = comb; }
  }
  return { rate: fps / bestP, strength: bestComb / ac[0]! };
}

/** What the tracker says, every second or so. */
export type TempoReading =
  /** Seconds since the recording started (its own clock, pauses left out). */
  { t: number } & (
    /** Not heard long enough yet, since the start or a resume. */
    | { state: 'listening' }
    /** Heard, but nothing repeats: talk, noise, silence. */
    | { state: 'none' }
    | { state: 'pulse'; rate: number }
  );

/** The last `windowSeconds` of novelty, fed with FolkFriend's features as
 *  they come; read it whenever. */
export class TempoTracker {
  private readonly ring: Float32Array;
  private written = 0;
  private readonly novelty = new Novelty();
  readonly fps: number;
  private readonly opt: TempoOptions;

  // No parameter properties: Node's type stripping refuses them.
  constructor(fps: number, opt: TempoOptions = TEMPO_OPTIONS) {
    this.fps = fps;
    this.opt = opt;
    this.ring = new Float32Array(Math.ceil(opt.windowSeconds * fps));
  }

  /** The last estimates read, strong enough or null — see `agree`. */
  private recent: (number | null)[] = [];
  /** The tempo shown by the last reading, null for none. */
  private shown: number | null = null;

  /** Forget everything: after a pause, or audio lost — a window across the
   *  join would hear two tempi as one. */
  reset(): void {
    this.written = 0;
    this.novelty.reset();
    this.recent = [];
    this.shown = null;
  }

  /** Frames × 48 pitch energies, oldest first. Returns their novelty — what
   *  a detection's own tempo is worked out from (tempoInside). */
  push(features: Float32Array): Float32Array {
    const values = this.novelty.of(features);
    for (const value of values) {
      this.ring[this.written % this.ring.length] = value;
      this.written++;
    }
    return values;
  }

  /** Frames pushed since the last reset. */
  get frames(): number { return this.written; }

  /** The estimate over what the window holds, whatever its strength — null
   *  before `minSeconds`. */
  estimate(): TempoEstimate | null {
    if (this.written < this.opt.minSeconds * this.fps) return null;
    const n = Math.min(this.written, this.ring.length);
    const nov = new Float32Array(n);
    for (let i = 0; i < n; i++) nov[i] = this.ring[(this.written - n + i) % this.ring.length]!;
    return estimateRate(nov, this.fps, this.opt);
  }

  /** What to show at `t`, the estimate made now counted in — read about once
   *  a second, the rhythm `last` is measured in. `estimate` is that estimate,
   *  for the bench. */
  read(t: number): { reading: TempoReading; estimate: TempoEstimate | null } {
    const e = this.estimate();
    if (!e) return { reading: { t, state: 'listening' }, estimate: null };
    const keeps = this.shown !== null && e.strength >= this.opt.keepStrength
      && Math.abs(e.rate / this.shown - 1) < this.opt.tolerance;
    this.recent.push(e.strength >= this.opt.minStrength || keeps ? e.rate : null);
    if (this.recent.length > this.opt.last) this.recent.shift();
    const rates = this.recent.filter((r): r is number => r !== null).sort((a, b) => a - b);
    // Nothing shown on an estimate that does not count, however well the ones
    // before agree: the music has just stopped.
    this.shown = null;
    if (rates.length && this.recent[this.recent.length - 1] !== null) {
      const median = rates[Math.floor(rates.length / 2)]!;
      if (rates.filter(r => Math.abs(r / median - 1) < this.opt.tolerance).length >= this.opt.agree) this.shown = median;
    }
    return { reading: this.shown === null ? { t, state: 'none' } : { t, state: 'pulse', rate: this.shown }, estimate: e };
  }
}

// ── A detection's own tempo ──────────────────────────────────────────────────
// The readings above listen to the last 12 s whatever was played in them: a
// tune's first readings still hear the tune before (Ellen's Delight, on the
// tabac session, opened at 230 for 145 — 2026-11-02). A detection's tempo is
// read inside it instead (the user's rule, 2026-11-02): at each second t, over
// [t_min, t_max], t_min = max(t − T, start), t_max = min(t_min + T, end). Its
// first seconds share the window [start, start + T]; a tune shorter than T
// gets a window of its own length, and so a tempo — a "~" one.

/** One window's tempo inside a detection. */
export interface WindowTempo {
  /** The second it is drawn at. */
  t: number;
  /** The window: from, and how long (T_eff). */
  from: number;
  span: number;
  /** Quavers per second, whatever its strength: inside a detection there is
   *  a tune. */
  rate: number;
  /** As TempoEstimate's: what insideRate prefers to count. */
  strength: number;
}

/** Frames a curve may miss at a detection's end (tempoInside). */
const END_SLACK_FRAMES = 4;

/** Strong windows enough to count them alone (insideRate). */
const MIN_STRONG = 3;

/** Shorter windows say nothing: the comb needs a few periods of a bar. */
const MIN_SPAN_S = 3;

/** The tempo inside [start, end] of a novelty curve whose value 0 is at
 *  `from` seconds, a window a second (WindowTempo). A window reaching past the
 *  curve's end is left out — heard later, when the curve is still growing. */
export function tempoInside(
  nov: Float32Array, fps: number, from: number, start: number, end: number,
  opt: TempoOptions = TEMPO_OPTIONS,
  /** Windows already worked out, kept between calls on a growing curve. */
  done: Map<string, TempoEstimate | null> = new Map(),
): WindowTempo[] {
  const T = opt.windowSeconds;
  const out: WindowTempo[] = [];
  for (let t = start; t <= end + 1e-6; t += 1) {
    const lo = Math.max(t - T, start), hi = Math.min(lo + T, end);
    if (hi - lo < MIN_SPAN_S) continue;
    const a = Math.round((lo - from) * fps);
    let b = Math.round((hi - from) * fps);
    // A curve decoded to the detection's very end may fall a frame or two
    // short of it: its last window is cut that much, not dropped — for a tune
    // of 10 s it is the only one (2026-11-02).
    if (b > nov.length && hi >= end - 1e-6 && b - nov.length <= END_SLACK_FRAMES) b = nov.length;
    if (a < 0 || b > nov.length) continue;
    const key = `${a}:${b}`;
    if (!done.has(key)) done.set(key, estimateRate(nov.subarray(a, b), fps, opt));
    const e = done.get(key)!;
    if (e) out.push({ t, from: lo, span: hi - lo, rate: e.rate, strength: e.strength });
  }
  return out;
}

/** The windows of the longest span, in order, each once: a detection's first
 *  seconds share one. */
export function longestWindows(points: readonly WindowTempo[]): WindowTempo[] {
  const longest = Math.max(...points.map(p => p.span));
  const seen = new Set<number>();
  const out: WindowTempo[] = [];
  for (const p of points) {
    if (p.span < longest - 1e-6 || seen.has(p.from)) continue;
    seen.add(p.from);
    out.push(p);
  }
  return out;
}

/** A detection's tempo: the median over its windows of the longest span,
 *  each counted once (its first seconds share one). `approx` when that span
 *  is short of T — a tune shorter than the window, shown with a "~". */
export function insideRate(points: readonly WindowTempo[], opt: TempoOptions = TEMPO_OPTIONS): { rate: number; approx: boolean; weak: boolean } | null {
  if (!points.length) return null;
  const all = longestWindows(points);
  const strong = all.filter(p => p.strength >= opt.minStrength).length;
  const rates = countedWindows(points, opt).map(p => p.rate).sort((a, b) => a - b);
  return {
    rate: rates[Math.floor(rates.length / 2)]!,
    approx: all[0]!.span < opt.windowSeconds - 0.5,
    // Too few strong windows: the median of weak ones too, which take half
    // again or twice the tempo as often as not — told with a "~" (2026-11-02).
    weak: strong < MIN_STRONG && strong < all.length,
  };
}

/** The windows a detection's tempo is the median of: those of the longest
 *  span, the strong ones when there are a few — the weak ones are those that
 *  take half again or twice the tempo (STRONG_ENOUGH's measure). */
export function countedWindows(points: readonly WindowTempo[], opt: TempoOptions = TEMPO_OPTIONS): WindowTempo[] {
  const all = longestWindows(points);
  const strong = all.filter(p => p.strength >= opt.minStrength);
  return strong.length >= MIN_STRONG ? strong : all;
}

/** The novelty of a whole analysis, as it comes: value i is frame i of the
 *  recording's own clock (pauses left out, as the detections' times). Kept by
 *  the live and import engines so that each detection's tempo is read inside
 *  its final bounds when the analysis is saved — 47 values a second, some
 *  2 MB for three hours. */
export class NoveltyStore {
  private buf = new Float32Array(1 << 16);
  private n = 0;
  readonly fps: number;

  constructor(fps: number) { this.fps = fps; }

  /** `values` from frame `at` on. A hole before it (audio lost) stays 0. */
  write(at: number, values: Float32Array): void {
    const end = at + values.length;
    if (end > this.buf.length) {
      let size = this.buf.length;
      while (size < end) size *= 2;
      const grown = new Float32Array(size);
      grown.set(this.buf.subarray(0, this.n));
      this.buf = grown;
    }
    this.buf.set(values, at);
    this.n = Math.max(this.n, end);
  }

  get length(): number { return this.n; }

  /** The curve so far — a view, valid until the next write. */
  view(): Float32Array { return this.buf.subarray(0, this.n); }
}
