import { useEffect, useRef, useLayoutEffect } from 'preact/hooks';
import { appState, navigate, mutate } from '../store';
import { pickRandom, pickOptimal, pickStochastic } from '../services/deckService';
import { isAvailable } from '../services/knowledgeService';
import { getCurrentUser } from '../services/userService';
import { t } from '../services/i18nService';
import { renderNotes } from '../components/fileViewer';
import { renderAttachmentList } from '../components/attachmentList';
import type { StudyStrategy, DeckEntry, AppState, SessionRating } from '../types';

const STRATEGY_LABEL_KEYS: Record<StudyStrategy, string> = {
  random: 'study.strategy.random', optimal: 'study.strategy.optimal', stochastic: 'study.strategy.stochastic',
};

const RATINGS: Array<{ rating: SessionRating; key: string; cls: string; shortcut: string }> = [
  { rating: 'again', key: 'rating.again', cls: 'btn py-2.5 text-sm font-semibold bg-danger/10 hover:bg-danger/20 text-danger',   shortcut: '1' },
  { rating: 'hard',  key: 'rating.hard',  cls: 'btn py-2.5 text-sm font-semibold bg-warn/10 hover:bg-warn/20 text-warn',          shortcut: '2' },
  { rating: 'good',  key: 'rating.good',  cls: 'btn py-2.5 text-sm font-semibold bg-accent/10 hover:bg-accent/20 text-accent',    shortcut: '3' },
  { rating: 'easy',  key: 'rating.easy',  cls: 'btn py-2.5 text-sm font-semibold bg-success/10 hover:bg-success/20 text-success', shortcut: '4' },
];

function pickNextCard(state: AppState, deckId: string, strategy: StudyStrategy): DeckEntry | null {
  const deck = state.decks[deckId];
  if (!deck) return null;
  const user = getCurrentUser(state);
  const profileId = state.currentProfileId;
  const w = user.weightByImportance ?? true;
  if (strategy === 'random')     return pickRandom(user, profileId, deck, state.cardWorks);
  if (strategy === 'optimal')    return pickOptimal(user, profileId, deck, state.cards, state.cardWorks, w);
  if (strategy === 'stochastic') return pickStochastic(user, profileId, deck, state.cards, state.cardWorks, w);
  return null;
}

// Bridge: mounts a vanilla HTMLElement into the Preact tree.
function VanillaEl({ el }: { el: HTMLElement }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => { ref.current!.replaceChildren(el); });
  return <div ref={ref} />;
}

export function StudyView({ deckId, strategy, currentCardId }: {
  deckId: string;
  strategy: StudyStrategy;
  currentCardId?: string | null;
}) {
  const state     = appState.value;
  const deck      = state.decks[deckId];
  const user      = getCurrentUser(state);
  const profileId = state.currentProfileId;

  // null means "deck complete" screen; undefined means "pick next card".
  const cardId = currentCardId ?? pickNextCard(state, deckId, strategy)?.cardId;
  const card   = (cardId && currentCardId !== null) ? state.cards[cardId] : undefined;

  const total         = deck?.entries.length ?? 0;
  const candidateCount = deck ? deck.entries.filter(e =>
    !isAvailable(user, state.cardWorks[`${profileId}:${e.cardId}`])
  ).length : 0;
  const mastered = total - candidateCount;
  const canSkip = candidateCount > 1;

  const goNext = () => {
    const s    = appState.value;
    const next = pickNextCard(s, deckId, strategy);
    const nextId: string | null = (next?.cardId !== cardId || (deck?.entries.length ?? 0) <= 1)
      ? (next?.cardId ?? null)
      : (pickNextCard(s, deckId, strategy)?.cardId ?? null);
    navigate({ view: 'study', deckId, strategy, currentCardId: nextId });
  };

  const logRating = (rating: SessionRating) => {
    const ts = Date.now();
    mutate(s => {
      const key = `${s.currentProfileId}:${cardId}`;
      if (!s.cardWorks[key]) s.cardWorks[key] = { profileId: s.currentProfileId, cardId: cardId!, history: [] };
      s.cardWorks[key]!.history.push({ ts, rating });
    }).then(goNext);
  };

  const skipCard = () => {
    const s = appState.value;
    let next = pickNextCard(s, deckId, strategy);
    if (next?.cardId === cardId && (deck?.entries.length ?? 0) > 1) next = pickNextCard(s, deckId, strategy);
    navigate({ view: 'study', deckId, strategy, currentCardId: next?.cardId ?? null });
  };

  // No dep array → always fresh closures; listener torn down on each re-render.
  useEffect(() => {
    if (!card) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if      (e.key === '1')      { e.preventDefault(); logRating('again'); }
      else if (e.key === '2')      { e.preventDefault(); logRating('hard');  }
      else if (e.key === '3')      { e.preventDefault(); logRating('good');  }
      else if (e.key === '4')      { e.preventDefault(); logRating('easy');  }
      else if (e.key === 'Escape') { e.preventDefault(); navigate({ view: 'deck', deckId }); }
      else if (e.key === 'Tab')    { e.preventDefault(); if (canSkip) skipCard(); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  });

  // ── Guards (after all hooks) ──────────────────────────────────────────────────
  if (!deck) return <div class="flex flex-col h-full view-enter">{t('study.notFound')}</div>;

  const topBar = (
    <div class="flex items-center justify-between px-6 py-3 border-b border-border bg-surface shrink-0">
      <div class="flex items-center gap-3">
        <span class="text-xs font-semibold text-muted uppercase tracking-widest">{t('study.header', { deck: deck.name })}</span>
        <span class="text-xs px-2 py-0.5 rounded bg-accent/10 text-accent font-mono">{t(STRATEGY_LABEL_KEYS[strategy])}</span>
      </div>
      <span class="text-xs font-mono text-muted">{mastered}/{total}</span>
    </div>
  );

  if (currentCardId === null) {
    return (
      <div class="flex flex-col h-full view-enter">
        {topBar}
        <div class="flex-1 overflow-y-auto p-6">
          <div class="flex flex-col items-center justify-center h-full gap-4 text-center">
            <div class="text-5xl">✓</div>
            <h2 class="text-xl font-semibold text-success">{t('study.complete.title')}</h2>
            <button class="btn-primary mt-2" onClick={() => navigate({ view: 'deck', deckId })}>{t('study.complete.back')}</button>
          </div>
        </div>
      </div>
    );
  }

  if (!card) {
    return (
      <div class="flex flex-col h-full view-enter">
        {topBar}
        <div class="flex-1 overflow-y-auto p-6">
          <div class="flex flex-col items-center justify-center h-full gap-4 text-center">
            <div class="text-5xl">★</div>
            <h2 class="text-xl font-semibold text-success">{t('study.mastered.title')}</h2>
            <button class="btn-primary mt-2" onClick={() => navigate({ view: 'deck', deckId })}>{t('study.mastered.back')}</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div class="flex flex-col h-full view-enter">
      {topBar}
      <div class="flex-1 overflow-y-auto p-6">
        <div class="max-w-3xl mx-auto space-y-6">

          <div class="flex items-center justify-between">
            <h2 class="text-2xl font-semibold text-primary">{card.name}</h2>
            <button class="btn-ghost text-xs" onClick={() => navigate({ view: 'card', cardId: card.id })}>{t('study.viewCard')}</button>
          </div>

          <div class="space-y-2">
            <div class="grid grid-cols-4 gap-2">
              {RATINGS.map(({ rating, key, cls, shortcut }) => (
                <button key={rating} class={cls} title={`${t(key)} [${shortcut}]`} onClick={() => logRating(rating)}>
                  {t(key)}
                </button>
              ))}
            </div>
            <button class="btn-ghost py-1.5 text-xs w-full" disabled={!canSkip} title={t('study.skipTitle')} onClick={skipCard}>
              {t('study.skip')}
            </button>
          </div>

          {card.content.notes.trim() && (
            <div class="card-block space-y-2">
              <div class="section-title">{t('study.notes')}</div>
              <VanillaEl el={renderNotes(card.content.notes)} />
            </div>
          )}

          {card.content.attachments.length > 0 && (
            <VanillaEl el={renderAttachmentList({ attachments: card.content.attachments, editable: false })} />
          )}

        </div>
      </div>
    </div>
  );
}
