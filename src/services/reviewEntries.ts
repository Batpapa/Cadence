import type { SessionEntry } from '../types';

// ── Ratings that something else owns ─────────────────────────────────────────
// A review entry is normally anonymous: a rating at an instant, in the history
// the card page and FSRS read. Some ratings, though, are not given by hand on
// the card — they are given from somewhere else that goes on existing
// afterwards, and that place has to be able to find its rating again: to say
// "already rated", to take it back, to follow it when what it describes
// changes. That is what `SessionEntry.id` is for, and everything here works on
// it without knowing what it means.
//
// The id is OPAQUE. Whoever files the entry owns its shape and is the only one
// that may read into it — the core compares strings and nothing more. (The
// tune analyser builds one from the analysis and the detection a rating came
// from; see session/reviewLink.ts.)
//
// The instant stays what it always was: real data, which FSRS schedules from.
// It just stopped being an identity. It used to be one, and everything the
// entry described was then free to move underneath it — which is how one
// evening's playing came to be scheduled as two.

/** Index of the entry carrying `id`, or -1.
 *
 *  `legacyTs` is where the entry would sit if it was filed before ids existed
 *  — pass null when there is no instant to look at. Only an entry with NO id
 *  can be claimed that way: one that carries another id belongs to whatever
 *  filed it, however the instants line up. */
export function reviewEntryIndex(
  history: readonly SessionEntry[],
  id: string,
  legacyTs: number | null,
): number {
  const known = history.findIndex(e => e.id === id);
  if (known !== -1) return known;
  if (legacyTs === null) return -1;
  return history.findIndex(e => e.id === undefined && e.ts === legacyTs);
}

const byTs = (a: SessionEntry, b: SessionEntry): number => a.ts - b.ts;

/** The history after an entry is moved, re-attributed or dropped, or null when
 *  there was nothing to do.
 *
 *  `next` is where it goes: another instant, another id, or null to remove it.
 *  An entry already carrying the destination id wins, and the moved one goes
 *  rather than join it — two records of one and the same thing are one record.
 *
 *  An entry found by `legacyTs` is stamped with its id on the way past, so a
 *  history written before ids existed heals at the first touch. */
export function retargetedHistory(
  history: readonly SessionEntry[],
  id: string,
  legacyTs: number | null,
  next: { id: string; ts: number } | null,
): SessionEntry[] | null {
  const i = reviewEntryIndex(history, id, legacyTs);
  if (i === -1) return null;
  const entry = history[i]!;
  if (next && entry.ts === next.ts && entry.id === next.id) return null;

  const rest = history.filter((_, k) => k !== i);
  if (!next || rest.some(e => e.id === next.id)) return rest.sort(byTs);
  return [...rest, { ...entry, ts: next.ts, id: next.id }].sort(byTs);
}

/** The two histories after an entry changes CARD — a rating lives in the
 *  history of one card, so whatever filed it has to be able to hand it to
 *  another when it decides it was describing a different card all along.
 *
 *  `toHistory` is null when there is no destination card: the entry then goes
 *  rather than stay filed against a card that has just been said to be the
 *  wrong one. The returned `to` is null when the destination needs no write —
 *  either there was none, or it already carries this id. */
export function movedReviewEntry(
  fromHistory: readonly SessionEntry[],
  toHistory: readonly SessionEntry[] | null,
  id: string,
  legacyTs: number | null,
): { from: SessionEntry[]; to: SessionEntry[] | null } | null {
  const i = reviewEntryIndex(fromHistory, id, legacyTs);
  if (i === -1) return null;
  const entry = fromHistory[i]!;
  const from = fromHistory.filter((_, k) => k !== i).sort(byTs);
  if (toHistory === null || reviewEntryIndex(toHistory, id, legacyTs) !== -1) return { from, to: null };
  return { from, to: [...toHistory, { ...entry, id }].sort(byTs) };
}

/** The history once whatever filed some of these entries is gone: the ratings
 *  STAY — they happened, and nothing about them became false — and lose an id
 *  that now points at nothing. They become what a rating typed on the card
 *  page has always been. Null when `matches` claims none of them. */
export function strippedReviewIds(
  history: readonly SessionEntry[],
  matches: (id: string) => boolean,
): SessionEntry[] | null {
  if (!history.some(e => e.id !== undefined && matches(e.id))) return null;
  return history.map(e => {
    if (e.id === undefined || !matches(e.id)) return e;
    const { id: _dropped, ...rest } = e;
    return rest;
  });
}
