import { useState, useEffect, useRef, useLayoutEffect, useMemo } from 'preact/hooks';
import { appState, navigate, mutate } from '../store';
import { pct, focusIfDesktop, externalSourceLink } from '../utils';
import { TrashIcon, ExternalLinkIcon, iconElement, TuneIcon, TuneSetIcon, PencilIcon, EyeIcon, PlusIcon, GearIcon } from '../components/icons';
import { confirmModal, showModal, closeModal } from '../components/modal';
import { renderNotes } from '../components/fileViewer';
import { AttachmentList, CardRefList, showCardPicker, cardToRef } from '../components/attachmentList';
import { decksContainingCard, deckPath } from '../services/deckService';
import { findBacklinks, findSetsContaining } from '../services/cardRefService';
import { CARD_TYPES, CARD_TYPE_TUNE, CARD_TYPE_TUNESET, cardTypeLabelKey, isTuneset, canBeTuneOf, isTypeLocked, applyCardType } from '../services/cardTypeService';
import { tunesetAutoName } from '../services/stateNormalise';
import { cardAvailability, retentionWindowDays, replayFSRS } from '../services/knowledgeService';
import { fetchTuneById, applyTheSessionName, applyTheSessionAbc, applyTheSessionImportance, applyTheSessionMigration, fetchSet, buildSetCards, parseSetExternalId, findByExternalId, type TuneResult } from '../services/theSessionService';
import { showDuplicateCardsModal } from '../components/duplicateCardModal';
import { removeCards } from '../services/cardService';
import { lookupItiMapping } from '../services/itiMappingService';
import type { ItiMappingEntry } from '../services/itiMappingDb';
import { useContextMenu, type ContextMenuItem } from '../components/contextMenu';
import { t } from '../services/i18nService';
import { CustomSelect } from '../components/customSelect';
import { showDeckPickerPopover } from '../components/deckSelector';
import type { Card, SessionRating } from '../types';

// ── Local bridges ─────────────────────────────────────────────────────────────

function VanillaEl({ el }: { el: HTMLElement }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => { ref.current!.replaceChildren(el); });
  return <div ref={ref} />;
}


// ── Helpers ───────────────────────────────────────────────────────────────────

function CardMetric({ label, value, colorClass = 'text-primary' }: {
  label: string;
  value: string;
  colorClass?: string;
}) {
  return (
    <div class="flex items-baseline gap-2">
      <span class="text-[10px] font-medium uppercase tracking-wider text-dim">{label}</span>
      <span class={`text-sm font-mono font-semibold ${colorClass}`}>{value}</span>
    </div>
  );
}

function formatDays(d: number): string {
  if (d >= 365) return t('common.durationYears',  { n: (d / 365).toFixed(1) });
  if (d >= 30)  return t('common.durationMonths', { n: Math.round(d / 30) });
  if (d >= 1)   return t('common.durationDays',   { n: Math.round(d) });
  return t('common.durationLessThanDay');
}

const RATING_COLORS: Record<string, string> = { again: 'var(--color-danger)', hard: 'var(--color-warn)', good: 'var(--color-accent)', easy: 'var(--color-success)' };
const RATING_LABELS: Record<string, string> = { again: 'Again', hard: 'Hard', good: 'Good', easy: 'Easy' };
const RATING_DEFS: Array<{ rating: SessionRating; key: string; activeClass: string }> = [
  { rating: 'again', key: 'rating.again', activeClass: 'bg-danger/20 text-danger border-danger/40' },
  { rating: 'hard',  key: 'rating.hard',  activeClass: 'bg-warn/20 text-warn border-warn/40' },
  { rating: 'good',  key: 'rating.good',  activeClass: 'bg-accent/20 text-accent border-accent/40' },
  { rating: 'easy',  key: 'rating.easy',  activeClass: 'bg-success/20 text-success border-success/40' },
];
const IDLE_BTN = 'btn border border-border text-muted hover:text-primary hover:bg-elevated text-xs py-1.5';
// Fixed per-source brand colors — intentionally not theme-driven (the app's
// dark/green/light themes swap via [data-theme], not Tailwind's `dark:` variant).
const SOURCE_PIN_COLORS: Record<string, string> = {
  thesession: 'text-green-500 border-green-500/30 hover:border-green-500/60',
  // A set comes from the same site as a tune, so it wears the same colour —
  // the pin names the source, and what kind of card this is is already said
  // by the type row and its icon.
  'thesession-set': 'text-green-500 border-green-500/30 hover:border-green-500/60',
  irishtuneinfo: 'text-blue-500 border-blue-500/30 hover:border-blue-500/60',
};
const pad = (n: number) => String(n).padStart(2, '0');
const toInputVal = (ts: number) => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

function mkSessionForm(defaultTs: number, defaultRating: SessionRating) {
  let selected: SessionRating = defaultRating;
  const body      = document.createElement('div'); body.className = 'space-y-4';
  const dtLbl     = document.createElement('label'); dtLbl.className = 'label'; dtLbl.textContent = t('card.logSession.dateLabel');
  const inp       = document.createElement('input'); inp.type = 'datetime-local'; inp.value = toInputVal(defaultTs); inp.className = 'input';
  const ratingLbl = document.createElement('div'); ratingLbl.className = 'label'; ratingLbl.textContent = t('card.logSession.qualityLabel');
  const ratingRow = document.createElement('div'); ratingRow.className = 'grid grid-cols-4 gap-2';
  for (const def of RATING_DEFS) {
    const btn = document.createElement('button');
    btn.className = def.rating === defaultRating
      ? `btn border text-xs py-1.5 transition-colors ${def.activeClass}`
      : `${IDLE_BTN} transition-colors`;
    btn.textContent = t(def.key);
    btn.onclick = () => {
      selected = def.rating;
      ratingRow.querySelectorAll('button').forEach(b => { (b as HTMLElement).className = `${IDLE_BTN} transition-colors`; });
      btn.className = `btn border text-xs py-1.5 transition-colors ${def.activeClass}`;
    };
    ratingRow.appendChild(btn);
  }
  body.append(dtLbl, inp, ratingLbl, ratingRow);
  return { body, inp, getRating: () => selected };
}

function openSessionModal(
  defaultTs: number,
  defaultRating: SessionRating,
  onSave: (ts: number, rating: SessionRating) => void,
  onDelete?: () => void,
) {
  const { body, inp, getRating } = mkSessionForm(defaultTs, defaultRating);
  showModal(onDelete ? t('card.logSession.editTitle') : t('card.logSession.title'), body, [
    ...(onDelete ? [{ label: '', icon: iconElement(TrashIcon), danger: true, align: 'start' as const, onClick: () => { closeModal(); onDelete(); } }] : []),
    { label: t('common.cancel'), onClick: closeModal },
    { label: t('common.save'), primary: true, onClick: () => {
      const ts = inp.value ? new Date(inp.value).getTime() : defaultTs;
      if (isNaN(ts)) return;
      closeModal(); onSave(ts, getRating());
    }},
  ]);
  focusIfDesktop(inp);
}

function showManageDecksModal(cardId: string) {
  const user = appState.value;
  const selected = new Set(
    Object.values(user.decks).filter(d => d.entries.some(e => e.cardId === cardId)).map(d => d.id),
  );
  // Live-toggle, no separate save step (same as the session/new-card deck pickers):
  // each checkbox click immediately syncs this card's membership for every deck.
  showDeckPickerPopover(selected, () => {
    void mutate(s => {
      for (const deck of Object.values(s.decks)) {
        const linked = deck.entries.some(e => e.cardId === cardId);
        const shouldBeLinked = selected.has(deck.id);
        if (shouldBeLinked && !linked) deck.entries.push({ cardId });
        if (!shouldBeLinked && linked) deck.entries = deck.entries.filter(e => e.cardId !== cardId);
      }
    });
  });
}

function showContextMenuError(message: string): void {
  const p = document.createElement('p');
  p.className = 'text-sm text-muted leading-relaxed';
  p.textContent = message;
  showModal(t('card.contextMenu.errorTitle'), p, [{ label: t('common.close'), primary: true, onClick: closeModal }]);
}

/** Sets or clears a card's type. Leaving 'tuneset' DISCARDS the tune list —
 *  see applyCardType, which owns that rule. */
function setCardType(cardId: string, type: string): void {
  void mutate(s => {
    const c = s.cards[cardId];
    if (c) applyCardType(c, type);
  });
}

/** The glyph for a card type — kept here rather than in cardTypeService so
 *  that service stays free of any dependency on components. Unknown and
 *  absent types get nothing, matching their shared "no type" label. */
function cardTypeIcon(type: string | undefined, size = 12) {
  if (type === CARD_TYPE_TUNE)    return <TuneIcon size={size} />;
  if (type === CARD_TYPE_TUNESET) return <TuneSetIcon size={size} />;
  return null;
}

/** Re-reads a set from TheSession and applies its tune list back onto the
 *  card: tunes added upstream appear, tunes dropped upstream go, and the
 *  order follows. Any tune not yet in the library is created with the very
 *  setting the set plays already starred — buildSetCards owns that rule, and
 *  it is the same routine the import screen runs, so the two cannot drift.
 *
 *  The card's own notes, attachments, decks, review history and id survive:
 *  only the tune list is TheSession's to dictate. */
async function refreshSetTunes(cardId: string, externalId: string | undefined): Promise<void> {
  const parsed = parseSetExternalId(externalId);
  if (!parsed) return;
  try {
    const set = await fetchSet(parsed.memberId, parsed.setId);
    const { setCard, newTunes } = await buildSetCards(set, appState.value.cards);
    await mutate(s => {
      for (const tune of newTunes) s.cards[tune.id] = tune;
      const existing = s.cards[cardId];
      if (!existing) return;
      existing.tunes = setCard.tunes;
    });
  } catch (e) {
    showContextMenuError(t('card.contextMenu.refreshSetError', { message: e instanceof Error ? e.message : String(e) }));
  }
}

/** Why the type selector is locked, told only to whoever actually clicks it.
 *
 *  Names the sets rather than just counting them, and makes each one a way out:
 *  changing this card's type means removing it from those sets first, so the
 *  modal takes you straight to the one you need to edit. */
function showTypeLockedModal(sets: Card[]): void {
  const body = document.createElement('div');
  body.className = 'space-y-3';

  const p = document.createElement('p');
  p.className = 'text-sm text-muted leading-relaxed';
  p.textContent = t(sets.length === 1 ? 'card.type.locked' : 'card.type.lockedPlural', { n: sets.length });
  body.appendChild(p);

  const list = document.createElement('div');
  list.className = 'space-y-1';
  for (const set of sets) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'w-full text-left text-xs font-mono truncate px-2 py-1.5 rounded text-muted hover:text-primary hover:bg-accent/10 transition-colors cursor-pointer';
    row.className += ' flex items-center gap-2';
    row.append(iconElement(TuneSetIcon, 12), document.createTextNode(set.name));
    row.onclick = () => { closeModal(); navigate({ view: 'card', cardId: set.id }); };
    list.appendChild(row);
  }
  body.appendChild(list);

  // No footer action: the ✕, a click outside and Escape all close it already,
  // and there is nothing here to confirm. Same shape as the card-ref picker.
  showModal(t('card.type.lockedTitle'), body, []);
}

/** Re-fetches the tune and applies one field back onto the card. The field
 *  itself is decided by `apply` (see theSessionService), so the card page and
 *  the library's bulk refresh share the same rules. */
async function refreshFromTheSession(
  cardId: string,
  sessionId: number,
  apply: (card: Card, tune: TuneResult) => void,
  errorKey: 'card.contextMenu.refreshError' | 'card.contextMenu.refreshNameError' | 'card.contextMenu.refreshImportanceError',
): Promise<void> {
  try {
    const tune = await fetchTuneById(sessionId);
    await mutate(s => {
      const card = s.cards[cardId]; if (!card) return;
      apply(card, tune);
    });
  } catch (e) {
    showContextMenuError(t(errorKey, { message: e instanceof Error ? e.message : String(e) }));
  }
}

/** Full replace via a fresh TheSession fetch — name, tags, notes and
 *  attachments all come from `fetched`; only `id`/`guid` are kept so decks,
 *  review history and cross-references stay attached to the same card. */
async function migrateCardToTheSession(cardId: string, sessionId: number): Promise<void> {
  try {
    const tune = await fetchTuneById(sessionId);
    await mutate(s => {
      const existing = s.cards[cardId]; if (!existing) return;
      applyTheSessionMigration(existing, tune);
    });
  } catch (e) {
    showContextMenuError(t('card.contextMenu.migrateError', { message: e instanceof Error ? e.message : String(e) }));
  }
}

// ── Main component ────────────────────────────────────────────────────────────

export function CardView({ cardId, contextDeckId }: { cardId: string; contextDeckId?: string }) {
  const user  = appState.value;
  const card  = user.cards[cardId];
  const work  = user.cardWorks[`${user.currentProfileId}:${cardId}`];

  // All hooks before conditional returns
  const [isEditingName,  setIsEditingName]  = useState(false);
  const [editName,       setEditName]       = useState('');
  const [editingTag,     setEditingTag]     = useState<string | null>(null);
  const [tagEditValue,   setTagEditValue]   = useState('');
  const [newTag,         setNewTag]         = useState('');
  const [isEditingImportance, setIsEditingImportance] = useState(false);
  const [importanceDraft,     setImportanceDraft]     = useState('');
  const [importanceCtx,       setImportanceCtx]       = useState(contextDeckId ?? ''); // '' = Défaut
  const importanceRef = useRef<HTMLInputElement>(null);
  const [isEditingNotes, setIsEditingNotes] = useState(false);
  const [notesDraft,     setNotesDraft]     = useState(card?.content.notes ?? '');
  const notesRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (isEditingNotes && notesRef.current) focusIfDesktop(notesRef.current);
  }, [isEditingNotes]);

  useLayoutEffect(() => {
    if (isEditingImportance && importanceRef.current) {
      importanceRef.current.focus();
      importanceRef.current.select();
    }
  }, [isEditingImportance]);

  // `source` computed here (not just below, alongside the other derived
  // values) because the context-menu hook must be called unconditionally,
  // before the `if (!card) return` below — same "all hooks before
  // conditional returns" rule the rest of this component already follows.
  const source = externalSourceLink(card?.externalId);

  const [itiMapping, setItiMapping] = useState<ItiMappingEntry | null | undefined>(undefined);
  useEffect(() => {
    setItiMapping(undefined);
    if (source?.source !== 'irishtuneinfo' || !card?.externalId) return;
    const itiId = parseInt(card.externalId.slice('irishtuneinfo:'.length), 10);
    if (isNaN(itiId)) return;
    let cancelled = false;
    void lookupItiMapping(itiId).then(entry => { if (!cancelled) setItiMapping(entry); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [card?.externalId, source?.source]);

  const menuItems: ContextMenuItem[] = !source ? [] : source.source === 'thesession-set'
    // A set has exactly one thing to refresh, and browsing is already what
    // left-clicking the pin does — so the menu carries that one action alone.
    ? [{ label: t('card.contextMenu.refreshSetTunes'), onClick: () => void refreshSetTunes(cardId, card?.externalId) }]
    : source.source === 'thesession'
    ? [
        { label: t('card.contextMenu.browse'), onClick: () => window.open(source.url, '_blank', 'noopener') },
        { label: t('card.contextMenu.refreshAbc'), onClick: () => {
          const sessionId = parseInt(card?.externalId?.slice('thesession:'.length) ?? '', 10);
          if (!isNaN(sessionId)) void refreshFromTheSession(cardId, sessionId, applyTheSessionAbc, 'card.contextMenu.refreshError');
        } },
        { label: t('card.contextMenu.refreshName'), onClick: () => {
          const sessionId = parseInt(card?.externalId?.slice('thesession:'.length) ?? '', 10);
          if (!isNaN(sessionId)) void refreshFromTheSession(cardId, sessionId, applyTheSessionName, 'card.contextMenu.refreshNameError');
        } },
        { label: t('card.contextMenu.refreshImportance'), onClick: () => {
          const sessionId = parseInt(card?.externalId?.slice('thesession:'.length) ?? '', 10);
          if (!isNaN(sessionId)) void refreshFromTheSession(cardId, sessionId, applyTheSessionImportance, 'card.contextMenu.refreshImportanceError');
        } },
      ]
    : [
        { label: t('card.contextMenu.browse'), onClick: () => window.open(source.url, '_blank', 'noopener') },
        ...(itiMapping ? [{
          label: t('card.contextMenu.migrate'),
          onClick: () => {
            // The TheSession version of this tune is already a card here.
            // Migrating would leave two cards claiming the same externalId, so
            // it does not happen — and the same dialog the library's bulk
            // migration ends on says why, and offers the same way out.
            const twin = findByExternalId(`thesession:${itiMapping.sessionId}`, user.cards);
            if (card && twin && twin.id !== cardId) {
              showDuplicateCardsModal([card], {
                // No `onPick`, so nothing is listed: the only card concerned is
                // the one already on screen. Deleting it would leave this page
                // showing nothing, so it hands over to the twin — the version
                // being kept, and the same tune the reader came here for.
                onDeleted: () => navigate({ view: 'card', cardId: twin.id }),
              });
              return;
            }
            confirmModal(
              t('card.contextMenu.migrateConfirmTitle'),
              t('card.contextMenu.migrateConfirmMessage'),
              t('card.contextMenu.migrate'),
              () => { void migrateCardToTheSession(cardId, itiMapping.sessionId); },
            );
          },
        }] : []),
      ];
  const { menu: pinContextMenu, triggerProps: pinTriggerProps } = useContextMenu(menuItems);

  // These three sit above the `if (!card) return` for the same reason `source`
  // does: they are hooks, and a hook that only runs on some renders desyncs
  // Preact's hook list. None of them needs `card` — they key off cardId and
  // the cards map.
  //
  // One pass over the library's attachments, memoised on the cards object,
  // which store.ts replaces wholesale on every mutate — so this recomputes
  // whenever anything changes (including another card gaining a reference to
  // this one, which is exactly what should refresh the list) and not on
  // renders that change nothing else.
  const backlinks  = useMemo(() => findBacklinks(cardId, user.cards), [user.cards, cardId]);
  // Same derivation, the other list: which SETS play this tune. Disjoint from
  // `backlinks` by construction — a set's tunes and a card's mentions are two
  // different fields — so the two sections can never show the same card twice.
  const inSets     = useMemo(() => findSetsContaining(cardId, user.cards), [user.cards, cardId]);
  const typeLocked = isTypeLocked(inSets.length);
  // What the set would be called automatically, whether or not it currently
  // is — the toggle shows it as a preview when the flag is off.
  const autoName = useMemo(
    () => (card ? tunesetAutoName(card, user.cards) : null),
    [user.cards, card],
  );
  const typeMenu = useContextMenu([
    { label: t('card.type.none'), onClick: () => setCardType(cardId, '') },
    ...CARD_TYPES.map(ct => ({
      label: t(cardTypeLabelKey(ct)),
      icon: cardTypeIcon(ct),
      onClick: () => setCardType(cardId, ct),
    })),
  ]);

  if (!card) return <div class="p-6 space-y-6 view-enter overflow-y-auto h-full">{t('card.notFound')}</div>;

  // ── Derived values ────────────────────────────────────────────────────────────
  const k          = cardAvailability(user, work);
  const fsrsState  = work ? replayFSRS(work.history) : undefined;
  const stabWindow = fsrsState?.stability !== undefined ? retentionWindowDays(fsrsState.stability, user.availabilityThreshold, user.forgettingRate ?? 1) : undefined;
  const ease       = fsrsState?.difficulty !== undefined ? (10 - fsrsState.difficulty) / 9 : undefined;
  const deckIds    = decksContainingCard(cardId, user);
  const sorted     = work ? [...work.history].sort((a, b) => a.ts - b.ts) : [];

  const rColor    = k >= 0.75 ? 'text-success' : k >= 0.4 ? 'text-warn' : k > 0 ? 'text-danger' : 'text-dim';
  const easeColor = ease === undefined ? 'text-dim' : ease >= 0.6 ? 'text-success' : ease >= 0.35 ? 'text-warn' : 'text-danger';

  return (
    <div class="p-6 space-y-6 view-enter overflow-y-auto h-full">

      {/* ── Header ── One wrapping row, not two columns: the deck chips are a
           `basis-full` item, so they break to their own line and run the full
           width — under the pin and the delete button, not beside them. Those
           two never wrap: the title column is `flex-1` (basis 0), so it just
           narrows and the name wraps inside it. */}
      <div class="flex flex-wrap items-start gap-x-4 gap-y-1.5">
        <div class="flex-1 min-w-0">
          {isEditingName ? (
            <input
              type="text"
              value={editName}
              autoFocus
              class="text-xl font-semibold bg-transparent border-b border-accent outline-none text-primary w-full"
              onInput={(e) => setEditName((e.target as HTMLInputElement).value)}
              onBlur={() => {
                const val = editName.trim();
                if (val && val !== card.name) mutate(s => {
                  const c = s.cards[cardId];
                  if (!c) return;
                  c.name = val;
                  // Typing a name is taking it back. Without this the next
                  // normalisation would silently undo what was just typed.
                  delete c.computedName;
                });
                setIsEditingName(false);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter')  (e.target as HTMLInputElement).blur();
                if (e.key === 'Escape') setIsEditingName(false);
              }}
            />
          ) : (
            <h1
              class="text-xl font-semibold text-primary cursor-text hover:text-accent transition-colors"
              title="Click to rename"
              onClick={() => { setEditName(card.name); setIsEditingName(true); }}
            >
              {card.name}
            </h1>
          )}
        </div>

        <div class="flex items-center gap-2 shrink-0">
          {/* Just the id, not the spelled-out source: the pin's colour already
              says which site, and `title` carries the stored externalId
              verbatim on hover. */}
          {source && (
            <a
              href={source.url}
              target="_blank"
              rel="noopener"
              class={`inline-flex items-center gap-1 text-[10px] font-mono px-2 py-0.5 rounded-full bg-elevated border transition-colors shrink-0 ${SOURCE_PIN_COLORS[source.source] ?? 'text-dim border-border'}`}
              title={source.label}
              {...pinTriggerProps}
            >
              {source.id}
              <ExternalLinkIcon size={9} />
            </a>
          )}
          {pinContextMenu}
          <button
            class="btn-danger px-2 shrink-0"
            title={t('card.deleteTitle')}
            onClick={() => confirmModal(
              t('card.delete.title'),
              t('card.delete.message', { name: card.name }),
              t('common.delete'),
              () => {
                void mutate(s => removeCards(s, [cardId]));
                navigate({ view: 'folder', folderId: null });
              },
            )}
          >
            <TrashIcon />
          </button>
        </div>

        {/* Deck chips */}
        <div class="basis-full flex flex-wrap gap-1.5">
          {deckIds.map(dId => {
            const deck = user.decks[dId]; if (!deck) return null;
            return (
              <span
                key={dId}
                class="inline-flex items-center text-xs px-2 py-0.5 rounded-full bg-accent/10 text-accent hover:bg-accent/20 transition-colors cursor-pointer"
                title={deckPath(dId, user)}
                onClick={() => navigate({ view: 'deck', deckId: dId })}
              >
                {deck.name}
              </span>
            );
          })}
          <span
            class="inline-flex items-center gap-1 text-xs text-dim hover:text-primary transition-colors cursor-pointer"
            title={t('card.manageDecks')}
            onClick={() => showManageDecksModal(cardId)}
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
          </span>
        </div>
      </div>

      {/* ── Stats ── */}
      <div class="stats-container border-y border-border">
      <div class="stats-grid py-3 px-4 gap-x-4 gap-y-3 justify-items-center">
        <CardMetric
          label={t('card.section.availability')}
          value={k > 0 ? pct(k) : '—'}
          colorClass={rColor}
        />
        <CardMetric
          label={t('card.section.stability')}
          value={stabWindow !== undefined ? formatDays(stabWindow) : '—'}
        />
        <CardMetric
          label={t('card.section.ease')}
          value={ease !== undefined ? pct(ease) : '—'}
          colorClass={easeColor}
        />
        <div class="flex items-baseline gap-1.5">
          {deckIds.length > 0 ? (
            <CustomSelect
              value={importanceCtx}
              options={[
                { value: '', label: t('card.context.default') },
                ...deckIds.map(dId => ({ value: dId, label: user.decks[dId]?.name ?? dId })),
              ]}
              onChange={setImportanceCtx}
              renderTrigger={(label, open, toggle) => (
                <button
                  type="button"
                  class="text-[10px] font-medium uppercase tracking-wider text-dim cursor-pointer hover:text-muted transition-colors flex items-center gap-0.5 shrink-0 whitespace-nowrap"
                  onClick={toggle}
                >
                  {t('card.section.importance')}&nbsp;({label}
                  <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class={`transition-transform ${open ? 'rotate-180' : ''}`}><polyline points="6 9 12 15 18 9"/></svg>
                  )
                </button>
              )}
            />
          ) : (
            <span class="text-[10px] font-medium uppercase tracking-wider text-dim shrink-0">{t('card.section.importance')}</span>
          )}
          {isEditingImportance ? (
            <input
              ref={importanceRef}
              type="number" min={importanceCtx === '' ? '0.1' : '0'} step="0.1"
              value={importanceDraft}
              class="text-sm font-mono font-semibold bg-transparent border-b border-accent outline-none text-primary w-16 p-0 leading-none"
              onInput={(e) => setImportanceDraft((e.target as HTMLInputElement).value)}
              onBlur={() => {
                const raw = importanceDraft.trim();
                if (importanceCtx === '') {
                  const val = parseFloat(raw);
                  if (!isNaN(val) && val > 0) mutate(s => { s.cards[cardId]!.defaultImportance = val; });
                } else {
                  mutate(s => {
                    const deck = s.decks[importanceCtx];
                    if (!deck) return;
                    const entry = deck.entries.find(e => e.cardId === cardId);
                    if (!entry) return;
                    if (raw === '') {
                      delete entry.importance;
                    } else {
                      const val = parseFloat(raw);
                      if (!isNaN(val) && val >= 0) entry.importance = val;
                    }
                  });
                }
                setIsEditingImportance(false);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter')  (e.target as HTMLInputElement).blur();
                if (e.key === 'Escape') setIsEditingImportance(false);
              }}
            />
          ) : (
            <span
              class={`text-sm font-mono font-semibold cursor-text hover:text-accent transition-colors ${
                importanceCtx !== '' &&
                user.decks[importanceCtx]?.entries.find(e => e.cardId === cardId)?.importance === undefined
                  ? 'text-dim' : 'text-primary'
              }`}
              onClick={() => {
                const ctxEntry = importanceCtx !== ''
                  ? user.decks[importanceCtx]?.entries.find(e => e.cardId === cardId)
                  : undefined;
                setImportanceDraft(
                  importanceCtx === ''
                    ? String(card.defaultImportance)
                    : ctxEntry?.importance !== undefined ? String(ctxEntry.importance) : '',
                );
                setIsEditingImportance(true);
              }}
              title={importanceCtx === '' ? t('card.importance.label') : t('card.importance.labelDeck')}
            >
              ×{importanceCtx === ''
                ? card.defaultImportance
                : (user.decks[importanceCtx]?.entries.find(e => e.cardId === cardId)?.importance
                    ?? card.defaultImportance)}
            </span>
          )}
        </div>
      </div>
      </div>

      {/* ── Type ── */}
      {/* Inline label/value, like the metrics above: a card's type is one short
          word, not a form field. The value is the control — clicking it raises
          the same overflow menu the attachments "+" uses, or, when the card is
          already playing in a set, the modal explaining why it cannot move. */}
      <div class="flex items-center gap-2">
        <span class="section-title shrink-0">{t('card.section.type')}</span>
        <button
          type="button"
          class="inline-flex items-center gap-1.5 text-sm text-primary hover:text-accent transition-colors cursor-pointer"
          title={typeLocked ? t('card.type.lockedTitle') : t('card.type.change')}
          onClick={(e) => typeLocked
            ? showTypeLockedModal(inSets)
            : typeMenu.open(e.clientX, e.clientY)}
        >
          {cardTypeIcon(card.type)}
          <span>{t(cardTypeLabelKey(card.type))}</span>
        </button>
        {typeMenu.menu}
      </div>

      {/* ── Tunes (tunesets only) ── */}
      {/* The set's DEFINITION, deliberately not an attachment: a set can
          reference a card (a recording, a neighbouring set) without that card
          becoming one of its tunes. Order is the content, so rows are numbered
          and drag-reorderable. */}
      {isTuneset(card) && (
        <div class="space-y-2">
          <div class="flex items-center justify-between gap-2">
            <div class="flex items-center gap-2 min-w-0">
              <span class="section-title shrink-0">{t('card.section.tunes')}</span>
              {/* A filled gear means the name looks after itself; a hollow one
                  means it is yours, and its label is then a LIVE PREVIEW of what
                  switching would produce — so the toggle never replaces a name
                  without having shown what replaces it. Beside the tunes rather
                  than beside the title: this is a property OF the list. */}
              {(autoName || card.computedName) && (
                <button
                  type="button"
                  class="inline-flex items-center gap-1.5 text-xs text-dim hover:text-accent transition-colors cursor-pointer min-w-0"
                  title={t(card.computedName ? 'card.autoName.disable' : 'card.autoName.enable')}
                  onClick={() => mutate(s => {
                    const c = s.cards[cardId];
                    if (!c) return;
                    if (c.computedName) delete c.computedName; else c.computedName = true;
                  })}
                >
                  <span class="shrink-0 flex items-center"><GearIcon size={12} filled={!!card.computedName} /></span>
                  <span class="truncate">
                    {card.computedName ? t('card.autoName.on') : t('card.autoName.preview', { name: autoName ?? '' })}
                  </span>
                </button>
              )}
            </div>
            <button
              class="btn-ghost px-2 shrink-0"
              title={t('card.tunes.add')}
              onClick={() => showCardPicker(
                picked => mutate(s => {
                  const c = s.cards[cardId];
                  if (!c) return;
                  if (!c.tunes) c.tunes = [];
                  c.tunes.push(cardToRef(picked));
                }),
                { titleKey: 'card.tunes.add', eligible: (c) => canBeTuneOf(c, card), emptyKey: 'card.tunes.onlyTunes' },
              )}
            ><PlusIcon size={13} /></button>
          </div>
          {(card.tunes ?? []).length === 0 ? (
            <p class="text-xs text-dim">{t('card.tunes.empty')}</p>
          ) : (
            <CardRefList
              refs={card.tunes ?? []}
              editable={true}
              glyph={<TuneIcon size={11} />}
              onSetRepeat={(i, repeat) => mutate(s => {
                const entry = s.cards[cardId]?.tunes?.[i];
                if (!entry) return;
                // Once is the default; storing it would be noise in every export.
                if (repeat > 1) entry.repeat = repeat; else delete entry.repeat;
              })}
              onRemove={(i) => mutate(s => { s.cards[cardId]?.tunes?.splice(i, 1); })}
              onReorder={(from, insertBefore) => mutate(s => {
                const list = s.cards[cardId]?.tunes;
                if (!list) return;
                const [moved] = list.splice(from, 1);
                list.splice(insertBefore > from ? insertBefore - 1 : insertBefore, 0, moved!);
              })}
            />
          )}
        </div>
      )}

      {/* ── Tags ── */}
      <div class="space-y-2">
        <span class="section-title">{t('card.section.tags')}</span>
        <div class="flex flex-wrap items-center gap-1.5">
          {(card.tags ?? []).map(tag => (
            <span key={tag} class="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-elevated border border-border text-muted group">
              {editingTag === tag ? (
                <input
                  type="text"
                  value={tagEditValue}
                  autoFocus
                  class="text-xs bg-transparent border-none outline-none text-primary w-16"
                  onInput={(e) => setTagEditValue((e.target as HTMLInputElement).value)}
                  onBlur={() => {
                    const val = tagEditValue.trim().replace(/,/g, '');
                    if (val && val !== tag && !(card.tags ?? []).includes(val))
                      mutate(s => { const c = s.cards[cardId]; if (c) c.tags = c.tags.map(tg => tg === tag ? val : tg); });
                    setEditingTag(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter')  (e.target as HTMLInputElement).blur();
                    if (e.key === 'Escape') setEditingTag(null);
                  }}
                />
              ) : (
                <span
                  class="cursor-text hover:text-primary transition-colors"
                  title={t('card.renameTag')}
                  onClick={() => { setEditingTag(tag); setTagEditValue(tag); }}
                >
                  {tag}
                </span>
              )}
              <button
                class="hidden group-hover:inline-flex items-center text-dim hover:text-danger cursor-pointer leading-none"
                onClick={() => mutate(s => { const c = s.cards[cardId]; if (c) c.tags = c.tags.filter(tg => tg !== tag); })}
              >
                ✕
              </button>
            </span>
          ))}
          <input
            type="text"
            placeholder="+"
            value={newTag}
            class="text-xs bg-transparent border-none outline-none text-dim placeholder-dim w-6 focus:w-24 transition-all"
            onInput={(e) => setNewTag((e.target as HTMLInputElement).value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ',') {
                e.preventDefault();
                const val = newTag.trim().replace(/,/g, '');
                if (val && !(card.tags ?? []).includes(val))
                  mutate(s => { const c = s.cards[cardId]; if (c) { if (!c.tags) c.tags = []; c.tags.push(val); } });
                setNewTag('');
              }
              if (e.key === 'Escape') setNewTag('');
            }}
          />
        </div>
      </div>

      {/* ── Notes ── */}
      <div class="space-y-2">
        <div class="flex items-center justify-between">
          <span class="section-title">{t('card.section.notes')}</span>
          <button
            class="btn-ghost px-2"
            title={isEditingNotes ? t('card.previewNotes') : t('card.editNotes')}
            onClick={() => {
              if (isEditingNotes) void mutate(s => { s.cards[cardId]!.content.notes = notesDraft; });
              setIsEditingNotes(v => !v);
            }}
          >
            {isEditingNotes ? <EyeIcon size={13} /> : <PencilIcon size={13} />}
          </button>
        </div>
        {isEditingNotes ? (
          <textarea
            ref={notesRef}
            value={notesDraft}
            class="input w-full font-mono text-xs resize-none"
            rows={12}
            onInput={(e) => setNotesDraft((e.target as HTMLTextAreaElement).value)}
            onBlur={(e) => {
              const val = (e.target as HTMLTextAreaElement).value;
              setNotesDraft(val);
              void mutate(s => { s.cards[cardId]!.content.notes = val; });
            }}
          />
        ) : notesDraft.trim() ? (
          <VanillaEl el={renderNotes(notesDraft)} />
        ) : null}
      </div>

      {/* ── Attachments ── */}
      <AttachmentList options={{
        attachments: card.content.attachments,
        card,
        editable: true,
        onAdd:     (a) => mutate(s => { s.cards[cardId]!.content.attachments.push(a); }),
        onRemove:  (i) => mutate(s => { s.cards[cardId]!.content.attachments.splice(i, 1); }),
        onUpdateFile: (i, data) => mutate(s => {
          const att = s.cards[cardId]!.content.attachments[i];
          if (att && att.type === 'file') att.data = data;
        }),
        onSetPreferredIndex: (i, index) => mutate(s => {
          const att = s.cards[cardId]!.content.attachments[i];
          if (att && att.type === 'file') att.preferredIndex = index;
        }),
        onReorder: (from, insertBefore) => mutate(s => {
          const atts = s.cards[cardId]!.content.attachments;
          const [moved] = atts.splice(from, 1);
          atts.splice(insertBefore > from ? insertBefore - 1 : insertBefore, 0, moved!);
        }),
      }} />

      {/* ── Played in these sets (read-only) ── */}
      {/* Above "referenced by" because membership is stronger information than
          mention: this card is part of those sets, the others merely point at
          it. Same derivation, same hidden-when-empty rule. */}
      {inSets.length > 0 && (
        <div class="space-y-2">
          <span class="section-title">{t('card.section.inSets')}</span>
          <div class="space-y-1">
            {inSets.map(set => (
              <div key={set.id} class="flex items-center gap-2">
                <span class="text-dim shrink-0 w-4 flex items-center justify-center"><TuneSetIcon size={12} /></span>
                <span
                  class="text-xs font-mono truncate flex-1 text-muted hover:text-primary cursor-pointer transition-colors"
                  title={t('card.backlinks.open')}
                  onClick={() => navigate({ view: 'card', cardId: set.id })}
                >{set.name}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Referenced by (read-only) ── */}
      {/* Sits right after the attachments so outgoing and incoming references
          read as one block. Derived, never stored — see findBacklinks. Hidden
          entirely when empty: most cards have no backlink and an empty section
          would just be noise. */}
      {backlinks.length > 0 && (
        <div class="space-y-2">
          <span class="section-title">{t('card.section.backlinks')}</span>
          <div class="space-y-1">
            {backlinks.map(src => (
              <div key={src.id} class="flex items-center gap-2">
                <span class="text-[11px] text-dim shrink-0 w-4 text-center font-mono">↙</span>
                <span
                  class="text-xs font-mono truncate flex-1 text-muted hover:text-primary cursor-pointer transition-colors"
                  title={t('card.backlinks.open')}
                  onClick={() => navigate({ view: 'card', cardId: src.id })}
                >{src.name}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Review history ── */}
      <div class="space-y-2">
        <div class="flex items-center justify-between">
          <span class="section-title">{t('card.section.reviewHistory')}</span>
          <button onClick={() =>
            openSessionModal(Date.now(), 'good', (ts, rating) => mutate(s => {
              const key = `${s.currentProfileId}:${cardId}`;
              if (!s.cardWorks[key]) s.cardWorks[key] = { profileId: s.currentProfileId, cardId, history: [] };
              s.cardWorks[key]!.history.push({ ts, rating });
              s.cardWorks[key]!.history.sort((a, b) => a.ts - b.ts);
            }))
          } class="btn-ghost px-2" title={t('card.logSession.add')}>
            <PlusIcon size={13} />
          </button>
        </div>
        {sorted.length > 0 && (
          <div class="flex flex-wrap gap-[3px]">
            {sorted.map((entry, i) => {
              const originalIndex = work!.history.findIndex(e => e.ts === entry.ts && e.rating === entry.rating);
              return (
                <div
                  key={i}
                  style={{ width: '10px', height: '10px', borderRadius: '2px', background: RATING_COLORS[entry.rating] ?? 'var(--color-dim)', opacity: 0.75, cursor: 'pointer', flexShrink: 0 }}
                  title={`${new Date(entry.ts).toLocaleDateString()} — ${RATING_LABELS[entry.rating] ?? entry.rating}`}
                  onClick={() => openSessionModal(entry.ts, entry.rating,
                    (ts, rating) => mutate(s => {
                      const h = s.cardWorks[`${s.currentProfileId}:${cardId}`]?.history;
                      if (h) { h.splice(originalIndex, 1, { ts, rating }); h.sort((a, b) => a.ts - b.ts); }
                    }),
                    () => mutate(s => { s.cardWorks[`${s.currentProfileId}:${cardId}`]?.history.splice(originalIndex, 1); }),
                  )}
                />
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
