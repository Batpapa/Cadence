import type { AppContext, StudyStrategy, DeckEntry } from '../types';
import { renderNotes, renderFiles } from '../components/fileViewer';
import { renderEmbeds } from '../components/embedViewer';
import { pickRandom, pickOptimal, pickStochastic } from '../services/deckService';
import { cardKnowledge, deckKnowledge } from '../services/knowledgeService';
import type { SessionRating } from '../types';
import { getCurrentUser } from '../services/userService';
import { pct, timeAgo } from '../utils';
import { t } from '../services/i18nService';

const STRATEGY_LABEL_KEYS: Record<StudyStrategy, string> = {
  random: 'study.strategy.random', optimal: 'study.strategy.optimal', stochastic: 'study.strategy.stochastic',
};

function pickNext(ctx: AppContext, deckId: string, strategy: StudyStrategy): DeckEntry | null {
  const { state } = ctx;
  const deck = state.decks[deckId];
  if (!deck) return null;
  const user = getCurrentUser(state);
  const w = user.weightByImportance ?? true;
  if (strategy === 'random')     return pickRandom(user, deck, state.cardWorks);
  if (strategy === 'optimal')    return pickOptimal(user, deck, state.cards, state.cardWorks, w);
  if (strategy === 'stochastic') return pickStochastic(user, deck, state.cards, state.cardWorks, w);
  return null;
}

export function renderStudyView(
  ctx: AppContext,
  deckId: string,
  strategy: StudyStrategy,
  currentCardId?: string | null
): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'flex flex-col h-full view-enter';

  const { state } = ctx;
  const deck = state.decks[deckId];
  if (!deck) { wrap.textContent = t('study.notFound'); return wrap; }

  const user = getCurrentUser(state);
  const dk = deckKnowledge(user, deck, state.cards, state.cardWorks, user.weightByImportance ?? true);

  // ── Top bar ──
  const topBar = document.createElement('div');
  topBar.className = 'flex items-center justify-between px-6 py-3 border-b border-border bg-surface shrink-0';

  const left = document.createElement('div'); left.className = 'flex items-center gap-3';
  const deckName = document.createElement('span'); deckName.className = 'text-xs font-semibold text-muted uppercase tracking-widest'; deckName.textContent = t('study.header', { deck: deck.name });
  const stratBadge = document.createElement('span'); stratBadge.className = 'text-xs px-2 py-0.5 rounded bg-accent/10 text-accent font-mono'; stratBadge.textContent = t(STRATEGY_LABEL_KEYS[strategy]);
  left.append(deckName, stratBadge);

  const right = document.createElement('div'); right.className = 'flex items-center gap-4';
  const knBadge = document.createElement('span'); knBadge.className = 'text-xs font-mono text-muted'; knBadge.textContent = t('study.knowledge', { pct: pct(dk) });
  right.append(knBadge);
  topBar.append(left, right);
  wrap.appendChild(topBar);

  // ── Content ──
  const content = document.createElement('div');
  content.className = 'flex-1 overflow-y-auto p-6';

  const cardId = currentCardId ?? pickNext(ctx, deckId, strategy)?.cardId;

  if (currentCardId === null) {
    const done = document.createElement('div'); done.className = 'flex flex-col items-center justify-center h-full gap-4 text-center';
    const icon = document.createElement('div'); icon.className = 'text-5xl'; icon.textContent = '✓';
    const msg = document.createElement('h2'); msg.className = 'text-xl font-semibold text-success'; msg.textContent = t('study.complete.title');
    const sub = document.createElement('p'); sub.className = 'text-sm text-muted'; sub.textContent = t('study.complete.sub', { pct: pct(dk) });
    const btn2 = document.createElement('button'); btn2.className = 'btn-primary mt-2'; btn2.textContent = t('study.complete.back'); btn2.onclick = () => ctx.navigate({ view: 'deck', deckId });
    done.append(icon, msg, sub, btn2);
    content.appendChild(done);
    wrap.appendChild(content);
    return wrap;
  }

  const card = cardId ? state.cards[cardId] : undefined;
  if (!card) {
    const done = document.createElement('div'); done.className = 'flex flex-col items-center justify-center h-full gap-4 text-center';
    const icon = document.createElement('div'); icon.className = 'text-5xl'; icon.textContent = '★';
    const msg = document.createElement('h2'); msg.className = 'text-xl font-semibold text-success'; msg.textContent = t('study.mastered.title');
    const sub = document.createElement('p'); sub.className = 'text-sm text-muted'; sub.textContent = t('study.complete.sub', { pct: pct(dk) });
    const btn2 = document.createElement('button'); btn2.className = 'btn-primary mt-2'; btn2.textContent = t('study.mastered.back'); btn2.onclick = () => ctx.navigate({ view: 'deck', deckId });
    done.append(icon, msg, sub, btn2);
    content.appendChild(done); wrap.appendChild(content); return wrap;
  }

  const work = state.cardWorks[`${user.id}:${cardId}`];
  const k = cardKnowledge(user, work);

  const cardWrap = document.createElement('div'); cardWrap.className = 'max-w-3xl mx-auto space-y-6';

  const cardHeader = document.createElement('div'); cardHeader.className = 'flex items-center justify-between';
  const cardTitle = document.createElement('h2'); cardTitle.className = 'text-2xl font-semibold text-primary'; cardTitle.textContent = card.name;
  const viewCardBtn = document.createElement('button'); viewCardBtn.className = 'btn-ghost text-xs'; viewCardBtn.textContent = t('study.viewCard');
  viewCardBtn.onclick = () => ctx.navigate({ view: 'card', cardId: card.id });
  cardHeader.append(cardTitle, viewCardBtn);
  cardWrap.appendChild(cardHeader);

  const knRow = document.createElement('div'); knRow.className = 'flex items-center gap-3';
  const knLabel = document.createElement('span'); knLabel.className = 'text-xs text-muted'; knLabel.textContent = t('study.currentKnowledge');
  const knVal = document.createElement('span'); knVal.className = 'text-xs font-mono text-primary font-semibold'; knVal.textContent = pct(k);
  const knLast = document.createElement('span'); knLast.className = 'text-xs text-dim';
  knLast.textContent = work?.history.length
    ? t('study.lastReview', { ago: timeAgo(work.history.at(-1)!.ts) })
    : t('study.neverReviewed');
  knRow.append(knLabel, knVal, knLast);
  cardWrap.appendChild(knRow);

  const actionRow = document.createElement('div'); actionRow.className = 'space-y-2';
  const ratingRow = document.createElement('div'); ratingRow.className = 'grid grid-cols-4 gap-2';

  const goNext = () => {
    const next = pickNext(ctx, deckId, strategy);
    const nextId: string | null = (next?.cardId !== cardId || deck.entries.length <= 1)
      ? (next?.cardId ?? null)
      : (pickNext(ctx, deckId, strategy)?.cardId ?? null);
    ctx.navigate({ view: 'study', deckId, strategy, currentCardId: nextId });
  };

  const logRating = (rating: SessionRating) => {
    const ts = Date.now();
    ctx.mutate(s => {
      const key = `${s.currentUserId}:${cardId}`;
      if (!s.cardWorks[key]) s.cardWorks[key] = { userId: s.currentUserId, cardId: cardId!, history: [] };
      s.cardWorks[key]!.history.push({ ts, rating });
    }).then(goNext);
  };

  const ratings: Array<{ rating: SessionRating; key: string; className: string; shortcut: string }> = [
    { rating: 'again', key: 'rating.again', className: 'btn py-2.5 text-sm font-semibold bg-danger/10 hover:bg-danger/20 text-danger',   shortcut: '1' },
    { rating: 'hard',  key: 'rating.hard',  className: 'btn py-2.5 text-sm font-semibold bg-warn/10 hover:bg-warn/20 text-warn',          shortcut: '2' },
    { rating: 'good',  key: 'rating.good',  className: 'btn py-2.5 text-sm font-semibold bg-accent/10 hover:bg-accent/20 text-accent',    shortcut: '3' },
    { rating: 'easy',  key: 'rating.easy',  className: 'btn py-2.5 text-sm font-semibold bg-success/10 hover:bg-success/20 text-success', shortcut: '4' },
  ];
  for (const { rating, key, className, shortcut } of ratings) {
    const btn = document.createElement('button'); btn.className = className; btn.textContent = t(key);
    btn.title = `${t(key)} [${shortcut}]`;
    btn.onclick = () => logRating(rating);
    ratingRow.appendChild(btn);
  }

  const candidateCount = deck.entries.filter(e => {
    const w = state.cardWorks[`${user.id}:${e.cardId}`];
    return cardKnowledge(user, w) < user.masteryThreshold;
  }).length;
  const skipBtn = document.createElement('button'); skipBtn.className = 'btn-ghost py-1.5 text-xs w-full'; skipBtn.textContent = t('study.skip');
  skipBtn.disabled = candidateCount <= 1;
  skipBtn.title = t('study.skipTitle');
  skipBtn.onclick = () => {
    let next = pickNext(ctx, deckId, strategy);
    if (next?.cardId === cardId && deck.entries.length > 1) next = pickNext(ctx, deckId, strategy);
    ctx.navigate({ view: 'study', deckId, strategy, currentCardId: next?.cardId ?? null });
  };

  actionRow.append(ratingRow, skipBtn);
  cardWrap.appendChild(actionRow);

  const onKey = (e: KeyboardEvent) => {
    if (!wrap.isConnected) { document.removeEventListener('keydown', onKey); return; }
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    if (e.key === '1') { e.preventDefault(); logRating('again'); }
    else if (e.key === '2') { e.preventDefault(); logRating('hard'); }
    else if (e.key === '3') { e.preventDefault(); logRating('good'); }
    else if (e.key === '4') { e.preventDefault(); logRating('easy'); }
    else if (e.key === 'Escape') { e.preventDefault(); ctx.navigate({ view: 'deck', deckId }); }
    else if (e.key === 'Tab') { e.preventDefault(); if (!skipBtn.disabled) skipBtn.click(); }
  };
  document.addEventListener('keydown', onKey);

  if (card.content.notes.trim()) {
    const notesWrap = document.createElement('div'); notesWrap.className = 'card-block space-y-2';
    const notesTitle = document.createElement('div'); notesTitle.className = 'section-title'; notesTitle.textContent = t('study.notes');
    notesWrap.append(notesTitle, renderNotes(card.content.notes));
    cardWrap.appendChild(notesWrap);
  }

  if (card.content.files.length > 0) {
    cardWrap.appendChild(renderFiles({ files: card.content.files, editable: false }));
  }

  const embeds = card.content.embeds ?? [];
  if (embeds.length > 0) {
    cardWrap.appendChild(renderEmbeds({ embeds, editable: false }));
  }

  content.appendChild(cardWrap);
  wrap.appendChild(content);
  return wrap;
}
