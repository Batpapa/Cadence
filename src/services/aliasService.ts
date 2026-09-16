import type { Card } from '../types';
import { foldForSearch, normalizeDisplayName } from '../utils';

// ── A card's other names ──────────────────────────────────────────────────────
// Every read and write of `Card.aliases` goes through here, so the rules below
// are stated once:
//
//  • Absent and empty mean the same thing (user's call, 2026-09-16) — no
//    migration, and no "never filled in" state to preserve. An emptied list is
//    written as an absent field, so an untouched card and an emptied one are
//    the same object to the Drive diff, which compares deeply.
//  • Duplicates are kept (same call). TheSession lists "Drowsey Maggie" and
//    "Drowsie Maggie" as aliases of Drowsy Maggie: noise to read, but exactly
//    what a misspelled search needs to land.
//  • Only the typing is refused: adding by hand a string the card already
//    carries, as its name or an alias, is a no-op that would read as a failure.

export function cardAliases(card: Card): readonly string[] {
  return card.aliases ?? [];
}

export function setCardAliases(card: Card, aliases: readonly string[]): void {
  if (aliases.length > 0) card.aliases = [...aliases];
  else delete card.aliases;
}

/** A source's aliases as a card stores them. TheSession's data dump writes
 *  names in catalogue order ("Tulla, The"); its live API already does not, and
 *  normalising is a no-op there. Nothing is removed but blanks. */
export function sourceAliases(names: readonly string[]): string[] {
  return names.map(n => normalizeDisplayName(n.trim())).filter(n => n !== '');
}

export type AliasProblem = 'empty' | 'isName' | 'alreadyAlias';

/** Why `value` cannot be written as an alias of `card` — or null when it can.
 *  `exceptIndex` is the alias being renamed, which is merely unchanged rather
 *  than a collision. */
export function aliasProblem(card: Card, value: string, exceptIndex?: number): AliasProblem | null {
  const v = value.trim();
  if (!v) return 'empty';
  if (v === card.name.trim()) return 'isName';
  if (cardAliases(card).some((a, i) => i !== exceptIndex && a === v)) return 'alreadyAlias';
  return null;
}

export function addAlias(card: Card, value: string): boolean {
  if (aliasProblem(card, value)) return false;
  setCardAliases(card, [...cardAliases(card), value.trim()]);
  return true;
}

export function renameAlias(card: Card, index: number, value: string): boolean {
  const list = cardAliases(card);
  if (index < 0 || index >= list.length || aliasProblem(card, value, index)) return false;
  setCardAliases(card, list.map((a, i) => (i === index ? value.trim() : a)));
  return true;
}

export function removeAlias(card: Card, index: number): void {
  setCardAliases(card, cardAliases(card).filter((_, i) => i !== index));
}

/** "Use as name": the alias and the name trade places, the old name taking the
 *  alias's position in the list. Choosing a name is taking it back, so a set
 *  stops naming itself — as typing a name does on the card page. */
export function promoteAliasToName(card: Card, index: number): void {
  const list = cardAliases(card);
  const alias = list[index];
  if (alias === undefined) return;
  const oldName = card.name;
  card.name = alias;
  delete card.computedName;
  setCardAliases(card, oldName.trim() ? list.map((a, i) => (i === index ? oldName : a)) : list.filter((_, i) => i !== index));
}

/** The aliases a refresh writes: the source's, plus the source's own NAME when
 *  the card goes by another one. Without it, a tune renamed to "Reaping the
 *  Rye" and then refreshed would lose "Cooley's" altogether — the source's list
 *  of aliases never repeats its main name, bar a few hundred accidents. */
export function refreshedAliases(card: Card, sourceName: string, aliases: readonly string[]): string[] {
  const list = sourceAliases(aliases);
  const name = sourceName.trim();
  if (!name || foldForSearch(name) === foldForSearch(card.name.trim()) || list.includes(name)) return list;
  return [name, ...list];
}
