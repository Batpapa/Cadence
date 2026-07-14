import type { User, Card, DeckEntry, Deck, CardWork, SessionRating, SessionEntry, AppState } from '../types';

// ── FSRS v4.5 ────────────────────────────────────────────────────────────────
// Reference: https://github.com/open-spaced-repetition/fsrs4anki

const W = [
  0.4072, 1.1829, 3.1262, 15.4722, // w[0-3]  initial stability by grade (1=Again…4=Easy)
  7.2102, 0.5316, 1.0651,           // w[4-6]  difficulty init & update
  0.0589,                           // w[7]    (unused in core formulas)
  1.5330, 0.1544, 1.0070,           // w[8-10] stability-after-recall
  1.9395, 0.1100, 0.2900, 2.2700,  // w[11-14] stability-after-forgetting
  0.2500, 2.9898,                   // w[15-16] hard penalty / easy bonus
] as const;

/** Power-law forgetting curve exponent. */
const DECAY = -0.5;
/** Derived so that R(S) = 0.9 exactly. */
const FACTOR = 19 / 81;

/** FSRS grade from rating (1=Again, 2=Hard, 3=Good, 4=Easy). */
function gradeFromRating(rating: SessionRating): 1 | 2 | 3 | 4 {
  if (rating === 'again') return 1;
  if (rating === 'hard')  return 2;
  if (rating === 'good')  return 3;
  return 4; // 'easy'
}

function initStability(grade: number): number {
  return W[grade - 1]!;
}

function initDifficulty(grade: number): number {
  return Math.max(1, Math.min(10, W[4]! - Math.exp(W[5]! * (grade - 1)) + 1));
}

function nextDifficulty(D: number, grade: number): number {
  const D0good = initDifficulty(3);
  const raw = D - W[6]! * (grade - 3);
  return Math.max(1, Math.min(10, W[5]! * D0good + (1 - W[5]!) * raw));
}

function stabilityAfterRecall(D: number, S: number, R: number, grade: number): number {
  const hardPenalty = grade === 2 ? W[15]! : 1;
  const easyBonus   = grade === 4 ? W[16]! : 1;
  return S * (
    Math.exp(W[8]!) *
    (11 - D) *
    Math.pow(S, -W[9]!) *
    (Math.exp(W[10]! * (1 - R)) - 1) *
    hardPenalty * easyBonus
    + 1
  );
}

function stabilityAfterForgetting(D: number, S: number, R: number): number {
  return W[11]! *
    Math.pow(D, -W[12]!) *
    (Math.pow(S + 1, W[13]!) - 1) *
    Math.exp(W[14]! * (1 - R));
}

/**
 * Retrievability R ∈ (0, 1]: probability of recall after elapsedDays given stability S.
 * forgettingRate > 1 means the user forgets faster (equivalent to S_eff = S / forgettingRate).
 * Pass forgettingRate = 1 (default) for raw FSRS — used inside applyFSRS so state updates
 * are not biased by the user coefficient.
 */
export function fsrsRetrievability(elapsedDays: number, stability: number, forgettingRate = 1): number {
  return Math.pow(1 + FACTOR * elapsedDays / (stability / forgettingRate), DECAY);
}

/** Days from a fresh review (R=1) until R drops to availabilityThreshold, accounting for forgettingRate. */
export function retentionWindowDays(stability: number, availabilityThreshold: number, forgettingRate = 1): number {
  return (stability / forgettingRate) * (Math.pow(availabilityThreshold, 1 / DECAY) - 1) / FACTOR;
}

/** Apply a FSRS rating, returning updated stability (days) and difficulty (1–10). */
export function applyFSRS(
  stability: number | undefined,
  difficulty: number | undefined,
  lastTs: number | undefined,
  rating: SessionRating,
  nowTs = Date.now()
): { stability: number; difficulty: number } {
  const grade = gradeFromRating(rating);

  // First-ever review: initialise from grade
  if (stability === undefined || lastTs === undefined) {
    return {
      stability:  initStability(grade),
      difficulty: difficulty ?? initDifficulty(grade),
    };
  }

  const elapsedDays = Math.max(0, (nowTs - lastTs) / 86400000);
  const R    = fsrsRetrievability(elapsedDays, stability);
  const D    = difficulty ?? initDifficulty(3);
  const Dnew = nextDifficulty(D, grade);
  const Sraw = grade === 1
    ? stabilityAfterForgetting(D, stability, R)
    : stabilityAfterRecall(D, stability, R, grade);

  return {
    stability:  Math.max(0.1, Math.min(36500, Sraw)),
    difficulty: Dnew,
  };
}

// ── Card & deck knowledge ─────────────────────────────────────────────────────

export function effectiveImportance(card: Card, entry: DeckEntry): number {
  return entry.importance ?? card.defaultImportance;
}

/**
 * Builds a filtered + re-weighted entry list for the given context.
 * - contextDeckId = null/undefined → Défaut: all entries kept, importance = card.defaultImportance
 * - contextDeckId = deckId: only entries whose card is in that deck (and importance > 0);
 *   importance = contextDeck.entry.importance ?? card.defaultImportance
 */
export function buildContextualEntries(
  deck: Deck,
  contextDeckId: string | null | undefined,
  user: AppState,
): DeckEntry[] {
  if (!contextDeckId) {
    return deck.entries.map(e => {
      const card = user.cards[e.cardId];
      return { cardId: e.cardId, importance: card?.defaultImportance ?? 1 };
    });
  }
  const contextDeck = user.decks[contextDeckId];
  if (!contextDeck) {
    return deck.entries.map(e => {
      const card = user.cards[e.cardId];
      return { cardId: e.cardId, importance: card?.defaultImportance ?? 1 };
    });
  }
  const contextMap = new Map(contextDeck.entries.map(e => [e.cardId, e]));
  const result: DeckEntry[] = [];
  for (const e of deck.entries) {
    const ctxEntry = contextMap.get(e.cardId);
    if (!ctxEntry) continue; // not in context deck → excluded
    const card = user.cards[e.cardId];
    const imp = ctxEntry.importance ?? card?.defaultImportance ?? 1;
    if (imp <= 0) continue; // importance 0 → excluded
    result.push({ cardId: e.cardId, importance: imp });
  }
  return result;
}

/** Replay the full review history to compute current FSRS state on-the-fly. */
export function replayFSRS(history: SessionEntry[]): { stability: number; difficulty: number; lastTs: number } | undefined {
  const sorted = [...history].filter(e => e.rating).sort((a, b) => a.ts - b.ts);
  if (sorted.length === 0) return undefined;
  let stability: number | undefined;
  let difficulty: number | undefined;
  let lastTs: number | undefined;
  for (const entry of sorted) {
    const result = applyFSRS(stability, difficulty, lastTs, entry.rating, entry.ts);
    stability = result.stability;
    difficulty = result.difficulty;
    lastTs = entry.ts;
  }
  return { stability: stability!, difficulty: difficulty!, lastTs: lastTs! };
}

/** Retrievability of a card right now, scaled by user.forgettingRate. */
export function cardAvailability(user: User, cardWork: CardWork | undefined): number {
  if (!cardWork || cardWork.history.length === 0) return 0;
  const fsrs = replayFSRS(cardWork.history);
  if (!fsrs) return 0;
  const elapsedDays = (Date.now() - fsrs.lastTs) / 86400000;
  return fsrsRetrievability(elapsedDays, fsrs.stability, user.forgettingRate ?? 1);
}

/** True when the card's current retrievability meets the user's availability threshold. */
export function isAvailable(user: User, cardWork: CardWork | undefined): boolean {
  return cardAvailability(user, cardWork) >= user.availabilityThreshold;
}

/** Weighted availability (avg R) of a full deck (0–1). */
export function deckAvailability(
  user: User,
  profileId: string,
  deck: Deck,
  cards: Record<string, Card>,
  cardWorks: Record<string, CardWork>,
  weighted = true
): number {
  let totalWeight = 0;
  let total = 0;
  for (const entry of deck.entries) {
    const card = cards[entry.cardId]; if (!card) continue;
    const w = weighted ? effectiveImportance(card, entry) : 1;
    const work = cardWorks[`${profileId}:${entry.cardId}`];
    totalWeight += w;
    total += w * cardAvailability(user, work);
  }
  return totalWeight === 0 ? 0 : total / totalWeight;
}

/** Weighted average stability (days) of a full deck. Only counts reviewed cards. */
export function deckStability(
  profileId: string,
  deck: Deck,
  cards: Record<string, Card>,
  cardWorks: Record<string, CardWork>,
  weighted = true
): number {
  let totalWeight = 0;
  let total = 0;
  for (const entry of deck.entries) {
    const card = cards[entry.cardId]; if (!card) continue;
    const work = cardWorks[`${profileId}:${entry.cardId}`];
    const fsrs = work ? replayFSRS(work.history) : undefined;
    if (!fsrs) continue;
    const w = weighted ? effectiveImportance(card, entry) : 1;
    totalWeight += w;
    total += w * fsrs.stability;
  }
  return totalWeight === 0 ? 0 : total / totalWeight;
}

/** Weighted average ease ((10−D)/9) of a full deck. Only counts reviewed cards. */
export function deckEase(
  profileId: string,
  deck: Deck,
  cards: Record<string, Card>,
  cardWorks: Record<string, CardWork>,
  weighted = true
): number {
  let totalWeight = 0;
  let total = 0;
  for (const entry of deck.entries) {
    const card = cards[entry.cardId]; if (!card) continue;
    const work = cardWorks[`${profileId}:${entry.cardId}`];
    const fsrs = work ? replayFSRS(work.history) : undefined;
    if (!fsrs) continue;
    const w = weighted ? effectiveImportance(card, entry) : 1;
    totalWeight += w;
    total += w * (10 - fsrs.difficulty) / 9;
  }
  return totalWeight === 0 ? 0 : total / totalWeight;
}

/** Marginal gain of reviewing a given card. */
export function cardGain(
  user: User,
  card: Card,
  entry: DeckEntry,
  totalImportance: number,
  cardWork: CardWork | undefined,
  weighted = true
): number {
  if (totalImportance === 0) return 0;
  const imp = weighted ? effectiveImportance(card, entry) : 1;
  return (imp / totalImportance) * (1 - cardAvailability(user, cardWork));
}

// ── Deck-level helpers ────────────────────────────────────────────────────────


export function totalDeckImportance(
  deck: Deck,
  cards: Record<string, Card>,
  weighted = true
): number {
  return deck.entries.reduce((sum, e) => {
    const card = cards[e.cardId];
    if (!card) return sum;
    return sum + (weighted ? effectiveImportance(card, e) : 1);
  }, 0);
}

// ── forgettingRate optimizer ──────────────────────────────────────────────────

export const FORGETTING_RATE_MIN_DATA = 30;

/**
 * Estimates the optimal forgettingRate λ from review history via 1-D grid search
 * minimizing log-loss + L2 regularization on ln(λ) (pulls toward 1 when data is sparse).
 *
 * Only uses reviews after the first (we need a prior FSRS state to compute R).
 * 'again' → recalled=false, 'hard'/'good'/'easy' → recalled=true.
 */
export function optimizeForgettingRate(
  cardWorks: Record<string, CardWork>,
  alpha = 0.5,
): { lambda: number; dataPoints: number } {
  type Event = { elapsedDays: number; stability: number; recalled: boolean };
  const events: Event[] = [];

  for (const work of Object.values(cardWorks)) {
    const sorted = [...work.history].sort((a, b) => a.ts - b.ts);
    let stability: number | undefined;
    let difficulty: number | undefined;
    let lastTs: number | undefined;

    for (const entry of sorted) {
      if (stability !== undefined && lastTs !== undefined) {
        const elapsedDays = Math.max(0, (entry.ts - lastTs) / 86400000);
        events.push({ elapsedDays, stability, recalled: entry.rating !== 'again' });
      }
      const result = applyFSRS(stability, difficulty, lastTs, entry.rating, entry.ts);
      stability  = result.stability;
      difficulty = result.difficulty;
      lastTs     = entry.ts;
    }
  }

  if (events.length < FORGETTING_RATE_MIN_DATA) return { lambda: 1, dataPoints: events.length };

  const STEPS = 80;
  let bestLambda = 1;
  let bestLoss   = Infinity;

  for (let k = 0; k <= STEPS; k++) {
    const lambda = Math.exp(-1.5 + k * 3 / STEPS); // range ≈ [0.22, 4.48]
    let loss = alpha * Math.pow(Math.log(lambda), 2); // L2 regularization

    for (const { elapsedDays, stability, recalled } of events) {
      const R = Math.max(1e-7, Math.min(1 - 1e-7, fsrsRetrievability(elapsedDays, stability, lambda)));
      loss += recalled ? -Math.log(R) : -Math.log(1 - R);
    }

    if (loss < bestLoss) { bestLoss = loss; bestLambda = lambda; }
  }

  return { lambda: Math.round(bestLambda * 100) / 100, dataPoints: events.length };
}


