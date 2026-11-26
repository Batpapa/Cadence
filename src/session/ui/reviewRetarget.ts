import { cardOfTuneId } from '../detections';
import type { AppContext } from '../../types';
import { getContext } from '../../store';
import type { Detection } from '../model';
import { retargetedHistory } from '../../services/reviewEntries';
import { detectionReviewId, reviewEntryTs } from '../reviewLink';
import { ClipSessionRef } from './clips';

// Out of sessionUiShared.tsx since 2026-11-26.

/** Everything a rating given from a detection has to survive, in one place.
 *  Each one finds that rating the way the card does — by the id this module
 *  gives it (reviewLink.ts), falling back to the instant for one filed before
 *  ids existed, which also stamps it on the way past. Silent, like the clip
 *  re-cut above and for the same reason: the user corrected the analysis, not
 *  their mind about having played the tune.
 *
 *  They all return whether anything changed — false in the ordinary case of a
 *  detection nobody rated.
 *
 *  `previousEnd` is where the detection used to end, since that is where an
 *  unstamped rating would be sitting. */
async function retargetReview(
  ctx: AppContext,
  session: ClipSessionRef,
  ann: Detection,
  previousEnd: number | null,
  next: { id: string; ts: number } | null,
): Promise<boolean> {
  const card = cardOfTuneId(ann.tuneId, getContext().user.cards);
  if (!card) return false;
  const startMs = session.date === null ? NaN : Date.parse(session.date);
  const legacyTs = Number.isNaN(startMs) || previousEnd === null ? null : reviewEntryTs(startMs, previousEnd);
  const id = detectionReviewId(session.id, ann.id);

  let changed = false;
  await ctx.mutate(s => {
    const work = s.cardWorks[`${s.currentProfileId}:${card.id}`];
    if (!work) return;
    const history = retargetedHistory(work.history, id, legacyTs, next);
    if (!history) return;
    work.history = history;
    changed = true;
  });
  return changed;
}

/** Follows the rating to the detection's new end. The instant is data — FSRS
 *  schedules from it — so a bound that moves has to take it along. */
export async function repinReviewEntry(
  ctx: AppContext,
  session: ClipSessionRef,
  ann: Detection,
  previous: { start: number; end: number | null },
): Promise<boolean> {
  if (ann.end === null || session.date === null) return false;
  const startMs = Date.parse(session.date);
  if (Number.isNaN(startMs)) return false;
  return retargetReview(ctx, session, ann, previous.end, {
    id: detectionReviewId(session.id, ann.id),
    ts: reviewEntryTs(startMs, ann.end),
  });
}

/** Hands the rating of a detection being merged away to the one that absorbs
 *  it. If the survivor was rated too, its own rating stands: two detections of
 *  one tune, merged, are one playing and therefore one review. */
export async function absorbReviewEntry(
  ctx: AppContext,
  session: ClipSessionRef,
  absorbed: Detection,
  absorbedPreviousEnd: number | null,
  survivor: Detection,
): Promise<boolean> {
  if (survivor.end === null || session.date === null) return false;
  const startMs = Date.parse(session.date);
  if (Number.isNaN(startMs)) return false;
  return retargetReview(ctx, session, absorbed, absorbedPreviousEnd, {
    id: detectionReviewId(session.id, survivor.id),
    ts: reviewEntryTs(startMs, survivor.end),
  });
}

/** Takes the rating with the detection (user's rule, 2026-09-23): the rating
 *  said this tune was played here, and deleting the detection says it was not.
 *  Deleting the whole ANALYSIS is the opposite case — the playing stands, only
 *  the origin goes; that one is handled in db.ts's deleteSession. */
export async function dropReviewEntry(
  ctx: AppContext,
  session: ClipSessionRef,
  ann: Detection,
): Promise<boolean> {
  return retargetReview(ctx, session, ann, ann.end, null);
}

/** Moves every rating of a session when the session's own date moves — the
 *  instant a tune ended is that date plus its end, so editing the date by a
 *  minute shifts all of them by a minute. The picker only offers minutes, so
 *  re-choosing what looks like the same date lands seconds away from it.
 *
 *  Clearing the date moves nothing: there is no instant to move to, and the
 *  ratings keep the one they were given. */
export async function repinSessionDate(
  ctx: AppContext,
  /** Only the analysis's identity and its NEW date — an import in progress has
   *  no duration to give yet, and this needs none. */
  session: { id: string; date: string | null },
  anns: readonly Detection[],
  previousDate: string | null,
): Promise<boolean> {
  if (session.date === null || previousDate === null) return false;
  const from = Date.parse(previousDate), to = Date.parse(session.date);
  if (Number.isNaN(from) || Number.isNaN(to) || from === to) return false;

  let changed = false;
  await ctx.mutate(s => {
    for (const ann of anns) {
      if (ann.end === null) continue;
      const card = cardOfTuneId(ann.tuneId, s.cards);
      if (!card) continue;
      const work = s.cardWorks[`${s.currentProfileId}:${card.id}`];
      if (!work) continue;
      const id = detectionReviewId(session.id, ann.id);
      const history = retargetedHistory(work.history, id, reviewEntryTs(from, ann.end), {
        id, ts: reviewEntryTs(to, ann.end),
      });
      if (!history) continue;
      work.history = history;
      changed = true;
    }
  });
  return changed;
}
