import { useEffect, useRef, useState } from 'preact/hooks';
import type { Card } from '../types';
import { t } from '../services/i18nService';
import { appState } from '../store';
import { focusIfDesktop, rankByRelevance } from '../utils';
import { CheckIcon } from './icons';

// ── The one way to find a card of the library (2026-10-15) ──────────────────
// Every place that asks for an existing card goes through this field: a card
// as an attachment, a tune into a set, a card into a deck, where a clip goes.
// Each had its own until then — a dialog listing the whole library, a dashed
// field with a floating list of twelve, a field with a tick — with nothing in
// common but the ranking (the user asked for one, 2026-10-15). Only the
// wording stays the caller's: it says what the card is being picked FOR.
//
// Suggestions appear only while something is typed, best first, aliases
// included (rankByRelevance), and are walked with ↑ ↓ and taken with Enter.
// Escape empties a search before it reaches the dialog around (see main.ts).

/** How many suggestions at most: past that, the answer is to type more. */
const MAX_SUGGESTIONS = 20;

interface Common {
  /** What the field is for — "Link an existing card…". Default: a search. */
  placeholder?: string;
  /** Said when nothing matches; the caller's when it knows why (a set takes
   *  only tunes). */
  noMatch?: string;
  /** Narrows the candidates. */
  eligible?: (card: Card) => boolean;
  /** Focus on mount, on a device with a keyboard. */
  autoFocus?: boolean;
  disabled?: boolean;
  /** The list over what follows rather than pushing it down — for a field on a
   *  page; in a dialog it stays in the flow, where nothing can clip it. */
  floating?: boolean;
  /** The size of a field set among small controls (a deck's header): the same
   *  look, at the height of the buttons beside it. */
  compact?: boolean;
  id?: string;
}

/** `onPick`: choosing a card is the whole act (adding it), and the field
 *  empties for the next one. `onChange`: the field NAMES a card, which a
 *  button acts on later — it opens on `initialCardId`, shows a green tick
 *  while its text is a card's exact name, and reports that card, or none. */
type Props = Common & (
  | { onPick: (card: Card) => void; onChange?: never; initialCardId?: never }
  | { onChange: (card: Card | undefined) => void; initialCardId?: string; onPick?: never }
);

/** The card a text names exactly, whatever the case — the one already chosen
 *  when two share it. */
function named(cards: Card[], text: string, current: string | undefined): Card | undefined {
  const name = text.trim().toLowerCase();
  if (!name) return undefined;
  const same = cards.filter(c => c.name.trim().toLowerCase() === name);
  return same.find(c => c.id === current) ?? same[0];
}

export function CardSearchField(props: Props) {
  const { placeholder, noMatch, eligible, autoFocus, disabled, floating, compact, id } = props;
  const naming = !!props.onChange;
  const cards = Object.values(appState.value.cards).filter(eligible ?? (() => true));

  const [query, setQuery] = useState(() =>
    (props.initialCardId && appState.value.cards[props.initialCardId]?.name) || '');
  const [chosen, setChosen] = useState<string | undefined>(props.initialCardId);
  const [active, setActive] = useState(0);
  const [focused, setFocused] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { if (autoFocus && inputRef.current) focusIfDesktop(inputRef.current); }, []);

  const q = query.trim();
  const valid = naming && !!chosen && !!appState.value.cards[chosen];
  const open = !!q && !valid && (focused || !floating);
  const found = open ? rankByRelevance(cards, q).slice(0, MAX_SUGGESTIONS) : [];

  const type = (text: string) => {
    setQuery(text);
    setActive(0);
    if (!naming) return;
    const card = named(cards, text, chosen);
    setChosen(card?.id);
    props.onChange!(card);
  };
  const take = (card: Card) => {
    if (naming) {
      setQuery(card.name);
      setChosen(card.id);
      props.onChange!(card);
    } else {
      setQuery('');
      props.onPick!(card);
    }
    setActive(0);
  };

  return (
    <div class="relative">
      <input
        ref={inputRef}
        id={id}
        type="text"
        class={`input ${compact ? 'h-6 py-0 px-2 text-xs' : 'text-sm'} ${naming ? 'pr-8' : ''}`}
        placeholder={placeholder ?? t('fileViewer.cardRef.search')}
        value={query}
        disabled={disabled}
        role="combobox"
        aria-expanded={open}
        aria-autocomplete="list"
        onFocus={(e) => { setFocused(true); if (naming) (e.target as HTMLInputElement).select(); }}
        // A field on a page lets its search go with the focus, as it always did.
        onBlur={() => { setFocused(false); if (floating && !naming) setQuery(''); }}
        onInput={(e) => type((e.target as HTMLInputElement).value)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' && found.length) { e.preventDefault(); setActive((active + 1) % found.length); }
          else if (e.key === 'ArrowUp' && found.length) { e.preventDefault(); setActive((active - 1 + found.length) % found.length); }
          else if (e.key === 'Enter' && found[active]) { e.preventDefault(); take(found[active].item); }
          // A search is emptied first, the dialog closed only once there is
          // none. Not a named card: its text is the answer, not a search.
          else if (e.key === 'Escape' && !naming && q) { e.preventDefault(); type(''); }
        }}
      />
      {valid && (
        <span class="absolute right-2.5 top-1/2 -translate-y-1/2 text-success pointer-events-none" title={t('cardSearch.valid')}>
          <CheckIcon size={14} />
        </span>
      )}
      {open && (
        <div
          role="listbox"
          class={`bg-surface border border-border rounded p-1 space-y-0.5 max-h-52 overflow-y-auto ${
            floating ? 'absolute z-10 left-0 right-0 top-full mt-1 shadow-lg' : 'mt-1.5'}`}
        >
          {found.map(({ item, via }, i) => (
            <button
              key={item.id}
              type="button"
              role="option"
              aria-selected={i === active}
              class={`w-full text-left text-sm px-2 py-1.5 rounded cursor-pointer transition-colors ${i === active ? 'bg-accent/10' : ''}`}
              onMouseEnter={() => setActive(i)}
              // Before the blur, which would otherwise take the list away first.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => take(item)}
            >
              <span class="block truncate text-primary">{item.name}</span>
              {via !== undefined && <span class="block truncate text-xs text-dim">{t('search.viaAlias', { alias: via })}</span>}
            </button>
          ))}
          {found.length === 0 && <p class="text-xs text-dim px-2 py-1.5">{noMatch ?? t('cardSearch.noMatch')}</p>}
        </div>
      )}
    </div>
  );
}
