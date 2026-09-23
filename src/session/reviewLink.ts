// ── How this module names the ratings it files ───────────────────────────────
// A rating given from a detection is an ordinary review entry — the card page
// and FSRS neither know nor care where it came from. What it carries is an
// `id` (SessionEntry.id), opaque to everything outside this module, which this
// file builds and reads. The core only ever compares it; see
// services/reviewEntries.ts.
//
// Why it exists at all: the id used to BE the instant, and the instant is
// computed from the analysis's date and the detection's end, on the card the
// detection's tune points at. Every one of those can be corrected afterwards —
// a bound, a date, a merge, a confirmed alternate — and each correction left
// the rating where nothing could find it, so the detection offered to file a
// second one. One evening's playing, two reviews for FSRS to schedule from.

const PREFIX = 'analysis';

/** The id a rating given from `detectionId` of `sessionId` carries.
 *
 *  Both are UUIDs, so the separator cannot occur inside either — which is what
 *  lets the session be read back out of a finished id. */
export function detectionReviewId(sessionId: string, detectionId: string): string {
  return `${PREFIX}:${sessionId}:${detectionId}`;
}

/** Whether `id` names a rating given from that analysis — what deleting one
 *  asks, so it can drop the origins it is about to invalidate. */
export function isAnalysisReviewId(id: string, sessionId: string): boolean {
  return id.startsWith(`${PREFIX}:${sessionId}:`);
}

/** Where a detection's rating is filed in time: the wall-clock instant the
 *  tune ended. `endSec` counts from the start of the recording.
 *
 *  This one is not identity but data — it is the review's date, and FSRS
 *  schedules from it — so it follows the detection's end when that moves. */
export function reviewEntryTs(sessionStartMs: number, endSec: number): number {
  return sessionStartMs + endSec * 1000;
}
