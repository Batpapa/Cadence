import { signal } from '@preact/signals';
import { useEffect, useRef, useState } from 'preact/hooks';
import { createPortal } from 'preact/compat';
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
//
// Signal-backed single instance (same idea as commandPalette.tsx/modal.tsx's
// modalStack): most callers are still vanilla TS (theSessionImport.ts,
// trendingModule.ts, sessionUiShared.ts — Tier 4/5/6, not yet converted), so
// showDeckPickerPopover() stays an imperative "show" function rather than a
// component a caller renders inline. Opening a second picker while one is
// already open replaces it rather than stacking — the original vanilla
// version could technically stack two overlays, but nothing in the app opens
// more than one deck picker at a time in practice.

interface PickerState {
  selected: Set<string>;
  onChange: () => void;
  onClose?: () => void;
}

const pickerState = signal<PickerState | null>(null);

export function showDeckPickerPopover(
  selected: Set<string>,
  onChange: () => void,
  onClose?: () => void,
): void {
  pickerState.value = { selected, onChange, onClose };
}

function closePicker(): void {
  const s = pickerState.value;
  pickerState.value = null;
  s?.onClose?.();
}

function DeckPickerPopover({ selected, onChange }: { selected: Set<string>; onChange: () => void }) {
  const [, bump] = useState(0);
  const [addingNew, setAddingNew] = useState(false);
  const [newName, setNewName] = useState('');
  const addInputRef = useRef<HTMLInputElement>(null);
  const mouseDownOnOverlay = useRef(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closePicker(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => { if (addingNew) addInputRef.current?.focus(); }, [addingNew]);

  const toggle = (deckId: string) => {
    if (selected.has(deckId)) selected.delete(deckId); else selected.add(deckId);
    onChange();
    bump(x => x + 1);
  };

  // ── "+ new deck" — click turns it into a text input; creates the deck at
  // the root (same place as the sidebar's "new deck", no folder picker here)
  // and auto-selects it, since the user is mid-pick.
  const commitAdd = () => {
    const name = newName.trim();
    setAddingNew(false);
    setNewName('');
    if (!name) return;
    const id = generateId();
    void mutate(s => {
      s.decks[id] = { id, name, entries: [] };
      s.rootDeckIds.push(id);
    });
    selected.add(id);
    onChange();
  };

  const decks = Object.values(appState.value.decks).sort((a, b) => a.name.localeCompare(b.name));

  return (
    <div
      class="fixed inset-0 z-[200] flex items-center justify-center bg-black/60"
      onMouseDown={(e) => { mouseDownOnOverlay.current = e.target === e.currentTarget; }}
      onClick={(e) => { if (e.target === e.currentTarget && mouseDownOnOverlay.current) closePicker(); }}
    >
      <div
        class="bg-elevated border border-border rounded-xl shadow-2xl w-full mx-4 flex flex-col overflow-hidden"
        style={{ maxWidth: `min(360px, ${modalMaxW(0.9)})`, maxHeight: modalMaxH(0.65) }}
      >
        <div class="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
          <span class="text-sm font-semibold text-primary">{t('newCard.selectDecks')}</span>
          <button class="text-dim hover:text-primary transition-colors text-lg leading-none cursor-pointer" onClick={closePicker}>✕</button>
        </div>

        <div class="overflow-y-auto flex-1 py-2">
          {decks.map(deck => (
            <label key={deck.id} class="flex items-center gap-3 px-4 py-2 cursor-pointer hover:bg-bg transition-colors">
              <input
                type="checkbox"
                class="card-checkbox shrink-0"
                checked={selected.has(deck.id)}
                onChange={() => toggle(deck.id)}
              />
              <span class="text-sm text-primary truncate">{deck.name}</span>
            </label>
          ))}

          <div class="px-4 py-2">
            {addingNew ? (
              <input
                ref={addInputRef}
                type="text"
                class="input text-sm"
                placeholder={t('modal.newDeck.label')}
                value={newName}
                onInput={(e) => setNewName((e.target as HTMLInputElement).value)}
                onBlur={commitAdd}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                  if (e.key === 'Escape') { setNewName(''); setAddingNew(false); }
                }}
              />
            ) : (
              <button
                class="flex items-center gap-2 text-sm text-dim hover:text-accent transition-colors cursor-pointer"
                onClick={() => setAddingNew(true)}
              >
                <span class="text-base leading-none">+</span><span>{t('newCard.newDeck')}</span>
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/** Mount once in AppRoot — portaled callers (still-vanilla Tier 4/5/6 files
 *  included) just need this host live somewhere in the tree, same as
 *  ModalHost/CommandPaletteHost. */
export function DeckPickerHost() {
  const s = pickerState.value;
  if (!s) return null;
  return createPortal(<DeckPickerPopover selected={s.selected} onChange={s.onChange} />, document.body);
}

/** Link-icon SVG string — matches the "new card" modal's deck button. */
export const deckLinkIcon =
  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>';
