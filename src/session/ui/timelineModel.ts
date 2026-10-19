import type { Detection } from '../model';

// ── What the summary's timeline and list agree on ────────────────────────────
// Pure, and deliberately in its own file: the two rules below are the subtle
// half of that screen and deserve tests, which importing the component itself
// cannot give (it drags in the store, and with it the whole app).

/** Below this, a hole between two detections is bound slop, not silence: the
 *  detector's bounds come from 10 s windows on a 5 s hop, so two tunes running
 *  straight into each other still leave one hop between them. Measured on real
 *  sessions (2026-09-05): every genuine pause was 15 s or more, every artefact
 *  was exactly one or two hops.
 *
 *  With the experimental sets on (2026-10-19) it is also, by construction, the
 *  ONE rule that makes a set — the user's decision: detections with no hole of
 *  this size between them were played without stopping, and form one chain
 *  (see withChains). A silence row in the list and a break between two sets
 *  are the same thing by default. What the threshold gets wrong, the user
 *  corrects by hand: a cut where nothing stopped, a link across a silence
 *  (model.ts's opensSet, 2026-10-20). */
export const GAP_MIN_S = 15;

/** EVERY detection covering `t` — none, one, or several.
 *
 *  Detections OVERLAP as a rule, not as an edge case: 22 of 37 boundaries on a
 *  real 48 min session, by 5 to 10 s, because two tunes of a set run together
 *  and window bounds bite.
 *
 *  An earlier version answered with a single detection — the last to start —
 *  and, in a silence, kept showing whichever it had answered last. Both were
 *  inventions dressed as readings. What the play head can honestly report is
 *  which detections cover the instant it sits on: genuinely empty in a gap,
 *  genuinely plural across a join. Two cards lit at a transition say more than
 *  a coin toss between them, and an empty list says more in a silence than a
 *  stale leftover that looks exactly like a live answer.
 *
 *  Orientation during a silence is not lost by this: it is the play head
 *  standing in an empty stretch of the strip, and the gap rows in the list,
 *  that carry it — instruments that can say "nothing here" without lying.
 *
 *  Returned in the annotations' own order, so the result depends only on `t`. */
export function detectionsAt(anns: Detection[], t: number, duration: number): string[] {
  return anns.filter(a => a.start <= t && t < (a.end ?? duration)).map(a => a.id);
}

/** Detections and the silences between them, in playing order — what the
 *  timeline shows positionally, rendered as a sequence so the list can say it
 *  too. A list of cards butted together reads as one continuous concert. */
export function withGaps(anns: Detection[], duration: number): Array<
  { kind: 'ann'; ann: Detection; i: number } | { kind: 'gap'; from: number; len: number }
> {
  const out: ReturnType<typeof withGaps> = [];
  let cursor = 0;
  anns.forEach((ann, i) => {
    const hole = ann.start - cursor;
    if (hole >= GAP_MIN_S) out.push({ kind: 'gap', from: cursor, len: hole });
    out.push({ kind: 'ann', ann, i });
    // Overlaps mean the next tune can start before this one ends; the cursor
    // only ever moves forward, so a negative hole simply never shows.
    cursor = Math.max(cursor, ann.end ?? duration);
  });
  if (duration - cursor >= GAP_MIN_S) out.push({ kind: 'gap', from: cursor, len: duration - cursor });
  return out;
}

/** A silence row. `nextId`: the detection right after it when a set could be
 *  carried on across it — the one a "link" marks (absent before the first
 *  detection and after the last). */
export type ListGap = { kind: 'gap'; from: number; len: number; nextId?: string };
/** `cut`: it opens a set only because the user said so — nothing stopped
 *  before it — so the join it sits on carries the mark. */
export type ListAnn = { kind: 'ann'; ann: Detection; i: number; cut: boolean };
export type ListChain = {
  kind: 'chain';
  members: Array<{ ann: Detection; i: number }>;
  /** Its detections in order, with the silences it was linked across between
   *  them — only those: the list shows them inside the set. */
  rows: Array<ListAnn | ListGap>;
  cut: boolean;
};

/** Whether `ann` opens a set: the first always does; then the user's mark
 *  (model.ts's opensSet) if there is one; else the rule — a silence before it. */
function opensSet(ann: Detection, first: boolean, silence: boolean): boolean {
  if (first) return true;
  return ann.opensSet ?? silence;
}

/** What the list shows, in playing order: the silences, the tunes played
 *  alone, and the CHAINS — two or more detections with no silence between
 *  them, which is what a set is here (see GAP_MIN_S). Built on withGaps rather
 *  than beside it, so by default a chain ends exactly where a silence row
 *  begins and nowhere else.
 *
 *  The user's marks override that both ways (2026-10-20): a cut opens a set
 *  where nothing stopped, a link carries one on across a silence — which then
 *  shows INSIDE it (`rows`), its span and its clip covering the pause.
 *
 *  `i` is each detection's index in `anns`, which the summary's merge and
 *  delete controls address it by. */
export function withChains(anns: Detection[], duration: number): Array<ListGap | ListAnn | ListChain> {
  const out: ReturnType<typeof withChains> = [];
  let run: Array<ListAnn | ListGap> = [];
  let runCut = false;
  const flush = () => {
    const members = run.filter((r): r is ListAnn => r.kind === 'ann');
    if (members.length === 1) out.push({ ...members[0]!, cut: runCut });
    else if (members.length > 1) out.push({ kind: 'chain', members: members.map(m => ({ ann: m.ann, i: m.i })), rows: run, cut: runCut });
    run = [];
  };
  let gap: ListGap | null = null;
  let seen = false;
  for (const item of withGaps(anns, duration)) {
    if (item.kind === 'gap') { gap = item; continue; }
    const first = !seen;
    seen = true;
    const row: ListAnn = { kind: 'ann', ann: item.ann, i: item.i, cut: false };
    if (opensSet(item.ann, first, !!gap)) {
      flush();
      if (gap) out.push(first ? gap : { ...gap, nextId: item.ann.id });
      runCut = !first && !gap;
    } else if (gap) {
      run.push({ ...gap, nextId: item.ann.id });
    }
    run.push(row);
    gap = null;
  }
  flush();
  if (gap) out.push(gap);
  return out;
}

/** Whether a set holds a silence — one it was linked across by hand. */
export function hasPause(chain: readonly Detection[], duration: number): boolean {
  let cursor = chain[0]?.start ?? 0;
  for (const d of chain) {
    if (d.start - cursor >= GAP_MIN_S) return true;
    cursor = Math.max(cursor, d.end ?? duration);
  }
  return false;
}

/** Just the chains, as lists of detections — what the set table and the
 *  searches across analyses are built from. */
export function chainsOf(anns: Detection[], duration: number): Detection[][] {
  return withChains(anns, duration)
    .filter((x): x is Extract<typeof x, { kind: 'chain' }> => x.kind === 'chain')
    .map(x => x.members.map(m => m.ann));
}

/** Where the play head stands, as the list and the strip both need to show
 *  it: the detections covering that instant, or — when none do — the silence
 *  it is standing in.
 *
 *  One reading rather than two, so the two views cannot disagree, and so a
 *  caller can tell "the answer changed" from a single comparable key.
 *
 *  `gapFrom` is null both when a detection covers `t` and when the hole is
 *  too short to be shown at all: the list has no row there to light up. */
export function headPosition(anns: Detection[], t: number, duration: number): { ids: string[]; gapFrom: number | null } {
  const ids = detectionsAt(anns, t, duration);
  if (ids.length > 0) return { ids, gapFrom: null };
  for (const item of withGaps(anns, duration)) {
    if (item.kind === 'gap' && t >= item.from && t < item.from + item.len) return { ids, gapFrom: item.from };
  }
  return { ids, gapFrom: null };
}
