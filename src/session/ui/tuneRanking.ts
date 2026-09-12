import type { TuneSort } from '../../types';
import type { Analysis, Detection } from '../model';

// ── What this scene actually plays ───────────────────────────────────────────
// Asked for from the field (2026-09-11), and it is the interesting half of the
// request: "faire des paquets de tunes que je ne connais pas, classés par ordre
// de ceux que j'ai le plus entendus, mais que je n'ai pas encore bossés". The
// user was keeping that list in a spreadsheet with colour gradients.
//
// The sessions already hold the answer — every detection carries a tune id —
// it had simply never been read across sessions rather than within one. A leaf
// on purpose: SessionLibrary reaches the store, which reaches the Drive
// client, which touches localStorage on import, so anything with a decision
// in it has to live out here to be testable at all.

/** One tune, seen across every session. */
export interface TuneRankRow {
  tuneId: string;
  /** The recogniser's own name, left raw — the view resolves the presentable
   *  one through `tuneName()` (card name, else the index, else re-cased). */
  displayName: string;
  /** Detections in total. A tune played four times in one evening counts four
   *  times: that IS how often it was heard. */
  count: number;
  /** How many different sessions it appeared in. The discriminator the total
   *  cannot give — four passes in one night is a set someone was drilling,
   *  four nights is a tune the scene actually plays. */
  sessions: number;
  /** Whether ANY detection of it was hearted. One heart is the user saying
   *  "this one", and no amount of un-hearted passes elsewhere unsays it. */
  liked: boolean;
  /** Epoch ms of the last time it was actually played — the recording's t=0
   *  plus the detection's own offset into it (see heardAt), not merely the date
   *  of the evening. null when every session it appears in is undated (imports
   *  start with no date). */
  lastHeard: number | null;
}

function sessionTime(session: Analysis): number | null {
  if (!session.date) return null;
  const ms = Date.parse(session.date);
  return Number.isNaN(ms) ? null : ms;
}

/** When a tune was ACTUALLY played: the recording's t=0 plus how far into it
 *  the detection sits.
 *
 *  The offset is not a detail. Without it every tune in one evening carries the
 *  same instant, so "heard most recently" cannot order them at all and the
 *  tie-break decides instead — and worse, across two overlapping evenings it
 *  gets the answer wrong: a tune at 23:30 of a session that began at 20:00 is
 *  more recent than one at 23:05 of a session that began at 23:00, which
 *  comparing the two START times reverses.
 *
 *  null stays null: an offset into an undated recording is still no date. */
function heardAt(sessionStart: number | null, detectionStart: number): number | null {
  return sessionStart === null ? null : sessionStart + detectionStart * 1000;
}

/** Every tune any session recognised, most heard first.
 *
 *  Grouped by `tuneId` and not by name: two spellings of the same reel are one
 *  tune, and the id is the only thing that says so. The name kept is the one
 *  from the most recent detection — where a name was corrected, the correction
 *  is the newer of the two. "Most recent" means the moment the tune was
 *  PLAYED, offset included (see heardAt), so two passes in one evening are
 *  told apart rather than tying.
 *
 *  Ties are broken by session spread, then by name, so the order is total and
 *  the list does not reshuffle under the reader between two identical states. */
export function rankDetectedTunes(sessions: Analysis[]): TuneRankRow[] {
  const byTune = new Map<string, { row: TuneRankRow; sessionIds: Set<string>; newest: number }>();

  for (const session of sessions) {
    const sessionAt = sessionTime(session);
    for (const ann of session.annotations ?? []) {
      if (!ann.tuneId) continue;
      const at = heardAt(sessionAt, ann.start);
      const found = byTune.get(ann.tuneId);
      if (!found) {
        byTune.set(ann.tuneId, {
          row: {
            tuneId: ann.tuneId,
            displayName: ann.displayName,
            count: 1,
            sessions: 1,
            liked: ann.liked,
            lastHeard: at,
          },
          sessionIds: new Set([session.id]),
          // Undated sessions must not win the "newest name" contest against a
          // dated one, but they have to beat nothing at all.
          newest: at ?? -Infinity,
        });
        continue;
      }
      found.row.count++;
      found.row.liked ||= ann.liked;
      found.sessionIds.add(session.id);
      found.row.sessions = found.sessionIds.size;
      if (at !== null && (found.row.lastHeard === null || at > found.row.lastHeard)) {
        found.row.lastHeard = at;
      }
      if ((at ?? -Infinity) >= found.newest) {
        found.newest = at ?? -Infinity;
        found.row.displayName = ann.displayName;
      }
    }
  }

  return [...byTune.values()]
    .map(v => v.row)
    .sort((a, b) =>
      b.count - a.count
      || b.sessions - a.sessions
      || a.displayName.localeCompare(b.displayName));
}

// `TuneSort` lives in types.ts, beside `LibrarySort`, because it travels in
// the route. `alpha` is its default — the ranking by occurrences is what this
// screen is FOR, but a list you cannot find a name in is a report rather than
// a tool, and the count is one click away.

/** Every criterion starts in its natural order, which `sortTuneRows` now
 *  builds directly — so the useful direction is simply "not reversed", for all
 *  three. Same default as the card library's (`?? false`), and the reason the
 *  per-criterion table this used to be no longer has anything to say. */
export const TUNE_SORT_DEFAULT_ASC = false;

/** Orders the rows, and never leaves two of them interchangeable.
 *
 *  Every comparator falls through to the same total order — count, then
 *  spread, then name — so a list cannot quietly reshuffle between two renders
 *  of identical data. The name is passed in rather than read here: it comes
 *  from the card, else the index, else a re-casing, and none of that belongs
 *  in a pure function. */
export function sortTuneRows<T extends { row: TuneRankRow; name: string }>(
  rows: T[], mode: TuneSort, asc: boolean,
): T[] {
  const tiebreak = (a: T, b: T) =>
    b.row.count - a.row.count
    || b.row.sessions - a.row.sessions
    || a.name.localeCompare(b.name);

  // Each criterion's NATURAL order — the one worth landing on: names A→Z,
  // and for the two questions ("most heard", "heard most recently") the answer
  // at the top. `asc` then flips the whole thing.
  const primary = (a: T, b: T): number => {
    switch (mode) {
      case 'alpha':
        return a.name.localeCompare(b.name);
      case 'count':
        return b.row.count - a.row.count;
      case 'lastHeard':
        // A tune nobody has dated sorts as the oldest thing there is — an
        // unknown date is not a recent one, the same call "Detected in" makes.
        // Reversing the list does carry it to the top, exactly as the card
        // library's never-reviewed cards travel with theirs.
        return (b.row.lastHeard ?? -Infinity) - (a.row.lastHeard ?? -Infinity);
    }
  };

  // Sorted, THEN reversed — never a flipped comparator. This is the card
  // library's own shape (views/library.tsx: `if (sortAsc) filtered.reverse()`)
  // and it matters twice over. It keeps the tie-break travelling with the
  // primary key rather than staying put while everything else turns over; and
  // it makes `sortAsc: false` mean the same thing on both screens. It did not:
  // this used to flip the comparator instead, so at an identical arrow the two
  // lists ran opposite ways (2026-09-12).
  const sorted = [...rows].sort((a, b) => primary(a, b) || tiebreak(a, b));
  return asc ? sorted.reverse() : sorted;
}

/** Every detection of one tune, newest session first, each with where it is.
 *
 *  The same shape the search results already use, for the same reason: two
 *  passes through a tune are two moments in a recording and two places to
 *  land, never one row saying "3 times". */
export interface TuneOccurrence {
  /** The whole analysis, not just its id: the row's own controls need its
   *  name, its duration and its date — extracting a clip and attaching it are
   *  done from here now, exactly as inside the analysis itself. */
  session: Analysis;
  detection: Detection;
}

export function occurrencesOf(sessions: Analysis[], tuneId: string): TuneOccurrence[] {
  const out: Array<TuneOccurrence & { at: number | null }> = [];
  for (const session of sessions) {
    const at = sessionTime(session);
    for (const ann of session.annotations ?? []) {
      if (ann.tuneId === tuneId) out.push({ session, detection: ann, at });
    }
  }
  // Newest session first — and an undated one last rather than first, the same
  // call "Detected in" makes: an unknown date is not a very old one.
  return out
    .sort((a, b) => (b.at ?? -Infinity) - (a.at ?? -Infinity) || a.detection.start - b.detection.start)
    .map(({ at: _at, ...rest }) => rest);
}
