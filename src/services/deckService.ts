import type { User, Card, Deck, DeckEntry, CardWork, AppState } from '../types';
import {
  cardGain, totalDeckImportance, isAvailable,
} from './knowledgeService';

// ── Picking strategies ────────────────────────────────────────────────────────

/** Cards eligible for study: the not-yet-mastered ones, or every card when
 *  `excludeMastered` is off (study as if the mastery threshold were 100%). */
function candidateEntries(
  user: User,
  profileId: string,
  deck: Deck,
  cardWorks: Record<string, CardWork>,
  excludeMastered: boolean
): DeckEntry[] {
  if (!excludeMastered) return [...deck.entries];
  return deck.entries.filter(entry => {
    const work = cardWorks[`${profileId}:${entry.cardId}`];
    return !isAvailable(user, work);
  });
}

/** Uniform random pick among eligible cards. */
export function pickRandom(
  user: User,
  profileId: string,
  deck: Deck,
  cardWorks: Record<string, CardWork>,
  excludeMastered = true
): DeckEntry | null {
  const candidates = candidateEntries(user, profileId, deck, cardWorks, excludeMastered);
  if (candidates.length === 0) return null;
  return candidates[Math.floor(Math.random() * candidates.length)] ?? null;
}

/** Deterministic: eligible entry with highest marginal gain. */
export function pickOptimal(
  user: User,
  profileId: string,
  deck: Deck,
  cards: Record<string, Card>,
  cardWorks: Record<string, CardWork>,
  weighted = true,
  excludeMastered = true
): DeckEntry | null {
  const candidates = candidateEntries(user, profileId, deck, cardWorks, excludeMastered);
  if (candidates.length === 0) return null;
  const total = totalDeckImportance(deck, cards, weighted);
  let best: DeckEntry | null = null;
  let bestGain = -Infinity;
  for (const entry of candidates) {
    const card = cards[entry.cardId];
    if (!card) continue;
    const work = cardWorks[`${profileId}:${entry.cardId}`];
    const g = cardGain(user, card, entry, total, work, weighted);
    if (g > bestGain) { bestGain = g; best = entry; }
  }
  return best ?? candidates[0] ?? null;
}

/** Weighted random by marginal gain among eligible cards. */
export function pickStochastic(
  user: User,
  profileId: string,
  deck: Deck,
  cards: Record<string, Card>,
  cardWorks: Record<string, CardWork>,
  weighted = true,
  excludeMastered = true
): DeckEntry | null {
  const candidates = candidateEntries(user, profileId, deck, cardWorks, excludeMastered);
  if (candidates.length === 0) return null;
  const total = totalDeckImportance(deck, cards, weighted);
  const gains = candidates.map(e => {
    const card = cards[e.cardId];
    if (!card) return 0;
    const work = cardWorks[`${profileId}:${e.cardId}`];
    return Math.max(0, cardGain(user, card, e, total, work, weighted));
  });
  const totalGain = gains.reduce((s, g) => s + g, 0);
  if (totalGain === 0) return candidates[Math.floor(Math.random() * candidates.length)] ?? null;
  let r = Math.random() * totalGain;
  for (let i = 0; i < gains.length; i++) {
    r -= gains[i]!;
    if (r <= 0) return candidates[i] ?? null;
  }
  return candidates[candidates.length - 1] ?? null;
}

// ── Navigation helpers ────────────────────────────────────────────────────────

export function findParentFolder(
  targetId: string,
  type: 'folder' | 'deck',
  user: AppState
): string | null {
  for (const folder of Object.values(user.folders)) {
    const list = type === 'folder' ? folder.folderIds : folder.deckIds;
    if (list.includes(targetId)) return folder.id;
  }
  return null;
}

/** Full breadcrumb path for a deck, e.g. "Folk / Reels / My deck". */
export function deckPath(deckId: string, user: AppState): string {
  const deck = user.decks[deckId];
  if (!deck) return '';
  const parts: string[] = [deck.name];
  let folderId = findParentFolder(deckId, 'deck', user);
  while (folderId) {
    const folder = user.folders[folderId];
    if (!folder) break;
    parts.unshift(folder.name);
    folderId = findParentFolder(folderId, 'folder', user);
  }
  return parts.join(' / ');
}

export function decksContainingCard(cardId: string, user: AppState): string[] {
  return Object.values(user.decks)
    .filter(d => d.entries.some(e => e.cardId === cardId))
    .map(d => d.id);
}
