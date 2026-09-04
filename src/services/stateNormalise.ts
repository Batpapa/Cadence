import type { AppState, Card, CardRef } from '../types';
import { resolveCardRef } from './cardRefService';
import { isTuneset } from './cardTypeService';

/** How a set's tunes are strung together into its name. The session
 *  convention, and deliberately not TheSession's own comma — an imported set
 *  is renamed to this form so every set in the library reads the same way. */
export const TUNESET_NAME_SEPARATOR = ' / ';

/** The name a set WOULD carry automatically, or null when there is nothing to
 *  build one from. Deliberately ignores `computedName`, so the card page can
 *  show a live preview of what turning it on would give.
 *
 *  Each tune contributes its resolved card's live name — that is what makes
 *  the set's name follow a rename — falling back to the reference's stored
 *  title when the card is gone, so a deleted tune leaves a legible trace
 *  instead of quietly shortening the title. */
export function tunesetAutoName(card: Card, cards: Record<string, Card>): string | null {
  const parts = (card.tunes ?? [])
    .map(ref => resolveCardRef(ref, cards)?.name ?? ref.title)
    .filter(name => name.trim());
  return parts.length > 0 ? parts.join(TUNESET_NAME_SEPARATOR) : null;
}

/** Every card reference this card stores, whatever role it plays: a mention
 *  among its attachments, or — on a set — one of its tunes.
 *
 *  `tunes` is walked even on a card that is not a set. The list is ignored when
 *  reading (type is the truth), but an ignored list is not a corrupt one, and
 *  a card retyped back to a set should not come back with stale titles. */
function cardRefsOf(card: Card): CardRef[] {
  const refs: CardRef[] = card.content?.attachments?.filter(a => a.type === 'card') ?? [];
  return card.tunes ? [...refs, ...card.tunes] : refs;
}

/** Brings a state's derived fields back in line with what they are derived
 *  from. Pure in effect — same input, same output — and idempotent, so it is
 *  safe to run on every state change however often that is.
 *
 *  Two derived things live here, and they are the same problem — a value that
 *  depends on another card, stored in a field rather than recomputed at every
 *  read, so that everything which already displays, sorts, searches, exports
 *  and snapshots a card name keeps working untouched:
 *
 *  1. A set's `name`, when it has opted into `computedName`.
 *  2. Every `CardRef.title`. That field is a snapshot of the target's name
 *     taken when the reference was created, and nothing ever updated it, so
 *     renaming a card left every reference to it frozen on the old name.
 *     Invisible while the target resolves (rows display the resolved card's
 *     live name and only fall back to `title`), but it silently broke
 *     `resolveLocalCardRefs`, which matches a package's reference titles
 *     against card names on import. Refreshing is always right because the
 *     field's only job is to be a fallback: a fresher fallback is strictly
 *     better, and the historical name is never what you want. */
export function normaliseState(state: AppState): void {
  const cards = state.cards ?? {};

  // Two passes, in this order, and it provably terminates without iterating to
  // a fixpoint: a set's name is built from TUNE names, which are never
  // computed, so pass one reads nothing pass one writes. Pass two then reads
  // every name including the sets' fresh ones, so a reference pointing AT a
  // set picks up its new title in the same normalisation. The dependency graph
  // is only that deep because a set cannot contain a set (canBeTuneOf).
  for (const card of Object.values(cards)) {
    if (!isTuneset(card) || !card.computedName) continue;
    const auto = tunesetAutoName(card, cards);
    // Never an empty name: a card with no name is unsortable, unsearchable and
    // effectively invisible in the library. A set with no tunes yet simply
    // keeps whatever it was called.
    if (auto && card.name !== auto) card.name = auto;
  }

  for (const card of Object.values(cards)) {
    for (const ref of cardRefsOf(card)) {
      const target = resolveCardRef(ref, cards);
      // An unresolved reference keeps its last known title — that is exactly
      // what the fallback is for, and the alternative would be erasing the
      // only trace of a deleted card.
      if (!target) continue;
      if (ref.title !== target.name) ref.title = target.name;
      // Heal the lookup while we hold the answer. `resolveCardRef` is O(1)
      // through its id fast path but falls back to scanning every card by guid
      // or externalId, which is the normal state of affairs after an import or
      // a merge rewrote ids. Writing the resolved id back means each reference
      // pays that scan at most once ever, instead of on every pass — and it
      // cannot change what the reference points at, since id is what the
      // resolver consults first and it is this same card's.
      if (ref.id !== target.id) ref.id = target.id;
      if (ref.guid !== target.guid) ref.guid = target.guid;
      // Same reasoning for the third lookup key, which is the one that can
      // change under a reference that still resolves: migrating a card from
      // IrishTuneInfo to TheSession keeps its id and guid but replaces its
      // externalId, leaving every set that plays it pointing at a source the
      // card no longer has.
      if (ref.externalId !== target.externalId) {
        if (target.externalId) ref.externalId = target.externalId;
        else delete ref.externalId;
      }
    }
  }
}
