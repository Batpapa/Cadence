import { t } from '../services/i18nService';
import { modalMaxW, modalMaxH } from '../services/zoomService';
import { appState, mutate } from '../store';
import { generateId } from '../utils';

// ── Deck-picker popover ──────────────────────────────────────────────────────
// Checkbox list over `selected` (mutated in place). Shared primitive — used by
// the "new card" modal and the session module's per-session target-deck picker.
// Reads decks straight from the live `appState` signal (not a passed-in
// AppContext snapshot) so a deck created while the caller's own context was
// captured earlier still shows up without needing to reopen the whole screen.

export function showDeckPickerPopover(
  selected: Set<string>,
  onChange: () => void,
  onClose?: () => void,
): void {
  const overlay = document.createElement('div');
  overlay.className = 'fixed inset-0 z-[200] flex items-center justify-center bg-black/60';
  const dialog = document.createElement('div');
  dialog.className = 'bg-elevated border border-border rounded-xl shadow-2xl w-full mx-4 flex flex-col overflow-hidden';
  dialog.style.cssText = `max-width:min(360px, ${modalMaxW(0.9)}); max-height:${modalMaxH(0.65)};`;

  const header = document.createElement('div');
  header.className = 'flex items-center justify-between px-4 py-3 border-b border-border shrink-0';
  const title = document.createElement('span');
  title.className = 'text-sm font-semibold text-primary';
  title.textContent = t('newCard.selectDecks');
  const closeBtn = document.createElement('button');
  closeBtn.className = 'text-dim hover:text-primary transition-colors text-lg leading-none cursor-pointer';
  closeBtn.textContent = '✕';
  header.append(title, closeBtn);

  const body = document.createElement('div');
  body.className = 'overflow-y-auto flex-1 py-2';

  const renderRows = () => {
    body.innerHTML = '';
    const decks = Object.values(appState.value.decks).sort((a, b) => a.name.localeCompare(b.name));
    for (const deck of decks) {
      const row = document.createElement('label');
      row.className = 'flex items-center gap-3 px-4 py-2 cursor-pointer hover:bg-bg transition-colors';
      const chk = document.createElement('input');
      chk.type = 'checkbox';
      chk.checked = selected.has(deck.id);
      chk.className = 'card-checkbox shrink-0';
      chk.onchange = () => {
        if (chk.checked) selected.add(deck.id); else selected.delete(deck.id);
        onChange();
      };
      const nameEl = document.createElement('span');
      nameEl.className = 'text-sm text-primary truncate';
      nameEl.textContent = deck.name;
      row.append(chk, nameEl);
      body.appendChild(row);
    }
    body.appendChild(addRow);
  };

  // ── "+ new deck" row — click turns it into a text input; creates the deck
  // at the root (same place as the sidebar's "new deck", no folder picker
  // here) and auto-selects it, since the user is mid-pick.
  const addRow = document.createElement('div');
  addRow.className = 'px-4 py-2';
  const addBtn = document.createElement('button');
  addBtn.className = 'flex items-center gap-2 text-sm text-dim hover:text-accent transition-colors cursor-pointer';
  addBtn.innerHTML = `<span class="text-base leading-none">+</span><span>${t('newCard.newDeck')}</span>`;
  const addInp = document.createElement('input');
  addInp.type = 'text';
  addInp.className = 'input text-sm hidden';
  addInp.placeholder = t('modal.newDeck.label');

  const showAddInput = () => {
    addBtn.classList.add('hidden');
    addInp.classList.remove('hidden');
    addInp.value = '';
    addInp.focus();
  };
  const showAddBtn = () => {
    addInp.classList.add('hidden');
    addBtn.classList.remove('hidden');
  };
  const commitAdd = () => {
    const name = addInp.value.trim();
    if (!name) { showAddBtn(); return; }
    const id = generateId();
    void mutate(s => {
      s.decks[id] = { id, name, entries: [] };
      s.rootDeckIds.push(id);
    });
    selected.add(id);
    onChange();
    renderRows();
    showAddBtn(); // renderRows() rebuilds addRow's contents fresh
  };
  addBtn.onclick = showAddInput;
  addInp.addEventListener('blur', commitAdd);
  addInp.addEventListener('keydown', e => {
    if (e.key === 'Enter') addInp.blur();
    if (e.key === 'Escape') { addInp.value = ''; showAddBtn(); }
  });
  addRow.append(addBtn, addInp);

  renderRows();

  const close = () => {
    document.removeEventListener('keydown', onKey);
    overlay.remove();
    onClose?.();
  };
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  closeBtn.onclick = close;
  overlay.addEventListener('mousedown', e => { if (e.target === overlay) close(); });

  dialog.append(header, body);
  overlay.appendChild(dialog);
  document.body.appendChild(overlay);
}

/** Link-icon SVG string — matches the "new card" modal's deck button. */
export const deckLinkIcon =
  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>';
