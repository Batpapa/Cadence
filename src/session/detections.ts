import type { Card } from '../types';
import { TUNE_ANALYSER_MODULE_KEY, type Analysis, type Detection, type TuneAnalyserModuleData } from './model';
import { cardGuidOf, cardTuneId } from './recognition/cardIndex';

// ── "Detected in": the sessions where a card's tune was recognised ────────────
// The third twin of cardRefService's findBacklinks/findSetsContaining, and for
// the same reasons — derived on demand, never stored, so it cannot go stale and
// costs nothing in the synced blob. It lives here rather than beside them
// because it derives from a DIFFERENT source: the tune-analyser module's own
// slice of the user blob, which the core knows nothing about. That is exactly
// what makes this the module's contribution to a card rather than the card
// view's business.

/** A session that recognised this card's tune, with every detection of it.
 *  Two passes through the same tune in one evening are two detections here:
 *  each is its own place in the recording, so each is its own destination.
 *
 *  Whole objects rather than a summary of them (2026-09-13): a pass is played,
 *  previewed and cut into a clip from the card page now, exactly as from the
 *  analyser's tunes tab, and those controls need the detection's end and
 *  setting and the analysis's duration — a summary would only have grown back
 *  into the originals one field at a time. */
export interface CardDetectionGroup {
  session: Analysis;
  /** In playing order. */
  detections: Detection[];
}

/** TheSession's numeric tune id for a card, or null when it is not a
 *  TheSession tune. Since 2026-11-16 a tune card with an ABC is recognised
 *  too, under its own id (detectionTuneId below, cardIndex.ts). */
export function theSessionTuneId(card: Card): string | null {
  const id = card.externalId;
  if (!id || !id.startsWith('thesession:')) return null;
  const rest = id.slice('thesession:'.length);
  return /^\d+$/.test(rest) ? rest : null;
}

/** The tune id a detection of this card carries: TheSession's when the card is
 *  a TheSession tune, else the card's own, `card:<guid>` — what the recogniser
 *  names a tune card by when it found it from the card's ABC (cardIndex.ts). */
export function detectionTuneId(card: Card): string {
  return theSessionTuneId(card) ?? cardTuneId(card.guid);
}

/** The card a detection's tune id names: by its guid for a card's own tune
 *  (`card:<guid>`, whatever the card has become since), else the card with
 *  that TheSession tune as its external id — the first in `cards` order, as
 *  `findByExternalId('thesession:' + tuneId)` answers it. */
export function cardOfTuneId(tuneId: string, cards: Record<string, Card>): Card | undefined {
  const guid = cardGuidOf(tuneId);
  if (guid !== null) return Object.values(cards).find(c => c.guid === guid);
  return Object.values(cards).find(c => c.externalId === `thesession:${tuneId}`);
}

/** cardOfTuneId, from a map built in one pass. For a list that names a tune
 *  per row: searching every card per row took seconds per click over 3000 rows
 *  and 1500 cards (bench, 2026-11-10). */
export function cardsByExternalTuneId(cards: Record<string, Card>): (tuneId: string) => Card | undefined {
  const byTune = new Map<string, Card>();
  for (const card of Object.values(cards)) {
    const own = cardTuneId(card.guid);
    if (!byTune.has(own)) byTune.set(own, card);
    const ext = card.externalId;
    if (!ext?.startsWith('thesession:')) continue;
    const tuneId = ext.slice('thesession:'.length);
    if (!byTune.has(tuneId)) byTune.set(tuneId, card);
  }
  return tuneId => byTune.get(tuneId);
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
  // Its TheSession tune, and its own tune id (cardIndex.ts): a card linked to
  // TheSession after it had been recognised from its ABC has detections of both.
  const tuneIds = new Set([cardTuneId(card.guid)]);
  const theSession = theSessionTuneId(card);
  if (theSession !== null) tuneIds.add(theSession);

  const groups: CardDetectionGroup[] = [];
  for (const session of Object.values(sessions)) {
    // filter() copies, so the sort never reorders the analysis's own list.
    const detections = (session.annotations ?? [])
      .filter(a => tuneIds.has(a.tuneId))
      .sort((a, b) => a.start - b.start);
    if (detections.length > 0) groups.push({ session, detections });
  }
  // Newest first, and an undated import last rather than first: an unknown date
  // is not a very old one, and sorting it to the top would push real sessions
  // down under something that says nothing.
  const at = (g: CardDetectionGroup) => { const ms = g.session.date ? Date.parse(g.session.date) : NaN; return Number.isNaN(ms) ? -Infinity : ms; };
  return groups.sort((a, b) => at(b) - at(a));
}

/** Whether this module's panel should appear on card pages. Absent = yes. */
export function detectionsOnCards(user: { modules?: Record<string, unknown> }): boolean {
  return (user.modules?.[TUNE_ANALYSER_MODULE_KEY] as TuneAnalyserModuleData | undefined)?.detectionsOnCards !== false;
}

/** Whether sets are detected and shown at all — "Use set detection", an
 *  option of the module, on by default. Absent = on. Off, the analyser behaves
 *  exactly as it did before sets existed. Reads the stored `experimentalSets`
 *  field, whose name outlived the experiment (see TuneAnalyserModuleData). */
export function setDetectionOn(user: { modules?: Record<string, unknown> }): boolean {
  return (user.modules?.[TUNE_ANALYSER_MODULE_KEY] as TuneAnalyserModuleData | undefined)?.experimentalSets !== false;
}


/** The module's slice of a user blob — read here rather than through db.ts so
 *  this stays a pure function of state, testable without a database. */
export function sessionsOf(user: { modules?: Record<string, unknown> }): Record<string, Analysis> {
  return (user.modules?.[TUNE_ANALYSER_MODULE_KEY] as TuneAnalyserModuleData | undefined)?.sessions ?? {};
}
