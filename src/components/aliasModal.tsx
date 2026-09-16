import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import { appState, mutate } from '../store';
import { showModal, renderModalBody } from './modal';
import { focusIfDesktop } from '../utils';
import { t } from '../services/i18nService';
import { PencilIcon, TrashIcon, PromoteIcon } from './icons';
import {
  cardAliases, aliasProblem, addAlias, renameAlias, removeAlias, promoteAliasToName, type AliasProblem,
} from '../services/aliasService';
import type { Card } from '../types';

// ── Managing a card's aliases ─────────────────────────────────────────────────
// One dialog for the whole list, the way the user asked for it (2026-09-17):
// add, remove, rename, and "use as name", which swaps an alias with the name.
// Every action writes at once — there is nothing to confirm, and the list on
// screen is the card's, read live, so a swap shows its result where it happened.
//
// The actions are always-visible buttons on each row, never hover: the tag
// pills learned that the hard way (a ✕ reachable only through a :hover stuck on
// the last thing tapped). Renaming is a button too, not a tap on the text,
// which would put an edit field one mis-tap away.

function problemNote(problem: AliasProblem | null, value: string): string | null {
  if (problem === 'isName') return t('card.aliases.isName', { alias: value.trim() });
  if (problem === 'alreadyAlias') return t('card.aliases.alreadyAlias', { alias: value.trim() });
  return null;
}

function AliasRow({ cardId, alias, index, editing, onEdit, onDone }: {
  cardId: string;
  alias: string;
  index: number;
  editing: boolean;
  onEdit: () => void;
  onDone: () => void;
}) {
  const [value, setValue] = useState(alias);
  const [note, setNote] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // The field is filled when the edit STARTS, in the click, not in an effect:
  // an effect runs after the field is on screen, and wrote the old text over
  // whatever was typed first (caught in the browser, 2026-09-17). Focus is a
  // layout effect for a related reason: given after paint, a quick Escape
  // landed before the field had focus and closed the whole dialog instead of
  // cancelling the edit.
  const startEdit = () => { setValue(alias); setNote(null); onEdit(); };
  useLayoutEffect(() => {
    if (editing && inputRef.current) { focusIfDesktop(inputRef.current); inputRef.current.select(); }
  }, [editing]);

  const edit = (fn: (card: Card) => void) => mutate(s => { const c = s.cards[cardId]; if (c) fn(c); });

  /** Enter keeps the field open on a refused name, to say why; leaving the
   *  field (`leaving`) gives up on it instead, as Escape does. */
  const commit = (leaving: boolean) => {
    const card = appState.value.cards[cardId];
    if (!card) { onDone(); return; }
    // The field itself, not the state: a paste followed at once by Enter can
    // reach this before the render that would have updated `value`.
    const v = (inputRef.current?.value ?? value).trim();
    if (v === alias || v === '') { onDone(); return; }
    const problem = aliasProblem(card, v, index);
    if (problem) {
      if (leaving) onDone(); else setNote(problemNote(problem, v));
      return;
    }
    void edit(c => { renameAlias(c, index, v); });
    onDone();
  };

  return (
    <div class="py-1.5 space-y-1">
      <div class="flex items-center gap-1">
        {editing ? (
          <input
            ref={inputRef}
            type="text"
            class="input flex-1 min-w-0 text-sm py-1"
            value={value}
            onInput={(e) => { setValue((e.target as HTMLInputElement).value); setNote(null); }}
            onBlur={() => commit(true)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); commit(false); }
              // Marked handled so the shell's Escape cancels the edit rather
              // than closing the whole dialog.
              if (e.key === 'Escape') { e.preventDefault(); onDone(); }
            }}
          />
        ) : (
          <span class="flex-1 min-w-0 text-sm text-primary break-words">{alias}</span>
        )}
        <button
          type="button"
          class="tap-btn text-dim hoverable:text-accent hoverable:bg-elevated cursor-pointer shrink-0"
          title={t('card.aliases.useAsName')}
          // Before the input's blur commits: the swap must see the list as it is.
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => { onDone(); void edit(c => promoteAliasToName(c, index)); }}
        >
          <PromoteIcon size={13} />
        </button>
        <button
          type="button"
          class="tap-btn text-dim hoverable:text-accent hoverable:bg-elevated cursor-pointer shrink-0"
          title={t('card.aliases.rename')}
          onClick={startEdit}
        >
          <PencilIcon size={13} />
        </button>
        <button
          type="button"
          class="tap-btn text-dim hoverable:text-danger hoverable:bg-elevated cursor-pointer shrink-0"
          title={t('card.aliases.remove')}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => { onDone(); void edit(c => removeAlias(c, index)); }}
        >
          <TrashIcon size={13} />
        </button>
      </div>
      {editing && note && <p class="text-xs text-warn leading-relaxed">{note}</p>}
    </div>
  );
}

function AliasManager({ cardId }: { cardId: string }) {
  const card = appState.value.cards[cardId];
  // Index of the row being renamed. Cleared by every action that reshapes the
  // list, so it can never end up pointing at a different alias.
  const [editing, setEditing] = useState<number | null>(null);
  const [value, setValue] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const addRef = useRef<HTMLInputElement>(null);

  // Deleted meanwhile — from another device, through a sync.
  if (!card) return <p class="text-sm text-dim">{t('card.notFound')}</p>;
  const aliases = cardAliases(card);

  const add = () => {
    // Read from the field for the same reason as a rename's commit.
    const v = (addRef.current?.value ?? value).trim();
    if (!v) return;
    const problem = aliasProblem(card, v);
    if (problem) { setNote(problemNote(problem, v)); return; }
    setEditing(null);
    void mutate(s => { const c = s.cards[cardId]; if (c) addAlias(c, v); });
    setValue('');
    setNote(null);
  };

  return (
    <div class="space-y-3">
      {/* The name is shown because "use as name" changes it, and the swap
          should be visible without closing the dialog to find out. */}
      <p class="text-xs text-dim break-words">{t('card.aliases.currentName', { name: card.name })}</p>

      {aliases.length === 0 ? (
        <p class="text-sm text-dim">{t('card.aliases.empty')}</p>
      ) : (
        <div class="divide-y divide-border/50">
          {aliases.map((alias, i) => (
            <AliasRow
              // Index as key on purpose: duplicates are allowed, so the text
              // cannot identify a row.
              key={i}
              cardId={cardId}
              alias={alias}
              index={i}
              editing={editing === i}
              onEdit={() => setEditing(i)}
              onDone={() => setEditing(null)}
            />
          ))}
        </div>
      )}

      <div class="space-y-1">
        <div class="flex gap-2">
          <input
            ref={addRef}
            type="text"
            class="input flex-1 min-w-0 text-sm"
            placeholder={t('card.aliases.placeholder')}
            value={value}
            onInput={(e) => { setValue((e.target as HTMLInputElement).value); setNote(null); }}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }}
          />
          <button type="button" class="btn-primary text-xs shrink-0" disabled={!value.trim()} onClick={add}>
            {t('common.add')}
          </button>
        </div>
        {note && <p class="text-xs text-warn leading-relaxed">{note}</p>}
      </div>
    </div>
  );
}

/** The card's aliases, to add, remove, rename, or promote to name. */
export function showAliasModal(cardId: string): void {
  const { el, cleanup } = renderModalBody(<AliasManager cardId={cardId} />);
  // No action buttons: every change is already written. The ✕, Escape and a
  // click outside close it.
  showModal(t('card.aliases.title'), el, [], { maxWidth: '28rem', onDismiss: cleanup });
}
