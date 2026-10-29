// ── Score following: where in its score a recorded tune is ───────────────────
// Proof of concept (2026-10-28). Recognition says WHICH tune a detection is;
// this says WHERE in that tune's score the musicians are, moment by moment, so
// the score's cursor can follow the real recording instead of the synth.
//
// Inputs
//   features — FolkFriend's per-frame pitch energies (`take_features`): frames ×
//              48, MIDI 48..95, one frame per 1024 samples at 48 kHz.
//   score    — MIDI pitches, one per quaver, repeats unfolded: exactly the
//              recognition index's `contour` of the setting, one pass of the tune.
//
// Model: a hidden semi-Markov model. Each quaver of the score is a segment of
// free length around the nominal quaver at a candidate tempo; after the last
// quaver the score loops to the first, since a tune is played several times.
// Frames before the first and after the last aligned quaver belong to a "not
// this tune" state, so the detection's bounds need not be exact. A frame's
// emission for a pitch is the log of that pitch's share of the frame's energy,
// octaves folded in (fiddle and whistle are often heard an octave off).
//
// Measured on the annotated sessions (experiments/score-follow/): see the
// README there. Synthetic renders with drift, swing, cuts, accompaniment and
// noise: median onset error 8 ms.

import { ANALYSIS_SAMPLE_RATE, FF_PCM_WINDOW } from './sessionConfig';

const MIDI_LOW = 48;
const MIDI_NUM = 48;
/** Feature frames per second at the analysis rate — the default; a
 *  recording decoded at its own rate has rate / FF_PCM_WINDOW. */
export const FOLLOW_FPS = ANALYSIS_SAMPLE_RATE / FF_PCM_WINDOW;

/** The index's contour alphabet, MIDI_LOW first (ff_config::CONTOUR_TO_QUERY_CHAR). */
const CONTOUR_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUV';

export function contourToMidi(contour: string): number[] {
  const out: number[] = [];
  for (const c of contour) {
    const i = CONTOUR_CHARS.indexOf(c);
    if (i >= 0) out.push(MIDI_LOW + i);
  }
  return out;
}

export interface FollowOptions {
  /** Shortest and longest quaver, as a ratio of the candidate tempo's. */
  minRatio: number;
  maxRatio: number;
  /** Weight of the squared log-ratio penalty on a quaver's length. */
  durWeight: number;
  /** What a frame costs outside the tune: its best pitch, whatever the score
   *  says, minus this. "Another tune is playing" rather than a flat score —
   *  a flat one loses to any music at all, and the neighbouring tune of a set
   *  (same meter, same rhythm) got aligned as the end of a pass. */
  otherPenalty: number;
  /** ...or noise: a frame with no clear pitch is worth at least this outside
   *  the tune, so the tune does not reach into the chatter around it. */
  noiseFloor: number;
  /** Crotchets per minute, FolkFriend's convention (one contour symbol = a
   *  quaver). Session reels run near 190-230 — a 256-quaver pass in 40 s. */
  bpms: number[];
  transposes: number[];
  /** Feature frames per second: the sample rate the features were made at,
   *  over FF_PCM_WINDOW. */
  fps: number;
}

export const FOLLOW_DEFAULTS: FollowOptions = {
  minRatio: 0.45,
  maxRatio: 2.2,
  durWeight: 2,
  // 1.2 over 1, measured on the 336 annotated tunes (2026-10-28): the worst
  // tenth covered 90 % instead of 63 %, the ends 5 s from the annotation
  // instead of 12 (90th percentile). 1.5 is past the edge: any score then
  // aligns anywhere.
  otherPenalty: 1.2,
  noiseFloor: Math.log(0.01 + 2 / MIDI_NUM),
  bpms: [80, 100, 120, 140, 160, 180, 200, 220, 240, 260],
  transposes: [0],
  fps: FOLLOW_FPS,
};

export interface FollowResult {
  /** Start of every quaver entered, in seconds from the start of the
   *  features, in playing order. */
  times: number[];
  /** Index into the score of each of them; going down means a new pass. */
  indices: number[];
  /** End of the last aligned quaver, seconds. */
  end: number;
  bpm: number;
  transpose: number;
  /** Mean log score per frame — comparable between scores on the same audio. */
  perFrame: number;
  /** Share of the aligned frames whose loudest pitch class is the score's. */
  match: number;
  /** The same, quaver by quaver: of each aligned quaver's frames that had a
   *  pitch, how many had the score's (`hits`) out of how many (`counted`) —
   *  for showing where the alignment holds and where it does not
   *  (localMatch). */
  hits: number[];
  counted: number[];
  /** Quavers in one pass of the score — the contour's length. NOT the highest
   *  index aligned: a recording that does not reach the end of the score (a
   *  tune started or left mid-way) would stretch every position towards it,
   *  and the cursor would race to the end of the page (seen 2026-10-28). */
  quavers: number;
  /** The score aligned to, one MIDI pitch per quaver: what places each quaver
   *  on the drawn score (`alignContour`). */
  pitches: number[];
}

/** Per-frame log share of each pitch, octave-folded. Quiet frames say nothing:
 *  every pitch gets the same value there. */
function emissions(features: Float32Array, frames: number): Float32Array {
  const octaveWeight = 0.6, floor = 0.01;
  const L = new Float32Array(frames * MIDI_NUM);
  const energy = new Float32Array(frames);
  for (let t = 0; t < frames; t++) {
    let sum = 0;
    for (let p = 0; p < MIDI_NUM; p++) sum += features[t * MIDI_NUM + p]!;
    energy[t] = sum;
  }
  const sorted = Array.from(energy).sort((a, b) => a - b);
  const loud = sorted[Math.floor(sorted.length * 0.9)] || 1;
  const flat = Math.log(floor + 1 / MIDI_NUM);
  for (let t = 0; t < frames; t++) {
    const sum = energy[t]!;
    const base = t * MIDI_NUM;
    if (sum < loud * 0.05) { L.fill(flat, base, base + MIDI_NUM); continue; }
    for (let p = 0; p < MIDI_NUM; p++) {
      const below = p >= 12 ? features[base + p - 12]! : 0;
      const above = p + 12 < MIDI_NUM ? features[base + p + 12]! : 0;
      L[base + p] = Math.log(floor + (features[base + p]! + octaveWeight * Math.max(below, above)) / sum);
    }
  }
  return L;
}

/** Cumulative emission per pitch: a segment's score is C[p][b] − C[p][a]. */
function cumulate(L: Float32Array, frames: number): Float64Array {
  const C = new Float64Array(MIDI_NUM * (frames + 1));
  for (let p = 0; p < MIDI_NUM; p++) {
    const row = p * (frames + 1);
    for (let t = 0; t < frames; t++) C[row + t + 1] = C[row + t]! + L[t * MIDI_NUM + p]!;
  }
  return C;
}

/** Cumulative score of "not this tune" — another tune or noise: G[b] − G[a]
 *  for frames [a, b). */
function cumulateOther(L: Float32Array, frames: number, penalty: number, noiseFloor: number): Float64Array {
  const G = new Float64Array(frames + 1);
  for (let t = 0; t < frames; t++) {
    let top = -Infinity;
    for (let p = 0; p < MIDI_NUM; p++) top = Math.max(top, L[t * MIDI_NUM + p]!);
    G[t + 1] = G[t]! + Math.max(top - penalty, noiseFloor);
  }
  return G;
}

interface Pass { score: number; onsets: Array<{ frame: number; index: number }>; end: number }

function alignAt(
  C: Float64Array, G: Float64Array, frames: number, score: number[], framesPerQuaver: number, transpose: number,
  opt: FollowOptions, best: Float64Array, from: Int16Array,
  /** Called with the frames done so far, every 256. */
  tick?: (framesDone: number) => void,
): Pass {
  const N = score.length;
  const d = framesPerQuaver;
  const dMin = Math.max(1, Math.floor(d * opt.minRatio));
  const dMax = Math.ceil(d * opt.maxRatio);
  const pen = new Float64Array(dMax + 1);
  for (let k = dMin; k <= dMax; k++) pen[k] = -opt.durWeight * Math.log(k / d) ** 2;
  const rowOf = score.map((m) => {
    let p = m - MIDI_LOW + transpose;
    while (p < 0) p += 12;
    while (p >= MIDI_NUM) p -= 12;
    return p * (frames + 1);
  });

  // best[t·N + i]: best score of a path whose quaver i ENDS at frame t.
  // from: that quaver's length; negative when it was the first one, entered
  // from "not this tune".
  best.fill(-Infinity, 0, (frames + 1) * N);
  for (let t = 1; t <= frames; t++) {
    if (tick && (t & 255) === 0) tick(t);
    const top = Math.min(dMax, t);
    for (let i = 0; i < N; i++) {
      const prevI = i === 0 ? N - 1 : i - 1;
      const row = rowOf[i]!;
      const ct = C[row + t]!;
      let b = -Infinity, arg = 0;
      for (let k = dMin; k <= top; k++) {
        const s = t - k;
        const viaPrev = best[s * N + prevI]!;
        const viaStart = G[s]!; // everything before s was another tune
        const v = (viaPrev >= viaStart ? viaPrev : viaStart) + ct - C[row + s]! + pen[k]!;
        if (v > b) { b = v; arg = viaPrev >= viaStart ? k : -k; }
      }
      best[t * N + i] = b;
      from[t * N + i] = arg;
    }
  }
  let endT = 0, endI = -1, total = G[frames]!;
  for (let t = 1; t <= frames; t++) {
    for (let i = 0; i < N; i++) {
      const v = best[t * N + i]! + G[frames]! - G[t]!;
      if (v > total) { total = v; endT = t; endI = i; }
    }
  }
  const onsets: Array<{ frame: number; index: number }> = [];
  let t = endT, i = endI;
  while (i >= 0 && t > 0) {
    const k = from[t * N + i]!;
    const s = t - Math.abs(k);
    onsets.push({ frame: s, index: i });
    if (k < 0) break;
    t = s;
    i = i === 0 ? N - 1 : i - 1;
  }
  onsets.reverse();
  return { score: total, onsets, end: endT };
}

/** How far an alignment can be trusted, from the share of the notes heard
 *  that fall on the score. Read off the annotated sessions: the right score
 *  scores ~0.7 (0.5 in a noisy pub), a wrong one ~0.45. At or above
 *  MATCH_GOOD it holds — 0.6, not 0.7: by ear, an alignment is quite good
 *  from there, and green was out of reach (2026-10-29, the user); below
 *  MATCH_USABLE it is not followed at all — set between the right score in
 *  a noisy pub and a wrong one. The same two lines judge the whole and each
 *  stretch of it. */
export const MATCH_GOOD = 0.6;
export const MATCH_USABLE = 0.5;

/** For each aligned quaver, of its frames that had a pitch at all, how many
 *  had the score's pitch class loudest. */
function quaverHits(features: Float32Array, score: number[], r: Pass, transpose: number): { hits: number[]; counted: number[] } {
  const hits: number[] = [], counted: number[] = [];
  for (let k = 0; k < r.onsets.length; k++) {
    const a = r.onsets[k]!.frame;
    const b = k + 1 < r.onsets.length ? r.onsets[k + 1]!.frame : r.end;
    const pc = (score[r.onsets[k]!.index]! + transpose) % 12;
    let hit = 0, n = 0;
    for (let t = a; t < b; t++) {
      let top = 0, arg = 0;
      for (let p = 0; p < MIDI_NUM; p++) {
        const v = features[t * MIDI_NUM + p]!;
        if (v > top) { top = v; arg = p; }
      }
      if (top <= 0) continue;
      n++;
      if ((arg + MIDI_LOW) % 12 === pc) hit++;
    }
    hits.push(hit);
    counted.push(n);
  }
  return { hits, counted };
}

/** Of the frames of quavers `from`..`to` (exclusive) that had a pitch, the
 *  share on the score's pitch class; null when none had one. */
function shareOf(hits: number[], counted: number[], from = 0, to = hits.length): number | null {
  let h = 0, n = 0;
  for (let k = Math.max(0, from); k < Math.min(to, hits.length); k++) { h += hits[k]!; n += counted[k]!; }
  return n ? h / n : null;
}

/** The match share around each of `at` (seconds, same origin as `times`):
 *  over the quavers within `halfWidth` s of it, null outside the aligned span
 *  or where nothing had a pitch. What colours the waveform by how well the
 *  score holds there (2026-10-29, the user). */
export function localMatch(r: FollowResult, at: number[], halfWidth: number): (number | null)[] {
  const { times } = r;
  return at.map((t) => {
    if (times.length === 0 || t < times[0]! || t >= r.end) return null;
    let lo = 0;
    while (lo < times.length && times[lo]! < t - halfWidth) lo++;
    let hi = lo;
    while (hi < times.length && times[hi]! <= t + halfWidth) hi++;
    // At least the quaver under `t`, however long it is.
    if (hi === lo) { lo = Math.max(0, lo - 1); hi = lo + 1; }
    return shareOf(r.hits, r.counted, lo, hi);
  });
}

/** Frames the coarse tempo search looks at: a stretch of the tune is enough to
 *  hear its tempo, and the search then costs the same however long the tune. */
const TEMPO_PROBE_S = 30;

/** What `followScore` is doing, for a progress display: the tempo search,
 *  then the alignment of the whole recording, each from 0 to 1. */
export type FollowProgress = { stage: 'tempo' | 'align'; ratio: number };

/** The best alignment of `score` over `features`.
 *
 *  The tempo and transposition are chosen on a 30 s stretch from a quarter in
 *  (past any lead-in): every candidate, then ±5 around the best. The whole
 *  recording is then aligned ONCE, at that tempo — a tempo is only the centre
 *  of each quaver's free length, so ±5 more on the whole changes little and
 *  cost three times as much. On a phone that is the difference between a few
 *  seconds and a quarter of a minute. Null when nothing could be aligned. */
export function followScore(
  features: Float32Array, score: number[], options: Partial<FollowOptions> = {},
  onProgress?: (p: FollowProgress) => void,
): FollowResult | null {
  const opt = { ...FOLLOW_DEFAULTS, ...options };
  const frames = Math.floor(features.length / MIDI_NUM);
  if (frames < 2 || score.length < 2) return null;
  const fps = opt.fps;
  const fpq = (bpm: number) => fps / ((bpm / 60) * 2);
  const prepare = (f: Float32Array, n: number) => {
    const L = emissions(f, n);
    return { n, C: cumulate(L, n), G: cumulateOther(L, n, opt.otherPenalty, opt.noiseFloor) };
  };
  const best = new Float64Array((frames + 1) * score.length);
  const from = new Int16Array((frames + 1) * score.length);
  type Tempo = { bpm: number; transpose: number };
  type Found = Pass & Tempo;

  // The probe: the whole recording when it is short, else 30 s of it.
  const probeFrames = Math.min(frames, Math.round(TEMPO_PROBE_S * fps));
  const at = Math.max(0, Math.min(Math.floor(frames / 4), frames - probeFrames));
  const probe = probeFrames === frames ? prepare(features, frames)
    : prepare(features.subarray(at * MIDI_NUM, (at + probeFrames) * MIDI_NUM), probeFrames);
  const coarse = opt.transposes.flatMap(transpose => opt.bpms.map(bpm => ({ bpm, transpose })));
  const runs = coarse.length + 2;
  let done = 0;
  const search = (tempi: Tempo[]): Found | null => {
    let top: Found | null = null;
    for (const t of tempi) {
      if (t.bpm > 0) {
        const r = alignAt(probe.C, probe.G, probe.n, score, fpq(t.bpm), t.transpose, opt, best, from);
        if (!top || r.score > top.score) top = { ...r, ...t };
      }
      onProgress?.({ stage: 'tempo', ratio: ++done / runs });
    }
    return top;
  };
  const rough = search(coarse);
  if (!rough) return null;
  const fine = search([-5, 5].map(d => ({ bpm: rough.bpm + d, transpose: rough.transpose })));
  const tempo: Found = fine && fine.score > rough.score ? fine : rough;

  const whole = probeFrames === frames ? probe : prepare(features, frames);
  const r: Found = probeFrames === frames ? tempo : {
    ...alignAt(whole.C, whole.G, frames, score, fpq(tempo.bpm), tempo.transpose, opt, best, from,
      (t) => onProgress?.({ stage: 'align', ratio: t / frames })),
    bpm: tempo.bpm, transpose: tempo.transpose,
  };
  onProgress?.({ stage: 'align', ratio: 1 });
  if (r.onsets.length === 0) return null;
  const { hits, counted } = quaverHits(features, score, r, r.transpose);
  return {
    times: r.onsets.map(o => o.frame / fps),
    indices: r.onsets.map(o => o.index),
    end: r.end / fps,
    bpm: r.bpm,
    transpose: r.transpose,
    perFrame: r.score / frames,
    match: shareOf(hits, counted) ?? 0,
    hits,
    counted,
    quavers: score.length,
    pitches: score,
  };
}

/** Where the score is at `t` seconds (same origin as `times`): the quaver, with
 *  its fraction, and the pass. Null before the first and after the last
 *  aligned quaver — the tune is not being played there. */
export function positionAt(r: FollowResult, t: number): { quaver: number; pass: number } | null {
  const { times, indices } = r;
  if (times.length === 0 || t < times[0]! || t >= r.end) return null;
  let lo = 0, hi = times.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (times[mid]! <= t) lo = mid; else hi = mid - 1;
  }
  const next = lo + 1 < times.length ? times[lo + 1]! : r.end;
  const frac = next > times[lo]! ? (t - times[lo]!) / (next - times[lo]!) : 0;
  let pass = 0;
  for (let k = 1; k <= lo; k++) if (indices[k]! <= indices[k - 1]!) pass++;
  return { quaver: indices[lo]! + Math.min(1, Math.max(0, frac)), pass };
}

// ── From a quaver of the contour to a moment of the drawn score ──────────────
// The index's contour was made by abc2midi plus a quantiser (FolkFriend's
// index builder, midi.py `to_midi_contour`): notes only, rests dropped, each
// note a whole number of quavers, a note shorter than a quaver given one and
// the next one skipped while the real time lags behind. The same rule run on
// abcjs's timeline of the same ABC gives the moment each contour quaver is
// drawn at — rests and long notes included, which a proportion of the whole
// timeline gets wrong (measured 2026-10-28: abcjs and the contour disagree by
// more than 3 % on one setting in ten — rests, endings, grace notes).
// The two still differ by a quaver or three on most settings with endings, and
// by more on ornate ones, so the contour is then matched to the slots by pitch
// (`alignContour`); stretched to the slot count only where pitches are missing.

/** One event of abcjs's timeline, as `contourSlots` needs it. `pitch`: its
 *  lowest MIDI pitch, the one a chord gives the contour, when abcjs has it. */
export interface TimelineEvent { milliseconds: number; millisecondsPerMeasure: number; isNote: boolean; pitch?: number }

/** The moment (ms on abcjs's timeline) of every contour quaver, by the index
 *  builder's rule. `meter` as the index gives it ("6/8"). */
export function contourSlots(events: TimelineEvent[], lastMoment: number, meter: string): number[] {
  return slotNotes(events, lastMoment, meter).ms;
}

/** The same slots, each with the pitch drawn there. */
export function slotNotes(events: TimelineEvent[], lastMoment: number, meter: string): { ms: number[]; pitch: (number | undefined)[] } {
  const [num, den] = meter.split('/').map(Number);
  const perMeasure = num && den ? (num * 8) / den : 8;
  // abcjs gives its times rounded to the millisecond: at 333.3 ms a quaver, a
  // quaver can measure 1.001 of one. Taken for "longer than a quaver", it got
  // two slots and the next note none — every other note misplaced, the cursor
  // out of step on a reel (2026-10-28, Curlews). Durations within this much of
  // a whole number of quavers are that number; comparisons allow as much.
  const TOL = 0.02;
  const slots: number[] = [];
  const pitch: (number | undefined)[] = [];
  let music = 0, output = 0;
  for (let k = 0; k < events.length; k++) {
    const e = events[k]!;
    if (!e.isNote || !(e.millisecondsPerMeasure > 0)) continue;
    const quaverMs = e.millisecondsPerMeasure / perMeasure;
    const end = k + 1 < events.length ? events[k + 1]!.milliseconds : lastMoment;
    let d = (end - e.milliseconds) / quaverMs;
    if (Math.round(d) >= 1 && Math.abs(d - Math.round(d)) < TOL) d = Math.round(d);
    music += d;
    if (music <= output + TOL) continue;
    const n = Number.isInteger(d) ? d
      : d < 1 ? 1
        : music > output + TOL ? Math.ceil(d) : Math.floor(d);
    for (let j = 0; j < n; j++) { slots.push(e.milliseconds + j * quaverMs); pitch.push(e.pitch); }
    output += n;
  }
  return { ms: slots, pitch };
}

/** Each contour quaver's moment on abcjs's timeline, found by matching the
 *  contour's pitches to the drawn notes' — or null when the notes carry no
 *  pitch or too few of them match (then `quaverToMs` stretches the slots).
 *
 *  The rule `slotNotes` replays is the index builder's as far as it is known,
 *  and on ornate settings the two part ways: setting 54954 of The Bunch of
 *  Green Rushes, full of `(3d/d/d/d` and `~`, has 199 quavers in its contour
 *  and 192 in its drawing. Stretched over the pass, the 7 put the cursor ahead
 *  of the sound (the user, 2026-10-28). Matched by pitch — an edit distance,
 *  the drawn note under each contour quaver — an extra quaver stays by the
 *  note it belongs to instead of shifting everything after it. Pitch classes,
 *  at the shift that matches most: the score may be drawn transposed. */
export function alignContour(contour: number[], notes: { ms: number[]; pitch: (number | undefined)[] }): number[] | null {
  const n = contour.length, m = notes.ms.length;
  if (n === 0 || m === 0) return null;
  const { pitch } = notes;
  let shift = 0, bestHits = -1;
  for (let s = 0; s < 12; s++) {
    let hits = 0;
    for (let i = 0; i < Math.min(n, m); i++) if (pitch[i] !== undefined && (((contour[i]! - pitch[i]! - s) % 12) + 12) % 12 === 0) hits++;
    if (hits > bestHits) { bestHits = hits; shift = s; }
  }
  // Run BACKWARDS, so that the walk back through the table — which settles
  // ties on the note it meets first — meets the start of the tune first: of a
  // run of equal quavers (a triplet the contour spells out), the FIRST is the
  // drawn note's and the others follow it, rather than come before it.
  const same = (i: number, j: number) => {
    const p = pitch[m - 1 - j];
    return p !== undefined && (((contour[n - 1 - i]! - p - shift) % 12) + 12) % 12 === 0;
  };
  // Edit distance, row i = contour quavers taken, column j = slots taken.
  const W = m + 1;
  const cost = new Int32Array((n + 1) * W);
  for (let j = 0; j <= m; j++) cost[j] = j;
  for (let i = 1; i <= n; i++) {
    cost[i * W] = i;
    for (let j = 1; j <= m; j++) {
      cost[i * W + j] = Math.min(
        cost[(i - 1) * W + j - 1]! + (same(i - 1, j - 1) ? 0 : 1),
        cost[(i - 1) * W + j]! + 1,
        cost[i * W + j - 1]! + 1,
      );
    }
  }
  // Back through the table, from the tune's start: the slot each contour
  // quaver lands on, -1 for one the drawing has no slot of its own for.
  const slotOf = new Int32Array(n).fill(-1);
  let matches = 0;
  for (let i = n, j = m; i > 0 && j >= 0;) {
    const here = cost[i * W + j]!;
    if (j > 0 && here === cost[(i - 1) * W + j - 1]! + (same(i - 1, j - 1) ? 0 : 1)) {
      slotOf[n - i] = m - j;
      if (same(i - 1, j - 1)) matches++;
      i--; j--;
    } else if (here === cost[(i - 1) * W + j]! + 1) i--;
    else j--;
  }
  if (matches < n * 0.6) return null;
  // Quavers without a slot share the time between their neighbours.
  const out = new Array<number>(n);
  for (let i = 0; i < n;) {
    if (slotOf[i]! >= 0) { out[i] = notes.ms[slotOf[i]!]!; i++; continue; }
    let k = i;
    while (k < n && slotOf[k]! < 0) k++;
    const from = i > 0 ? out[i - 1]! : notes.ms[0]!;
    const to = k < n ? notes.ms[slotOf[k]!]! : from;
    for (let x = i; x < k; x++) out[x] = from + ((to - from) * (x - i + 1)) / (k - i + 1);
    i = k;
  }
  return out;
}

/** The moment on abcjs's timeline of a (fractional) contour quaver, through
 *  `slots`, stretched when their count differs from the contour's. Without
 *  slots: proportional to the whole timeline. */
export function quaverToMs(quaver: number, quavers: number, slots: number[], lastMoment: number): number {
  if (slots.length < 2) return (quaver / quavers) * lastMoment;
  const j = Math.max(0, (quaver * slots.length) / quavers);
  const k = Math.min(slots.length - 1, Math.floor(j));
  const next = k + 1 < slots.length ? slots[k + 1]! : lastMoment;
  return slots[k]! + (next - slots[k]!) * Math.min(1, j - k);
}

/** The inverse, for a note pressed: the contour quaver drawn at `ms`. */
export function msToQuaver(ms: number, quavers: number, slots: number[], lastMoment: number): number {
  if (slots.length < 2) return Math.round((ms / lastMoment) * quavers);
  let k = 0;
  while (k + 1 < slots.length && slots[k + 1]! <= ms + 1) k++;
  return Math.min(quavers - 1, Math.round((k * quavers) / slots.length));
}
