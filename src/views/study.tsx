import { useEffect, useRef, useLayoutEffect } from 'preact/hooks';
import { appState, navigate, mutate, goBack } from '../store';
import { pickRandom, pickOptimal, pickStochastic, pickSequential, decksContainingCard } from '../services/deckService';
import { isAvailable, buildContextualEntries } from '../services/knowledgeService';
import { t } from '../services/i18nService';
import { renderNotes } from '../components/fileViewer';
import { AttachmentList, CardRefList } from '../components/attachmentList';
import { isTuneset } from '../services/cardTypeService';
import { TuneIcon } from '../components/icons';
import { STRATEGY_ICONS } from '../components/studyModal';
import type { Deck, StudyStrategy, DeckEntry, AppState, SessionRating } from '../types';

const STRATEGY_LABEL_KEYS: Record<StudyStrategy, string> = {
  random: 'study.strategy.random', optimal: 'study.strategy.optimal', stochastic: 'study.strategy.stochastic',
  sequential: 'study.strategy.sequential',
};

/** The strategies that draw at random — the only ones an anti-repeat re-roll
 *  means anything for. `optimal` and `sequential` are deterministic. */
function isRandomDraw(strategy: StudyStrategy): boolean {
  return strategy === 'random' || strategy === 'stochastic';
}

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

/** `afterCardId` is only read by the sequential strategy, which derives its
 *  position from the card on screen (see pickSequential). The other three
 *  ignore it — they are stateless. */
function pickNextCard(
  user: AppState,
  deck: Deck,
  strategy: StudyStrategy,
  contextDeckId: string | null | undefined,
  afterCardId?: string | null,
): DeckEntry | null {
  const profileId = user.currentProfileId;
  const w    = user.weightByImportance ?? true;
  const excl = user.excludeMastered ?? true;
  const ctxEntries = buildContextualEntries(deck, contextDeckId, user);
  const ctxDeck: Deck = { ...deck, entries: ctxEntries };
  if (strategy === 'random')     return pickRandom(user, profileId, ctxDeck, user.cardWorks, excl);
  if (strategy === 'optimal')    return pickOptimal(user, profileId, ctxDeck, user.cards, user.cardWorks, w, excl);
  if (strategy === 'stochastic') return pickStochastic(user, profileId, ctxDeck, user.cards, user.cardWorks, w, excl);
  if (strategy === 'sequential') return pickSequential(user, profileId, ctxDeck, user.cardWorks, excl, afterCardId);
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
  // `mastered` stays the real count (informational); eligibility follows the toggle.
  const mastered = ctxEntries.filter(e =>
    isAvailable(user, user.cardWorks[`${profileId}:${e.cardId}`])
  ).length;
  const candidateCount = (user.excludeMastered ?? true) ? ctxTotal - mastered : ctxTotal;
  // Skipping logs no rating, so it changes nothing that `optimal` reads: it
  // would re-pick the very same highest-gain card. `sequential` is
  // deterministic too, but it advances by position — skipping means something
  // there, and is the natural way to step through a deck without grading it.
  const canSkip  = candidateCount > 1 && strategy !== 'optimal';

  // Position in the deck's own order. Sequential only: it is the one mode that
  // loops with nothing else to mark where you are — with "exclude mastered" off
  // it never even reaches an end screen. 0 = don't show (other strategies, or
  // the card is no longer in the list).
  const seqPos = strategy === 'sequential' && cardId
    ? ctxEntries.findIndex(e => e.cardId === cardId) + 1
    : 0;

  // Base route shape — carries full context for each navigate() call
  const routeBase = { view: 'study' as const, deckId, cardIds, studyTitle, strategy, contextDeckId };

  // navigate (push) so each card gets its own history entry — back goes to previous card, not to pre-study.
  const goNext = () => {
    const u    = appState.value;
    const d    = buildDeck(u, deckId, cardIds, studyTitle);
    if (!d) return;
    const ctxLen = buildContextualEntries(d, contextDeckId, u).length;
    let   next   = pickNextCard(u, d, strategy, contextDeckId, cardId);
    // Anti-repeat re-roll: only a random draw can land back on the card we
    // just left, and only a random draw can land elsewhere on a second try.
    if (isRandomDraw(strategy) && next?.cardId === cardId && ctxLen > 1) next = pickNextCard(u, d, strategy, contextDeckId);
    navigate({ ...routeBase, currentCardId: next?.cardId ?? null });
  };

  const skipCard = () => {
    const u = appState.value;
    const d = buildDeck(u, deckId, cardIds, studyTitle);
    if (!d) return;
    const ctxLen = buildContextualEntries(d, contextDeckId, u).length;
    let   next   = pickNextCard(u, d, strategy, contextDeckId, cardId);
    // Anti-repeat re-roll: only a random draw can land back on the card we
    // just left, and only a random draw can land elsewhere on a second try.
    if (isRandomDraw(strategy) && next?.cardId === cardId && ctxLen > 1) next = pickNextCard(u, d, strategy, contextDeckId);
    navigate({ ...routeBase, currentCardId: next?.cardId ?? null });
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

  const StrategyIcon = STRATEGY_ICONS[strategy].Icon;

  const topBar = (
    <div class="flex items-center justify-between px-6 py-3 border-b border-border bg-surface shrink-0">
      <div class="flex items-center gap-3 flex-wrap">
        {/* Mode first, and as an icon rather than a spelled-out chip: it is
            the same glyph the picker showed a moment ago, it costs a fraction
            of the width on a phone, and the tooltip still spells it out. Icon
            and position are one unit — in sequential mode the count is that
            mode's own state — so they never break apart from each other. */}
        <div
          class={`flex items-center gap-1.5 shrink-0 ${STRATEGY_ICONS[strategy].color}`}
          title={seqPos > 0
            ? t('study.strategy.sequentialWithPos', { pos: seqPos, total: ctxTotal })
            : t(STRATEGY_LABEL_KEYS[strategy])}
        >
          <StrategyIcon size={15} />
          {seqPos > 0 && <span class="text-xs font-mono tabular-nums">{seqPos}/{ctxTotal}</span>}
        </div>
        <span class="text-xs font-semibold text-muted uppercase tracking-widest">{t('study.header', { deck: deckName })}</span>
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

          <div>
            <div class="flex items-center justify-between">
              <h2 class="text-2xl font-semibold text-primary">{card.name}</h2>
              <button class="btn-ghost text-xs" onClick={() => navigate({ view: 'card', cardId: card.id, contextDeckId: contextDeckId ?? undefined })}>{t('study.viewCard')}</button>
            </div>
            {(() => {
              const cardDeckIds = decksContainingCard(card.id, user);
              if (cardDeckIds.length === 0) return null;
              return (
                <div class="flex flex-wrap gap-1.5 mt-1.5">
                  {cardDeckIds.map(dId => {
                    const deck = user.decks[dId]; if (!deck) return null;
                    return (
                      <span
                        key={dId}
                        class="inline-flex items-center text-xs px-2 py-0.5 rounded-full bg-accent/10 text-accent hover:bg-accent/20 transition-colors cursor-pointer"
                        onClick={() => navigate({ view: 'deck', deckId: dId })}
                      >
                        {deck.name}
                      </span>
                    );
                  })}
                </div>
              );
            })()}
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
            {/* Absent under `optimal`, not merely disabled: there it could
                never do anything. Elsewhere it greys out while a single
                candidate is left, which is a passing state worth showing. */}
            {strategy !== 'optimal' && (
              <button class="btn-ghost py-1.5 text-xs w-full" disabled={!canSkip} title={t('study.skipTitle')} onClick={skipCard}>
                {t('study.skip')}
              </button>
            )}
          </div>

          {card.tags.length > 0 && (
            <div class="space-y-2">
              <span class="section-title">{t('card.section.tags')}</span>
              <div class="flex flex-wrap items-center gap-1.5">
                {card.tags.map(tag => (
                  <span key={tag} class="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-elevated border border-border text-muted">
                    {tag}
                  </span>
                ))}
              </div>
            </div>
          )}

          {card.content.notes.trim() && (
            <div class="space-y-2">
              <div class="section-title">{t('study.notes')}</div>
              <VanillaEl el={renderNotes(card.content.notes)} />
            </div>
          )}

          {/* A set's tunes, between the notes and the attachments — the same
              slot the card page gives them, so the two screens read alike.
              The list sits right above the score it explains: the fused ABC
              is an attachment, and knowing which tunes it strings together
              is what makes it readable. Read-only here: the type selector
              stays out of study, but the definition belongs. */}
          {isTuneset(card) && (card.tunes ?? []).length > 0 && (
            <div class="space-y-2">
              <span class="section-title">{t('card.section.tunes')}</span>
              <CardRefList refs={card.tunes ?? []} editable={false} onRemove={() => {}} onReorder={() => {}} glyph={<TuneIcon size={11} />} />
            </div>
          )}

          {card.content.attachments.length > 0 && (
            <AttachmentList options={{
              attachments: card.content.attachments,
              // The set's own card, without which a generated score cannot be
              // built: it stores only the intent, so an AttachmentList that
              // does not get the card shows the placeholder entry as-is —
              // named "ABC", and empty. `editable: false` still keeps the
              // "add a generated score" action out of study.
              card,
              editable: false,
              // Picking a favorite ABC version is a viewing preference, not a
              // content edit — allowed here even though the rest is read-only.
              onSetPreferredIndex: (i, index) => mutate(s => {
                const att = s.cards[cardId!]?.content.attachments[i];
                if (att && att.type === 'file') att.preferredIndex = index;
              }),
            }} />
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
