// ── What a bulk action over a selection of tunes has to decide ───────────────
// A leaf, like tuneRanking.ts and for the same reason: the panel that calls
// this reaches the store, the Drive client and IndexedDB, so the one question
// worth getting right lives out here where a test can ask it directly.

/** How many of these tunes a deck would gain.
 *
 *  A tune with no card yet counts: the operation creates it, so it WILL join.
 *  That is the whole difference from the card library's version of this, where
 *  every row is by definition already a card. */
export function deckGain(
  tuneIds: string[],
  cardIdOf: (tuneId: string) => string | undefined,
  deckHolds: (cardId: string) => boolean,
): number {
  return tuneIds.filter(tuneId => {
    const cardId = cardIdOf(tuneId);
    return cardId === undefined || !deckHolds(cardId);
  }).length;
}
