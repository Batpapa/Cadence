import type { Card, CardReferenceAttachment } from '../types';

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
