import type { Detection } from '../model';

// ── The arithmetic behind the bound editor ───────────────────────────────────
// Pure, and in its own file for the same reason timelineModel.ts is: these
// rules are the subtle half of the editor and deserve tests, which importing
// the component itself cannot give (it drags in the store, mediabunny and the
// modal shell with it).

/** How much of the recording the context strip shows on each side of the
 *  detection.
 *
 *  A view rule, not a leash: the window is recomputed from the bounds as they
 *  move, so pulling a bound back uncovers what lies before it instead of
 *  running into an edge, and a bound may go anywhere in the recording
 *  (2026-09-20, user request — it was fixed at open time for one day, which
 *  made the decoding job knowable in advance but walled off the one case where
 *  a bound is badly wrong). The audio the move exposes is decoded when it is
 *  exposed; see the editor's `ensureDecoded`. */
export const CTX_PAD_S = 30;

/** Past this much audio, the context strip goes without its waveform.
 *
 *  Only the context strip: the magnifier keeps its own whatever the detection's
 *  length, because it only ever looks at a dozen seconds and that decodes in a
 *  fraction of one. The cap spends the budget on the scenery, never on the
 *  place the precise work happens. */
export const CTX_MAX_WAVE_S = 600;

/** Half-width of the magnifier's view: 8 s across, so a second is roughly
 *  45 px on a phone — against 2 px in the context strip on a three-minute
 *  detection, which is why there are two strips at all. */
export const LOUPE_HALF_S = 4;

/** Half-width of what the magnifier DECODES, wider than what it shows so a
 *  small drag does not run off the end of the decoded audio. */
export const LOUPE_DECODE_HALF_S = 6;

/** How close a bound has to come before it clicks onto a mark. Wide enough to
 *  be reachable with a thumb, far below the second of error being corrected. */
export const SNAP_TOLERANCE_S = 0.3;

/** A detection may not be squeezed below this. Not a musical rule — just a
 *  floor that keeps the two handles from swapping places. */
export const MIN_SPAN_S = 1;

/** Resolution of the peak array both strips read from: one value per 10 ms.
 *  Fine enough for the magnifier (8 s across ≈ 800 values, about two per
 *  pixel), and a three-minute window is still only 18 000 floats. */
export const PEAK_BUCKET_S = 0.01;

/** Somewhere the active bound can click onto.
 *
 *  `kind` decides how it is drawn and what it is called; the label itself is
 *  built by the component, which is the only part that may speak to the user. */
export interface SnapMark {
  t: number;
  /** A neighbouring detection's bound, or this detection's other one. */
  kind: 'bound' | 'trough';
  /** The neighbour's name — absent for this detection's own other bound and
   *  for a silence. */
  name?: string;
  /** Which end of that detection the mark is. Absent for a silence. */
  edge?: 'start' | 'end';
}

/** What the editor shows and what its bounds may reach, fixed at open time.
 *  Clamped to the recording, so the edges of a session are safe. */
export function contextWindow(start: number, end: number, duration: number): [number, number] {
  return [Math.max(0, start - CTX_PAD_S), Math.min(duration, end + CTX_PAD_S)];
}

/** Whether the context strip gets a waveform at all. */
export function waveformFitsContext(win: [number, number]): boolean {
  return win[1] - win[0] <= CTX_MAX_WAVE_S;
}

/** The stretch the magnifier needs decoded for the bound to sit at `t`. */
export function loupeDecodeWindow(t: number, win: [number, number]): [number, number] {
  return [Math.max(win[0], t - LOUPE_DECODE_HALF_S), Math.min(win[1], t + LOUPE_DECODE_HALF_S)];
}

/** What of `want` is not covered by `have`, left to right.
 *
 *  The editor asks for audio as the view uncovers it, and asks repeatedly
 *  while a bound is being dragged: this is what keeps it from ordering the
 *  same seconds twice. `have` need not be sorted or disjoint.
 *
 *  Ranges shorter than `grain` are dropped — a sliver of a second is not worth
 *  opening a decoder for, and rounding the edges of a request is what stops a
 *  drag from producing a queue of one-pixel jobs. */
export function missingRanges(
  want: [number, number],
  have: Array<[number, number]>,
  grain = 1,
): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let cursor = want[0];
  for (const [lo, hi] of [...have].sort((a, b) => a[0] - b[0])) {
    if (hi <= cursor) continue;
    if (lo >= want[1]) break;
    if (lo > cursor) out.push([cursor, Math.min(lo, want[1])]);
    cursor = Math.max(cursor, hi);
    if (cursor >= want[1]) break;
  }
  if (cursor < want[1]) out.push([cursor, want[1]]);
  return out.filter(([a, b]) => b - a >= grain);
}

/** Puts a proposed value where it is allowed to be: inside `range` — the
 *  recording — and on its own side of the other bound. Returns the whole pair,
 *  since moving one bound is the only thing that can push the other. */
export function clampBound(
  field: 'start' | 'end',
  value: number,
  draft: { start: number; end: number },
  range: [number, number],
): { start: number; end: number } {
  const v = Math.max(range[0], Math.min(range[1], value));
  return field === 'start'
    ? { start: Math.min(v, draft.end - MIN_SPAN_S), end: draft.end }
    : { start: draft.start, end: Math.max(v, draft.start + MIN_SPAN_S) };
}

/** Every mark the active bound may click onto, in no particular order.
 *
 *  Neighbouring bounds are offered because a join is often meant to be exact —
 *  making one tune end where the next begins is a decision the user can state
 *  in one gesture instead of matching two numbers by hand. Overlaps are NOT
 *  forbidden by this: 22 of 37 joins on a real session overlap, and a mark is
 *  an offer, not a rail (see timelineModel.ts's own note).
 *
 *  `troughs` are the silences read off the waveform — absent when the
 *  recording is not on this device, which is why they arrive as an argument
 *  rather than being computed here. */
export function snapMarks(
  anns: Detection[],
  editedId: string,
  draft: { start: number; end: number },
  activeBound: 'start' | 'end',
  duration: number,
  troughs: number[],
): SnapMark[] {
  const out: SnapMark[] = [];
  for (const a of anns) {
    if (a.id === editedId) continue;
    out.push({ t: a.start, kind: 'bound', name: a.displayName, edge: 'start' });
    out.push({ t: a.end ?? duration, kind: 'bound', name: a.displayName, edge: 'end' });
  }
  // This detection's OTHER bound, so a very short tune can be closed exactly.
  out.push({ t: activeBound === 'start' ? draft.end : draft.start, kind: 'bound', edge: activeBound === 'start' ? 'end' : 'start' });
  for (const t of troughs) out.push({ t, kind: 'trough' });
  return out;
}

/** The mark `t` would click onto, or null. Nearest wins; ties go to the first
 *  in the list, which is stable because `snapMarks` builds it in a fixed order. */
export function findSnap(t: number, marks: SnapMark[], tolerance = SNAP_TOLERANCE_S): SnapMark | null {
  let best: SnapMark | null = null;
  let bestD = tolerance;
  for (const m of marks) {
    const d = Math.abs(m.t - t);
    if (d < bestD) { best = m; bestD = d; }
  }
  return best;
}

/** Longest run of near-silence to still count as bound slop rather than a
 *  place. Below this, a snap mark would land on the gap between two notes. */
const TROUGH_MIN_S = 0.4;
/** Share of the window's typical level under which the sound counts as absent. */
const TROUGH_RATIO = 0.45;
/** Half-width of the box the level is smoothed over before troughs are read,
 *  so the gaps BETWEEN notes do not each become a silence. */
const TROUGH_SMOOTH_S = 0.3;
/** A recording chopped into more holes than this is not telling us anything —
 *  offering hundreds of marks would make the snap a nuisance, not a help. */
const TROUGH_MAX = 60;

/** The silences in a decoded window, as instants to snap to.
 *
 *  Read off the peak envelope rather than the samples: a real pause between
 *  two sets shows there plainly, and that is the one boundary the ear and the
 *  eye agree on. Between two tunes OF a set there is no silence at all — the
 *  waveform says nothing there, which is exactly why the editor also draws
 *  the recogniser's own observation windows.
 *
 *  `from` is the window's start in session time; `peaks` holds one value per
 *  PEAK_BUCKET_S from there. Only the decoded head of the array is read, so
 *  this can be re-run while the rest is still arriving. */
export function findTroughs(peaks: Float32Array, from: number, decodedCount = peaks.length): number[] {
  const n = Math.min(decodedCount, peaks.length);
  if (n === 0) return [];
  const half = Math.round(TROUGH_SMOOTH_S / PEAK_BUCKET_S);

  // Box-smoothed level, via a running sum — the naive version is O(n·half),
  // which on a ten-minute window is 36 million additions for a strip nobody
  // is looking at yet.
  const smooth = new Float32Array(n);
  let sum = 0;
  for (let i = 0; i < Math.min(n, half + 1); i++) sum += peaks[i]!;
  for (let i = 0; i < n; i++) {
    const lo = i - half, hi = i + half;
    smooth[i] = sum / (Math.min(n - 1, hi) - Math.max(0, lo) + 1);
    if (hi + 1 < n) sum += peaks[hi + 1]!;
    if (lo >= 0) sum -= peaks[lo]!;
  }

  // The window's own typical level, so a quiet recording is read on its own
  // terms instead of against an absolute that would call all of it silence.
  const sorted = Float32Array.from(smooth).sort();
  const median = sorted[Math.floor(n / 2)] ?? 0;
  if (median <= 0) return [];
  const floor = median * TROUGH_RATIO;
  const minRun = Math.round(TROUGH_MIN_S / PEAK_BUCKET_S);

  const out: number[] = [];
  let i = 0;
  while (i < n && out.length < TROUGH_MAX) {
    if (smooth[i]! < floor) {
      let j = i;
      while (j < n && smooth[j]! < floor) j++;
      if (j - i >= minRun) out.push(from + ((i + j) / 2) * PEAK_BUCKET_S);
      i = j;
    } else i++;
  }
  return out;
}
