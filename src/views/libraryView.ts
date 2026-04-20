import type { AppContext, Card } from '../types';
import { pct, availabilityColor, trashIcon, focusIfDesktop } from '../utils';
import { exportCards } from '../services/importExport';
import { confirmModal } from '../components/modal';
import { showNewCardModal } from '../components/theSessionImport';
import { decksContainingCard, deckPath } from '../services/deckService';
import { cardAvailability, replayFSRS } from '../services/knowledgeService';
import { getCurrentUser } from '../services/userService';
import { t } from '../services/i18nService';


export function renderLibraryView(ctx: AppContext): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'flex flex-col h-full view-enter';

  const { state } = ctx;
  const user = getCurrentUser(state);
  const allCards = Object.values(state.cards) as Card[];

  const selected = new Set<string>();

  // ── Header ──
  const header = document.createElement('div'); header.className = 'flex items-center justify-between px-6 pt-6 pb-4 shrink-0';
  const titleWrap = document.createElement('div');
  const title = document.createElement('h1'); title.className = 'text-xl font-semibold text-primary'; title.textContent = t('library.title');
  const sub = document.createElement('p'); sub.className = 'text-xs text-muted mt-0.5';
  sub.textContent = t(allCards.length !== 1 ? 'library.cardCountPlural' : 'library.cardCount', { count: allCards.length });
  titleWrap.append(title, sub);
  const headerBtns = document.createElement('div'); headerBtns.className = 'flex gap-2';
  const newCardBtn = document.createElement('button'); newCardBtn.className = 'btn-primary'; newCardBtn.textContent = t('library.newCard');
  newCardBtn.onclick = () => showNewCardModal(ctx);
  headerBtns.append(newCardBtn);
  header.append(titleWrap, headerBtns);
  wrap.appendChild(header);

  // ── Search + tag filter ──
  const filterBar = document.createElement('div'); filterBar.className = 'px-6 pb-3 shrink-0 space-y-2';
  const searchInput = document.createElement('input'); searchInput.type = 'text'; searchInput.placeholder = t('library.search'); searchInput.className = 'input';

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

  // ── Selection toolbar ──
  const selBar = document.createElement('div');
  selBar.className = 'flex items-center justify-between px-6 py-1.5 shrink-0';

  const selLabel = document.createElement('span'); selLabel.className = 'text-xs text-dim';
  const selActions = document.createElement('div'); selActions.className = 'flex gap-1';

  const selectAllBtn = document.createElement('button'); selectAllBtn.className = 'btn-ghost text-xs'; selectAllBtn.textContent = t('library.selectAll');
  const deselectBtn = document.createElement('button'); deselectBtn.className = 'btn-ghost text-xs'; deselectBtn.textContent = t('library.deselectAll');
  const exportBtn = document.createElement('button'); exportBtn.className = 'btn-ghost text-xs hidden'; exportBtn.textContent = t('library.exportSelected');
  const deleteBtn = document.createElement('button'); deleteBtn.className = 'btn-danger text-xs flex items-center gap-1.5';
  deleteBtn.title = t('library.deleteSelected'); deleteBtn.appendChild(trashIcon(12));
  const deleteLbl = document.createElement('span'); deleteBtn.appendChild(deleteLbl);

  exportBtn.onclick = () => exportCards(allCards.filter(c => selected.has(c.id)));

  const updateSelBar = (filtered: Card[]) => {
    selectAllBtn.onclick = () => { for (const c of filtered) selected.add(c.id); renderList(); };
    if (selected.size === 0) {
      selLabel.textContent = '';
      deselectBtn.classList.add('hidden');
      exportBtn.classList.add('hidden');
      deleteBtn.classList.add('hidden');
    } else {
      selLabel.textContent = t('library.selected', { count: selected.size });
      deselectBtn.classList.remove('hidden');
      exportBtn.classList.remove('hidden');
      deleteLbl.textContent = String(selected.size);
      deleteBtn.classList.remove('hidden');
    }
  };

  deselectBtn.onclick = () => { selected.clear(); renderList(); };
  deleteBtn.onclick = () => {
    const count = selected.size;
    confirmModal(
      t('library.delete.title'),
      t(count !== 1 ? 'library.delete.messagePlural' : 'library.delete.message', { count }),
      t('common.delete'),
      () => {
        ctx.mutate(s => {
          for (const cardId of selected) {
            delete s.cards[cardId];
            for (const deck of Object.values(s.decks)) deck.entries = deck.entries.filter(e => e.cardId !== cardId);
            delete s.cardWorks[`${s.currentUserId}:${cardId}`];
          }
        });
      }
    );
  };

  deselectBtn.classList.add('hidden');
  deleteBtn.classList.add('hidden');
  selActions.append(selectAllBtn, deselectBtn, exportBtn, deleteBtn);
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
        const matchesText = !q || c.name.toLowerCase().includes(q) || tags.some(tg => tg.toLowerCase().includes(q));
        const matchesTag = activeTags.size === 0 || [...activeTags].every(at => tags.includes(at));
        return matchesText && matchesTag;
      })
      .sort((a, b) => a.name.localeCompare(b.name));

    updateSelBar(filtered);

    if (filtered.length === 0) {
      const empty = document.createElement('p'); empty.className = 'text-sm text-dim italic';
      empty.textContent = (q || activeTags.size > 0) ? t('library.noMatch') : t('library.empty');
      listWrap.appendChild(empty); return;
    }

    const list = document.createElement('div'); list.className = 'space-y-1';
    for (const card of filtered) {
      const work = state.cardWorks[`${state.currentProfileId}:${card.id}`];
      const k = cardAvailability(user, work);
      const deckIds = decksContainingCard(card.id, state);
      const isSelected = selected.has(card.id);

      const row = document.createElement('div');
      row.className = `flex items-center gap-3 px-3 py-2.5 rounded transition-colors group cursor-pointer ${isSelected ? 'bg-elevated' : 'hover:bg-elevated'}`;

      const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = isSelected;
      checkbox.className = `card-checkbox shrink-0 transition-opacity ${isSelected ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`;
      checkbox.onclick = (e) => {
        e.stopPropagation();
        if (checkbox.checked) selected.add(card.id); else selected.delete(card.id);
        renderList();
      };

      const fsrs = work ? replayFSRS(work.history) : undefined;
      const cardEase = fsrs ? (10 - fsrs.difficulty) / 9 : undefined;
      const dotsWrap = document.createElement('span'); dotsWrap.className = 'flex gap-0.5 items-center shrink-0';
      const dot1 = document.createElement('span'); dot1.className = `w-2 h-2 rounded-full ${availabilityColor(k)}`; dot1.title = `R: ${pct(k)}`;
      const dot2 = document.createElement('span'); dot2.className = `w-2 h-2 rounded-full ${cardEase === undefined ? 'bg-border' : cardEase >= 0.6 ? 'bg-success' : cardEase >= 0.35 ? 'bg-warn' : 'bg-danger'}`; dot2.title = cardEase !== undefined ? `Ease: ${pct(cardEase)}` : 'Never reviewed';
      dotsWrap.append(dot1, dot2);
      const nameEl = document.createElement('span'); nameEl.className = 'text-sm text-primary flex-1 truncate'; nameEl.textContent = card.name;
      const meta = document.createElement('div'); meta.className = 'flex items-center gap-3 shrink-0';

      if ((card.tags ?? []).length > 0) {
        const cardTagsWrap = document.createElement('div'); cardTagsWrap.className = 'flex gap-1';
        for (const tg of (card.tags ?? []).slice(0, 3)) {
          const tb = document.createElement('span'); tb.className = 'text-xs px-1.5 py-0.5 rounded bg-border text-dim'; tb.textContent = tg;
          cardTagsWrap.appendChild(tb);
        }
        meta.appendChild(cardTagsWrap);
      }

      const impBadge = document.createElement('span'); impBadge.className = 'text-xs font-mono text-dim'; impBadge.textContent = `×${card.importance}`; impBadge.title = t('library.baseImportance');

      const deckTagsWrap = document.createElement('div'); deckTagsWrap.className = 'hidden group-hover:flex gap-1';
      for (const dId of deckIds.slice(0, 2)) {
        const deck = state.decks[dId]; if (!deck) continue;
        const tag = document.createElement('span');
        tag.className = 'text-xs px-1.5 py-0.5 rounded bg-accent/10 text-accent cursor-pointer hover:bg-accent/20 transition-colors';
        tag.textContent = deck.name;
        tag.title = deckPath(dId, state);
        tag.onclick = (e) => { e.stopPropagation(); ctx.navigate({ view: 'deck', deckId: dId }); };
        deckTagsWrap.appendChild(tag);
      }
      if (deckIds.length > 2) { const more = document.createElement('span'); more.className = 'text-xs text-dim'; more.textContent = `+${deckIds.length - 2}`; deckTagsWrap.appendChild(more); }

      meta.append(impBadge, deckTagsWrap);
      row.append(checkbox, dotsWrap, nameEl, meta);
      row.onclick = () => ctx.navigate({ view: 'card', cardId: card.id });
      list.appendChild(row);
    }
    listWrap.appendChild(list);
  };

  renderTagRow();
  renderList();
  searchInput.addEventListener('input', () => renderList());
  wrap.appendChild(listWrap);
  focusIfDesktop(searchInput);
  return wrap;
}
