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

/** Somewhere the active bound can click onto: a neighbouring detection's
 *  bound, or this detection's other one. The label is built by the component,
 *  which is the only part that may speak to the user.
 *
 *  Silences were marks too until 2026-09-21 — troughs read off the envelope,
 *  at 45 % of the window's median level for at least 0.4 s. Dropped at the
 *  user's request: "je trouve ça plus juste de les lire à l'œil avec la forme
 *  de l'onde". The waveform already shows a real pause plainly, and a mark
 *  placed at the MIDDLE of one was answering a question nobody asked — where a
 *  bound belongs is the edge of the silence, and which edge depends on which
 *  bound. Do not reintroduce them without that answer. */
export interface SnapMark {
  t: number;
  /** The neighbour's name — absent for this detection's own other bound. */
  name?: string;
  /** Which end of that detection the mark is. */
  edge: 'start' | 'end';
  /** The detection the mark belongs to — absent for this detection's own
   *  other bound. What `findTwin` matches a linked neighbour by. */
  id?: string;
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
 *  A bound that is LINKED to ours is left out: it is travelling with us, so
 *  offering it would be offering to snap to where we already are. */
export function snapMarks(
  anns: Detection[],
  editedId: string,
  draft: { start: number; end: number },
  activeBound: 'start' | 'end',
  duration: number,
  linkedIds: ReadonlySet<string> = new Set(),
): SnapMark[] {
  const out: SnapMark[] = [];
  for (const a of anns) {
    if (a.id === editedId || linkedIds.has(a.id)) continue;
    out.push({ t: a.start, name: a.displayName, edge: 'start', id: a.id });
    out.push({ t: a.end ?? duration, name: a.displayName, edge: 'end', id: a.id });
  }
  // This detection's OTHER bound, so a very short tune can be closed exactly.
  out.push({ t: activeBound === 'start' ? draft.end : draft.start, edge: activeBound === 'start' ? 'end' : 'start' });
  return out;
}

// ── Joins that move as one ───────────────────────────────────────────────────

/** How close two bounds have to be to count as THE SAME instant. A join is
 *  written by one gesture — a snap, or a previous linked move — so the two
 *  numbers are either equal or they are not; this only absorbs the float
 *  arithmetic on the way. */
const TWIN_EPSILON_S = 0.001;

/** A neighbouring bound that sits exactly on one of ours. */
export interface BoundTwin {
  id: string;
  name: string;
  /** Which of the NEIGHBOUR's bounds it is: the previous tune's `end` sits on
   *  our `start`, the next tune's `start` sits on our `end`. */
  edge: 'start' | 'end';
}

/** Keeps a linked move from turning the neighbour inside out.
 *
 *  `clampBound` already stops THIS detection's two bounds from crossing, but a
 *  linked bound drags a neighbour's along with it, and that neighbour has an
 *  far side of its own: pulling our start back past the previous tune's start
 *  would leave it ending before it began. So each linked bound also answers to
 *  the far side of the tune it is joined to.
 *
 *  `startTwin` is the tune whose END follows our start, `endTwin` the one whose
 *  START follows our end — the only two shapes a join has. */
export function clampLinked(
  pair: { start: number; end: number },
  startTwin: Detection | null,
  endTwin: Detection | null,
  duration: number,
): { start: number; end: number } {
  let { start, end } = pair;
  if (startTwin) start = Math.max(start, startTwin.start + MIN_SPAN_S);
  if (endTwin) end = Math.min(end, (endTwin.end ?? duration) - MIN_SPAN_S);
  // Our own two bounds come first: a twin must never be the reason they cross.
  if (end - start < MIN_SPAN_S) return pair;
  return { start, end };
}

/** The neighbour whose bound sits on `t`, or null.
 *
 *  This is what makes a join a single frontier rather than two numbers that
 *  happen to agree: when two detections touch, moving one side alone does not
 *  correct anything — it opens a hole or an overlap exactly as wide as the
 *  move (user request, 2026-09-21).
 *
 *  `edge` is the neighbour's side, so ours is the opposite one: pass 'end' to
 *  find what our `start` is flush against. Ties are impossible in practice and
 *  resolved by order if they happen. */
export function findTwin(
  anns: Detection[],
  editedId: string,
  t: number,
  edge: 'start' | 'end',
  duration: number,
): BoundTwin | null {
  for (const a of anns) {
    if (a.id === editedId) continue;
    const at = edge === 'start' ? a.start : (a.end ?? duration);
    if (Math.abs(at - t) <= TWIN_EPSILON_S) return { id: a.id, name: a.displayName, edge };
  }
  return null;
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
