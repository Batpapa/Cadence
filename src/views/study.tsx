import { useEffect, useRef, useLayoutEffect } from 'preact/hooks';
import { appState, navigate, mutate, replaceRoute, goBack } from '../store';
import { pickRandom, pickOptimal, pickStochastic } from '../services/deckService';
import { isAvailable, buildContextualEntries } from '../services/knowledgeService';
import { t } from '../services/i18nService';
import { renderNotes } from '../components/fileViewer';
import { renderAttachmentList } from '../components/attachmentList';
import type { Deck, StudyStrategy, DeckEntry, AppState, SessionRating } from '../types';

const STRATEGY_LABEL_KEYS: Record<StudyStrategy, string> = {
  random: 'study.strategy.random', optimal: 'study.strategy.optimal', stochastic: 'study.strategy.stochastic',
};

const RATINGS: Array<{ rating: SessionRating; key: string; cls: string; shortcut: string }> = [
  { rating: 'again', key: 'rating.again', cls: 'btn py-2.5 text-sm font-semibold bg-danger/10 hover:bg-danger/20 text-danger',   shortcut: '1' },
  { rating: 'hard',  key: 'rating.hard',  cls: 'btn py-2.5 text-sm font-semibold bg-warn/10 hover:bg-warn/20 text-warn',          shortcut: '2' },
  { rating: 'good',  key: 'rating.good',  cls: 'btn py-2.5 text-sm font-semibold bg-accent/10 hover:bg-accent/20 text-accent',    shortcut: '3' },
  { rating: 'easy',  key: 'rating.easy',  cls: 'btn py-2.5 text-sm font-semibold bg-success/10 hover:bg-success/20 text-success', shortcut: '4' },
];

function buildDeck(user: AppState, deckId?: string, cardIds?: string[], studyTitle?: string): Deck | undefined {
  if (deckId) return user.decks[deckId];
  if (cardIds) return { id: '__virtual', name: studyTitle ?? '', entries: cardIds.map(id => ({ cardId: id })) };
  return undefined;
}

function pickNextCard(
  user: AppState,
  deck: Deck,
  strategy: StudyStrategy,
  contextDeckId: string | null | undefined,
): DeckEntry | null {
  const profileId = user.currentProfileId;
  const w = user.weightByImportance ?? true;
  const ctxEntries = buildContextualEntries(deck, contextDeckId, user);
  const ctxDeck: Deck = { ...deck, entries: ctxEntries };
  if (strategy === 'random')     return pickRandom(user, profileId, ctxDeck, user.cardWorks);
  if (strategy === 'optimal')    return pickOptimal(user, profileId, ctxDeck, user.cards, user.cardWorks, w);
  if (strategy === 'stochastic') return pickStochastic(user, profileId, ctxDeck, user.cards, user.cardWorks, w);
  return null;
}

// Bridge: mounts a vanilla HTMLElement into the Preact tree.
function VanillaEl({ el }: { el: HTMLElement }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => { ref.current!.replaceChildren(el); });
  return <div ref={ref} />;
}

export function StudyView({ deckId, cardIds, studyTitle, strategy, currentCardId, contextDeckId }: {
  deckId?: string;
  cardIds?: string[];
  studyTitle?: string;
  strategy: StudyStrategy;
  currentCardId?: string | null;
  contextDeckId?: string | null;
}) {
  const user = appState.value;
  const deck = buildDeck(user, deckId, cardIds, studyTitle);

  const profileId = user.currentProfileId;

  const ctxEntries = deck ? buildContextualEntries(deck, contextDeckId, user) : [];

  // null means "deck complete" screen; undefined means "pick next card".
  const cardId = currentCardId ?? (deck ? pickNextCard(user, deck, strategy, contextDeckId)?.cardId : undefined);
  const card   = (cardId && currentCardId !== null) ? user.cards[cardId] : undefined;

  const total          = deck?.entries.length ?? 0;
  const ctxTotal       = ctxEntries.length;
  const excludedByCtx  = total - ctxTotal;
  const candidateCount = ctxEntries.filter(e =>
    !isAvailable(user, user.cardWorks[`${profileId}:${e.cardId}`])
  ).length;
  const mastered = ctxTotal - candidateCount;
  const canSkip  = candidateCount > 1;

  // Base route shape for replaceRoute — carries full context
  const routeBase = { view: 'study' as const, deckId, cardIds, studyTitle, strategy, contextDeckId };

  const goNext = () => {
    const u    = appState.value;
    const d    = buildDeck(u, deckId, cardIds, studyTitle);
    if (!d) return;
    const ctxLen = buildContextualEntries(d, contextDeckId, u).length;
    let   next   = pickNextCard(u, d, strategy, contextDeckId);
    if (next?.cardId === cardId && ctxLen > 1) next = pickNextCard(u, d, strategy, contextDeckId);
    replaceRoute({ ...routeBase, currentCardId: next?.cardId ?? null });
  };

  const skipCard = () => {
    const u = appState.value;
    const d = buildDeck(u, deckId, cardIds, studyTitle);
    if (!d) return;
    const ctxLen = buildContextualEntries(d, contextDeckId, u).length;
    let   next   = pickNextCard(u, d, strategy, contextDeckId);
    if (next?.cardId === cardId && ctxLen > 1) next = pickNextCard(u, d, strategy, contextDeckId);
    replaceRoute({ ...routeBase, currentCardId: next?.cardId ?? null });
  };

  const logRating = (rating: SessionRating) => {
    const ts = Date.now();
    mutate(s => {
      const key = `${s.currentProfileId}:${cardId}`;
      if (!s.cardWorks[key]) s.cardWorks[key] = { profileId: s.currentProfileId, cardId: cardId!, history: [] };
      s.cardWorks[key]!.history.push({ ts, rating });
    }).then(goNext);
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
      else if (e.key === 'Escape') { e.preventDefault(); goBack(); }
      else if (e.key === 'Tab')    { e.preventDefault(); if (canSkip) skipCard(); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  });

  // ── Guards (after all hooks) ──────────────────────────────────────────────────
  if (!deck) return <div class="flex flex-col h-full view-enter">{t('study.notFound')}</div>;

  const deckName  = deckId ? (user.decks[deckId]?.name ?? studyTitle ?? '') : (studyTitle ?? '');
  const ctxName   = contextDeckId
    ? (user.decks[contextDeckId]?.name ?? contextDeckId)
    : t('deck.context.default');

  const topBar = (
    <div class="flex items-center justify-between px-6 py-3 border-b border-border bg-surface shrink-0">
      <div class="flex items-center gap-3 flex-wrap">
        <span class="text-xs font-semibold text-muted uppercase tracking-widest">{t('study.header', { deck: deckName })}</span>
        <span class="text-xs px-2 py-0.5 rounded bg-accent/10 text-accent font-mono">{t(STRATEGY_LABEL_KEYS[strategy])}</span>
        <span class="text-xs text-dim">{t('study.context')} <span class="text-primary">{ctxName}</span></span>
        {excludedByCtx > 0 && (
          <span class="text-xs text-warn">{t('study.excludedByContext', { n: excludedByCtx })}</span>
        )}
      </div>
      <span class="text-xs font-mono text-muted shrink-0">{t('study.mastery')}: {mastered}/{ctxTotal}</span>
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
            <button class="btn-primary mt-2" onClick={() => goBack()}>{t('study.complete.back')}</button>
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
            <button class="btn-primary mt-2" onClick={() => goBack()}>{t('study.mastered.back')}</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div class="flex flex-col h-full view-enter">
      {topBar}
      <div class="flex-1 overflow-y-auto p-6">
        <div class="space-y-6">

          <div class="flex items-center justify-between">
            <h2 class="text-2xl font-semibold text-primary">{card.name}</h2>
            <button class="btn-ghost text-xs" onClick={() => navigate({ view: 'card', cardId: card.id, contextDeckId: contextDeckId ?? undefined })}>{t('study.viewCard')}</button>
          </div>

          <div class="space-y-2">
            <p class="text-xs text-dim text-center">{t('study.ratingHint')}</p>
            <div class="grid grid-cols-1 min-[520px]:grid-cols-2 min-[900px]:grid-cols-4 gap-2">
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
            <div class="space-y-2">
              <div class="section-title">{t('study.notes')}</div>
              <VanillaEl el={renderNotes(card.content.notes)} />
            </div>
          )}

          {card.content.attachments.length > 0 && (
            <VanillaEl el={renderAttachmentList({ attachments: card.content.attachments, editable: false })} />
          )}

          {(() => {
            const work   = user.cardWorks[`${profileId}:${cardId}`];
            const sorted = work ? [...work.history].sort((a, b) => a.ts - b.ts) : [];
            if (sorted.length === 0) return null;
            const colors: Record<string, string> = { again: 'var(--color-danger)', hard: 'var(--color-warn)', good: 'var(--color-accent)', easy: 'var(--color-success)' };
            const countKey = sorted.length === 1 ? 'card.section.reviewHistoryCount' : 'card.section.reviewHistoryCountPlural';
            return (
              <div class="space-y-2">
                <div class="section-title">{t(countKey, { count: sorted.length })}</div>
                <div class="flex flex-wrap gap-[3px]">
                  {sorted.map((entry, i) => (
                    <div
                      key={i}
                      style={{ width: '10px', height: '10px', borderRadius: '2px', background: colors[entry.rating] ?? 'var(--color-dim)', opacity: 0.75, flexShrink: 0 }}
                      title={`${new Date(entry.ts).toLocaleDateString()} — ${entry.rating}`}
                    />
                  ))}
                </div>
              </div>
            );
          })()}

        </div>
      </div>
    </div>
  );
}
