import { signal } from '@preact/signals';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { createPortal } from 'preact/compat';
import { t } from '../services/i18nService';
import { modalMaxW, modalMaxH } from '../services/zoomService';
import { showModal, closeModal, renderModalBody } from './modal';
import { PinIcon } from './icons';
import { appState, mutate } from '../store';
import { generateId } from '../utils';

// ── Deck choice ──────────────────────────────────────────────────────────────
// One modal for every "this card is about to land somewhere" moment: adding a
// detected tune from a session, linking one that already exists, importing from
// TheSession or Irish Tune Info, creating a card by hand.
//
// It replaced a per-page picker that opened ONCE — on the first add — and then
// applied its answer silently to every later click. That saved clicks and cost
// legibility: by the seventh tune, pressing + did nothing visible and the card
// landed in decks chosen ten minutes earlier. Opening every time is the
// deliberate trade: one more click, in exchange for always knowing where a card
// went. Pinning (below) is what keeps that from becoming tedious.
//
// Three states per deck, cycled by clicking the row — off → ticked → pinned →
// off, and backwards on right-click, the same ring and the same gesture as the
// library's filter pins. A pinned deck comes back ticked the next time the
// modal opens. Pins are EPHEMERAL and page-scoped: they live in a Set the
// caller owns (a session engine, a modal's ref), never in the synced state and
// never in storage. Choosing a destination is a decision about right now, not a
// preference about the user.
//
// The modal never REMOVES a card from a deck: decks the card already belongs to
// render ticked and untouchable. Removal stays where it belongs, in the deck
// view.

export type DeckChoiceState = 'off' | 'ticked' | 'pinned';

/** Next state in the ring. Exported for the tests, which pin the ring itself
 *  rather than re-deriving it from a click sequence. */
export function nextDeckChoiceState(current: DeckChoiceState, back = false): DeckChoiceState {
  if (back) return current === 'off' ? 'pinned' : current === 'pinned' ? 'ticked' : 'off';
  return current === 'off' ? 'ticked' : current === 'ticked' ? 'pinned' : 'off';
}

/** Decks that already hold this card — rendered ticked and disabled. */
export function decksContainingCard(cardId: string): Set<string> {
  return new Set(
    Object.values(appState.value.decks)
      .filter(d => d.entries.some(e => e.cardId === cardId))
      .map(d => d.id),
  );
}

/** True when there is somewhere to put a card at all. With no deck the modal
 *  has nothing to offer, so callers skip it entirely rather than showing an
 *  empty list. */
export function hasAnyDeck(): boolean {
  return Object.keys(appState.value.decks).length > 0;
}

/** Nothing left to add this card to. The trigger dims to say so, but stays
 *  clickable: the modal is then the only place that shows WHERE the card
 *  already lives, and taking that away to signal "nothing to do" would cost
 *  more than it says. */
export function isInEveryDeck(cardId: string): boolean {
  const decks = Object.values(appState.value.decks);
  return decks.length > 0 && decks.every(d => d.entries.some(e => e.cardId === cardId));
}

interface Draft { chosen: string[] }

interface DeckChoiceOptions {
  /** Pinned deck ids. MUTATED IN PLACE — the caller owns the lifetime, which is
   *  what makes a pin last exactly as long as the page or modal that holds it. */
  pinned: Set<string>;
  /** Decks the card is already in. Ticked, disabled, and never in the result. */
  alreadyIn?: Iterable<string>;
  /** Decks to start ticked beyond the pinned ones — the deck a "new card" was
   *  launched from, say. Ticked, not pinned: it applies to this card only. */
  preTicked?: Iterable<string>;
  /** Runs ONLY on the confirm button, with the decks to add to. Dismissing the
   *  modal — ✕, Escape, a click outside — cancels the whole operation, card
   *  creation included. */
  onConfirm: (deckIds: string[]) => void;
  /** Runs instead of `onConfirm` when the modal is dismissed. Callers that
   *  fetched something before asking use it to drop their busy state — the work
   *  is thrown away, and the button must not stay disabled over nothing. */
  onDismiss?: () => void;
}

/** One deck row. It has to LOOK exactly like an ordinary checkbox — same
 *  `.card-checkbox` control as everywhere else — while carrying a third state
 *  the element itself cannot express, so the pin sits beside the label rather
 *  than inside the box.
 *
 *  `checked` is written straight to the DOM in a layout effect, and the click is
 *  deliberately NOT prevented. Both halves were measured in a browser, not
 *  guessed: cancelling the click makes the browser undo its own pre-toggle
 *  after the handler, and that undo lands after Preact has rendered — the pin
 *  appeared while the box stayed empty, on every left click. Letting the toggle
 *  happen and re-asserting the real value afterwards leaves nothing pending to
 *  fight, and a plain `checked` prop cannot do it (Preact skips the DOM write
 *  whenever the value matches its own previous render, which it often does
 *  while the ring moves between its two ticked states). */
function DeckRow({ name, state, already, onCycle }: {
  name: string;
  state: DeckChoiceState;
  already: boolean;
  onCycle: (back: boolean) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const checked = already || state !== 'off';
  useLayoutEffect(() => { if (inputRef.current) inputRef.current.checked = checked; });

  return (
    <label
      class={`flex items-center gap-2 px-2 py-1.5 rounded ${already ? 'opacity-60' : 'hover:bg-elevated cursor-pointer'}`}
      title={already ? t('deckChoice.alreadyIn') : t('deckChoice.pinHint')}
      onContextMenu={(e) => { e.preventDefault(); if (!already) onCycle(true); }}
    >
      <input
        ref={inputRef}
        type="checkbox"
        class="card-checkbox"
        disabled={already}
        onClick={() => onCycle(false)}
      />
      <span class="text-sm text-primary flex-1 truncate">{name}</span>
      {state === 'pinned' && (
        <span class="text-accent shrink-0" title={t('deckChoice.pinned')}><PinIcon size={12} /></span>
      )}
      {already && <span class="text-xs text-dim shrink-0">{t('deckChoice.alreadyIn')}</span>}
    </label>
  );
}

function DeckChoiceBody({ pinned, alreadyIn, initial, draft }: {
  pinned: Set<string>;
  alreadyIn: Set<string>;
  initial: Set<string>;
  draft: Draft;
}) {
  const [ticked, setTicked] = useState<Set<string>>(() => new Set(initial));
  const [addingNew, setAddingNew] = useState(false);
  const [newName, setNewName] = useState('');
  const addInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { if (addingNew) addInputRef.current?.focus(); }, [addingNew]);

  const stateOf = (id: string): DeckChoiceState =>
    pinned.has(id) ? 'pinned' : ticked.has(id) ? 'ticked' : 'off';

  const cycle = (id: string, back = false) => {
    if (alreadyIn.has(id)) return;
    const to = nextDeckChoiceState(stateOf(id), back);
    const next = new Set(ticked);
    if (to === 'off') { next.delete(id); pinned.delete(id); }
    else {
      next.add(id);
      if (to === 'pinned') pinned.add(id); else pinned.delete(id);
    }
    setTicked(next);
    draft.chosen = [...next];
  };

  // "+ new deck" — creates at the root (same place as the sidebar's) and ticks
  // it straight away, since the user is mid-pick.
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
    const next = new Set(ticked); next.add(id);
    setTicked(next);
    draft.chosen = [...next];
  };

  const decks = Object.values(appState.value.decks).sort((a, b) => a.name.localeCompare(b.name));

  return (
    <div class="space-y-1">
      {decks.map(deck => (
        <DeckRow
          key={deck.id}
          name={deck.name}
          state={stateOf(deck.id)}
          already={alreadyIn.has(deck.id)}
          onCycle={(back) => cycle(deck.id, back)}
        />
      ))}

      <div class="px-2 pt-1">
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

      <p class="text-xs text-dim px-2 pt-2 leading-relaxed">{t('deckChoice.pinHint')}</p>
    </div>
  );
}

export function showDeckChoiceModal(opts: DeckChoiceOptions): void {
  const alreadyIn = new Set(opts.alreadyIn ?? []);
  // Pinned decks the card already belongs to would otherwise be counted as a
  // pending addition and light up a confirm button with nothing behind it.
  const initial = new Set([...opts.pinned, ...(opts.preTicked ?? [])].filter(id => !alreadyIn.has(id)));
  const draft: Draft = { chosen: [...initial] };

  const { el, cleanup } = renderModalBody(
    <DeckChoiceBody pinned={opts.pinned} alreadyIn={alreadyIn} initial={initial} draft={draft} />,
  );
  // No disabled state on the confirm: ticking nothing is a real answer ("put it
  // nowhere"), and when the card is already in every deck it is the ONLY answer
  // left — greying the button out there would trap the user in a dialog they
  // opened to look at something.
  showModal(t('newCard.selectDecks'), el, [
    // `closeModal` pops the stack without running `onDismiss`, so the body's
    // Preact tree has to be unmounted here too — otherwise confirming leaks it.
    { label: t('deckChoice.confirm'), primary: true, onClick: () => { closeModal(); cleanup(); opts.onConfirm(draft.chosen); } },
  ], { maxWidth: '22rem', onDismiss: () => { cleanup(); opts.onDismiss?.(); } });
}

// ── Deck membership popover ──────────────────────────────────────────────────
// A different job from the modal above, which is why both live here. This one
// EDITS MEMBERSHIP in both directions for a card that already exists: unticking
// removes it from that deck, and every click applies immediately with no
// confirm step. The card view's "manage decks" is its only caller, and it is
// where removing a card from a deck belongs — the choice modal above is
// additive by construction and must never take a card out of a deck.

interface PickerState {
  selected: Set<string>;
  onChange: () => void;
}

const pickerState = signal<PickerState | null>(null);

export function showDeckPickerPopover(selected: Set<string>, onChange: () => void): void {
  pickerState.value = { selected, onChange };
}

function closePicker(): void {
  pickerState.value = null;
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

/** Mount once in AppRoot — the popover is opened imperatively, so it just needs
 *  a live host somewhere in the tree, same as ModalHost/CommandPaletteHost. */
export function DeckPickerHost() {
  const s = pickerState.value;
  if (!s) return null;
  return createPortal(<DeckPickerPopover selected={s.selected} onChange={s.onChange} />, document.body);
}

/** Link-icon SVG string — the "already a card, put it in a deck" affordance. */
export const deckLinkIcon =
  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>';
