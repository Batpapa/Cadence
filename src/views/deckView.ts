import type { AppContext, Card, DeckEntry } from '../types';
import { pct, timeAgo, availabilityColor, trashIcon, renderAvailabilityBar, makeInlineEditable, unlinkIcon, addTouchDragSupport, focusIfDesktop } from '../utils';
import { promptModal, confirmModal, showModal, closeModal } from '../components/modal';
import { showNewCardModal } from '../components/theSessionImport';
import { findParentFolder, decksContainingCard } from '../services/deckService';
import { pickRandom, pickOptimal, pickStochastic } from '../services/deckService';
import {
  deckAvailability, cardAvailability, effectiveImportance,
  mostUrgentEntry, totalDeckImportance, isAvailable,
  deckStability, deckEase, replayFSRS, retentionWindowDays,
} from '../services/knowledgeService';
import { getCurrentUser } from '../services/userService';
import { t } from '../services/i18nService';


export function renderDeckView(ctx: AppContext, deckId: string): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'p-6 space-y-6 view-enter overflow-y-auto h-full';

  const { state } = ctx;
  const deck = state.decks[deckId];
  if (!deck) { wrap.textContent = t('deck.notFound'); return wrap; }

  const user = getCurrentUser(state);
  const w = user.weightByImportance ?? true;
  const urgent = mostUrgentEntry(user, deck, state.cards, state.cardWorks, w);

  // ── Header ──
  const header = document.createElement('div');
  header.className = 'flex items-start justify-between gap-4';

  const titleWrap = document.createElement('div');
  const title = document.createElement('h1');
  title.textContent = deck.name;
  makeInlineEditable(title, deck.name, val => ctx.mutate(s => { s.decks[deckId]!.name = val; }));
  titleWrap.appendChild(title);

  const headerActions = document.createElement('div'); headerActions.className = 'flex gap-2 shrink-0';

  const deleteBtn = document.createElement('button'); deleteBtn.className = 'btn-danger px-2'; deleteBtn.title = t('deck.deleteTitle'); deleteBtn.appendChild(trashIcon());
  deleteBtn.onclick = () => confirmModal(t('deck.delete.title'), t('deck.delete.message', { name: deck.name }), t('common.delete'), () => {
    const parent = findParentFolder(deckId, 'deck', state);
    ctx.mutate(s => {
      delete s.decks[deckId];
      if (parent) s.folders[parent]!.deckIds = s.folders[parent]!.deckIds.filter(id => id !== deckId);
      else s.rootDeckIds = s.rootDeckIds.filter(id => id !== deckId);
    });
    ctx.navigate({ view: 'folder', folderId: findParentFolder(deckId, 'deck', state) });
  });

  headerActions.append(deleteBtn);
  header.append(titleWrap, headerActions);
  wrap.appendChild(header);

  // ── Metrics ──
  const metricsRow = document.createElement('div'); metricsRow.className = 'grid grid-cols-3 gap-3';

  // Availability
  const avail = deckAvailability(user, deck, state.cards, state.cardWorks, w);
  const availColor = avail >= 0.75 ? 'text-success' : avail >= 0.4 ? 'text-warn' : avail > 0 ? 'text-danger' : 'text-primary';
  const availBox = document.createElement('div'); availBox.className = 'card-block space-y-2';
  const availLabel = document.createElement('div'); availLabel.className = 'section-title'; availLabel.textContent = t('deck.section.availability');
  const availVal = document.createElement('div'); availVal.className = `text-2xl font-mono font-semibold ${availColor}`; availVal.textContent = pct(avail);
  availBox.append(availLabel, availVal);

  // Stability
  const stab = deckStability(user, deck, state.cards, state.cardWorks, w);
  const stabWindow = stab > 0 ? retentionWindowDays(stab, user.availabilityThreshold) : 0;
  const formatDays = (d: number) => d >= 365 ? t('common.durationYears', { n: (d / 365).toFixed(1) }) : d >= 30 ? t('common.durationMonths', { n: Math.round(d / 30) }) : d >= 1 ? t('common.durationDays', { n: Math.round(d) }) : t('common.durationLessThanDay');
  const stabBox = document.createElement('div'); stabBox.className = 'card-block space-y-2';
  const stabLabel = document.createElement('div'); stabLabel.className = 'section-title'; stabLabel.textContent = t('deck.section.stability');
  const stabVal = document.createElement('div'); stabVal.className = 'text-2xl font-mono font-semibold text-primary'; stabVal.textContent = stabWindow > 0 ? formatDays(stabWindow) : '—';
  stabBox.append(stabLabel, stabVal);

  // Ease
  const ease = deckEase(user, deck, state.cards, state.cardWorks, w);
  const easeColor = ease >= 0.6 ? 'text-success' : ease >= 0.35 ? 'text-warn' : ease > 0 ? 'text-danger' : 'text-primary';
  const easeBox = document.createElement('div'); easeBox.className = 'card-block space-y-2';
  const easeLabel = document.createElement('div'); easeLabel.className = 'section-title'; easeLabel.textContent = t('deck.section.ease');
  const easeVal = document.createElement('div'); easeVal.className = `text-2xl font-mono font-semibold ${easeColor}`; easeVal.textContent = ease > 0 ? pct(ease) : '—';
  easeBox.append(easeLabel, easeVal);

  metricsRow.append(availBox, stabBox, easeBox);
  wrap.appendChild(metricsRow);

  // ── Study button ──
  const candidateCount = deck.entries.filter(e => {
    const w = state.cardWorks[`${user.id}:${e.cardId}`];
    return !isAvailable(user, w);
  }).length;

  const studyBtn = document.createElement('button');
  const noCards = deck.entries.length === 0;
  const allMastered = !noCards && candidateCount === 0;
  studyBtn.className = (noCards || allMastered)
    ? 'btn w-full py-3 text-base font-semibold bg-elevated text-dim cursor-default'
    : 'btn-primary w-full py-3 text-base font-semibold';
  studyBtn.textContent = noCards ? t('deck.noCards') : allMastered ? t('deck.allAvailable') : t('deck.study');
  if (!noCards && !allMastered) {
    studyBtn.onclick = () => showStrategyModal(ctx, deckId);
  }
  wrap.appendChild(studyBtn);

  // ── Cards list ──
  const cardsSection = document.createElement('div'); cardsSection.className = 'space-y-3';

  const cardsHeader = document.createElement('div'); cardsHeader.className = 'flex items-center justify-between';
  const cardsTitle = document.createElement('span'); cardsTitle.className = 'section-title'; cardsTitle.textContent = t('deck.section.cards', { count: deck.entries.length });
  const cardActions = document.createElement('div'); cardActions.className = 'flex gap-2';

  const newCardBtn = document.createElement('button'); newCardBtn.className = 'btn-ghost text-xs'; newCardBtn.textContent = t('deck.newCard');
  newCardBtn.onclick = () => showNewCardModal(ctx, deckId);

  const linkCardBtn = document.createElement('button'); linkCardBtn.className = 'btn-ghost text-xs'; linkCardBtn.textContent = t('deck.linkExisting');
  linkCardBtn.onclick = () => showLinkCardModal(ctx, deckId);

  cardActions.append(newCardBtn, linkCardBtn);
  cardsHeader.append(cardsTitle, cardActions);
  cardsSection.appendChild(cardsHeader);

  if (deck.entries.length === 0) {
    const empty = document.createElement('p'); empty.className = 'text-sm text-dim italic'; empty.textContent = t('deck.empty');
    cardsSection.appendChild(empty);
  } else {
    const list = document.createElement('div'); list.className = 'space-y-1';
    const total = totalDeckImportance(deck, state.cards);

    let draggedCardId: string | null = null;
    let dropIndicator: HTMLElement | null = null;

    const clearIndicator = () => {
      dropIndicator?.classList.remove('drop-before', 'drop-after');
      dropIndicator = null;
    };

    for (const entry of deck.entries) {
      const card = state.cards[entry.cardId]; if (!card) continue;
      const work = state.cardWorks[`${user.id}:${entry.cardId}`];
      const k = cardAvailability(user, work);
      const fsrs = work ? replayFSRS(work.history) : undefined;
      const cardEase = fsrs ? (10 - fsrs.difficulty) / 9 : undefined;
      const imp = effectiveImportance(card, entry);
      const lastTs = work?.history.at(-1)?.ts;

      const row = document.createElement('div');
      row.className = 'flex items-center gap-3 px-3 py-2 rounded hover:bg-elevated transition-colors group';
      row.draggable = true;

      const handle = document.createElement('span');
      handle.className = 'text-dim opacity-0 group-hover:opacity-100 cursor-grab active:cursor-grabbing shrink-0 text-xs select-none transition-opacity';
      handle.textContent = '⠿';

      const dotsWrap = document.createElement('span'); dotsWrap.className = 'flex gap-0.5 items-center shrink-0';
      const dot1 = document.createElement('span'); dot1.className = `w-2 h-2 rounded-full ${availabilityColor(k)}`; dot1.title = `R: ${pct(k)}`;
      const dot2 = document.createElement('span'); dot2.className = `w-2 h-2 rounded-full ${cardEase === undefined ? 'bg-border' : cardEase >= 0.6 ? 'bg-success' : cardEase >= 0.35 ? 'bg-warn' : 'bg-danger'}`; dot2.title = cardEase !== undefined ? `Ease: ${pct(cardEase)}` : 'Never reviewed';
      dotsWrap.append(dot1, dot2);

      const name = document.createElement('span');
      name.className = 'text-sm text-primary flex-1 truncate cursor-pointer hover:text-accent';
      name.textContent = card.name;
      name.onclick = () => ctx.navigate({ view: 'card', cardId: card.id });

      const meta = document.createElement('span');
      meta.className = 'text-xs font-mono text-dim shrink-0';
      meta.textContent = lastTs ? timeAgo(lastTs) : t('card.neverReviewed');

      const impBadge = document.createElement('span');
      impBadge.className = 'text-xs font-mono shrink-0 w-6 text-right cursor-pointer hover:text-accent transition-colors';
      impBadge.textContent = `×${imp}`;
      impBadge.title = entry.importanceOverride !== undefined ? t('deck.importanceTitleOverride') : t('deck.importanceTitleDefault');
      if (entry.importanceOverride !== undefined) impBadge.classList.add('text-accent'); else impBadge.classList.add('text-dim');
      impBadge.onclick = () => showImportanceModal(ctx, deckId, entry, card.importance);

      const rowActions = document.createElement('div'); rowActions.className = 'hidden group-hover:flex gap-2';

      const unlinkBtn = document.createElement('button'); unlinkBtn.className = 'text-dim hover:text-danger transition-colors cursor-pointer'; unlinkBtn.title = t('deck.removeFromDeck');
      unlinkBtn.appendChild(unlinkIcon());
      unlinkBtn.onclick = () => { ctx.mutate(s => { s.decks[deckId]!.entries = s.decks[deckId]!.entries.filter(e => e.cardId !== card.id); }); };

      rowActions.append(unlinkBtn);
      row.append(handle, dotsWrap, name, meta, impBadge, rowActions);

      const cardId = card.id;
      row.addEventListener('dragstart', (e) => {
        draggedCardId = cardId;
        e.dataTransfer?.setData('text/plain', cardId);
        setTimeout(() => row.classList.add('opacity-40'), 0);
      });
      row.addEventListener('dragend', () => {
        draggedCardId = null;
        row.classList.remove('opacity-40');
        clearIndicator();
      });
      row.addEventListener('dragover', (e) => {
        if (!draggedCardId || draggedCardId === cardId) return;
        e.preventDefault();
        const rect = row.getBoundingClientRect();
        const zone = (e.clientY - rect.top) / rect.height < 0.5 ? 'drop-before' : 'drop-after';
        if (dropIndicator !== row || !row.classList.contains(zone)) {
          clearIndicator();
          row.classList.add(zone);
          dropIndicator = row;
        }
      });
      row.addEventListener('dragleave', (e) => {
        if (!row.contains(e.relatedTarget as Node)) clearIndicator();
      });
      row.addEventListener('drop', (e) => {
        if (!draggedCardId || draggedCardId === cardId) return;
        e.preventDefault();
        const rect = row.getBoundingClientRect();
        const before = (e.clientY - rect.top) / rect.height < 0.5;
        clearIndicator();
        const fromId = draggedCardId;
        draggedCardId = null;
        ctx.mutate(s => {
          const entries = s.decks[deckId]!.entries;
          const from = entries.findIndex(e => e.cardId === fromId);
          if (from === -1) return;
          const [moved] = entries.splice(from, 1);
          const to = entries.findIndex(e => e.cardId === cardId);
          if (to === -1) { entries.push(moved); return; }
          entries.splice(before ? to : to + 1, 0, moved);
        });
      });
      addTouchDragSupport(row);

      list.appendChild(row);
    }
    cardsSection.appendChild(list);
  }

  wrap.appendChild(cardsSection);
  return wrap;
}

function showStrategyModal(ctx: AppContext, deckId: string): void {
  const body = document.createElement('div');
  body.className = 'space-y-2';

  const desc = document.createElement('p'); desc.className = 'text-sm text-muted mb-4';
  desc.textContent = t('deck.strategy.desc');
  body.appendChild(desc);

  const strategies: Array<{ id: import('../types').StudyStrategy; labelKey: string; subKey: string }> = [
    { id: 'random',     labelKey: 'deck.strategy.random',     subKey: 'deck.strategy.random.sub' },
    { id: 'optimal',    labelKey: 'deck.strategy.optimal',    subKey: 'deck.strategy.optimal.sub' },
    { id: 'stochastic', labelKey: 'deck.strategy.stochastic', subKey: 'deck.strategy.stochastic.sub' },
  ];

  for (const s of strategies) {
    const btn = document.createElement('button');
    btn.className = 'w-full text-left card-block hover:border-accent/60 transition-colors cursor-pointer';
    btn.innerHTML = `<div class="text-sm font-medium text-primary">${t(s.labelKey)}</div><div class="text-xs text-muted mt-0.5">${t(s.subKey)}</div>`;
    btn.onclick = () => {
      closeModal();
      const { state } = ctx;
      const deck = state.decks[deckId]!;
      const user = getCurrentUser(state);
      const weighted = user.weightByImportance ?? true;
      const pickers = {
        random:     () => pickRandom(user, deck, state.cardWorks),
        optimal:    () => pickOptimal(user, deck, state.cards, state.cardWorks, weighted),
        stochastic: () => pickStochastic(user, deck, state.cards, state.cardWorks, weighted),
      };
      const entry: DeckEntry | null = pickers[s.id]?.() ?? null;
      ctx.navigate({ view: 'study', deckId, strategy: s.id, currentCardId: entry?.cardId ?? null });
    };
    body.appendChild(btn);
  }

  showModal(t('deck.strategy.title'), body, [{ label: t('common.cancel'), onClick: closeModal }]);
}

function showImportanceModal(ctx: AppContext, deckId: string, entry: DeckEntry, baseImportance: number): void {
  const body = document.createElement('div'); body.className = 'space-y-3';

  const info = document.createElement('p'); info.className = 'text-xs text-muted';
  info.textContent = t('deck.weight.info', { base: baseImportance });
  body.appendChild(info);

  const lbl = document.createElement('label'); lbl.className = 'label'; lbl.textContent = t('deck.weight.label');
  const input = document.createElement('input'); input.type = 'number'; input.min = '0.1'; input.step = '0.1'; input.className = 'input';
  if (entry.importanceOverride !== undefined) input.value = String(entry.importanceOverride);
  body.append(lbl, input);

  showModal(t('deck.weight.title'), body, [
    { label: t('common.cancel'), onClick: closeModal },
    { label: t('common.apply'), primary: true, onClick: () => {
      const val = parseFloat(input.value);
      closeModal();
      ctx.mutate(s => {
        const e = s.decks[deckId]!.entries.find(e => e.cardId === entry.cardId);
        if (!e) return;
        if (isNaN(val) || input.value.trim() === '') delete e.importanceOverride;
        else e.importanceOverride = val;
      });
    }},
  ]);
  focusIfDesktop(input);
}

function showLinkCardModal(ctx: AppContext, deckId: string): void {
  const alreadyLinked = new Set(ctx.state.decks[deckId]!.entries.map(e => e.cardId));
  const candidates = Object.values(ctx.state.cards).filter(c => !alreadyLinked.has(c.id));

  const body = document.createElement('div'); body.className = 'space-y-2';
  if (candidates.length === 0) {
    const msg = document.createElement('p'); msg.className = 'text-sm text-muted'; msg.textContent = t('deck.link.allLinked');
    body.appendChild(msg);
    showModal(t('deck.link.title'), body, [{ label: t('common.close'), onClick: closeModal }]);
    return;
  }

  const linkedThisSession = new Set<string>();
  const searchInput = document.createElement('input'); searchInput.type = 'text'; searchInput.placeholder = t('deck.link.search'); searchInput.className = 'input mb-2';
  const list = document.createElement('div'); list.className = 'space-y-1 max-h-60 overflow-y-auto';

  const renderList = () => {
    list.innerHTML = '';
    const filter = searchInput.value.toLowerCase();
    const visible = candidates.filter(c => !linkedThisSession.has(c.id) && c.name.toLowerCase().includes(filter));
    if (visible.length === 0) {
      const empty = document.createElement('p'); empty.className = 'text-sm text-dim italic';
      empty.textContent = filter ? t('deck.link.noMatches') : t('deck.link.allCardsLinked');
      list.appendChild(empty); return;
    }
    for (const card of visible) {
      const row = document.createElement('div'); row.className = 'flex items-center justify-between px-3 py-2 rounded hover:bg-surface cursor-pointer transition-colors';
      const name = document.createElement('span'); name.className = 'text-sm text-primary'; name.textContent = card.name;
      const linkBtn = document.createElement('button'); linkBtn.className = 'text-xs btn-primary'; linkBtn.textContent = t('common.link');
      linkBtn.onclick = () => {
        linkedThisSession.add(card.id);
        ctx.mutate(s => { s.decks[deckId]!.entries.push({ cardId: card.id }); });
        renderList();
      };
      row.append(name, linkBtn); list.appendChild(row);
    }
  };

  renderList();
  searchInput.oninput = () => renderList();
  body.append(searchInput, list);
  showModal(t('deck.link.title'), body, [
    { label: t('deck.link.done'), onClick: closeModal },
    { label: t('deck.link.linkAll'), primary: true, onClick: () => {
      const filter = searchInput.value.toLowerCase();
      const toLink = candidates.filter(c => !linkedThisSession.has(c.id) && c.name.toLowerCase().includes(filter));
      for (const card of toLink) linkedThisSession.add(card.id);
      ctx.mutate(s => { for (const card of toLink) s.decks[deckId]!.entries.push({ cardId: card.id }); });
      renderList();
    }},
  ]);
  focusIfDesktop(searchInput);
}
