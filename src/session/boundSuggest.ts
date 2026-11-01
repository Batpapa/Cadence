import { MATCH_USABLE, type FollowResult } from './scoreFollow';

// ── Bounds from the score's alignment ────────────────────────────────────────
// A detection's bounds come from 10 s windows on a 5 s hop: off by a few
// seconds as a rule, by a whole pass now and then. Aligned on its score
// (scoreFollow.ts), the same stretch says where each pass of the tune begins
// — and a tune is played in whole passes: of the annotated ends, 92 % lie
// within a tenth of a pass of a pass boundary (measured 2026-10-31 on 318
// detections of seven sessions).
//
// Hence the rule, measured there: where the alignment stops past 80 % of a
// pass, the pass was finished and the bound goes to its end; before 10 %, it
// was the next pass's first notes, or the next tune's taken for them, and the
// bound goes back to the pass's start. In between, the alignment is suspect
// — most often it ran a quarter of a pass into the next tune of the set,
// same meter, same rhythm — and nothing is proposed. Against the annotations,
// the end's error went from 2.5 / 14.5 s (median / 90th percentile) to
// 0.7 / 6.6 s; better than the detection on 152 ends, worse on 13. The start
// mirrors it.
//
// Offered in the bound editor, and applied by the analysis itself as it goes
// (alignedBounds, below) — for everyone since 2026-11-01, after a day in
// developer mode: "ça fonctionne suffisamment" (the user). The recogniser's
// bounds stay in Detection.detected, offered back by the bound editor.

/** A pass played this far is a pass finished. */
export const PASS_DONE = 0.8;
/** A pass begun no further than this was not begun. */
export const PASS_UNBEGUN = 0.1;
/** Seconds of recording aligned on each side of a detection — not the viewer's
 *  3 s: aligned that close, the alignment stopped on the margin's edge in a
 *  third of the detections, and the edge then said nothing of the passes. */
export const SUGGEST_MARGIN_S = 15;
/** Two suggestions this close at a join are one frontier, taken halfway
 *  (2026-10-31, the user's rule). Measured on 189 joins of sets: 76 joined,
 *  0.4 s from the annotation in the median, 1.4 s at worst; 4 wrong joins out
 *  of 141 pairs that were not a set. Half a second joined 57 for 2 wrong,
 *  three seconds 84 for 6. */
export const JOIN_TOLERANCE_S = 1;

/** The passes of an alignment, in session seconds. */
export interface PassGeometry {
  /** First aligned quaver, and the end of the last. */
  first: number;
  last: number;
  /** How long a pass lasts: the median of the whole ones aligned, or the
   *  tempo's when there are none. */
  pass: number;
  /** Where in its pass the alignment begins and ends, 0 to 1. */
  headFrac: number;
  tailFrac: number;
  /** Where each pass begins, in order — those the alignment crosses, and the
   *  first one's when it begins near — numbered as the Synchro audio numbers
   *  them (passStarts: a partial first pass is the first, a pickup is not);
   *  then where the last one ends, when the alignment stops near it
   *  (`end`). */
  marks: PassMark[];
  /** Share of the notes on the score (FollowResult.match). */
  match: number;
}

/** A pass boundary: where pass `pass` begins, or ends (`end`). */
export interface PassMark { t: number; pass: number; end?: true }

/** Fewer aligned quavers than this say nothing of the passes. */
const MIN_ONSETS = 8;

const median = (xs: number[]): number => {
  const s = xs.slice().sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length / 2))]!;
};

/** The passes of `r`, whose time 0 is `from` in the session. Null when too
 *  little was aligned. A pass begins where the score's index goes back.
 *  `r.pickup` (withPickup) only changes the numbering: the geometry is the
 *  one measured, pickup or not. */
export function passGeometry(r: Pick<FollowResult, 'times' | 'indices' | 'end' | 'quavers' | 'match' | 'pickup'>, from: number): PassGeometry | null {
  const { times, indices, quavers: n } = r;
  if (times.length < MIN_ONSETS || n < 2) return null;
  const crossings: number[] = [];
  let passes = 0;
  for (let k = 1; k < indices.length; k++) {
    if (indices[k]! <= indices[k - 1]!) { passes++; crossings.push(from + times[k]!); }
  }
  const first = from + times[0]!;
  const last = from + r.end;
  const headFrac = indices[0]! / n;
  const tailFrac = ((indices[indices.length - 1]! + 1) % n) / n;
  const quaversDone = passes * n + indices[indices.length - 1]! + 1 - indices[0]!;
  const pass = crossings.length >= 2
    ? median(crossings.slice(1).map((t, k) => t - crossings[k]!))
    : (n * (last - first)) / Math.max(1, quaversDone);
  // The aligned head is the first pass, partial or not, unless it is a
  // pickup: the first return to the top then begins the first.
  const offset = r.pickup !== undefined ? 1 : 2;
  const marks: PassMark[] = crossings.map((t, k) => ({ t, pass: k + offset }));
  // The nearest boundary past each end, when the alignment stops near it.
  if (headFrac <= 0.5) marks.unshift({ t: first - headFrac * pass, pass: 1 });
  const lastPass = marks.length ? marks[marks.length - 1]!.pass : 1;
  if (tailFrac === 0) marks.push({ t: last, pass: lastPass, end: true });
  else if (tailFrac >= 0.5) marks.push({ t: last + (1 - tailFrac) * pass, pass: lastPass, end: true });
  return { first, last, pass, headFrac, tailFrac, marks, match: r.match };
}

/** A suggestion further than this from the recogniser's own bound is not
 *  one: the alignment lost the tune there rather than found its end.
 *  Measured end to end on the seven annotated sessions (2026-11-01): the 17
 *  moves of 15 to 22 s were all right, the one of 73 s — the alignment
 *  stopped at a pass boundary while the tune played on — was wrong. */
export const MAX_MOVE_S = 30;

/** `suggestion`, unless it lies beyond MAX_MOVE_S of `bound`. */
export function withinReach(suggestion: number | null, bound: number): number | null {
  return suggestion !== null && Math.abs(suggestion - bound) <= MAX_MOVE_S ? suggestion : null;
}

/** Whether the alignment is worth proposing anything from: below
 *  MATCH_USABLE, the score is no more the recording's than a wrong one. */
export const trusted = (g: PassGeometry): boolean => g.match >= MATCH_USABLE;

/** Where the tune ends by the rule, or null where it proposes nothing. */
export function suggestedEnd(g: PassGeometry): number | null {
  if (!trusted(g)) return null;
  if (g.tailFrac >= PASS_DONE) return g.last + (1 - g.tailFrac) * g.pass;
  if (g.tailFrac <= PASS_UNBEGUN) return g.last - g.tailFrac * g.pass;
  return null;
}

/** Where the tune begins by the rule, or null. Begun barely into a pass, its
 *  first notes were missed: back to the pass's start. Begun at the very end
 *  of one, those were the tune before's last notes, or a pickup: on to the
 *  next. */
export function suggestedStart(g: PassGeometry): number | null {
  if (!trusted(g)) return null;
  if (g.headFrac <= PASS_UNBEGUN) return g.first - g.headFrac * g.pass;
  if (g.headFrac >= PASS_DONE) return g.first + (1 - g.headFrac) * g.pass;
  return null;
}

/** How close to an edge of the recording the alignment has to reach for
 *  that edge to be where it begins or ends. */
export const EDGE_S = 2;

/** The suggestions of `g`, aligned on a stretch whose start is an edge of
 *  the recording at `lo` and whose end one at `hi` — its start, the end of
 *  the recording or a pause (Analysis.pauses) — or null, a margin cut
 *  short. Where the playing runs into an edge — begun before the recording
 *  started or resumed, still going when it stopped or paused — there is no
 *  pass to finish or to drop: the edge is the bound. The tune before whose
 *  last notes a start would pass over, or the next one's first notes an end
 *  would drop, does not exist there, or belongs to another moment
 *  (2026-11-01, the user: a recording begun mid-pass had its start moved on
 *  7 s, to the next pass — "si on sait que le morceau était déjà commencé,
 *  la suggestion c'est de caler à 0 s"; and the same of pauses). And never
 *  beyond an edge. */
export function suggestionsIn(g: PassGeometry, lo: number | null, hi: number | null): { start: number | null; end: number | null; why: NoSuggestion } {
  const atStart = lo !== null && g.first < lo + EDGE_S;
  const atEnd = hi !== null && g.last > hi - EDGE_S;
  const start = atStart ? (trusted(g) ? lo : null) : suggestedStart(g);
  const end = atEnd ? (trusted(g) ? hi : null) : suggestedEnd(g);
  const reason = (v: number | null): NoReason | null =>
    v !== null ? null : !trusted(g) ? 'unsure' : 'midPass';
  return {
    start: start === null ? null : Math.max(lo ?? 0, start),
    end: end === null ? null : hi === null ? end : Math.min(hi, end),
    why: { start: reason(start), end: reason(end) },
  };
}

/** How far from a detection's bound a pause is taken for it: two of the
 *  recogniser's 5 s hops, what its bounds are commonly off by. */
const PAUSE_REACH_S = 10;

/** A stretch of the recording to align, in its seconds, and which of the
 *  detection's bounds it answers for. `lo` / `hi`: as suggestionsIn's. */
export interface AlignSpan { from: number; to: number; lo: number | null; hi: number | null; bounds: 'both' | 'start' | 'end' }

/** What to align to put a detection's bounds on its passes: its stretch,
 *  SUGGEST_MARGIN_S on each side — never across a pause. The music on the
 *  other side of one is of another moment, and the alignment, which cannot
 *  jump in the score, would follow it as if the tune went on. A detection
 *  over a pause is aligned twice: its start up to the first pause inside it,
 *  its end from the last. `duration`: Infinity while the recording is being
 *  made — it has no end yet to run into. */
export function alignmentPlan(start: number, end: number, duration: number, pauses: readonly number[] = []): AlignSpan[] {
  // A pause near a bound is that bound's, from either side: the recogniser's
  // bounds are off by a window hop or two.
  const ofStart = (p: number) => p <= start + PAUSE_REACH_S && p - start <= end - p;
  const ofEnd = (p: number) => p >= end - PAUSE_REACH_S && p - start > end - p;
  const below = Math.max(0, ...pauses.filter(ofStart));
  const above = Math.min(duration, ...pauses.filter(ofEnd));
  const inside = pauses.filter(p => p > start && p < end && !ofStart(p) && !ofEnd(p));
  const from = Math.max(below, start - SUGGEST_MARGIN_S);
  const to = Math.min(above, end + SUGGEST_MARGIN_S);
  const lo = from === below ? below : null;
  const hi = to === above && Number.isFinite(above) ? above : null;
  if (inside.length === 0) return [{ from, to, lo, hi, bounds: 'both' }];
  const first = inside[0]!, last = inside[inside.length - 1]!;
  return [
    { from, to: first, lo, hi: first, bounds: 'start' },
    { from: last, to, lo: last, hi, bounds: 'end' },
  ];
}

/** Why a bound has no suggestion, for the bound editor to say: the
 *  alignment is no better than a wrong score, it stops in the middle of a
 *  pass, or what it suggests lies beyond MAX_MOVE_S of the bound. */
export type NoReason = 'unsure' | 'midPass' | 'far';
export interface NoSuggestion { start: NoReason | null; end: NoReason | null }

/** The one frontier of a join: halfway between the end suggested for the
 *  tune before and the start suggested for the tune after, when the two
 *  agree; null otherwise. */
export function joinedBound(end: number | null, start: number | null, tolerance = JOIN_TOLERANCE_S): number | null {
  if (end === null || start === null || Math.abs(end - start) > tolerance) return null;
  return (end + start) / 2;
}

/** What a join's recalibration does (fixSeam). `gap`: between the two
 *  suggestions, null when only one side has one. `apart`: a null bound stays
 *  as it is. */
export type SeamFix =
  | { kind: 'joined'; t: number; gap: number }
  | { kind: 'apart'; end: number | null; start: number | null }
  | { kind: 'disagree'; gap: number | null }
  | { kind: 'none' };

/** Shortest a detection may be left by a recalibration (boundEditorModel's
 *  MIN_SPAN_S). */
const MIN_SPAN_S = 1;

/** What a join's recalibration does to the two detections on either side of
 *  it — `a` before, `b` after — given the end suggested for one and the start
 *  for the other. Joined when they agree. Else, across a hole, each bound that
 *  has a suggestion takes it, unless the two would then overlap; two
 *  detections already touching or overlapping are moved together or not at
 *  all — one side alone would open the very hole or overlap being
 *  corrected. */
export function fixSeam(
  a: { start: number; end: number },
  b: { start: number; end: number },
  end: number | null,
  start: number | null,
): SeamFix {
  // A bound that would turn its own detection inside out is no suggestion.
  if (end !== null && end < a.start + MIN_SPAN_S) end = null;
  if (start !== null && start > b.end - MIN_SPAN_S) start = null;
  const t = joinedBound(end, start);
  if (t !== null) return { kind: 'joined', t, gap: Math.abs(end! - start!) };
  if (end === null && start === null) return { kind: 'none' };
  const touching = b.start <= a.end + 0.001;
  const newEnd = end ?? a.end;
  const newStart = start ?? b.start;
  if (touching || newEnd > newStart) return { kind: 'disagree', gap: end !== null && start !== null ? Math.abs(end - start) : null };
  return { kind: 'apart', end, start };
}

// ── Every bound of an analysis at once ───────────────────────────────────────
// What the analysis itself does with the suggestions, as it goes (2026-11-01,
// the user: the bound editor should seldom be needed). Each join as fixSeam
// settles it — a silence of GAP_MIN_S or more included, the user's choice:
// a set the recogniser split across one is joined again — and the first
// tune's start and, once nothing more can follow, the last one's end, which
// have no neighbour to agree with, to their own suggestion.

/** What one detection's suggestion was worked out from: its bounds, its
 *  tune. A detection whose bounds or tune have changed since is a new
 *  question. */
export function alignKey(d: { settingId: string; start: number; end: number | null }): string {
  return `${d.settingId}|${d.start.toFixed(3)}|${d.end === null ? '-' : d.end.toFixed(3)}`;
}

/** A detection as alignedBounds sees it, in playing order. `end`: where it
 *  ends as far as is known. `suggestion`: its suggested bounds — undefined
 *  while not worked out, and then it does not move. */
export interface AlignTarget {
  id: string;
  start: number;
  end: number;
  suggestion?: { start: number | null; end: number | null } | null;
}

/** The bounds that change, by id. `final`: nothing more will follow the last
 *  detection — its end can be settled on its own. */
export function alignedBounds(dets: readonly AlignTarget[], final: boolean): Map<string, { start: number; end: number }> {
  const next = new Map<string, { start: number; end: number }>();
  for (const d of dets) if (d.suggestion !== undefined) next.set(d.id, { start: d.start, end: d.end });
  if (next.size === 0) return new Map();
  // Each join, with the detection reaching furthest before it — the
  // neighbour a silence row names (timelineModel's withGaps).
  let reached: AlignTarget | null = null;
  for (const d of dets) {
    if (reached) {
      const fix = fixSeam(reached, d, reached.suggestion?.end ?? null, d.suggestion?.start ?? null);
      const a = next.get(reached.id), b = next.get(d.id);
      if (fix.kind === 'joined') {
        if (a && b) { a.end = fix.t; b.start = fix.t; }
      } else if (fix.kind === 'apart') {
        if (a && fix.end !== null) a.end = fix.end;
        if (b && fix.start !== null) b.start = fix.start;
      }
    }
    if (!reached || d.end > reached.end) reached = d;
  }
  const head = dets[0]?.suggestion?.start ?? null;
  if (head !== null && head >= 0) next.get(dets[0]!.id)!.start = head;
  if (final && reached) {
    const tail = reached.suggestion?.end ?? null;
    if (tail !== null) next.get(reached.id)!.end = tail;
  }
  const out = new Map<string, { start: number; end: number }>();
  for (const d of dets) {
    const n = next.get(d.id);
    // Left as it was rather than squeezed to nothing.
    if (!n || n.end - n.start < MIN_SPAN_S) continue;
    if (Math.abs(n.start - d.start) < 0.001 && Math.abs(n.end - d.end) < 0.001) continue;
    out.set(d.id, n);
  }
  return out;
}
