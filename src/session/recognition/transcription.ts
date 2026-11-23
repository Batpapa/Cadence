// ── A recording written out as ABC ───────────────────────────────────────────
// The hidden transcription (2026-11-23, the user; transcribeRecording.tsx): the notes
// FolkFriend's fork hears (FolkFriendWASM.transcribe_notes — the pitch-class decoder, each
// note with the energy of every octave of its class), turned into a tune: octaves, quavers,
// repeated notes, metre, bars, key, then the ABC text.
//
// Every choice below was measured (research record outside the repo:
// transcription-bench/JOURNAL.md). Judges: the tuneset corpus (Beauguitte, Duggan & Kelleher,
// ISMIR 2016 — the only public Irish recordings annotated note by note: 13 session
// recordings, 2 solo flutes), 180 tunes of Cadence's annotated sessions against their
// TheSession settings (relative only: people do not play the setting), a classical flute
// corpus as a control. On tuneset, note F-measure (onset 50 ms, exact pitch): this chain
// 75.0 %, FolkFriend's 48-note transcription 65.9 %, Basic Pitch (NeuralNote's model) 55 %,
// pYIN + Tony 27-43 %.
//
// Self-contained on purpose, like liveTempo.ts: Node runs it as it is for the bench. The
// worker hands it what the engines give (scoreFollowWorker.ts).

/** FolkFriend's frames: 48 notes from MIDI 48 (C3). */
const MIDI_LOW = 48;
const PITCHES = 48;
const OCTAVES = 4;

/** A note of the pitch-class decoder: its class (0 = C), first frame, frames, power (as the
 *  decoder normalised it) and its class's energy at each octave from MIDI_LOW up. */
export interface ClassNote {
  cls: number;
  start: number;
  frames: number;
  power: number;
  octaves: number[];
}

/** transcribe_notes' flat array: 8 values a note. */
export function classNotes(flat: ArrayLike<number>): ClassNote[] {
  const out: ClassNote[] = [];
  for (let i = 0; i + 8 <= flat.length; i += 8) {
    out.push({
      cls: flat[i]!, start: flat[i + 1]!, frames: flat[i + 2]!, power: flat[i + 3]!,
      octaves: [flat[i + 4]!, flat[i + 5]!, flat[i + 6]!, flat[i + 7]!],
    });
  }
  return out;
}

// ── Notes and their octaves ──────────────────────────────────────────────────

/** FolkFriend's own note filter (decode/contour.rs): weaker or shorter notes are dropped
 *  before quantisation — cuts and strikes among them. Measured: the best on tuneset of 2-8
 *  frames and 0.05-0.3. */
const MIN_POWER = 0.1;
const MIN_FRAMES = 3;

/** The octave of each note: a Viterbi path over the notes, each octave scored by the log of
 *  its share of the class's energy (`EPS` keeps an unheard octave possible), each leap
 *  costing `LEAP_COST` a semitone — a melody line moves by steps. On tuneset, against the
 *  loudest octave alone: note F 64.9 -> 75.0 %; flat between 0.4 and 1.0 a semitone. On the
 *  sessions (nothing tuned there): exact pitch sequences 68.0 -> 75.4 %. */
const LEAP_COST = 0.6;
const EPS = 0.02;

/** A heard note: MIDI pitch, first frame, frames. */
export interface HeardNote {
  pitch: number;
  start: number;
  frames: number;
}

export function withOctaves(notes: ClassNote[]): HeardNote[] {
  const kept = notes.filter(n => n.power > MIN_POWER && n.frames >= MIN_FRAMES);
  const n = kept.length;
  if (!n) return [];
  const score = new Float64Array(n * OCTAVES);
  const back = new Int8Array(n * OCTAVES);
  const emission = (k: number, o: number): number => {
    const e = kept[k]!.octaves;
    let sum = 0;
    for (const x of e) sum += x;
    return Math.log(EPS + (sum > 0 ? e[o]! / sum : 0));
  };
  for (let o = 0; o < OCTAVES; o++) score[o] = emission(0, o);
  for (let k = 1; k < n; k++) {
    const c = kept[k]!.cls, pc = kept[k - 1]!.cls;
    for (let o = 0; o < OCTAVES; o++) {
      let best = -Infinity, arg = 0;
      for (let q = 0; q < OCTAVES; q++) {
        const v = score[(k - 1) * OCTAVES + q]! - LEAP_COST * Math.abs(c + 12 * o - (pc + 12 * q));
        if (v > best) { best = v; arg = q; }
      }
      score[k * OCTAVES + o] = best + emission(k, o);
      back[k * OCTAVES + o] = arg;
    }
  }
  let o = 0;
  for (let q = 1; q < OCTAVES; q++) if (score[(n - 1) * OCTAVES + q]! > score[(n - 1) * OCTAVES + o]!) o = q;
  const out: HeardNote[] = new Array(n);
  for (let k = n - 1; k >= 0; k--) {
    const note = kept[k]!;
    out[k] = { pitch: MIDI_LOW + note.cls + 12 * o, start: note.start, frames: note.frames };
    o = back[k * OCTAVES + o]!;
  }
  return out;
}

// ── The quaver grid ──────────────────────────────────────────────────────────
// Rounding each note on its own (FolkFriend's quantisation) gets the rhythm right but lets
// the bars drift: a quaver gained or lost here and there shifts every bar after it. A grid
// that follows the playing instead (Ellis 2007, "Beat tracking by dynamic programming", at
// the quaver): grid points landing on the novelty curve and on the notes' onsets, each step
// near the quaver period. Bar lines then stay where they belong: 76 % of them can be put on
// a true downbeat, against 38 % with the notes rounded alone (score following as the truth).

/** The pull towards the period: log-squared penalty of a step (librosa's default). */
const TIGHTNESS = 100;
/** The notes' onsets added to the novelty, in its standard deviations. */
const ONSET_WEIGHT = 3;

/** Grid frames over `signal` for a period of `P` frames. */
export function quaverGrid(signal: ArrayLike<number>, P: number): number[] {
  const n = signal.length;
  let mean = 0, sd = 0;
  for (let t = 0; t < n; t++) mean += signal[t]!;
  mean /= n || 1;
  for (let t = 0; t < n; t++) sd += (signal[t]! - mean) ** 2;
  sd = Math.sqrt(sd / (n || 1)) || 1;
  const lo = Math.max(1, Math.round(P / 2)), hi = Math.round(2 * P);
  // the step penalty, once per step length
  const penalty = new Float64Array(hi + 1);
  for (let d = lo; d <= hi; d++) penalty[d] = TIGHTNESS * Math.log(d / P) ** 2;
  const score = new Float64Array(n);
  const back = new Int32Array(n).fill(-1);
  for (let t = 0; t < n; t++) {
    let best = 0, arg = -1;
    const from = Math.max(0, t - hi);
    for (let u = t - lo; u >= from; u--) {
      const v = score[u]! - penalty[t - u]!;
      if (v > best) { best = v; arg = u; }
    }
    score[t] = signal[t]! / sd + best;
    back[t] = arg;
  }
  let t = n - 1;
  for (let k = Math.max(0, n - Math.round(P)); k < n; k++) if (score[k]! > score[t]!) t = k;
  const grid: number[] = [];
  while (t >= 0) { grid.push(t); t = back[t]!; }
  return grid.reverse();
}

/** The novelty with the notes' onsets added (ONSET_WEIGHT standard deviations). */
function gridSignal(novelty: ArrayLike<number>, notes: HeardNote[]): Float32Array {
  const sig = Float32Array.from(novelty);
  let mean = 0, sd = 0;
  for (const v of sig) mean += v;
  mean /= sig.length || 1;
  for (const v of sig) sd += (v - mean) ** 2;
  sd = Math.sqrt(sd / (sig.length || 1));
  for (const n of notes) if (n.start >= 0 && n.start < sig.length) sig[n.start] = sig[n.start]! + ONSET_WEIGHT * sd;
  return sig;
}

/** A note on the grid: its grid index and length in quavers. */
export interface GridNote {
  pitch: number;
  at: number;
  quavers: number;
  /** Quavers it actually sounds: a note followed by a silence of a crotchet or more
   *  sounds for less than it lasts (a rest is written after it). */
  sounds: number;
}

/** Each note at the grid point nearest its onset (strictly after the previous one), lasting
 *  until the next note; the last one its own length. */
function onGrid(notes: HeardNote[], grid: number[], P: number): GridNote[] {
  const at: number[] = [];
  let g = 0;
  for (const n of notes) {
    while (g + 1 < grid.length && Math.abs(grid[g + 1]! - n.start) <= Math.abs(grid[g]! - n.start)) g++;
    at.push(at.length && g <= at[at.length - 1]! ? at[at.length - 1]! + 1 : g);
  }
  return notes.map((n, i) => {
    const own = Math.max(1, Math.round(n.frames / P));
    const quavers = i + 1 < notes.length ? at[i + 1]! - at[i]! : own;
    return { pitch: n.pitch, at: at[i]!, quavers, sounds: Math.min(own, quavers) };
  });
}

/** Max of the novelty within 2 frames of `f`: the accent heard there. */
function accentAt(novelty: ArrayLike<number>, f: number): number {
  let m = 0;
  for (let u = Math.max(0, f - 2); u <= f + 2 && u < novelty.length; u++) if (novelty[u]! > m) m = novelty[u]!;
  return m;
}

/** Repeated notes: the decoder hears "A A A" as one long A (13 % of the notes of the
 *  settings repeat the one before). A long note re-attacked at one of its inner grid points
 *  — an accent over SPLIT x the median accent of the onsets — is split there. Against the
 *  notes as written (pitch and length): 57.9 -> 64.8 %. */
const SPLIT = 0.7;

function splitRepeats(notes: GridNote[], grid: number[], novelty: ArrayLike<number>): GridNote[] {
  const accents = notes.map(n => accentAt(novelty, grid[n.at]!)).sort((a, b) => a - b);
  const threshold = SPLIT * (accents[accents.length >> 1] || 1);
  const out: GridNote[] = [];
  for (const n of notes) {
    let from = n.at;
    const end = n.at + n.quavers;
    for (let k = n.at + 1; k < end && k < grid.length; k++) {
      if (k - n.at >= n.sounds) break; // in the silence after it
      if (accentAt(novelty, grid[k]!) > threshold) {
        out.push({ pitch: n.pitch, at: from, quavers: k - from, sounds: k - from });
        from = k;
      }
    }
    out.push({ pitch: n.pitch, at: from, quavers: end - from, sounds: Math.max(1, n.sounds - (from - n.at)) });
  }
  return out;
}

// ── Metre ────────────────────────────────────────────────────────────────────
// Binary (reels, hornpipes, polkas: 4/4) or ternary (jigs, slides, slip jigs: 6/8), from how
// much the accents repeat at 3, 6, 12 quavers against 2, 4, 8, and the melody at 24, 48
// quavers (4 and 8 bars of a jig) against 32, 64 (of a reel). 95.1 % right, cross-validated
// by session, with no weight fitted (1 and 0 came out of the fit anyway). 9/8 and 12/8 could
// not be told from 6/8 (4 and 2 examples): written 6/8.

export type Metre = '4/4' | '6/8';

/** The autocorrelation of `x` at a fractional lag, over its variance. */
function autocorrelation(x: ArrayLike<number>, mean: number, L: number): number {
  const i = Math.floor(L), f = L - i;
  let s = 0, n = 0;
  for (let t = i + 1; t < x.length; t++) {
    s += (x[t]! - mean) * (x[t - i]! * (1 - f) + x[t - i - 1]! * f - mean);
    n++;
  }
  return n ? s / n : 0;
}

/** Mean cosine similarity of chroma frames `L` apart (`chroma`: frames x 12). */
function chromaSimilarity(chroma: Float32Array, norms: Float32Array, L: number): number {
  const n = norms.length;
  let s = 0, k = 0;
  for (let t = L; t < n; t++) {
    const a = norms[t]!, b = norms[t - L]!;
    if (!(a > 0 && b > 0)) continue;
    let d = 0;
    for (let c = 0; c < 12; c++) d += chroma[t * 12 + c]! * chroma[(t - L) * 12 + c]!;
    s += d / (a * b);
    k++;
  }
  return k ? s / k : 0;
}

/** The metre of a recording: its novelty, its 48-note energies (frames x PITCHES), the
 *  quaver period in frames. */
export function metreOf(novelty: ArrayLike<number>, features: Float32Array, P: number): Metre {
  const n = novelty.length;
  let mean = 0;
  for (let t = 0; t < n; t++) mean += novelty[t]!;
  mean /= n || 1;
  const var0 = autocorrelation(novelty, mean, 0) || 1;
  const frames = Math.floor(features.length / PITCHES);
  const chroma = new Float32Array(frames * 12), norms = new Float32Array(frames);
  for (let t = 0; t < frames; t++) {
    for (let p = 0; p < PITCHES; p++) chroma[t * 12 + (p % 12)] += features[t * PITCHES + p]!;
    let q = 0;
    for (let c = 0; c < 12; c++) q += chroma[t * 12 + c]! ** 2;
    norms[t] = Math.sqrt(q);
  }
  const fits = (m: number) => m * P * 1.03 < n - 10;
  // the best over lags within 3 % of m quavers (accents), 2 % (melody)
  const accents = (m: number): number => {
    if (!fits(m)) return 0;
    let best = -Infinity;
    for (let L = m * P * 0.97; L <= m * P * 1.03; L += 0.25) best = Math.max(best, autocorrelation(novelty, mean, L));
    return best / var0;
  };
  const melody = (m: number): number => {
    if (!fits(m)) return 0;
    let best = -Infinity;
    for (let L = Math.round(m * P * 0.98); L <= Math.round(m * P * 1.02); L++) best = Math.max(best, chromaSimilarity(chroma, norms, L));
    return best;
  };
  const d = accents(3) + accents(6) + accents(12) - accents(2) - accents(4) - accents(8)
    + melody(24) + melody(48) - melody(32) - melody(64);
  return d > 0 ? '6/8' : '4/4';
}

// ── Bars ─────────────────────────────────────────────────────────────────────
// Where the bars start: each grid position weighs the accent of a note starting there and
// the note's length (a long note falls on a strong beat), against the metre's pattern of
// strong and weak quavers. The phase is followed through the recording (a Viterbi path, a
// slip of a quaver costing SLIP x the mean weight), the grid sometimes gaining or losing a
// step. With score following as the truth, bar lines on a true downbeat: 48 % on 30 s, 53 %
// on 60 s (chance 14 %; the best fixed phase 76 %), within half a bar 71 / 74 %. A learned
// model (structured perceptron, cross-validated) did no better.

const PATTERN: Record<Metre, number[]> = { '4/4': [4, 0, 1, 0, 2, 0, 1, 0], '6/8': [3, 0, 0, 2, 0, 0] };
const LENGTH_WEIGHT = 0.3;
const SLIP = 20;

/** For each grid position, whether a bar starts there. */
function barStarts(notes: GridNote[], gridLength: number, grid: number[], novelty: ArrayLike<number>, metre: Metre): boolean[] {
  const B = PATTERN[metre].length, pattern = PATTERN[metre];
  const accent = new Float64Array(gridLength), length = new Float64Array(gridLength);
  for (const n of notes) { accent[n.at] = accentAt(novelty, grid[n.at]!); length[n.at] = n.quavers - 1; }
  let sum = 0, count = 0;
  for (const a of accent) if (a) { sum += a; count++; }
  const meanAccent = count ? sum / count : 1;
  const w = Array.from(accent, (a, k) => a + LENGTH_WEIGHT * length[k]! * meanAccent);
  const meanW = w.reduce((a, b) => a + b, 0) / (w.length || 1) || 1;
  let score = new Float64Array(B);
  const back: Int8Array[] = [];
  for (let k = 0; k < gridLength; k++) {
    const next = new Float64Array(B), from = new Int8Array(B);
    for (let phi = 0; phi < B; phi++) {
      let best = -Infinity, arg = phi;
      for (const d of [0, 1, B - 1]) {
        const q = (phi + d) % B;
        const v = score[q]! - (d ? SLIP * meanW : 0);
        if (v > best) { best = v; arg = q; }
      }
      next[phi] = best + w[k]! * pattern[(((k - phi) % B) + B) % B]!;
      from[phi] = arg;
    }
    score = next;
    back.push(from);
  }
  const starts = new Array<boolean>(gridLength).fill(false);
  let phi = 0;
  for (let q = 1; q < B; q++) if (score[q]! > score[phi]!) phi = q;
  for (let k = gridLength - 1; k >= 0; k--) {
    starts[k] = (((k - phi) % B) + B) % B === 0;
    phi = back[k]![phi]!;
  }
  return starts;
}

// ── The tune ─────────────────────────────────────────────────────────────────

/** A recording transcribed, before it is written: notes on the grid, where bars start. */
export interface Transcription {
  notes: GridNote[];
  /** For each grid position, whether a bar starts there. */
  bars: boolean[];
  /** The frame of each grid position. */
  grid: number[];
  metre: Metre;
  /** Quavers a second. */
  rate: number;
}

/** `classes`: transcribe_notes' output; `novelty`: liveTempo's Novelty of the 48-note
 *  energies `features` (frames x PITCHES); all at `fps` frames a second, the same frames;
 *  `rate`: the quaver rate (liveTempo's estimateRate). Null when no tune was heard. */
export function transcribe(classes: ArrayLike<number>, novelty: ArrayLike<number>, features: Float32Array, fps: number, rate: number): Transcription | null {
  const heard = withOctaves(classNotes(classes));
  if (heard.length < 2 || !(rate > 0)) return null;
  const P = fps / rate;
  const grid = quaverGrid(gridSignal(novelty, heard), P);
  if (grid.length < 2) return null;
  const placed = onGrid(heard, grid, P);
  // a grid index past the grid (notes crowding its end) reads its last point
  const frameOf = [...grid];
  while (frameOf.length < placed[placed.length - 1]!.at + 1) frameOf.push(grid[grid.length - 1]!);
  const metre = metreOf(novelty, features, P);
  const last = placed[placed.length - 1]!;
  // the bars from the notes as heard (measured so), before the repeated notes are split
  const bars = barStarts(placed, last.at + last.quavers, frameOf, novelty, metre);
  return { notes: splitRepeats(placed, frameOf, novelty), bars, grid: frameOf, metre, rate };
}

/** One MIDI pitch a quaver, rests left out: what FolkFriend's key detection reads. */
export function quaverContour(t: Transcription): number[] {
  const out: number[] = [];
  for (const n of t.notes) for (let k = 0; k < n.sounds; k++) out.push(n.pitch);
  return out;
}

// ── Keys and spelling ────────────────────────────────────────────────────────

export type Mode = 'maj' | 'min' | 'dor' | 'mix';
const MODE_DEGREE: Record<Mode, { semitones: number; step: number }> = {
  maj: { semitones: 0, step: 0 }, dor: { semitones: 2, step: 1 }, mix: { semitones: 7, step: 4 }, min: { semitones: 9, step: 5 },
};
const LETTERS = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
const NATURAL: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const MAJOR = [0, 2, 4, 5, 7, 9, 11];
/** The major key of each pitch class, by its simplest signature. */
const MAJOR_NAME = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];

/** A key: its signature (each letter's alteration) and its ABC name. */
export interface Key {
  name: string;
  signature: Record<string, number>;
  /** Flats in the signature: an accidental off the scale is written flat. */
  flat: boolean;
}

export function makeKey(tonic: number, mode: Mode): Key {
  const parent = (((tonic - MODE_DEGREE[mode].semitones) % 12) + 12) % 12;
  const name = MAJOR_NAME[parent]!;
  const root = LETTERS.indexOf(name[0]!);
  const signature: Record<string, number> = {};
  const scale = MAJOR.map((step, i) => {
    const letter = LETTERS[(root + i) % 7]!;
    let alt = (parent + step - NATURAL[letter]! + 24) % 12;
    if (alt > 6) alt -= 12;
    signature[letter] = alt;
    return { letter, alt };
  });
  const t = scale[MODE_DEGREE[mode].step]!;
  const flat = Object.values(signature).some(a => a < 0);
  return { name: `${t.letter}${t.alt > 0 ? '#' : t.alt < 0 ? 'b' : ''}${mode}`, signature, flat };
}

/** The key of FolkFriend's ABC (its "K:" line, contour_to_abc), or null. */
export function keyOfAbc(abc: string): Key | null {
  const m = /^K:([A-G])([#b]?)(maj|min|dor|mix)/m.exec(abc);
  if (!m) return null;
  const tonic = (NATURAL[m[1]!]! + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0) + 12) % 12;
  return makeKey(tonic, m[3] as Mode);
}

/** A MIDI pitch's letter and alteration in `key`: in the scale as the signature has it,
 *  otherwise a natural where one fits, else a sharp (a flat in a flat key). */
function spell(midi: number, key: Key): { letter: string; alt: number } {
  const pc = ((midi % 12) + 12) % 12;
  for (const l of LETTERS) if ((NATURAL[l]! + key.signature[l]! + 12) % 12 === pc) return { letter: l, alt: key.signature[l]! };
  for (const l of LETTERS) if (NATURAL[l] === pc) return { letter: l, alt: 0 };
  for (const l of LETTERS) if ((NATURAL[l]! + (key.flat ? -1 : 1) + 12) % 12 === pc) return { letter: l, alt: key.flat ? -1 : 1 };
  return { letter: 'C', alt: 0 };
}

/** ABC of `letter` sounding `midi` (alteration `alt`): C4 = 60 is "C", C5 "c". */
function abcPitch(letter: string, alt: number, midi: number): string {
  const octave = Math.floor((midi - alt) / 12) - 1;
  if (octave >= 5) return letter.toLowerCase() + "'".repeat(octave - 5);
  return letter + ','.repeat(Math.max(0, 4 - octave));
}

// ── The ABC text ─────────────────────────────────────────────────────────────

/** Lengths one ABC note can show with L:1/8, longest first: a longer or odd one is tied. */
const LENGTHS = [12, 8, 6, 4, 3, 2, 1];
/** Quavers beamed together: half a 4/4 bar, a beat of 6/8. */
const GROUP: Record<Metre, number> = { '4/4': 4, '6/8': 3 };
const BARS_PER_LINE = 4;
/** A silence after a note is written from a crotchet on; shorter, the note is held. */
const MIN_REST = 2;

/** The M:, L:, Q:, K: lines and the body of a transcription in `key` (the caller adds X:
 *  and T:). */
export function writeAbc(t: Transcription, key: Key): string {
  // notes and rests (pitch null), each from grid position `at`
  const events: { pitch: number | null; at: number; len: number }[] = [];
  for (const n of t.notes) {
    const rest = n.quavers - n.sounds;
    if (rest >= MIN_REST) {
      events.push({ pitch: n.pitch, at: n.at, len: n.sounds });
      events.push({ pitch: null, at: n.at + n.sounds, len: rest });
    } else events.push({ pitch: n.pitch, at: n.at, len: n.quavers });
  }
  const isBar = (k: number) => t.bars[k] === true;
  let out = '';
  let barsOnLine = 0;
  let inBar = 0; // quavers since the bar's start (or the first note, in a pickup)
  let accidentals = new Map<string, number>();
  let started = false;
  let previous = 0; // the length of the note before, in its bar
  for (const e of events) {
    let at = e.at, left = e.len;
    while (left > 0) {
      if (isBar(at)) {
        if (started) {
          out += ' |';
          barsOnLine++;
          if (barsOnLine >= BARS_PER_LINE) { out += '\n'; barsOnLine = 0; } else out += ' ';
        }
        inBar = 0;
        previous = 0;
        accidentals = new Map();
      }
      started = true;
      // up to the next bar line, then the longest length a note can show
      let room = 1;
      while (room < left && !isBar(at + room)) room++;
      const len = LENGTHS.find(l => l <= room)!;
      // quavers beamed by groups; a crotchet or longer has no beam, set apart
      if (inBar > 0 && (inBar % GROUP[t.metre] === 0 || len > 1 || previous > 1)) out += ' ';
      previous = len;
      if (e.pitch === null) out += 'z';
      else {
        const { letter, alt } = spell(e.pitch, key);
        // accidentals hold for the rest of the bar, at their octave
        const id = abcPitch(letter, 0, e.pitch - alt);
        const current = accidentals.get(id) ?? key.signature[letter]!;
        if (current !== alt) {
          out += alt === 1 ? '^' : alt === -1 ? '_' : '=';
          accidentals.set(id, alt);
        }
        out += abcPitch(letter, alt, e.pitch);
      }
      if (len > 1) out += String(len);
      at += len;
      left -= len;
      inBar += len;
      if (left > 0 && e.pitch !== null) out += '-';
    }
  }
  const tempo = t.metre === '6/8' ? `3/8=${Math.round(t.rate * 20)}` : `1/4=${Math.round(t.rate * 30)}`;
  return [`M:${t.metre}`, 'L:1/8', `Q:${tempo}`, `K:${key.name}`, `${out.trim()} |]`].join('\n');
}

