import { keyOffsetOf, type Detection, type WindowResult } from '../model';
import { wrapSemitones } from './playedPitch';
import { DETECTION_TEMPORAL_CONFIG } from './detectionTemporalConfig';

// ── The pitch split ──────────────────────────────────────────────────────────
// (2026-11-08, the user's idea) One tune detection is cut where the tune starts
// being played at another pitch: same pitch within a quarter tone = same
// detection. Run on each segment after the same-tune merge, so the main decode
// (which tunes, where) is untouched — tunes found and false positives cannot move.
//
// A small Viterbi over the segment's windows, its states the pitches the windows
// heard the tune at (playedPitch.ts). A window costs nothing in a state within
// `tolerance` of a pitch the tune was found at there; otherwise it costs what the
// tune loses by being read at that state's pitch — its score, minus its best
// score at a pitch within `tolerance` of the state (the "soft" cost: a window that
// reads the tune almost as well in both keys proves nothing — a B part that is
// the A part transposed, a window read a fourth off). Changing state costs
// `lambda`, in the same unit as a window's score. A window without the tune, or
// without a pitch (windows stored before), costs nothing anywhere.
//
// Measured (recognition-research/JOURNAL.md 17-17.2), lambda swept 0.2-1: on the
// 725 detections of the 18 annotated files, 0 cut, in the end or for a moment
// live; on 144 synthetic files (a real performance, then the same shifted), every
// change of 100 cents or more that the engine recognises is cut, 1.5 s from the
// junction (median), +40 cents and a slow drift of 0 -> 60 cents never are; on 84
// stress files (tunes whose B part is their A part transposed, played whole off
// their written key, or then shifted) nothing wrong. Plateau 0.5-0.6 — 0.4
// already cuts a stress file, 0.7 misses changes; 0.6 keeps away from the wrong
// cuts (a missed cut is what happened before; a wrong one is a regression). Live,
// the cut shows 13 s after the change (median).

export interface PitchSplitConfig {
  lambda: number;
  tolerance: number;
}

interface Pitched {
  index: number;
  score: number;
  pitch: number;
  others: readonly (readonly [number, number])[];
}

/** The best score the tune has in this window at a pitch within `tol` of `state`. */
function scoreNear(w: Pitched, state: number, tol: number): number {
  let best = Math.abs(wrapSemitones(w.pitch - state)) <= tol ? w.score : 0;
  for (const [p, s] of w.others) if (s > best && Math.abs(wrapSemitones(p - state)) <= tol) best = s;
  return best;
}

/** Score-weighted circular mean of pitches. */
function meanPitch(ws: readonly Pitched[]): number {
  let c = 0, s = 0;
  for (const w of ws) { const a = (2 * Math.PI * w.pitch) / 12; c += w.score * Math.cos(a); s += w.score * Math.sin(a); }
  return wrapSemitones((Math.atan2(s, c) * 12) / (2 * Math.PI));
}

/** The pitch `tuneId` was played at over windows [first, first + count): the
 *  score-weighted mean of the windows that carry one (DetectionAlternate.pitch),
 *  undefined when none does. Rounded like WindowCandidate.pitch. */
export function segmentPitch(windows: readonly WindowResult[], tuneId: string, first: number, count: number): number | undefined {
  const ws: Pitched[] = [];
  for (let i = first; i < first + count; i++) {
    const c = windows[i]?.candidates.find(x => x.tuneId === tuneId);
    if (c?.pitch !== undefined) ws.push({ index: i, score: c.score, pitch: c.pitch, others: [] });
  }
  return ws.length ? Math.round(meanPitch(ws) * 1000) / 1000 : undefined;
}

/** Whether two detections were played in the same key, as the pitch split
 *  judges it (within its tolerance) — what "merge with the previous one" asks
 *  (the user's rule, 2026-11-08: only in the same key). By the engine's pitch
 *  when both carry it for the same tune; else, when both were recognised in
 *  the same setting, by the transposition it was heard at; otherwise nothing
 *  tells them apart (an analysis made before, a tune named by hand) and the
 *  answer is yes, as it always was. */
export function samePlayedPitch(a: Detection, b: Detection): boolean {
  const pa = a.viterbiPick?.pitch, pb = b.viterbiPick?.pitch;
  if (pa !== undefined && pb !== undefined && a.viterbiPick.tuneId === b.viterbiPick.tuneId) {
    return Math.abs(wrapSemitones(pa - pb)) <= (DETECTION_TEMPORAL_CONFIG.pitchSplitTolerance ?? 0.5);
  }
  if (a.settingId === b.settingId) {
    const ka = keyOffsetOf(a), kb = keyOffsetOf(b);
    if (ka !== null && kb !== null) return ka === kb;
  }
  return true;
}

/** Window indices (of `windows`) where each part after the first begins, for the
 *  tune `tuneId` over windows [first, first + count): empty when it is one pitch
 *  throughout. A cut falls midway through any windows without a pitch between
 *  the two parts' pitched windows. */
export function pitchCuts(windows: readonly WindowResult[], tuneId: string, first: number, count: number, cfg: PitchSplitConfig): number[] {
  const { lambda, tolerance: tol } = cfg;
  const ws: Pitched[] = [];
  for (let i = first; i < first + count; i++) {
    const c = windows[i]?.candidates.find(x => x.tuneId === tuneId);
    if (c?.pitch === undefined) continue;
    ws.push({ index: i, score: c.score, pitch: c.pitch, others: c.otherPitches ?? [] });
  }
  if (ws.length < 2) return [];
  const off = (w: Pitched, s: number) => Math.max(0, w.score - scoreNear(w, s, tol));
  // states: the windows' own pitches, best scores first, one per tol/2
  const states: number[] = [];
  for (const w of [...ws].sort((a, b) => b.score - a.score)) {
    if (!states.some(s => Math.abs(wrapSemitones(s - w.pitch)) < tol / 2)) states.push(w.pitch);
  }
  const S = states.length, T = ws.length;
  let cost = states.map(s => off(ws[0]!, s));
  const back: number[][] = [];
  for (let t = 1; t < T; t++) {
    let bi = 0;
    for (let j = 1; j < S; j++) if (cost[j]! < cost[bi]!) bi = j;
    const next = new Array<number>(S), from = new Array<number>(S);
    for (let j = 0; j < S; j++) {
      const stay = cost[j]!, move = cost[bi]! + lambda;
      // a tie stays: changing pitch needs evidence
      if (stay <= move) { next[j] = stay; from[j] = j; } else { next[j] = move; from[j] = bi; }
      next[j]! += off(ws[t]!, states[j]!);
    }
    back.push(from);
    cost = next;
  }
  let j = 0;
  for (let i = 1; i < S; i++) if (cost[i]! < cost[j]!) j = i;
  const path = new Array<number>(T);
  path[T - 1] = j;
  for (let t = T - 1; t > 0; t--) { j = back[t - 1]![j]!; path[t - 1] = j; }
  // runs of one state are parts; neighbouring parts whose own pitches end up
  // within tol of each other are one
  const parts: Pitched[][] = [];
  let run: Pitched[] = [ws[0]!];
  for (let t = 1; t < T; t++) {
    if (path[t] === path[t - 1]) run.push(ws[t]!);
    else { parts.push(run); run = [ws[t]!]; }
  }
  parts.push(run);
  const merged: { ws: Pitched[]; pitch: number }[] = [];
  for (const p of parts) {
    const pitch = meanPitch(p);
    const prev = merged[merged.length - 1];
    if (prev && Math.abs(wrapSemitones(prev.pitch - pitch)) <= tol) {
      prev.ws.push(...p);
      prev.pitch = meanPitch(prev.ws);
    } else merged.push({ ws: p, pitch });
  }
  const cuts: number[] = [];
  for (let k = 1; k < merged.length; k++) {
    const last = merged[k - 1]!.ws[merged[k - 1]!.ws.length - 1]!.index;
    const next = merged[k]!.ws[0]!.index;
    cuts.push(last + 1 + Math.floor((next - last - 1) / 2));
  }
  return cuts;
}
