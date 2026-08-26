import { useState, useRef, useEffect } from 'preact/hooks';
import { signal, type Signal } from '@preact/signals';
import type { ComponentChild } from 'preact';
import { appState, mutate } from '../store';
import { showModal, closeModal, renderModalBody } from './modal';
import { CustomSelect } from './customSelect';
import { focusIfDesktop } from '../utils';
import { t } from '../services/i18nService';
import type { Card } from '../types';

// ── Bulk edits on a library selection ────────────────────────────────────────
// The modal shell takes an HTMLElement and renders its footer buttons outside
// the body, so each of these bridges a Preact tree through renderModalBody()
// and hands the confirm handler a plain mutable `draft` the component writes
// to. The same draft carries a `noop` signal: a body that would currently
// change nothing (nothing ticked, empty field) sets it, and the footer's
// confirm button greys out. Cheaper than explaining in prose what the reader
// can see — a greyed-out Add says "tick something" on its own.

interface Draft { noop: Signal<boolean> }

/** Wraps a Preact body in the modal shell, unmounting it when the modal closes. */
function open(title: string, node: ComponentChild, confirmLabel: string, draft: Draft, onConfirm: () => void): void {
  const { el, cleanup } = renderModalBody(node);
  showModal(title, el, [
    { label: t('common.cancel'), onClick: closeModal },
    { label: confirmLabel, primary: true, disabled: draft.noop, onClick: () => { onConfirm(); closeModal(); } },
  ], true, '28rem', cleanup);
}

// ── Shared multi-pick list ───────────────────────────────────────────────────

interface PickItem { id: string; label: string; info: string }

/** Checkbox list used by both the deck picker and the tag remover — the two
 *  differ only in what they list, so the selection plumbing is shared. */
function CheckboxList({ items, draft }: { items: PickItem[]; draft: Draft & { chosen: string[] } }) {
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const toggle = (id: string) => {
    const next = new Set(chosen);
    next.has(id) ? next.delete(id) : next.add(id);
    setChosen(next);
    draft.chosen = [...next];
    draft.noop.value = next.size === 0;
  };
  return (
    <div class="space-y-1">
      {items.map(({ id, label, info }) => (
        <label key={id} class="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-elevated cursor-pointer">
          <input type="checkbox" class="card-checkbox" checked={chosen.has(id)} onChange={() => toggle(id)} />
          <span class="text-sm text-primary flex-1 truncate">{label}</span>
          <span class="text-xs text-dim shrink-0">{info}</span>
        </label>
      ))}
    </div>
  );
}

// ── Decks ────────────────────────────────────────────────────────────────────

/** Add/remove a selection to/from several decks at once. */
export function showDeckPickerModal(
  titleKey: string,
  confirmKey: string,
  eligibleDecks: { id: string; info: string }[],
  onConfirm: (deckIds: string[]) => void,
): void {
  const user  = appState.value;
  const items = eligibleDecks
    .filter(({ id }) => user.decks[id])
    .map(({ id, info }) => ({ id, label: user.decks[id]!.name, info }));
  const draft = { chosen: [] as string[], noop: signal(true) };
  open(t(titleKey), <CheckboxList items={items} draft={draft} />, t(confirmKey), draft, () => {
    onConfirm(draft.chosen);
  });
}

// ── Tags ─────────────────────────────────────────────────────────────────────

function AddTagBody({ cardIds, draft }: { cardIds: string[]; draft: Draft & { tag: string } }) {
  const user = appState.value;
  const [value, setValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (inputRef.current) focusIfDesktop(inputRef.current); }, []);

  const clean = value.trim().replace(/,/g, '');
  // Suggest tags already in use so the selection joins an existing tag rather
  // than silently creating a near-duplicate ("jig" vs "Jig"). The exact match
  // stays in the list, shown as selected, rather than being filtered out —
  // otherwise the pin vanishes under the cursor that just clicked it.
  const known = [...new Set(Object.values(user.cards).flatMap(c => c.tags ?? []))].sort();
  // Typing narrows the list, but once the text *is* one of the tags — which is
  // what picking a pin does — narrowing would collapse the list to that single
  // pin. Show the whole set again then, so the pins behave like the library's
  // tag filters: a stable row you toggle, not one that empties under you.
  const filter = known.includes(clean) ? '' : clean.toLowerCase();
  const suggestions = known.filter(tg => tg.toLowerCase().includes(filter)).slice(0, 12);
  const missing = clean ? cardIds.filter(id => !(user.cards[id]?.tags ?? []).includes(clean)).length : 0;

  const set = (v: string) => { setValue(v); draft.tag = v.trim().replace(/,/g, ''); };

  // Derived at render and republished each pass, rather than recomputed inside
  // every handler — one place to state what "would change nothing" means.
  // No tag typed, or every selected card already carries it.
  useEffect(() => { draft.noop.value = !clean || missing === 0; });

  return (
    <div class="space-y-3">
      {/* The count sits inside the field, right-aligned — it answers "what will
          this actually do?" at the point of typing. Hidden while empty, and the
          input's right padding reserves its room so text never runs under it. */}
      <div class="relative">
        <input
          ref={inputRef}
          type="text"
          class="input w-full pr-24"
          placeholder={t('library.batch.addTag.placeholder')}
          value={value}
          onInput={(e) => set((e.target as HTMLInputElement).value)}
        />
        {clean && (
          <span class="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-dim pointer-events-none">
            {t('library.batch.addTag.toAdd', { n: missing })}
          </span>
        )}
      </div>
      {suggestions.length > 0 && (
        <div class="flex flex-wrap items-center gap-1.5">
          {suggestions.map(tg => (
            <button
              key={tg}
              type="button"
              // Same pin as the library's tag filters, selected state included.
              class={`text-xs px-2 py-0.5 rounded-full border transition-colors cursor-pointer ${
                tg === clean
                  ? 'bg-accent text-white border-accent'
                  : 'border-border text-muted hover:border-accent hover:text-accent'
              }`}
              onClick={() => set(tg === clean ? '' : tg)}
            >{tg}</button>
          ))}
        </div>
      )}
    </div>
  );
}

export function showAddTagModal(cardIds: string[]): void {
  const draft = { tag: '', noop: signal(true) };
  open(t('library.batch.addTag.title'), <AddTagBody cardIds={cardIds} draft={draft} />,
    t('library.batch.addTag.confirm'), draft, () => {
      const tag = draft.tag;
      if (!tag) return;
      mutate(s => {
        for (const id of cardIds) {
          const card = s.cards[id];
          if (!card) continue;
          if (!card.tags) card.tags = [];
          if (!card.tags.includes(tag)) card.tags.push(tag);
        }
      });
    });
}

export function showRemoveTagModal(cardIds: string[]): void {
  const user = appState.value;
  // Only tags actually carried by the selection are offered, each with how many
  // of the selected cards have it — same shape as the deck picker's eligibility.
  const counts = new Map<string, number>();
  for (const id of cardIds)
    for (const tg of user.cards[id]?.tags ?? []) counts.set(tg, (counts.get(tg) ?? 0) + 1);
  const items = [...counts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    // Same "{n} to remove" wording the deck picker uses, so both lists in this
    // menu read identically.
    .map(([tg, n]) => ({ id: tg, label: tg, info: t('library.deckInfo.remove', { n }) }));

  const draft = { chosen: [] as string[], noop: signal(true) };
  open(t('library.batch.removeTag.title'), <CheckboxList items={items} draft={draft} />,
    t('library.batch.removeTag.confirm'), draft, () => {
      const drop = new Set(draft.chosen);
      mutate(s => {
        for (const id of cardIds) {
          const card = s.cards[id];
          if (card?.tags) card.tags = card.tags.filter(tg => !drop.has(tg));
        }
      });
    });
}

// ── Importance ───────────────────────────────────────────────────────────────

function ImportanceBody({ cardIds, draft }: { cardIds: string[]; draft: Draft & { ctx: string; value: string } }) {
  const user = appState.value;
  const [ctx, setCtx]     = useState('');
  const [value, setValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (inputRef.current) focusIfDesktop(inputRef.current); }, []);

  // Only decks holding at least one selected card can carry a contextual value.
  const decks = Object.values(user.decks)
    .filter(d => cardIds.some(id => d.entries.some(e => e.cardId === id)))
    .sort((a, b) => a.name.localeCompare(b.name));
  const inCtx = ctx === ''
    ? cardIds.length
    : cardIds.filter(id => user.decks[ctx]?.entries.some(e => e.cardId === id)).length;

  const raw = value.trim();
  const num = parseFloat(raw);
  useEffect(() => {
    draft.noop.value = ctx === ''
      // Base importance needs a real positive number; 0 would mean "excluded
      // everywhere", which is what a per-deck 0 is for.
      ? isNaN(num) || num <= 0
      : raw === ''
        // Empty clears the per-deck override — which does nothing if none of
        // the selected cards has one in this deck.
        ? !user.decks[ctx]?.entries.some(e => cardIds.includes(e.cardId) && e.importance !== undefined)
        : isNaN(num) || num < 0;
  });

  return (
    <div class="space-y-3">
      <div class="flex items-center gap-2">
        <span class="label shrink-0">{t('library.batch.importance.context')}</span>
        {/* CustomSelect's own wrapper is a bare `relative` div, so the growing
            has to happen here for the trigger's w-full to mean anything. */}
        <div class="flex-1 min-w-0">
          <CustomSelect
            value={ctx}
            options={[
              { value: '', label: t('card.context.default') },
              ...decks.map(d => ({ value: d.id, label: d.name })),
            ]}
            onChange={(v) => { setCtx(v); draft.ctx = v; }}
            triggerClass="flex items-center gap-2 w-full text-sm bg-surface border border-border rounded px-3 py-1.5 text-primary cursor-pointer hover:border-accent"
          />
        </div>
      </div>
      <input
        ref={inputRef}
        type="number"
        min={ctx === '' ? '0.1' : '0'}
        step="0.1"
        class="input w-full font-mono"
        placeholder={ctx === '' ? t('library.batch.importance.placeholder') : t('library.batch.importance.placeholderDeck')}
        value={value}
        onInput={(e) => { const v = (e.target as HTMLInputElement).value; setValue(v); draft.value = v; }}
      />
      <p class="text-xs text-dim">
        {(() => {
          const one = inCtx === 1;
          if (ctx === '') return t(one ? 'library.batch.importance.hintDefault' : 'library.batch.importance.hintDefaultPlural', { count: inCtx });
          if (value.trim() === '') return t(one ? 'library.batch.importance.hintClear' : 'library.batch.importance.hintClearPlural', { count: inCtx });
          return t(one ? 'library.batch.importance.hintDeck' : 'library.batch.importance.hintDeckPlural', { count: inCtx });
        })()}
      </p>
    </div>
  );
}

export function showImportanceModal(cardIds: string[]): void {
  const draft = { ctx: '', value: '', noop: signal(true) };
  open(t('library.batch.importance.title'), <ImportanceBody cardIds={cardIds} draft={draft} />,
    t('library.batch.importance.confirm'), draft, () => {
      const raw = draft.value.trim();
      if (draft.ctx === '') {
        // Base importance must stay > 0 — 0 would mean "excluded everywhere",
        // which is what a per-deck value of 0 is for.
        const val = parseFloat(raw);
        if (isNaN(val) || val <= 0) return;
        mutate(s => {
          for (const id of cardIds) {
            const card = s.cards[id];
            if (card) card.defaultImportance = val;
          }
        });
        return;
      }
      const val = parseFloat(raw);
      if (raw !== '' && (isNaN(val) || val < 0)) return;
      mutate(s => {
        const deck = s.decks[draft.ctx];
        if (!deck) return;
        for (const entry of deck.entries) {
          if (!cardIds.includes(entry.cardId)) continue;
          // Empty clears the override, so the card falls back to its base value.
          if (raw === '') delete entry.importance;
          else entry.importance = val;
        }
      });
    });
}

// ── Refreshing imported cards from their source ──────────────────────────────
// Unlike everything above, this hits the network once per card — so the fields
// are picked in one dialog and written from a single fetch per card, rather
// than one pass per field: refreshing name + score + importance over 50 cards
// is 50 requests to a free public API, not 150.
//
// Two modals in sequence: the picker doubles as the confirmation (it is where
// the card count and the overwrite warning live), then a live progress
// readout. They can't be one dialog because the modal shell's buttons are
// declared up front and can't be swapped mid-flight.

interface RefreshField<T> {
  /** Stable key, used for the checkbox identity. */
  key: string;
  /** i18n key for the checkbox label. */
  labelKey: string;
  /** Writes this one field back onto the card. */
  apply: (card: Card, fetched: T) => void;
}

interface RefreshSpec<T> {
  /** Cards to refresh, already filtered to the right source. */
  cardIds: string[];
  /** i18n key for the dialog title. */
  titleKey: string;
  /** `externalId` prefix the numeric source id follows, e.g. "thesession:". */
  prefix: string;
  /** One network round trip for one card. */
  fetch: (sourceId: number) => Promise<T>;
  /** What can be refreshed. Kept separate from `fetch` so the source stays the
   *  caller's business and this runner works for any of them. */
  fields: RefreshField<T>[];
}

function RefreshPicker<T>({ spec, draft }: { spec: RefreshSpec<T>; draft: Draft & { keys: string[] } }) {
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const n = spec.cardIds.length;
  const toggle = (key: string) => {
    const next = new Set(chosen);
    next.has(key) ? next.delete(key) : next.add(key);
    setChosen(next);
    draft.keys = [...next];
    draft.noop.value = next.size === 0;
  };
  return (
    <div class="space-y-3">
      <div class="space-y-1">
        {spec.fields.map(f => (
          <label key={f.key} class="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-elevated cursor-pointer">
            <input type="checkbox" class="card-checkbox" checked={chosen.has(f.key)} onChange={() => toggle(f.key)} />
            <span class="text-sm text-primary flex-1">{t(f.labelKey)}</span>
          </label>
        ))}
      </div>
      {/* No "tick at least one" line: the greyed-out confirm says it already. */}
      {chosen.size > 0 && (
        <p class="text-xs text-dim">
          {t(n === 1 ? 'library.batch.refresh.confirm' : 'library.batch.refresh.confirmPlural', { count: n })}
        </p>
      )}
    </div>
  );
}

function RefreshProgress<T>({ spec, fields, cancelled }: {
  spec: RefreshSpec<T>;
  fields: RefreshField<T>[];
  cancelled: { now: boolean };
}) {
  const [done, setDone] = useState(0);
  // Names, not just a count: a card that fails on its own has almost always
  // been deleted upstream, and knowing which one lets you go fix it.
  const [skipped, setSkipped] = useState<string[]>([]);
  const [finished, setFinished] = useState(false);
  const total = spec.cardIds.length;

  useEffect(() => {
    void (async () => {
      let ok = 0;
      const ko: string[] = [];
      for (const cardId of spec.cardIds) {
        // Closing the modal unmounts this and flips the flag: stop hammering a
        // public API for a result nobody is waiting for any more.
        if (cancelled.now) return;
        const card = appState.value.cards[cardId];
        const sourceId = parseInt((card?.externalId ?? '').slice(spec.prefix.length), 10);
        const fail = () => { ko.push(card?.name ?? cardId); setSkipped([...ko]); };
        if (isNaN(sourceId)) { fail(); setDone(ok + ko.length); continue; }
        try {
          // One fetch, every ticked field written from it.
          const fetched = await spec.fetch(sourceId);
          await mutate(s => {
            const c = s.cards[cardId];
            if (c) for (const f of fields) f.apply(c, fetched);
          });
          ok++;
        } catch { fail(); }
        setDone(ok + ko.length);
      }
      setFinished(true);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pct = total > 0 ? Math.round((done / total) * 100) : 100;
  const ok = done - skipped.length;
  // Every single one failing is a different story from a few failing: one tune
  // 404s because it was removed upstream, all of them 404 because the network
  // is down. Naming cards in that case would blame them for something that
  // isn't about them, so only the partial case lists them.
  const allFailed = finished && total > 0 && ok === 0;

  return (
    <div class="space-y-3">
      <div class="knowledge-bar"><div class="knowledge-fill bg-accent transition-all" style={{ width: `${pct}%` }} /></div>
      <p class="text-xs text-muted">
        {finished
          ? t(ok === 1 ? 'library.batch.refresh.done' : 'library.batch.refresh.donePlural', { n: ok })
          : t('library.batch.refresh.progress', { loaded: done, total })}
      </p>
      {allFailed && <p class="text-xs text-danger">{t('library.batch.refresh.allFailed')}</p>}
      {finished && !allFailed && skipped.length > 0 && (
        <div class="space-y-1">
          <p class="text-xs text-warn">
            {t(skipped.length === 1 ? 'library.batch.refresh.skipped' : 'library.batch.refresh.skippedPlural', { n: skipped.length })}
          </p>
          <ul class="text-xs text-muted list-disc pl-4 max-h-32 overflow-y-auto">
            {skipped.map(name => <li key={name}>{name}</li>)}
          </ul>
        </div>
      )}
    </div>
  );
}

/** Pick which fields to refresh, then run one fetch per card writing them all. */
export function showRefreshModal<T>(spec: RefreshSpec<T>): void {
  const draft = { keys: [] as string[], noop: signal(true) };
  const picker = renderModalBody(<RefreshPicker spec={spec} draft={draft} />);
  // Deliberately not the `open()` helper above: it closes the modal *after*
  // running onConfirm, which would pop the progress modal this pushes instead
  // of the picker. Closing first keeps the stack in the right order.
  showModal(t(spec.titleKey), picker.el, [
    { label: t('common.cancel'), onClick: closeModal },
    { label: t('library.batch.refresh.action'), primary: true, disabled: draft.noop, onClick: () => {
      const fields = spec.fields.filter(f => draft.keys.includes(f.key));
      if (fields.length === 0) return;
      closeModal();
      const cancelled = { now: false };
      const { el, cleanup } = renderModalBody(<RefreshProgress spec={spec} fields={fields} cancelled={cancelled} />);
      showModal(t(spec.titleKey), el, [
        { label: t('common.close'), primary: true, onClick: closeModal },
      ], true, '28rem', () => { cancelled.now = true; cleanup(); });
    } },
  ], true, '28rem', picker.cleanup);
}
