import type { AppState } from '../types';

/** Everything deleting a card means, in one place: the card itself, its place
 *  in every deck, and EVERY profile's work on it. The card leaves the decks it
 *  was in — no deck is ever deleted with it.
 *
 *  Written out identically in three places before this existed (the library's
 *  toolbar, the card page's delete button, the migration's duplicate cleanup),
 *  which is exactly how one of them ends up leaving debris the others clear.
 *
 *  Every profile, not just the current one: a card is not per-profile, so
 *  deleting it deletes it for everyone, and the work the others did on it can
 *  never be reached again — no screen can open it, no deck contains it, no
 *  import brings it back (a re-imported card gets a fresh id). Clearing only
 *  the current profile's row left exactly that debris, and it was visible: on
 *  one real library, a profile showed 52 reviews on the dashboard and not a
 *  single reviewed card anywhere else, because all 52 were rows left behind
 *  when another profile deleted their cards (2026-09-05). */
export function removeCards(state: AppState, cardIds: string[]): void {
  for (const cardId of cardIds) {
    delete state.cards[cardId];
    for (const deck of Object.values(state.decks)) deck.entries = deck.entries.filter(e => e.cardId !== cardId);
    for (const profileId of state.profileIds) delete state.cardWorks[`${profileId}:${cardId}`];
  }
}

// Renaming a tag on every card — the library's pencil, merging into a name that
// already exists (2026-11-01) — is tagGroups.ts's renameTagNode since tag
// groups (2026-11-09): renaming a group renames what is under it.

/** Removes a tag from every card that carries it; the cards themselves stay.
 *  The other half of the library's pencil (asked for 2026-11-09, once tag
 *  groups made "dissolving" a group a thing: a single tag needed the same).
 *  Exactly that tag, not a group's content: a group is dissolved instead
 *  (tagGroups.ts). Only the cards' own `tags`: a set found by its tunes' tags
 *  reads them live. Returns how many cards changed. */
export function removeTagEverywhere(state: AppState, tag: string): number {
  let n = 0;
  for (const card of Object.values(state.cards)) {
    if (!card.tags?.includes(tag)) continue;
    card.tags = card.tags.filter(tg => tg !== tag);
    n++;
  }
  return n;
}
