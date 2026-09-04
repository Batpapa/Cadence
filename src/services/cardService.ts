import type { AppState } from '../types';

/** Everything deleting a card means, in one place: the card itself, its place
 *  in every deck, and this profile's work on it. The card leaves the decks it
 *  was in — no deck is ever deleted with it.
 *
 *  Written out identically in three places before this existed (the library's
 *  toolbar, the card page's delete button, the migration's duplicate cleanup),
 *  which is exactly how one of them ends up leaving debris the others clear. */
export function removeCards(state: AppState, cardIds: string[]): void {
  for (const cardId of cardIds) {
    delete state.cards[cardId];
    for (const deck of Object.values(state.decks)) deck.entries = deck.entries.filter(e => e.cardId !== cardId);
    delete state.cardWorks[`${state.currentProfileId}:${cardId}`];
  }
}
