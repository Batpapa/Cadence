import { getContext } from '../store';
import { findByExternalId } from '../services/theSessionService';
import { reviewEntryIndex, retargetedHistory } from '../services/reviewEntries';
import { detectionReviewId, reviewEntryTs } from './reviewLink';
import type { Detection } from './model';

// ── Ratings given while the recording runs ───────────────────────────────────
// A tune can be rated while it is still playing (2026-10-10), when nobody yet
// knows where it ends: the rating is filed at the end of the last window that
// heard it (DetectionCard). Its definitive instant comes when the decoder
// finalizes the detection — this moves it there. The engines call it, not a
// screen: the recording goes on while the user is off looking at a card.
//
// And at the very end, a confirmation that a later one took the detection from
// (detectionState.ts's `dominated`) is settled the way merging and deleting
// already are in the summary: the same tune is one playing, so its rating goes
// to the survivor unless that one has its own; another tune was not played
// there, so its rating goes.
//
// Silent, as every other move of a rating is (sessionUiShared.tsx's
// retargetReview): the user corrected nothing, the recording simply settled.

type SessionRef = { id: string; date: string | null };

interface Move { key: string; id: string; next: { id: string; ts: number } | null }

function startOf(session: SessionRef): number | null {
  if (session.date === null) return null;
  const ms = Date.parse(session.date);
  return Number.isNaN(ms) ? null : ms;
}

/** Where `ann`'s rating is, if it has one: the card's key in cardWorks. */
function ratedAt(ann: Detection, id: string): string | null {
  const user = getContext().user;
  const card = findByExternalId(`thesession:${ann.tuneId}`, user.cards);
  if (!card) return null;
  const key = `${user.currentProfileId}:${card.id}`;
  const history = user.cardWorks[key]?.history;
  return history && reviewEntryIndex(history, id, null) !== -1 ? key : null;
}

async function apply(moves: Move[]): Promise<void> {
  if (moves.length === 0) return;
  await getContext().mutate(s => {
    for (const m of moves) {
      const work = s.cardWorks[m.key];
      if (!work) continue;
      const history = retargetedHistory(work.history, m.id, null, m.next);
      if (history) work.history = history;
    }
  });
}

/** Moves the ratings of detections just finalized to their definitive end. */
export async function repinSettledRatings(session: SessionRef, settled: readonly Detection[]): Promise<void> {
  const startMs = startOf(session);
  if (startMs === null) return;
  const moves: Move[] = [];
  for (const ann of settled) {
    if (ann.end === null) continue;
    const id = detectionReviewId(session.id, ann.id);
    const key = ratedAt(ann, id);
    if (key) moves.push({ key, id, next: { id, ts: reviewEntryTs(startMs, ann.end) } });
  }
  await apply(moves);
}

/** Settles the ratings of confirmations a later one overrode. */
export async function settleDominatedRatings(
  session: SessionRef,
  dominated: ReadonlyArray<{ loser: Detection; winner: Detection }>,
): Promise<void> {
  const startMs = startOf(session);
  const moves: Move[] = [];
  for (const { loser, winner } of dominated) {
    const id = detectionReviewId(session.id, loser.id);
    const key = ratedAt(loser, id);
    if (!key) continue;
    if (loser.tuneId !== winner.tuneId) { moves.push({ key, id, next: null }); continue; }
    // Without a date there is no instant to move it to: it stays as it is.
    if (startMs === null || winner.end === null) continue;
    moves.push({ key, id, next: { id: detectionReviewId(session.id, winner.id), ts: reviewEntryTs(startMs, winner.end) } });
  }
  await apply(moves);
}
