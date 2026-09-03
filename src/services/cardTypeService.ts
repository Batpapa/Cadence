import type { Card } from '../types';

/** The card specialisations this build knows about.
 *
 *  `Card.type` is an open string on purpose (see its doc in types.ts), so this
 *  module is the only place that decides what a value MEANS. Anything not
 *  listed here — a value from a future build, or a hand-edited import — is
 *  treated as an ordinary card: unknown specialisations degrade, they never
 *  throw and never hide a card.
 *
 *  Ordering note: 'tune' exists so a hand-made card can be a tune too. A card
 *  imported from TheSession or IrishTuneInfo carries the same type, stamped by
 *  the V6 → V7 migration, but `externalId` is NOT what makes a card a tune —
 *  a tune learnt by ear has no external id and is just as much a tune. */
export const CARD_TYPE_TUNE = 'tune';
export const CARD_TYPE_TUNESET = 'tuneset';

/** Every type a user can pick, in the order the selector offers them.
 *  `undefined` (no type) is offered too, but isn't a member of this list —
 *  it's the absence of a choice, not a choice. */
export const CARD_TYPES = [CARD_TYPE_TUNE, CARD_TYPE_TUNESET] as const;

export function isTune(card: Card | undefined): boolean {
  return card?.type === CARD_TYPE_TUNE;
}

/** True only for a card explicitly typed as a set. A `tunes` list alone never
 *  makes a set — that would give two contradictable markers for one fact. */
export function isTuneset(card: Card | undefined): boolean {
  return card?.type === CARD_TYPE_TUNESET;
}

/** The tunes of a set, in order — empty for anything that isn't a set, so
 *  callers never have to check the type and the list separately.
 *
 *  Still guarded even though `applyCardType` drops the list when a card stops
 *  being a set: an imported card can arrive carrying both a `tunes` array and
 *  some other type, and this must not read it. */
export function tunesOf(card: Card | undefined): Card['tunes'] {
  return isTuneset(card) ? (card?.tunes ?? []) : [];
}

/** i18n key for a type, for the selector and any label that shows one.
 *  `undefined` and unknown values share the "no type" label. */
export function cardTypeLabelKey(type: string | undefined): string {
  if (type === CARD_TYPE_TUNE) return 'card.type.tune';
  if (type === CARD_TYPE_TUNESET) return 'card.type.tuneset';
  return 'card.type.none';
}

/** Whether `candidate` may be added to `set`'s tune list.
 *
 *  Strict on purpose: a set contains tunes and nothing else. An untyped card
 *  is NOT eligible — the user types it first, from its own page or in bulk.
 *  Excluding sets also falls out of this, so a reference cycle is impossible
 *  by construction rather than by a check somewhere downstream.
 *
 *  This is one half of an invariant; the other half is that a card already
 *  playing in a set can no longer change type (see `isTypeLocked`). Entry and
 *  exit both guarded, so "every member of a set is a tune" stays true over
 *  time instead of only at the moment of insertion. */
export function canBeTuneOf(candidate: Card, set: Card): boolean {
  return candidate.id !== set.id && isTune(candidate);
}

/** Applies a type to a card in place; an empty string clears it.
 *
 *  A card that is not a set carries no tune list — the rule is stated on the
 *  RESULTING type rather than on the transition, so it holds unconditionally
 *  and a stray list (from an import, say) cannot survive by arriving through
 *  an unexpected path.
 *
 *  This DISCARDS the set's contents, and the app has no undo: the caller is
 *  responsible for whatever confirmation the gesture deserves. */
export function applyCardType(card: Card, type: string): void {
  const wasSet = isTuneset(card);
  if (type) card.type = type; else delete card.type;
  if (!isTuneset(card)) {
    delete card.tunes;
    delete card.computedName;
    return;
  }
  // A set names itself by default. Only on the way IN, so re-picking the type
  // a card already has cannot silently undo a user who turned it off. Safe
  // here because the automatic name never overwrites with an empty string —
  // a set with no tunes yet keeps whatever it was called.
  if (!wasSet) card.computedName = true;
}

/** Whether this card's type may still be changed.
 *
 *  A card playing in at least one set is locked as a tune: retyping it would
 *  leave a non-tune sitting inside a set, which `canBeTuneOf` refuses to
 *  create in the first place. The caller supplies the set count (the lookup
 *  lives in cardRefService, which already depends on this module). */
export function isTypeLocked(setCount: number): boolean {
  return setCount > 0;
}
