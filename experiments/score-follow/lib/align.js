'use strict';
// ── Score following: align a recorded performance to a known score ───────────
// Proof of concept (2026-10-28). The recognition engine says WHICH tune is
// played; this says WHERE in its score the musicians are, frame by frame, so a
// score cursor can follow the real recording.
//
// Inputs
//   features: Float32Array, frames × 48 pitch energies (MIDI 48..95), straight
//             from FolkFriend's feature extractor (`take_features`), ~46.9 fps.
//   score:    MIDI pitches, one per quaver, repeats unfolded — exactly the
//             index's `contour` of the setting (one pass of the tune).
//
// Model: a hidden semi-Markov model. Each quaver of the score is a segment of
// free length around the nominal quaver length at the candidate tempo; after
// the last quaver the score loops to the first (the tune is played several
// times). Frames before the first and after the last aligned quaver belong to
// a "not this tune" state. The emission of a frame for a pitch is the log of
// that pitch's share of the frame's energy, octaves folded in (fiddle and
// whistle are often heard an octave off).

const MIDI_LOW = 48;
const MIDI_NUM = 48;
const FPS = 48000 / 1024;

/** Per-frame log share of each pitch, octave-folded. Quiet frames carry no
 *  information: every pitch gets the same value there. */
function emissions(features, frames, { octaveWeight = 0.6, floor = 0.01 } = {}) {
  const L = new Float32Array(frames * MIDI_NUM);
  const energy = new Float32Array(frames);
  for (let t = 0; t < frames; t++) {
    let sum = 0;
    for (let p = 0; p < MIDI_NUM; p++) sum += features[t * MIDI_NUM + p];
    energy[t] = sum;
  }
  const sorted = Array.from(energy).sort((a, b) => a - b);
  const loud = sorted[Math.floor(sorted.length * 0.9)] || 1;
  for (let t = 0; t < frames; t++) {
    const sum = energy[t];
    const quiet = sum < loud * 0.05;
    for (let p = 0; p < MIDI_NUM; p++) {
      if (quiet) { L[t * MIDI_NUM + p] = Math.log(floor + 1 / MIDI_NUM); continue; }
      const e = (q) => (q >= 0 && q < MIDI_NUM ? features[t * MIDI_NUM + q] / sum : 0);
      const share = e(p) + octaveWeight * Math.max(e(p - 12), e(p + 12));
      L[t * MIDI_NUM + p] = Math.log(floor + share);
    }
  }
  return L;
}

/** Cumulative emission per pitch: seg(p, a, b) = C[p][b] - C[p][a]. */
function cumulate(L, frames) {
  const C = new Float64Array(MIDI_NUM * (frames + 1));
  for (let p = 0; p < MIDI_NUM; p++) {
    const row = p * (frames + 1);
    for (let t = 0; t < frames; t++) C[row + t + 1] = C[row + t] + L[t * MIDI_NUM + p];
  }
  return C;
}

/** Cumulative score of "not this tune": another tune (the frame's best pitch
 *  minus a penalty) or noise (a floor). Kept in step with src/session/scoreFollow.ts. */
function cumulateOther(L, frames, penalty, noiseFloor) {
  const G = new Float64Array(frames + 1);
  for (let t = 0; t < frames; t++) {
    let top = -Infinity;
    for (let p = 0; p < MIDI_NUM; p++) top = Math.max(top, L[t * MIDI_NUM + p]);
    G[t + 1] = G[t] + Math.max(top - penalty, noiseFloor);
  }
  return G;
}

/** One alignment at one tempo and one transposition.
 *  Returns { score, onsets } — onsets[k] = { frame, index } for every quaver
 *  entered, in order (index into `score`, the pass is implicit in the order). */
function alignAt(C, G, frames, score, framesPerQuaver, transpose, opt) {
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

  // best[t*N + i]: best score of a path whose quaver i ENDS at frame t.
  const best = new Float64Array((frames + 1) * N).fill(-Infinity);
  const from = new Int16Array((frames + 1) * N); // segment length; negative = entered from "not this tune"
  for (let t = 1; t <= frames; t++) {
    for (let i = 0; i < N; i++) {
      const prevI = i === 0 ? N - 1 : i - 1;
      const row = rowOf[i];
      let b = -Infinity, arg = 0;
      const top = Math.min(dMax, t);
      for (let k = dMin; k <= top; k++) {
        const s = t - k;
        const seg = C[row + t] - C[row + s] + pen[k];
        const viaPrev = best[s * N + prevI];
        const viaStart = G[s]; // everything before s was another tune
        if (viaPrev >= viaStart) {
          if (viaPrev + seg > b) { b = viaPrev + seg; arg = k; }
        } else if (viaStart + seg > b) { b = viaStart + seg; arg = -k; }
      }
      best[t * N + i] = b;
      from[t * N + i] = arg;
    }
  }
  // End: anywhere, the rest is "not this tune".
  let endT = 0, endI = -1, total = G[frames];
  for (let t = 1; t <= frames; t++) {
    for (let i = 0; i < N; i++) {
      const v = best[t * N + i] + G[frames] - G[t];
      if (v > total) { total = v; endT = t; endI = i; }
    }
  }
  const onsets = [];
  let t = endT, i = endI;
  while (i >= 0 && t > 0) {
    const k = from[t * N + i];
    const s = t - Math.abs(k);
    onsets.push({ frame: s, index: i });
    if (k < 0) break;
    t = s;
    i = i === 0 ? N - 1 : i - 1;
  }
  onsets.reverse();
  return { score: total, onsets, end: endT };
}

const DEFAULTS = {
  minRatio: 0.45, maxRatio: 2.2, durWeight: 2.0,
  otherPenalty: 1.2, // see scoreFollow.ts
  noiseFloor: Math.log(0.01 + 2 / MIDI_NUM),
  // Crotchets per minute, FolkFriend's convention (one contour symbol = a
  // quaver). Session reels run near 190-230: measured 2026-10-28, a 256-quaver
  // pass in 40 s.
  bpms: [80, 100, 120, 140, 160, 180, 200, 220, 240, 260],
  transposes: [0],
};

const TEMPO_PROBE_FRAMES = Math.round(30 * FPS);

/** Best alignment: tempo and transposition chosen on a 30 s probe from a
 *  quarter in (every candidate, then ±5), then ONE alignment of the whole —
 *  the app's scheme (scoreFollow.ts). `{ exhaustive: true }` restores the
 *  earlier search (every tempo on the whole, then ±5/±10), for comparison. */
function align(features, score, options = {}) {
  const opt = { ...DEFAULTS, ...options };
  const frames = features.length / MIDI_NUM;
  const fpq = (bpm) => FPS / ((bpm / 60) * 2);
  const prepare = (f, n) => {
    const L = emissions(f, n, opt);
    return { n, C: cumulate(L, n), G: cumulateOther(L, n, opt.otherPenalty, opt.noiseFloor) };
  };
  const coarse = opt.transposes.flatMap((transpose) => opt.bpms.map((bpm) => ({ bpm, transpose })));
  const search = (p, tempi) => {
    let top = null;
    for (const t of tempi) {
      if (t.bpm <= 0) continue;
      const r = alignAt(p.C, p.G, p.n, score, fpq(t.bpm), t.transpose, opt);
      if (!top || r.score > top.score) top = { ...r, ...t };
    }
    return top;
  };
  const whole = prepare(features, frames);
  let best;
  if (opt.exhaustive) {
    const rough = search(whole, coarse);
    const fine = search(whole, [-10, -5, 5, 10].map((d) => ({ bpm: rough.bpm + d, transpose: rough.transpose })));
    best = fine && fine.score > rough.score ? fine : rough;
  } else {
    const n = Math.min(frames, TEMPO_PROBE_FRAMES);
    const at = Math.max(0, Math.min(Math.floor(frames / 4), frames - n));
    const probe = n === frames ? whole : prepare(features.subarray(at * MIDI_NUM, (at + n) * MIDI_NUM), n);
    const rough = search(probe, coarse);
    const fine = search(probe, [-5, 5].map((d) => ({ bpm: rough.bpm + d, transpose: rough.transpose })));
    const tempo = fine && fine.score > rough.score ? fine : rough;
    best = n === frames ? tempo : { ...alignAt(whole.C, whole.G, frames, score, fpq(tempo.bpm), tempo.transpose, opt), bpm: tempo.bpm, transpose: tempo.transpose };
  }
  best.frames = frames;
  return best;
}

module.exports = { align, emissions, FPS, MIDI_LOW, MIDI_NUM };
