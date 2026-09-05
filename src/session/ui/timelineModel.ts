import type { SessionAnnotation } from '../model';

// ── What the summary's timeline and list agree on ────────────────────────────
// Pure, and deliberately in its own file: the two rules below are the subtle
// half of that screen and deserve tests, which importing the component itself
// cannot give (it drags in the store, and with it the whole app).

/** Below this, a hole between two detections is bound slop, not silence: the
 *  detector's bounds come from 10 s windows on a 5 s hop, so two tunes running
 *  straight into each other still leave one hop between them. Measured on real
 *  sessions (2026-09-05): every genuine pause was 15 s or more, every artefact
 *  was exactly one or two hops. */
const GAP_MIN_S = 15;

/** EVERY annotation covering `t` — none, one, or several.
 *
 *  Detections OVERLAP as a rule, not as an edge case: 22 of 37 boundaries on a
 *  real 48 min session, by 5 to 10 s, because two tunes of a set run together
 *  and window bounds bite.
 *
 *  An earlier version answered with a single annotation — the last to start —
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
export function annotationsAt(anns: SessionAnnotation[], t: number, duration: number): string[] {
  return anns.filter(a => a.start <= t && t < (a.end ?? duration)).map(a => a.id);
}

/** Annotations and the silences between them, in playing order — what the
 *  timeline shows positionally, rendered as a sequence so the list can say it
 *  too. A list of cards butted together reads as one continuous concert. */
export function withGaps(anns: SessionAnnotation[], duration: number): Array<
  { kind: 'ann'; ann: SessionAnnotation; i: number } | { kind: 'gap'; from: number; len: number }
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

/** Where the play head stands, as the list and the strip both need to show
 *  it: the detections covering that instant, or — when none do — the silence
 *  it is standing in.
 *
 *  One reading rather than two, so the two views cannot disagree, and so a
 *  caller can tell "the answer changed" from a single comparable key.
 *
 *  `gapFrom` is null both when a detection covers `t` and when the hole is
 *  too short to be shown at all: the list has no row there to light up. */
export function headPosition(anns: SessionAnnotation[], t: number, duration: number): { ids: string[]; gapFrom: number | null } {
  const ids = annotationsAt(anns, t, duration);
  if (ids.length > 0) return { ids, gapFrom: null };
  for (const item of withGaps(anns, duration)) {
    if (item.kind === 'gap' && t >= item.from && t < item.from + item.len) return { ids, gapFrom: item.from };
  }
  return { ids, gapFrom: null };
}
