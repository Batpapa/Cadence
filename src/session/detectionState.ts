import type { Detection, DetectionEvent } from './model';

// ── The detection list both engines keep ─────────────────────────────────────
// LiveSession and ImportSession held byte-identical copies of this until
// 2026-09-20. They are the same thing — a live recording and a file import run
// through the very same recogniser, one faster than real time — and the rules
// below are the delicate part: which of the user's decisions survive an update
// from the decoder, and which of the decoder's updates the user's decisions
// override.
//
// Pure, and in its own file, for the reason timelineModel.ts gives: it deserves
// tests, and importing either engine to get at it would drag in the worklet,
// the worker and the database.

/** Folds a batch of decoder events into `annotations`, in place.
 *
 *  Two rules, and both exist because a person's decision must outrank the
 *  algorithm's:
 *
 *  • A `retract` spares a detection the user has confirmed. Retraction means
 *    "this guess never really held up", which is not a thing that can be said
 *    about a tune someone has vouched for.
 *  • An update to a confirmed detection keeps the user's tune identity and
 *    takes only the timing and confidence. On an unconfirmed one it still
 *    carries the like marker and any hand-named variants forward — the
 *    aggregator has never heard of either.
 *
 *  There was briefly a third — a set of ids the user had deleted by hand, so
 *  the decoder could not put them back. It went the same day it arrived
 *  (2026-09-20): deleting a detection while its analysis is still running is
 *  not offered any more, and neither is anything else that acts on one. See
 *  the note above `cardOpts` in ImportAnalysis.tsx.
 */
export function applyDetectionEvents(
  annotations: Map<string, Detection>,
  events: DetectionEvent[],
): void {
  for (const ev of events) {
    if (ev.type === 'retract') {
      if (!annotations.get(ev.id)?.userConfirmed) annotations.delete(ev.id);
      continue;
    }

    const existing = annotations.get(ev.detection.id);
    if (existing?.userConfirmed) {
      annotations.set(ev.detection.id, {
        ...ev.detection,
        tuneId: existing.tuneId,
        settingId: existing.settingId,
        displayName: existing.displayName,
        dance: existing.dance,
        meter: existing.meter,
        userConfirmed: true,
        liked: existing.liked,
        manualAlternates: existing.manualAlternates,
      });
    } else {
      // Hand-named tunes outlive an un-confirmation, hence carrying them here
      // too and not only in the branch above.
      annotations.set(ev.detection.id, {
        ...ev.detection,
        liked: existing?.liked ?? false,
        manualAlternates: existing?.manualAlternates,
      });
    }
  }
}
