import type { Card } from '../types';
import { TUNE_ANALYSER_MODULE_KEY, type Analysis, type Detection, type TuneAnalyserModuleData } from './model';

// ── "Detected in": the sessions where a card's tune was recognised ────────────
// The third twin of cardRefService's findBacklinks/findSetsContaining, and for
// the same reasons — derived on demand, never stored, so it cannot go stale and
// costs nothing in the synced blob. It lives here rather than beside them
// because it derives from a DIFFERENT source: the tune-analyser module's own
// slice of the user blob, which the core knows nothing about. That is exactly
// what makes this the module's contribution to a card rather than the card
// view's business.

/** One detection, and where to find it again. */
export interface CardDetection {
  annotationId: string;
  /** Seconds from the session's start — what the row shows and what the deep
   *  link seeks to when there is audio to seek. */
  start: number;
  confirmed: boolean;
  bucket: Detection['bucket'];
  confidence: number;
}

/** A session that recognised this card's tune, with every detection of it.
 *  Two passes through the same tune in one evening are two detections here:
 *  each is its own place in the recording, so each is its own destination. */
export interface CardDetectionGroup {
  sessionId: string;
  name: string;
  /** ISO timestamp of the session's t=0, null for an import nobody has dated
   *  yet — the summary screen lets it be set and erased. */
  date: string | null;
  detections: CardDetection[];
}

/** TheSession's numeric tune id for a card, or null when there is nothing to
 *  match on. Only cards imported from TheSession can ever appear in a session's
 *  results: the recogniser answers with TheSession ids, so a hand-made card or
 *  one from IrishTuneInfo has no ground to be matched on. */
export function theSessionTuneId(card: Card): string | null {
  const id = card.externalId;
  if (!id || !id.startsWith('thesession:')) return null;
  const rest = id.slice('thesession:'.length);
  return /^\d+$/.test(rest) ? rest : null;
}

/** Every session that recognised this card's tune, newest session first, each
 *  with its detections in playing order.
 *
 *  Matching is on the detection's OWN `tuneId`, which is the displayed
 *  identity: where the user corrected a detection, the correction is what
 *  counts, not the algorithm's first answer. A detection that has since been
 *  re-identified as another tune therefore leaves this list, which is the point
 *  of deriving rather than storing.
 *
 *  Cost is one pass over the sessions' annotations — dozens of sessions of a
 *  few dozen detections. Deliberately not indexed: an index would be a second
 *  copy of a fact, with every add, delete, re-analysis and correction to
 *  maintain, for a scan that costs nothing at the moment a card is opened. */
export function findCardDetections(card: Card, sessions: Record<string, Analysis>): CardDetectionGroup[] {
  const tuneId = theSessionTuneId(card);
  if (tuneId === null) return [];

  const groups: CardDetectionGroup[] = [];
  for (const session of Object.values(sessions)) {
    const detections = (session.annotations ?? [])
      .filter(a => a.tuneId === tuneId)
      .map(a => ({
        annotationId: a.id,
        start: a.start,
        confirmed: a.userConfirmed,
        bucket: a.bucket,
        confidence: a.confidence,
      }))
      .sort((a, b) => a.start - b.start);
    if (detections.length > 0) {
      groups.push({ sessionId: session.id, name: session.name, date: session.date, detections });
    }
  }
  // Newest first, and an undated import last rather than first: an unknown date
  // is not a very old one, and sorting it to the top would push real sessions
  // down under something that says nothing.
  const at = (g: CardDetectionGroup) => { const ms = g.date ? Date.parse(g.date) : NaN; return Number.isNaN(ms) ? -Infinity : ms; };
  return groups.sort((a, b) => at(b) - at(a));
}

/** Whether this module's panel should appear on card pages. Absent = yes. */
export function detectionsOnCards(user: { modules?: Record<string, unknown> }): boolean {
  return (user.modules?.[TUNE_ANALYSER_MODULE_KEY] as TuneAnalyserModuleData | undefined)?.detectionsOnCards !== false;
}

/** The module's slice of a user blob — read here rather than through db.ts so
 *  this stays a pure function of state, testable without a database. */
export function sessionsOf(user: { modules?: Record<string, unknown> }): Record<string, Analysis> {
  return (user.modules?.[TUNE_ANALYSER_MODULE_KEY] as TuneAnalyserModuleData | undefined)?.sessions ?? {};
}
