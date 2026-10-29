import type { Card } from '../types';
import { resolveCardRef } from '../services/cardRefService';
import { isTuneset } from '../services/cardTypeService';
import { theSessionTuneId } from './detections';
import { chainsOf } from './ui/timelineModel';
import type { Analysis, Detection, TunesetRecord } from './model';

// ── Sets heard in an analysis (2026-10-19) ───────────────────────────────────
// A set here is nothing but a chain: detections with no silence between them
// (timelineModel.ts's GAP_MIN_S). No metric, no tune type, nothing from
// TheSession's sets — the user's rule, so that a set is something the user can
// read off the list and correct with the bounds, never a guess.
//
// Pure on purpose, like timelineModel: everything with a decision in it lives
// here, where it can be tested without the store.

/** Whether a chain has settled: every detection in it closed and finalized.
 *  Only a settled chain enters the table — a live tail can still be revised or
 *  retracted, and an identity given to it would be given to a guess. */
export function isSettled(chain: readonly Detection[]): boolean {
  return chain.every(d => d.end !== null && d.finalized !== false);
}

/** The table of sets, brought in line with the chains the detections make now.
 *
 *  Which detections form a set is never read from the table — it is the
 *  chains. What the table keeps is IDENTITY: a chain that shares detections
 *  with an entry of the previous table takes that entry's id and heart, so a
 *  bound moved, a tune added or one corrected does not orphan the set's review
 *  or lose its heart. Entries are matched greatest overlap first, each at most
 *  once: a set split in two keeps its identity on the larger half, two sets
 *  merged keep the one that brought the most tunes.
 *
 *  An entry nothing matches any more is simply dropped. A review it carried
 *  stays on the set's card — the set WAS played and rated — and only its link
 *  back to this analysis goes. */
export function reconcileTunesets(
  previous: readonly TunesetRecord[] | undefined,
  chains: readonly Detection[][],
  newId: () => string,
  /** A live recording or an import keeps an entry for a set still being
   *  decoded too: not to rate it yet, but so that a set already rated keeps its
   *  identity when a tune it had seemed to end on turns out to go on. */
  { includeUnsettled = false }: { includeUnsettled?: boolean } = {},
): TunesetRecord[] {
  const settled = chains.filter(c => includeUnsettled || isSettled(c)).map(c => c.map(d => d.id));
  const prev = previous ?? [];

  const pairs: Array<{ c: number; p: number; shared: number }> = [];
  settled.forEach((ids, c) => {
    const mine = new Set(ids);
    prev.forEach((rec, p) => {
      const shared = rec.detectionIds.filter(id => mine.has(id)).length;
      if (shared > 0) pairs.push({ c, p, shared });
    });
  });
  // Greatest overlap first; ties in playing order, so the result is total.
  pairs.sort((a, b) => b.shared - a.shared || a.c - b.c || a.p - b.p);

  const takenChain = new Map<number, number>();
  const takenPrev = new Set<number>();
  for (const { c, p } of pairs) {
    if (takenChain.has(c) || takenPrev.has(p)) continue;
    takenChain.set(c, p);
    takenPrev.add(p);
  }

  return settled.map((detectionIds, c) => {
    const p = takenChain.get(c);
    const was = p === undefined ? undefined : prev[p];
    return {
      id: was?.id ?? newId(),
      detectionIds,
      ...(was?.liked ? { liked: true } : {}),
    };
  });
}

/** Whether two tables say the same thing — what decides that a reconciled
 *  table is worth writing back at all. */
export function sameTunesets(a: readonly TunesetRecord[] | undefined, b: readonly TunesetRecord[]): boolean {
  const x = a ?? [];
  if (x.length !== b.length) return false;
  return x.every((r, i) => {
    const s = b[i]!;
    return r.id === s.id && !!r.liked === !!s.liked
      && r.detectionIds.length === s.detectionIds.length
      && r.detectionIds.every((id, j) => id === s.detectionIds[j]);
  });
}

/** The table entry for this chain, if it has one (an unsettled chain has none). */
export function recordOf(records: readonly TunesetRecord[] | undefined, chain: readonly Detection[]): TunesetRecord | undefined {
  return (records ?? []).find(r =>
    r.detectionIds.length === chain.length && r.detectionIds.every((id, i) => id === chain[i]!.id));
}

/** The analysis's table, reconciled with its detections as they stand. */
export function tunesetsOf(session: Analysis, newId: () => string): TunesetRecord[] {
  return reconcileTunesets(session.tunesets, chainsOf(session.annotations, session.duration), newId);
}

// ── Sets and cards ───────────────────────────────────────────────────────────

/** Every TheSession tune's card, by tune id — built once, not searched per tune. */
export function cardsByTuneId(cards: Record<string, Card>): Map<string, Card> {
  const out = new Map<string, Card>();
  for (const card of Object.values(cards)) {
    const id = theSessionTuneId(card);
    if (id !== null && !out.has(id)) out.set(id, card);
  }
  return out;
}

/** A set card's tunes as TheSession tune ids, in playing order — or null when
 *  one of them has none, since such a set can never be recognised. */
export function setTuneIds(set: Card, cards: Record<string, Card>): string[] | null {
  const ids: string[] = [];
  for (const ref of set.tunes ?? []) {
    const tune = resolveCardRef(ref, cards);
    const id = tune ? theSessionTuneId(tune) : null;
    if (id === null) return null;
    ids.push(id);
  }
  return ids.length > 0 ? ids : null;
}

/** The set card made of exactly these tunes, in exactly this order (the user's
 *  rule, 2026-10-19) — the repeats a card sets play no part. */
export function setCardFor(tuneIds: readonly string[], cards: Record<string, Card>): Card | undefined {
  return Object.values(cards).find(card => {
    if (!isTuneset(card) || (card.tunes?.length ?? 0) !== tuneIds.length) return false;
    const ids = setTuneIds(card, cards);
    return !!ids && ids.every((id, i) => id === tuneIds[i]);
  });
}

// ── Where a set card was heard ───────────────────────────────────────────────

export interface SetHearing {
  session: Analysis;
  chain: Detection[];
}

/** Every chain, in every analysis, made of this set's tunes in this order —
 *  newest analysis first, an undated one last, chains in playing order. The
 *  set's "Detected in", derived like a tune's (detections.ts). */
export function findSetHearings(set: Card, cards: Record<string, Card>, sessions: Record<string, Analysis>): SetHearing[] {
  const ids = setTuneIds(set, cards);
  if (!ids) return [];
  const key = ids.join(',');
  const out: SetHearing[] = [];
  const at = (s: Analysis) => { const ms = s.date ? Date.parse(s.date) : NaN; return Number.isNaN(ms) ? -Infinity : ms; };
  const ordered = Object.values(sessions).sort((a, b) => at(b) - at(a));
  for (const session of ordered) {
    for (const chain of chainsOf(session.annotations ?? [], session.duration)) {
      if (chain.map(d => d.tuneId).join(',') === key) out.push({ session, chain });
    }
  }
  return out;
}

/** The span a chain covers: from its first tune's start to the furthest end. */
export function chainSpan(chain: readonly Detection[], duration: number): { start: number; end: number } {
  return {
    start: Math.min(...chain.map(d => d.start)),
    end: Math.max(...chain.map(d => d.end ?? duration)),
  };
}

/** The field a saved analysis gets from a recording's or an import's table —
 *  none at all when the table was never asked for (the sets off). */
export function withSets(sets: TunesetRecord[] | undefined): { tunesets?: TunesetRecord[] } {
  return sets ? { tunesets: sets } : {};
}
