import { useState, useRef, useEffect } from 'preact/hooks';
import { signal, type Signal } from '@preact/signals';
import type { ComponentChild } from 'preact';
import { appState, mutate } from '../store';
import { showModal, closeModal, renderModalBody } from './modal';
import { CustomSelect } from './customSelect';
import { focusIfDesktop } from '../utils';
import { t } from '../services/i18nService';
import type { AppState, Card } from '../types';

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
  ], { maxWidth: '28rem', onDismiss: cleanup });
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
  /** Writes this one field back onto the card. `state` is the same draft the
   *  card was read from, for the rare field that has to touch more than its
   *  own card — refreshing a set may bring in tunes the library lacks. */
  apply: (card: Card, fetched: T, state: AppState) => void;
  /** How many of the run's cards this field can do anything with, when that is
   *  worth knowing before committing to it — migrating only works on tunes the
   *  source knows an equivalent for, and that answer costs a lookup.
   *
   *  Resolved once when the picker opens. The box cannot be ticked until it
   *  comes back, nor at all if it comes back zero: an action that would touch
   *  nothing should not be offerable. */
  eligible?: (cardIds: string[]) => Promise<number>;
}

interface RefreshSpec<T> {
  /** Cards to refresh, already filtered to the right source. */
  cardIds: string[];
  /** Dialog title, already translated — it names the family being acted on,
   *  count included, which is a parameterised string rather than a bare key. */
  title: string;
  /** One network round trip for one card. Parsing the card's `externalId` is
   *  the fetcher's business: an id it cannot read is a throw like any other
   *  failure, and lands the card in the skipped list by name. */
  fetch: (card: Card) => Promise<T>;
  /** What can be refreshed. Kept separate from `fetch` so the source stays the
   *  caller's business and this runner works for any of them. */
  fields: RefreshField<T>[];
  /** Recognised BEFORE the card is fetched: a card this run must not touch.
   *  Distinct from a failure in both senses — nothing went wrong, and nothing
   *  was written — and distinct from a card that simply has nothing to update:
   *  something about it needs deciding, which is what `onSetAside` is for. */
  setAside?: (card: Card) => Promise<boolean>;
  /** Handed every card `setAside` held back, once, when the run ends. Runs on
   *  top of the still-open report, so closing whatever it opens comes back to
   *  the tally rather than to nothing. The report itself stays silent about
   *  them: whatever this opens names them, and saying it twice in two stacked
   *  dialogs reads as two different problems. */
  onSetAside?: (cards: Card[]) => void;
  /** The line under the tickboxes spelling out what confirming does. Omitted
   *  where the ticked line already says it — an action named the same way as
   *  on the card page does not need a paragraph repeating it. Its plural is
   *  this key plus "Plural", the convention used throughout the i18n files. */
  confirmKey?: string;
  /** How the report names the cards it could not fetch. Defaults to the
   *  TheSession wording (removed upstream); same plural convention. */
  skippedKey?: string;
}

const skippedKey = <T,>(spec: RefreshSpec<T>) => spec.skippedKey ?? 'library.batch.refresh.skipped';

function RefreshPicker<T>({ spec, draft }: { spec: RefreshSpec<T>; draft: Draft & { keys: string[] } }) {
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  // Per-field, and only for fields that declare an `eligible` count: undefined
  // means "not answered yet", which is as good a reason not to tick the box as
  // a zero is.
  const [counts, setCounts] = useState<Record<string, number>>({});

  useEffect(() => {
    let live = true;
    for (const f of spec.fields) {
      if (!f.eligible) continue;
      // A lookup that fails leaves the count unknown, and the box stays
      // untickable — better than claiming a number nothing verified.
      void f.eligible(spec.cardIds).then(n => { if (live) setCounts(c => ({ ...c, [f.key]: n })); }).catch(() => {});
    }
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const countOf = (f: RefreshField<T>) => f.eligible ? counts[f.key] : spec.cardIds.length;
  const toggle = (key: string) => {
    const next = new Set(chosen);
    next.has(key) ? next.delete(key) : next.add(key);
    setChosen(next);
    draft.keys = [...next];
    draft.noop.value = next.size === 0;
  };

  // What the confirm line promises: the smallest of what the ticked actions
  // can actually reach, never the size of the selection when an action is
  // known to concern fewer cards than that.
  const n = spec.fields
    .filter(f => chosen.has(f.key))
    .reduce((min, f) => Math.min(min, countOf(f) ?? 0), spec.cardIds.length);

  return (
    <div class="space-y-3">
      <div class="space-y-1">
        {spec.fields.map(f => {
          const count = countOf(f);
          // An action that can reach nothing is shown, greyed: hiding it would
          // just raise the question of where it went.
          const off = f.eligible !== undefined && !count;
          return (
            <label
              key={f.key}
              class={`flex items-center gap-2 px-2 py-1.5 rounded ${off ? 'opacity-50 cursor-not-allowed' : 'hover:bg-elevated cursor-pointer'}`}
            >
              <input type="checkbox" class="card-checkbox" disabled={off} checked={chosen.has(f.key)} onChange={() => toggle(f.key)} />
              <span class="text-sm text-primary flex-1">{t(f.labelKey)}</span>
              {f.eligible !== undefined && (
                <span class="text-xs text-dim shrink-0">
                  {count === undefined ? '…' : t('library.batch.eligible', { n: count })}
                </span>
              )}
            </label>
          );
        })}
      </div>
      {/* No "tick at least one" line: the greyed-out confirm says it already. */}
      {chosen.size > 0 && spec.confirmKey && (
        <p class="text-xs text-dim">
          {t(n === 1 ? spec.confirmKey : `${spec.confirmKey}Plural`, { count: n })}
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
  // Held back rather than failed. Counted, so the tally of updated cards stays
  // honest, but not listed: `onSetAside` opens on top of this and names them.
  const [asideCount, setAsideCount] = useState(0);
  const [finished, setFinished] = useState(false);
  const total = spec.cardIds.length;

  useEffect(() => {
    void (async () => {
      let ok = 0;
      const ko: string[] = [];
      const held: Card[] = [];
      for (const cardId of spec.cardIds) {
        // Closing the modal unmounts this and flips the flag: stop hammering a
        // public API for a result nobody is waiting for any more.
        if (cancelled.now) return;
        const card = appState.value.cards[cardId];
        const fail = () => { ko.push(card?.name ?? cardId); setSkipped([...ko]); };
        const tally = () => setDone(ok + ko.length + held.length);
        if (!card) { fail(); tally(); continue; }
        try {
          // Asked before the fetch, so a card that must not be touched costs no
          // round trip either.
          if (await spec.setAside?.(card)) { held.push(card); setAsideCount(held.length); tally(); continue; }
          // One fetch, every ticked field written from it. Read from live state
          // each round rather than from a snapshot: a set that pulls in a
          // missing tune must be visible to the next set that also plays it.
          const fetched = await spec.fetch(card);
          await mutate(s => {
            const c = s.cards[cardId];
            if (c) for (const f of fields) f.apply(c, fetched, s);
          });
          ok++;
        } catch { fail(); }
        tally();
      }
      setFinished(true);
      // After the tally is on screen, and only if the reader is still there to
      // answer: whatever this opens sits on top of a report that already says
      // which cards it is about.
      if (held.length > 0 && !cancelled.now) spec.onSetAside?.(held);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pct = total > 0 ? Math.round((done / total) * 100) : 100;
  const ok = done - skipped.length - asideCount;
  // Every single one failing is a different story from a few failing: one tune
  // 404s because it was removed upstream, all of them 404 because the network
  // is down. Naming cards in that case would blame them for something that
  // isn't about them, so only the partial case lists them. A run that updated
  // nothing because everything was deliberately held back is not that story:
  // it needs at least one real failure to be one.
  const allFailed = finished && ok === 0 && skipped.length > 0 && asideCount === 0;

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
            {t(skipped.length === 1 ? skippedKey(spec) : `${skippedKey(spec)}Plural`, { n: skipped.length })}
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
  // No Cancel: the ✕, Escape and a click outside all back out already, and a
  // dialog whose confirm greys itself out until something is ticked is not one
  // you can leave in a half-done state. The confirm stays generic — what will
  // happen is what the ticked lines say, not what one button can name.
  showModal(spec.title, picker.el, [
    { label: t('common.confirm'), primary: true, disabled: draft.noop, onClick: () => {
      const fields = spec.fields.filter(f => draft.keys.includes(f.key));
      if (fields.length === 0) return;
      closeModal();
      const cancelled = { now: false };
      const { el, cleanup } = renderModalBody(<RefreshProgress spec={spec} fields={fields} cancelled={cancelled} />);
      // No footer at all: a progress bar that reaches the end and a tally
      // underneath need no button to agree with, and the ✕, Escape and the
      // backdrop already close it. Which is also the safe half of the shell —
      // those three run onDismiss, and a footer button would not, leaving the
      // loop fetching for a torn-down dialog.
      showModal(spec.title, el, [], { maxWidth: '28rem', onDismiss: () => { cancelled.now = true; cleanup(); } });
    } },
  ], { maxWidth: '28rem', onDismiss: picker.cleanup });
}
