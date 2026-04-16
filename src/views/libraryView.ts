import type { AppContext, Card } from '../types';
import { pct, knowledgeColor } from '../utils';
import { confirmModal } from '../components/modal';
import { showNewCardModal } from '../components/theSessionImport';
import { decksContainingCard } from '../services/deckService';
import { cardKnowledge } from '../services/knowledgeService';
import { getCurrentUser } from '../services/userService';


export function renderLibraryView(ctx: AppContext): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'flex flex-col h-full view-enter';

  const { state } = ctx;
  const user = getCurrentUser(state);
  const allCards = Object.values(state.cards) as Card[];

  // ── Selection state ──
  const selected = new Set<string>();

  // ── Header ──
  const header = document.createElement('div'); header.className = 'flex items-center justify-between px-6 pt-6 pb-4 shrink-0';
  const titleWrap = document.createElement('div');
  const title = document.createElement('h1'); title.className = 'text-xl font-semibold text-primary'; title.textContent = 'Card library';
  const sub = document.createElement('p'); sub.className = 'text-xs text-muted mt-0.5'; sub.textContent = `${allCards.length} card${allCards.length !== 1 ? 's' : ''}`;
  titleWrap.append(title, sub);
  const headerBtns = document.createElement('div'); headerBtns.className = 'flex gap-2';
  const newCardBtn = document.createElement('button'); newCardBtn.className = 'btn-primary'; newCardBtn.textContent = '+ New card';
  newCardBtn.onclick = () => showNewCardModal(ctx);
  headerBtns.append(newCardBtn);
  header.append(titleWrap, headerBtns);
  wrap.appendChild(header);

  // ── Search + tag filter ──
  const filterBar = document.createElement('div'); filterBar.className = 'px-6 pb-3 shrink-0 space-y-2';
  const searchInput = document.createElement('input'); searchInput.type = 'text'; searchInput.placeholder = 'Search cards…'; searchInput.className = 'input';

  const allTags = [...new Set(allCards.flatMap(c => c.tags ?? []))].sort();
  const activeTags = new Set<string>();

  const tagRow = document.createElement('div'); tagRow.className = 'flex flex-wrap gap-1.5';
  const renderTagRow = () => {
    tagRow.innerHTML = '';
    for (const tag of allTags) {
      const btn = document.createElement('button');
      const isActive = activeTags.has(tag);
      btn.className = `text-xs px-2 py-0.5 rounded-full border transition-colors cursor-pointer ${isActive ? 'bg-accent text-white border-accent' : 'border-border text-muted hover:border-accent hover:text-accent'}`;
      btn.textContent = tag;
      btn.onclick = () => { if (isActive) activeTags.delete(tag); else activeTags.add(tag); renderTagRow(); renderList(); };
      tagRow.appendChild(btn);
    }
  };

  filterBar.append(searchInput, tagRow);
  wrap.appendChild(filterBar);

  // ── Selection toolbar (always visible) ──
  const selBar = document.createElement('div');
  selBar.className = 'flex items-center justify-between px-6 py-1.5 shrink-0';

  const selLabel = document.createElement('span'); selLabel.className = 'text-xs text-dim';
  const selActions = document.createElement('div'); selActions.className = 'flex gap-1';

  const selectAllBtn = document.createElement('button'); selectAllBtn.className = 'btn-ghost text-xs'; selectAllBtn.textContent = 'Select all';
  const deselectBtn = document.createElement('button'); deselectBtn.className = 'btn-ghost text-xs'; deselectBtn.textContent = 'Deselect all';
  const deleteBtn = document.createElement('button'); deleteBtn.className = 'btn-danger text-xs';

  const updateSelBar = (filtered: Card[]) => {
    selectAllBtn.onclick = () => { for (const c of filtered) selected.add(c.id); renderList(); };
    if (selected.size === 0) {
      selLabel.textContent = '';
      deselectBtn.classList.add('hidden');
      deleteBtn.classList.add('hidden');
    } else {
      selLabel.textContent = `${selected.size} selected`;
      deselectBtn.classList.remove('hidden');
      deleteBtn.textContent = `Delete ${selected.size}`;
      deleteBtn.classList.remove('hidden');
    }
  };

  deselectBtn.onclick = () => { selected.clear(); renderList(); };
  deleteBtn.onclick = () => {
    const count = selected.size;
    confirmModal('Delete cards', `Permanently delete ${count} card${count !== 1 ? 's' : ''}? They will be removed from all decks.`, 'Delete', () => {
      ctx.mutate(s => {
        for (const cardId of selected) {
          delete s.cards[cardId];
          for (const deck of Object.values(s.decks)) deck.entries = deck.entries.filter(e => e.cardId !== cardId);
          delete s.cardWorks[`${s.currentUserId}:${cardId}`];
        }
      });
    });
  };

  deselectBtn.classList.add('hidden');
  deleteBtn.classList.add('hidden');
  selActions.append(selectAllBtn, deselectBtn, deleteBtn);
  selBar.append(selLabel, selActions);
  wrap.appendChild(selBar);

  // ── List ──
  const listWrap = document.createElement('div'); listWrap.className = 'flex-1 overflow-y-auto px-6 pb-6';

  const renderList = () => {
    listWrap.innerHTML = '';
    const q = searchInput.value.toLowerCase();
    const filtered = allCards
      .filter(c => {
        const tags = c.tags ?? [];
        const matchesText = !q || c.name.toLowerCase().includes(q) || tags.some(t => t.toLowerCase().includes(q));
        const matchesTag = activeTags.size === 0 || [...activeTags].every(at => tags.includes(at));
        return matchesText && matchesTag;
      })
      .sort((a, b) => a.name.localeCompare(b.name));

    updateSelBar(filtered);

    if (filtered.length === 0) {
      const empty = document.createElement('p'); empty.className = 'text-sm text-dim italic';
      empty.textContent = (q || activeTags.size > 0) ? 'No cards match.' : 'No cards yet.';
      listWrap.appendChild(empty); return;
    }

    const list = document.createElement('div'); list.className = 'space-y-1';
    for (const card of filtered) {
      const work = state.cardWorks[`${user.id}:${card.id}`];
      const k = cardKnowledge(user, work);
      const deckIds = decksContainingCard(card.id, state);
      const isSelected = selected.has(card.id);

      const row = document.createElement('div');
      row.className = `flex items-center gap-3 px-3 py-2.5 rounded transition-colors group cursor-pointer ${isSelected ? 'bg-elevated' : 'hover:bg-elevated'}`;

      // Checkbox
      const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = isSelected;
      checkbox.className = `card-checkbox shrink-0 transition-opacity ${isSelected ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`;
      checkbox.onclick = (e) => {
        e.stopPropagation();
        if (checkbox.checked) selected.add(card.id); else selected.delete(card.id);
        renderList();
      };

      // Knowledge dot
      const dot = document.createElement('span'); dot.className = `w-2 h-2 rounded-full shrink-0 ${knowledgeColor(k)}`; dot.title = pct(k);

      const nameEl = document.createElement('span'); nameEl.className = 'text-sm text-primary flex-1 truncate'; nameEl.textContent = card.name;

      const meta = document.createElement('div'); meta.className = 'flex items-center gap-3 shrink-0';

      // Card tags
      if ((card.tags ?? []).length > 0) {
        const cardTagsWrap = document.createElement('div'); cardTagsWrap.className = 'flex gap-1';
        for (const t of (card.tags ?? []).slice(0, 3)) {
          const tb = document.createElement('span'); tb.className = 'text-xs px-1.5 py-0.5 rounded bg-border text-dim'; tb.textContent = t;
          cardTagsWrap.appendChild(tb);
        }
        meta.appendChild(cardTagsWrap);
      }

      // Importance
      const impBadge = document.createElement('span'); impBadge.className = 'text-xs font-mono text-dim'; impBadge.textContent = `×${card.importance}`; impBadge.title = 'Base importance';

      // Knowledge %
      const knBadge = document.createElement('span'); knBadge.className = 'text-xs font-mono text-muted w-10 text-right'; knBadge.textContent = pct(k);

      // Deck tags (on hover)
      const deckTagsWrap = document.createElement('div'); deckTagsWrap.className = 'hidden group-hover:flex gap-1';
      for (const dId of deckIds.slice(0, 2)) {
        const deck = state.decks[dId]; if (!deck) continue;
        const tag = document.createElement('span'); tag.className = 'text-xs px-1.5 py-0.5 rounded bg-accent/10 text-accent'; tag.textContent = deck.name;
        deckTagsWrap.appendChild(tag);
      }
      if (deckIds.length > 2) { const more = document.createElement('span'); more.className = 'text-xs text-dim'; more.textContent = `+${deckIds.length - 2}`; deckTagsWrap.appendChild(more); }

      meta.append(impBadge, knBadge, deckTagsWrap);
      row.append(checkbox, dot, nameEl, meta);
      row.onclick = () => ctx.navigate({ view: 'card', cardId: card.id });
      list.appendChild(row);
    }
    listWrap.appendChild(list);
  };

  renderTagRow();
  renderList();
  searchInput.addEventListener('input', () => renderList());
  wrap.appendChild(listWrap);
  setTimeout(() => searchInput.focus(), 30);
  return wrap;
}
