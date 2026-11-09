import type { Card } from '../types';

/** Where a card was imported from, as this build knows it — read off its
 *  `externalId`, never off its tags.
 *
 *  Until 2026-11-09 the importers also wrote a tag naming the source
 *  ("TheSession", "IrishTuneInfo"). The id already said it, the tag could
 *  drift from it (edited, renamed, kept after a migration to another source),
 *  and the library now filters on the source directly; see stripSourceTag for
 *  the tags already written. */
export const CARD_SOURCE_THESESSION = 'thesession';
export const CARD_SOURCE_IRISHTUNEINFO = 'irishtuneinfo';

/** Every source the library filter offers, in its order. "No source" is
 *  offered too, but is the absence of one, not a member. */
export const CARD_SOURCES = [CARD_SOURCE_THESESSION, CARD_SOURCE_IRISHTUNEINFO] as const;
export type CardSource = typeof CARD_SOURCES[number];

/** `externalId` prefix → source. A TheSession set ("thesession-set:1-2") comes
 *  from TheSession as much as its tunes do. */
const PREFIXES: ReadonlyArray<[string, CardSource]> = [
  ['thesession:', CARD_SOURCE_THESESSION],
  ['thesession-set:', CARD_SOURCE_THESESSION],
  ['irishtuneinfo:', CARD_SOURCE_IRISHTUNEINFO],
];

/** The source a card counts as — `undefined` for a card made by hand AND for
 *  an id this build does not know (a future build's, a hand-edited import),
 *  the same rule knownCardType applies, so no card falls through every bucket
 *  of the filter. */
export function cardSource(card: Card | undefined): CardSource | undefined {
  const id = card?.externalId;
  if (!id) return undefined;
  return PREFIXES.find(([prefix]) => id.startsWith(prefix))?.[1];
}

/** What a source is called on screen: the site's own name, not translated. */
export function cardSourceLabel(source: string): string {
  return source === CARD_SOURCE_THESESSION ? 'TheSession'
    : source === CARD_SOURCE_IRISHTUNEINFO ? 'irishtune.info'
    : source;
}

/** The tag the importers used to write for each source, lower-cased: early
 *  builds wrote "thesession", later ones "TheSession" (the V3 → V4 migration
 *  only renamed it on tune cards), so every casing of the name goes. */
const SOURCE_TAGS: Record<CardSource, string> = {
  [CARD_SOURCE_THESESSION]: 'thesession',
  [CARD_SOURCE_IRISHTUNEINFO]: 'irishtuneinfo',
};

/** Removes the tag naming the card's own source, which its `externalId` now
 *  carries alone. Returns whether the card changed.
 *
 *  Only that tag, and only when the id agrees: "TheSession" on a hand-made
 *  card, or on an irishtune.info card, is the user's own and says something
 *  the id does not. Run on every normalisation rather than once, because an
 *  older build still writes the tag when it imports or refreshes a card. */
export function stripSourceTag(card: Card): boolean {
  const source = cardSource(card);
  if (!source || !Array.isArray(card.tags)) return false;
  const tag = SOURCE_TAGS[source];
  const isSourceTag = (t: string) => t.toLowerCase() === tag;
  if (!card.tags.some(isSourceTag)) return false;
  card.tags = card.tags.filter(t => !isSourceTag(t));
  return true;
}
