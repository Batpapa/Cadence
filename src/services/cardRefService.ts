import type { Card, CardReferenceAttachment } from '../types';

/** Resolution order matters, and `findBacklinks` below depends on it: a
 *  reference whose `id` lands on one card while its `guid` matches another
 *  belongs to the FIRST — anything else would make the backlink list disagree
 *  with where clicking the reference actually goes. */
export function resolveCardRef(ref: CardReferenceAttachment, cards: Record<string, Card>): Card | null {
  const byId = cards[ref.id];
  if (byId) return byId;

  const byGuid = Object.values(cards).find(c => c.guid === ref.guid);
  if (byGuid) return byGuid;

  if (ref.externalId) {
    const byExtId = Object.values(cards).find(c => c.externalId === ref.externalId);
    if (byExtId) return byExtId;
  }

  return null;
}

/** Every card holding a reference that resolves to `cardId` — the inverse of
 *  resolveCardRef, derived on demand rather than stored.
 *
 *  Nothing is persisted on purpose: a stored backlink is a second copy of a
 *  fact, and would have to be maintained on every add, remove, delete, import
 *  and merge. Here the list is a pure function of the cards, so it cannot go
 *  stale — a view reading it re-derives after every state change.
 *
 *  Membership is decided by RUNNING the resolver, never by comparing the
 *  reference's three fields against the target. Those fields are tried in
 *  order, so "any of the three matches" would list a card whose reference in
 *  fact opens a different one — a backlink you could click and not arrive at.
 *
 *  Cost is one pass over the library's attachments. `resolveCardRef` is O(1)
 *  through its id fast path, which is what a reference carries unless an
 *  import or a merge changed the ids under it; the O(n) guid/externalId
 *  fallbacks only run for those.
 *
 *  A card referencing itself is left out (noise, and it is already right
 *  there), and a card referencing the target several times appears once. */
export function findBacklinks(cardId: string, cards: Record<string, Card>): Card[] {
  const out: Card[] = [];
  for (const source of Object.values(cards)) {
    if (source.id === cardId) continue;
    const links = (source.content?.attachments ?? []).some(
      a => a.type === 'card' && resolveCardRef(a, cards)?.id === cardId,
    );
    if (links) out.push(source);
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
