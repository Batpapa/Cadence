import { useState, useEffect, useRef } from 'preact/hooks';
import { signal, type Signal } from '@preact/signals';
import { appState, mutate } from '../store';
import { showModal, closeModal, renderModalBody } from './modal';
import { focusIfDesktop } from '../utils';
import { t } from '../services/i18nService';

/** Every tag the library has ever been given, sorted — the suggestion pool
 *  behind each of these fields. */
function knownTags(): string[] {
  return [...new Set(Object.values(appState.value.cards).flatMap(c => c.tags ?? []))].sort();
}

/** The tag field: a text input over a row of pins.
 *
 *  The pins are the whole point. They are what stops a near-duplicate ("jig"
 *  beside "Jig") from being created by someone who simply could not see that
 *  the tag already existed — so anywhere a tag can be typed, this is what does
 *  the typing. The single-card path was the one that lacked them until
 *  2026-09-13, which is exactly backwards: it is the one people use.
 *
 *  `exclude` drops what would be illegal to pick here (the tags a card already
 *  carries), so every pin on screen is a choice that works, rather than one
 *  that is refused after the click. */
export function TagPicker({ value, onChange, exclude, readout, note, onSubmit }: {
  value: string;
  onChange: (v: string) => void;
  exclude?: readonly string[];
  /** Right-aligned inside the field: what confirming would do. */
  readout?: string | null;
  /** Under the field: why confirming would currently do nothing. */
  note?: string | null;
  /** Enter in the field does this. The modal shell handles no key but Escape,
   *  so a dialog where the field IS the interaction has to say so itself —
   *  without it, "type a tag, press Enter" silently does nothing. Left unset
   *  where confirming deserves a deliberate click. */
  onSubmit?: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (inputRef.current) focusIfDesktop(inputRef.current); }, []);

  const clean = value.trim().replace(/,/g, '');
  const known = exclude ? knownTags().filter(tg => !exclude.includes(tg)) : knownTags();
  // A plain substring match, always applied.
  //
  // It used to be dropped the moment the text WAS one of the tags, so that
  // clicking a pin left the rest of the list browsable instead of collapsing it
  // to the one pin just picked. That backfired as soon as the same field could
  // be TYPED into (2026-09-13, reported from a real library): typing "jig" where
  // "jig" already exists on another card cleared the filter, the twelve slots
  // went to "Amajor", "Aminor", "Bdorian"… and "jig" itself, further down the
  // alphabet, fell outside the slice — the one pin that mattered was the only
  // one not on screen. An exact match always passes its own substring filter, so
  // leaving the filter ON is precisely what keeps it visible and selected.
  //
  // The price is the case that rule was written for: after clicking a pin the
  // list narrows to it, and clearing the field is what brings the others back.
  // Cheap, next to twelve tags picked alphabetically out of a vocabulary of
  // dozens, which was never browsing to begin with.
  const filter = clean.toLowerCase();
  const suggestions = known.filter(tg => tg.toLowerCase().includes(filter)).slice(0, 12);

  return (
    <div class="space-y-3">
      {/* The readout sits inside the field, right-aligned — it answers "what
          will this actually do?" at the point of typing. The input's right
          padding reserves its room so text never runs under it. */}
      <div class="relative">
        <input
          ref={inputRef}
          type="text"
          class={`input w-full ${readout ? 'pr-24' : ''}`}
          placeholder={t('tags.namePlaceholder')}
          value={value}
          onInput={(e) => onChange((e.target as HTMLInputElement).value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && onSubmit) { e.preventDefault(); onSubmit(); } }}
        />
        {readout && (
          <span class="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-dim pointer-events-none">
            {readout}
          </span>
        )}
      </div>
      {note && <p class="text-xs text-warn leading-relaxed">{note}</p>}
      {suggestions.length > 0 && (
        <div class="flex flex-wrap items-center gap-1.5">
          {suggestions.map(tg => (
            <button
              key={tg}
              type="button"
              // Same pin as the library's tag filters, selected state included.
              // `hoverable:` and not `hover:`: the pin has a real selected
              // state, so a hover stuck on the last thing tapped would be a
              // second pin claiming to be the chosen one.
              class={`text-xs px-2 py-0.5 rounded-full border transition-colors cursor-pointer ${
                tg === clean
                  ? 'bg-accent text-white border-accent'
                  : 'border-border text-muted hoverable:border-accent hoverable:text-accent'
              }`}
              onClick={() => onChange(tg === clean ? '' : tg)}
            >{tg}</button>
          ))}
        </div>
      )}
    </div>
  );
}

function CardTagBody({ cardId, renaming, draft, noop, onSubmit }: {
  cardId: string;
  renaming: string | null;
  draft: { tag: string };
  noop: Signal<boolean>;
  onSubmit: () => void;
}) {
  const tags = appState.value.cards[cardId]?.tags ?? [];
  const [value, setValue] = useState(renaming ?? '');
  const clean = value.trim().replace(/,/g, '');

  // Already on this card — and not the tag being renamed, which is merely
  // unchanged rather than a collision.
  const taken = clean !== '' && clean !== renaming && tags.includes(clean);
  const idle  = !clean || taken || clean === renaming;

  /** What a commit would write, or '' for "nothing to do".
   *
   *  Set straight from the input event rather than from an effect, because
   *  Enter can land in the same tick as the keystroke that made the name valid
   *  — a paste, or a fast typist — and no effect has run by then. Reading the
   *  draft an effect had yet to publish, the commit saw an empty string and
   *  silently did nothing. */
  const set = (v: string) => {
    setValue(v);
    const c = v.trim().replace(/,/g, '');
    draft.tag = (!c || c === renaming || tags.includes(c)) ? '' : c;
  };

  // Only the greyed-out button has to wait for a render, so it is all this
  // publishes — one place to state what "would change nothing" means.
  useEffect(() => { noop.value = idle; });

  return (
    <TagPicker
      value={value}
      onChange={set}
      // Every pin is a legal pick, so the card's own tags are not offered —
      // the one being renamed included, since choosing it means "no change".
      exclude={tags}
      note={taken ? t('card.tags.alreadyOnCard', { tag: clean }) : null}
      onSubmit={onSubmit}
    />
  );
}

/** Add a tag to one card, or rename one of that card's tags.
 *
 *  Renaming is CARD-LOCAL by design (user's call, 2026-09-13): the tag is left
 *  untouched on every other card that carries it. "Remove, then add" reaches
 *  the same set of tags, but it APPENDS — and a card's tags are shown in the
 *  order they are stored, so renaming in place is the only way to keep one
 *  where it sits.
 *
 *  Both refuse a name the card already carries: adding a duplicate is a no-op
 *  that reads as a failure, and renaming onto an existing tag would silently
 *  collapse two of the card's own tags into one. The refusal is stated under
 *  the field — a greyed-out button that will not say why is a dead end.
 *
 *  `onDone` carries the tag that ended up on the card, so a caller holding a
 *  selection can follow a rename instead of pointing at a name that is gone. */
export function showCardTagModal(
  cardId: string,
  renaming: string | null,
  onDone?: (tag: string) => void,
): void {
  const noop  = signal(true);
  const draft = { tag: '' };

  // The one commit path, reached by the button and by Enter alike. An empty
  // draft is the body saying "this would change nothing", so Enter on a name
  // the card already carries does exactly what the greyed-out button does.
  const commit = () => {
    const tag = draft.tag;
    if (!tag) return;
    closeModal();
    void mutate(s => {
      const c = s.cards[cardId];
      if (!c) return;
      if (!c.tags) c.tags = [];
      if (renaming === null) {
        if (!c.tags.includes(tag)) c.tags.push(tag);
      } else {
        // Mapped in place: the index IS the position on screen.
        c.tags = c.tags.map(tg => tg === renaming ? tag : tg);
      }
    }).then(() => onDone?.(tag));
  };

  const { el, cleanup } = renderModalBody(
    <CardTagBody cardId={cardId} renaming={renaming} draft={draft} noop={noop} onSubmit={commit} />,
  );
  // No Cancel button: the ✕, Escape and a click outside all back out already,
  // and a confirm that greys itself out until something would happen cannot be
  // left half-done. Same reasoning as the batch dialogs.
  showModal(
    renaming === null ? t('card.tags.add') : t('card.tags.rename'),
    el,
    [{
      label: renaming === null ? t('common.add') : t('common.save'),
      primary: true,
      disabled: noop,
      onClick: commit,
    }],
    { maxWidth: '28rem', onDismiss: cleanup },
  );
}
