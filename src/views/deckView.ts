import type { AppContext, Card, DeckEntry } from '../types';
import { pct, timeAgo, knowledgeColor, trashIcon } from '../utils';
import { promptModal, confirmModal, showModal, closeModal } from '../components/modal';
import { showNewCardModal } from '../components/theSessionImport';
import { findParentFolder, decksContainingCard } from '../services/deckService';
import { pickRandom, pickOptimal, pickStochastic } from '../services/deckService';
import {
  deckKnowledge, cardKnowledge, effectiveImportance,
  mostUrgentEntry, totalDeckImportance, isMastered, deckKnowledgeBuckets,
} from '../services/knowledgeService';
import { getCurrentUser } from '../services/userService';


export function renderDeckView(ctx: AppContext, deckId: string): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'p-6 space-y-6 view-enter overflow-y-auto h-full';

  const { state } = ctx;
  const deck = state.decks[deckId];
  if (!deck) { wrap.textContent = 'Deck not found.'; return wrap; }

  const user = getCurrentUser(state);
  const w = user.weightByImportance ?? true;
  const dk = deckKnowledge(user, deck, state.cards, state.cardWorks, w);
  const urgent = mostUrgentEntry(user, deck, state.cards, state.cardWorks, w);

  // ── Header ──
  const header = document.createElement('div');
  header.className = 'flex items-start justify-between gap-4';

  const titleWrap = document.createElement('div');
  const title = document.createElement('h1');
  title.className = 'text-xl font-semibold text-primary cursor-text hover:text-accent transition-colors';
  title.textContent = deck.name; title.title = 'Click to rename';
  title.onclick = () => {
    const inp = document.createElement('input');
    inp.type = 'text'; inp.value = deck.name;
    inp.className = 'text-xl font-semibold bg-transparent border-b border-accent outline-none text-primary w-full';
    title.replaceWith(inp); inp.focus(); inp.select();
    const commit = () => {
      const val = inp.value.trim();
      if (val && val !== deck.name) { ctx.mutate(s => { s.decks[deckId]!.name = val; }); }
      else { inp.replaceWith(title); }
    };
    inp.addEventListener('blur', commit);
    inp.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); inp.blur(); }
      if (e.key === 'Escape') { inp.replaceWith(title); }
    });
  };
  titleWrap.appendChild(title);

  const headerActions = document.createElement('div'); headerActions.className = 'flex gap-2 shrink-0';

  const deleteBtn = document.createElement('button'); deleteBtn.className = 'btn-danger px-2'; deleteBtn.title = 'Delete deck'; deleteBtn.appendChild(trashIcon());
  deleteBtn.onclick = () => confirmModal('Delete Deck', `Delete "${deck.name}"? Cards will not be deleted.`, 'Delete', () => {
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

  // Global knowledge
  const knBox = document.createElement('div'); knBox.className = 'card-block space-y-2';
  const knLabel = document.createElement('div'); knLabel.className = 'section-title'; knLabel.textContent = 'Knowledge';
  const knVal = document.createElement('div'); knVal.className = 'text-2xl font-mono font-semibold text-primary'; knVal.textContent = pct(dk);
  const { buckets: knBuckets, total: knTotal } = deckKnowledgeBuckets(user, deck, state.cards, state.cardWorks, user.weightByImportance ?? true);
  const knBar = document.createElement('div'); knBar.className = 'flex h-1.5 rounded overflow-hidden bg-border';
  if (knTotal > 0) {
    for (const [i, cls] of (['bg-danger', 'bg-warn', 'bg-success/60', 'bg-success'] as const).entries()) {
      const w = knBuckets[i]! / knTotal;
      if (w === 0) continue;
      const s = document.createElement('div'); s.className = cls; s.style.width = `${w * 100}%`;
      knBar.appendChild(s);
    }
  }
  knBox.append(knLabel, knVal, knBar);

  // Mastered
  const masteredCount = deck.entries.filter(e => isMastered(user, state.cardWorks[`${user.id}:${e.cardId}`])).length;
  const totalCount = deck.entries.length;
  const mastBox = document.createElement('div'); mastBox.className = 'card-block space-y-2';
  const mastLabel = document.createElement('div'); mastLabel.className = 'section-title'; mastLabel.textContent = 'Mastered';
  const mastVal = document.createElement('div'); mastVal.className = 'text-2xl font-mono font-semibold text-primary';
  mastVal.textContent = totalCount > 0 ? `${masteredCount} / ${totalCount}` : '—';
  const mastBar = document.createElement('div'); mastBar.className = 'knowledge-bar';
  const mastFill = document.createElement('div'); mastFill.className = 'knowledge-fill bg-success';
  mastFill.style.width = totalCount > 0 ? `${Math.round((masteredCount / totalCount) * 100)}%` : '0%';
  mastBar.appendChild(mastFill); mastBox.append(mastLabel, mastVal, mastBar);

  // Most urgent
  const urgCard = urgent ? state.cards[urgent.cardId] : null;
  const urgWork = urgent ? state.cardWorks[`${user.id}:${urgent.cardId}`] : undefined;
  const urgBox = document.createElement('div'); urgBox.className = 'card-block space-y-1 cursor-pointer hover:border-accent/40 transition-colors';
  if (urgCard) urgBox.onclick = () => ctx.navigate({ view: 'card', cardId: urgCard.id });
  const urgLabel = document.createElement('div'); urgLabel.className = 'section-title'; urgLabel.textContent = 'Most urgent';
  const urgName = document.createElement('div'); urgName.className = 'text-sm text-primary truncate font-medium'; urgName.textContent = urgCard?.name ?? '—';
  const urgKn = document.createElement('div'); urgKn.className = 'text-xs font-mono text-muted'; urgKn.textContent = urgCard ? pct(cardKnowledge(user, urgWork)) : '';
  urgBox.append(urgLabel, urgName, urgKn);

  metricsRow.append(knBox, mastBox, urgBox);
  wrap.appendChild(metricsRow);

  // ── Study button ──
  const candidateCount = deck.entries.filter(e => {
    const w = state.cardWorks[`${user.id}:${e.cardId}`];
    return cardKnowledge(user, w) < user.masteryThreshold;
  }).length;

  const studyBtn = document.createElement('button');
  const noCards = deck.entries.length === 0;
  const allMastered = !noCards && candidateCount === 0;
  studyBtn.className = (noCards || allMastered)
    ? 'btn w-full py-3 text-base font-semibold bg-elevated text-dim cursor-default'
    : 'btn-primary w-full py-3 text-base font-semibold';
  studyBtn.textContent = noCards ? 'No cards to study' : allMastered ? '★  All cards mastered' : '▶  Study this deck';
  if (!noCards && !allMastered) {
    studyBtn.onclick = () => showStrategyModal(ctx, deckId);
  }
  wrap.appendChild(studyBtn);

  // ── Cards list ──
  const cardsSection = document.createElement('div'); cardsSection.className = 'space-y-3';

  const cardsHeader = document.createElement('div'); cardsHeader.className = 'flex items-center justify-between';
  const cardsTitle = document.createElement('span'); cardsTitle.className = 'section-title'; cardsTitle.textContent = `Cards (${deck.entries.length})`;
  const cardActions = document.createElement('div'); cardActions.className = 'flex gap-2';

  const newCardBtn = document.createElement('button'); newCardBtn.className = 'btn-ghost text-xs'; newCardBtn.textContent = '+ New card';
  newCardBtn.onclick = () => showNewCardModal(ctx, deckId);

  const linkCardBtn = document.createElement('button'); linkCardBtn.className = 'btn-ghost text-xs'; linkCardBtn.textContent = '+ Link existing';
  linkCardBtn.onclick = () => showLinkCardModal(ctx, deckId);

  cardActions.append(newCardBtn, linkCardBtn);
  cardsHeader.append(cardsTitle, cardActions);
  cardsSection.appendChild(cardsHeader);

  if (deck.entries.length === 0) {
    const empty = document.createElement('p'); empty.className = 'text-sm text-dim italic'; empty.textContent = 'No cards in this deck yet.';
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
      const k = cardKnowledge(user, work);
      const imp = effectiveImportance(card, entry);
      const lastTs = work?.history.at(-1)?.ts;

      const row = document.createElement('div');
      row.className = 'flex items-center gap-3 px-3 py-2 rounded hover:bg-elevated transition-colors group';
      row.draggable = true;

      // Drag handle
      const handle = document.createElement('span');
      handle.className = 'text-dim opacity-0 group-hover:opacity-100 cursor-grab active:cursor-grabbing shrink-0 text-xs select-none transition-opacity';
      handle.textContent = '⠿';

      // Knowledge dot
      const dot = document.createElement('span');
      dot.className = `w-2 h-2 rounded-full shrink-0 ${knowledgeColor(k)}`;
      dot.title = pct(k);

      const name = document.createElement('span');
      name.className = 'text-sm text-primary flex-1 truncate cursor-pointer hover:text-accent';
      name.textContent = card.name;
      name.onclick = () => ctx.navigate({ view: 'card', cardId: card.id });

      const meta = document.createElement('span');
      meta.className = 'text-xs font-mono text-dim shrink-0';
      meta.textContent = lastTs ? timeAgo(lastTs) : 'never';

      const impBadge = document.createElement('span');
      impBadge.className = 'text-xs font-mono text-dim shrink-0 w-6 text-right';
      impBadge.textContent = `×${imp}`;
      impBadge.title = entry.importanceOverride !== undefined ? 'Override active' : 'Default importance';
      if (entry.importanceOverride !== undefined) impBadge.classList.replace('text-dim', 'text-accent');

      const rowActions = document.createElement('div'); rowActions.className = 'hidden group-hover:flex gap-2';

      const impBtn = document.createElement('button'); impBtn.className = 'text-xs text-muted hover:text-accent transition-colors cursor-pointer'; impBtn.textContent = 'Weight';
      impBtn.onclick = () => showImportanceModal(ctx, deckId, entry, card.importance);

      const unlinkBtn = document.createElement('button'); unlinkBtn.className = 'text-xs text-muted hover:text-danger transition-colors cursor-pointer'; unlinkBtn.textContent = 'Unlink';
      unlinkBtn.onclick = () => { ctx.mutate(s => { s.decks[deckId]!.entries = s.decks[deckId]!.entries.filter(e => e.cardId !== card.id); }); };

      rowActions.append(impBtn, unlinkBtn);
      row.append(handle, dot, name, meta, impBadge, rowActions);

      // Drag events
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
  desc.textContent = 'Choose how the next card is picked during the session.';
  body.appendChild(desc);

  const strategies: Array<{ id: import('../types').StudyStrategy; label: string; sub: string }> = [
    { id: 'random',     label: 'Random',              sub: 'Uniform draw — all cards equally likely' },
    { id: 'optimal',    label: 'Optimal',             sub: 'Always the card with highest learning gain' },
    { id: 'stochastic', label: 'Optimal stochastic',  sub: 'Weighted random draw by learning gain' },
  ];

  for (const s of strategies) {
    const btn = document.createElement('button');
    btn.className = 'w-full text-left card-block hover:border-accent/60 transition-colors cursor-pointer';
    btn.innerHTML = `<div class="text-sm font-medium text-primary">${s.label}</div><div class="text-xs text-muted mt-0.5">${s.sub}</div>`;
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

  showModal('Study strategy', body, [{ label: 'Cancel', onClick: closeModal }]);
}

function showImportanceModal(ctx: AppContext, deckId: string, entry: DeckEntry, baseImportance: number): void {
  const body = document.createElement('div'); body.className = 'space-y-3';

  const info = document.createElement('p'); info.className = 'text-xs text-muted';
  info.textContent = `Card base importance: ×${baseImportance}. Set an override for this deck only.`;
  body.appendChild(info);

  const lbl = document.createElement('label'); lbl.className = 'label'; lbl.textContent = 'Override (leave empty to clear)';
  const input = document.createElement('input'); input.type = 'number'; input.min = '0.1'; input.step = '0.1'; input.className = 'input';
  if (entry.importanceOverride !== undefined) input.value = String(entry.importanceOverride);
  body.append(lbl, input);

  showModal('Card weight', body, [
    { label: 'Cancel', onClick: closeModal },
    { label: 'Apply', primary: true, onClick: () => {
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
  setTimeout(() => input.focus(), 30);
}

function showLinkCardModal(ctx: AppContext, deckId: string): void {
  const alreadyLinked = new Set(ctx.state.decks[deckId]!.entries.map(e => e.cardId));
  const candidates = Object.values(ctx.state.cards).filter(c => !alreadyLinked.has(c.id));

  const body = document.createElement('div'); body.className = 'space-y-2';
  if (candidates.length === 0) {
    const msg = document.createElement('p'); msg.className = 'text-sm text-muted'; msg.textContent = 'All existing cards are already linked to this deck.';
    body.appendChild(msg);
    showModal('Link Existing Card', body, [{ label: 'Close', onClick: closeModal }]);
    return;
  }

  const linkedThisSession = new Set<string>();
  const searchInput = document.createElement('input'); searchInput.type = 'text'; searchInput.placeholder = 'Search…'; searchInput.className = 'input mb-2';
  const list = document.createElement('div'); list.className = 'space-y-1 max-h-60 overflow-y-auto';

  const renderList = () => {
    list.innerHTML = '';
    const filter = searchInput.value.toLowerCase();
    const visible = candidates.filter(c => !linkedThisSession.has(c.id) && c.name.toLowerCase().includes(filter));
    if (visible.length === 0) {
      const empty = document.createElement('p'); empty.className = 'text-sm text-dim italic';
      empty.textContent = filter ? 'No matches.' : 'All cards linked!';
      list.appendChild(empty); return;
    }
    for (const card of visible) {
      const row = document.createElement('div'); row.className = 'flex items-center justify-between px-3 py-2 rounded hover:bg-surface cursor-pointer transition-colors';
      const name = document.createElement('span'); name.className = 'text-sm text-primary'; name.textContent = card.name;
      const linkBtn = document.createElement('button'); linkBtn.className = 'text-xs btn-primary'; linkBtn.textContent = 'Link';
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
  showModal('Link Existing Card', body, [
    { label: 'Done', onClick: closeModal },
    { label: 'Link all', primary: true, onClick: () => {
      const filter = searchInput.value.toLowerCase();
      const toLink = candidates.filter(c => !linkedThisSession.has(c.id) && c.name.toLowerCase().includes(filter));
      for (const card of toLink) linkedThisSession.add(card.id);
      ctx.mutate(s => { for (const card of toLink) s.decks[deckId]!.entries.push({ cardId: card.id }); });
      renderList();
    }},
  ]);
  setTimeout(() => searchInput.focus(), 30);
}
