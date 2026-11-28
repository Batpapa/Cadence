import { useEffect, useRef, useState } from 'preact/hooks';
import { t } from '../../services/i18nService';
import { TrashIcon, NotesIcon, MoreHorizontalIcon } from '../../components/icons';
import { IconButton } from '../../components/ui';
import { confirmModal } from '../../components/modal';
import { useContextMenu, type ContextMenuEntry } from '../../components/contextMenu';
import type { IndexProgress } from '../recognition/indexStore';
import type { Detection } from '../model';
import { DateField } from '../../components/dateField';
import { fieldValueToDate } from '../../services/dateFormat';

// ── Shared UI helpers ────────────────────────────────────────────────────────
// Small pieces used by more than one of the session containers
// (LiveSession/ImportAnalysis/SessionSummary). Living here — a plain leaf
// module with no dependency on any of them — is what lets them all import
// from it without a circular dependency between containers. What grew here
// beyond the small pieces has a file of its own since 2026-11-26: a tune's
// name (tuneNames.ts), clips (clips.tsx), ratings following their detection
// (reviewRetarget.ts), the card button (TuneDeckButton.tsx).
//
// TitleRow/DateRow/BoundControls/ClipControls (2026-08-26) replace what used
// to be imperative "install into this container" DOM-builders
// (titleAndDeleteRow/editableDateRow/appendBoundControls/appendClipControls)
// — real JSX now. They deliberately carry NO imperative refresh handle: the
// old versions returned `{ refreshTitle, refreshDeckBtn }` for a caller to
// invoke after some other part of the screen changed something these show.
// As real JSX children of each container, they already re-render for free
// whenever the container itself re-renders (every caller already bumps a
// tick/state counter after exactly the mutations that used to trigger an
// explicit refreshTitle()/refreshDeckBtn() call) — so that whole mechanism
// was dead weight once these became genuine components, not a port to redo.

export function fmtTime(s: number): string {
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(Math.max(0, s) % 60)).padStart(2, '0')}`;
}

export function fmtLongTime(s: number): string {
  const h = Math.floor(s / 3600);
  if (h > 0) return `${h}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  return fmtTime(s);
}

/** ISO timestamp → 'YYYY-MM-DDTHH:mm' local time, what a datetime-local input shows/expects. */
export function toLocalInput(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Colors for Detection['bucket'] — shared by DetectionCard.tsx's
 *  confidence badge and AlternatesPopover.tsx's per-option score (living here
 *  rather than in either of those, since DetectionCard.tsx imports
 *  AlternatesPopover.tsx — a shared leaf avoids the circular import). */
export const BUCKET_BADGE: Record<Detection['bucket'], string> = {
  high: 'bg-success/10 text-success',
  medium: 'bg-warn/10 text-warn',
  low: 'bg-elevated text-dim border border-border',
};

/** Same color code as BUCKET_BADGE, text-only (no pill background/border) —
 *  for coloring a plain score readout, e.g. AlternatesPopover.tsx's per-option
 *  percentage, without stacking a second badge-looking element next to it. */
export const BUCKET_TEXT: Record<Detection['bucket'], string> = {
  high: 'text-success',
  medium: 'text-warn',
  low: 'text-dim',
};

/** One line per step under way (recognitionClient.ts), for a
 *  `whitespace-pre-line` status. */
export function indexProgressText(steps: IndexProgress[]): string {
  return steps.map(indexStepText).join('\n');
}

/** A step of one index, "Index <name> : <step>" (the user, 2026-11-16), by
 *  its short name — the long one is the setting's (sessionModule.tsx). */
function indexStepText(p: IndexProgress): string {
  if (p.phase === 'engine') return t('sessions.initializing');
  if (p.phase === 'merging') return t('sessions.indexesIntoEngine');
  const of = (id: 'cards' | 'thesession', step: string) =>
    t('sessions.indexStep', { name: t(id === 'cards' ? 'sessions.indexes.cardsShort' : 'sessions.indexes.thesession'), step });
  if (p.phase === 'cards') return of('cards', t('sessions.indexStep.reading', { done: p.done, total: p.total }));
  if (p.phase === 'contours') return of('cards', t('sessions.indexStep.indexing', { done: p.done, total: p.total }));
  if (p.phase === 'downloading') {
    // No "/ N MB" total — see fetchIndex's doc in indexStore.ts for why the
    // download's Content-Length header can't be trusted as a decompressed
    // total (it isn't one).
    const mb = (p.loadedBytes / 1048576).toFixed(1);
    return of('thesession', t('sessions.indexStep.downloading', { mb }));
  }
  if (p.phase === 'loading') return of('thesession', t('sessions.indexStep.loading'));
  return of('thesession', t('sessions.indexStep.processing'));
}

export function fmtEta(etaS: number): string {
  if (etaS >= 90) return `${Math.round(etaS / 60)} min`;
  return `${Math.round(etaS)} s`;
}

/** Card.tsx-style header shared by the three "one particular session/recording"
 *  screens (a finished session, a live recording, an import in progress): plain
 *  heading that turns into an input on click, plus a delete button — no back
 *  arrow. `getName`/`getDefaultName` abstract over Analysis/LiveSession/
 *  ImportSession, which don't share a base type. */
export function TitleRow({ getName, getDefaultName, onRename, onDelete, menu, onNotes, hasNotes, deleteTexts }: {
  getName: () => string;
  getDefaultName: () => string;
  onRename: (name: string) => void;
  onDelete: () => void;
  /** Only the finished-session summary has one — its export and what can be
   *  done with its recording (2026-11-05), behind a ⋯ left of delete. */
  menu?: ContextMenuEntry[];
  /** The analysis's notes — a button left of share, same reason: only a saved
   *  analysis has somewhere to keep them. */
  onNotes?: () => void;
  /** Lights the notes button, so a note is known to be there without opening it. */
  hasNotes?: boolean;
  /** The bin's tooltip and its question, when what it deletes is not an
   *  analysis: a transcription (transcription/ui/screen.tsx, 2026-11-28). */
  deleteTexts?: { label: string; title: string; message: string; confirm?: string };
}) {
  // The deck-target button that used to sit here is gone (2026-09-06). It set a
  // destination once for the whole page, which every later add then applied in
  // silence; the deck choice now happens at each add, in its own modal, where
  // the user is actually looking. See components/deckSelector.tsx.
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  // The library's ⋯ is this same hook on a left click: same anchoring,
  // dismissal and zoom handling.
  const openMenu = useContextMenu(menu ?? []);

  useEffect(() => { if (editing) inputRef.current?.focus(); }, [editing]);

  const startEdit = () => { setDraft(getName() || getDefaultName()); setEditing(true); };
  const commit = () => {
    const val = draft.trim();
    if (val) onRename(val);
    setEditing(false);
  };

  return (
    // The buttons top right, always, the name whole beside them on as many
    // lines as it needs (N3e, 2026-11-23) — the deck's header rule
    // (2026-11-11, the user). It used to be cut short.
    <div class="flex items-start gap-2">
      {editing ? (
        <input
          ref={inputRef}
          type="text"
          class="text-xl font-semibold bg-transparent border-b border-accent outline-none text-primary flex-1 min-w-0"
          value={draft}
          onInput={(e) => setDraft((e.target as HTMLInputElement).value)}
          onBlur={commit}
          onKeyDown={(e) => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') setEditing(false); }}
        />
      ) : (
        <h1
          class="text-xl font-semibold text-primary cursor-text hover:text-accent transition-colors flex-1 name-wrap"
          title={t('common.clickToRename')}
          onClick={startEdit}
        >
          {getName() || getDefaultName()}
        </h1>
      )}

      <div class="flex items-center gap-2 ml-auto shrink-0">
      {onNotes && (
        <IconButton
          label={t(hasNotes ? 'sessions.notes.open' : 'sessions.notes.add')}
          on={hasNotes}
          onClick={onNotes}
        >
          <NotesIcon size={14} />
        </IconButton>
      )}

      {menu && (
        <IconButton
          label={t('sessions.menu.title')}
          // Only the summary has this menu; the tour's step on what can be
          // done with the recording points here.
          data-tour="summary-audio"
          onClick={(e) => openMenu.open(e.clientX, e.clientY)}
        >
          {/* The library's own ⋯: an object's menu. */}
          <MoreHorizontalIcon size={14} />
        </IconButton>
      )}
      {openMenu.menu}

      {/* The one delete of an analysis — costly to redo, so red and confirmed.
         The ⋯ beside it only offers what can be done with its recording. */}
      <IconButton
        label={deleteTexts?.label ?? t('sessions.deleteTitle')}
        variant="danger"
        onClick={() => confirmModal(
          deleteTexts?.title ?? t('sessions.delete.title'),
          deleteTexts?.message ?? t('sessions.delete.message', { name: getName() || getDefaultName() }),
          deleteTexts?.confirm ?? t('common.delete'),
          onDelete,
        )}
      >
        <TrashIcon size={14} />
      </IconButton>
      </div>
    </div>
  );
}

/** Editable + erasable session-start date row — shared by a finished session
 *  and an import in progress (both can be genuinely dateless, and an import's
 *  date is only ever a guess from its file: no trustworthy t=0 for a file —
 *  which is what this row is for). A live recording always has one and shows it read-only
 *  instead — editing it mid-recording isn't offered here.
 *
 *  The field alone since 2026-11-05 (the user's call): the "clear" / "now"
 *  link beside it repeated the calendar's own buttons. Emptied — typed away,
 *  or the calendar's Clear — the date is removed. */
export function DateRow({ getDate, setDate, onChange }: {
  getDate: () => string | null;
  setDate: (date: string | null) => void;
  onChange?: () => void;
}) {
  const date = getDate();
  const apply = (next: string | null) => { setDate(next); onChange?.(); };

  return (
    <div class="flex items-center gap-2 mt-2">
      <DateField
        withTime
        class="input text-sm"
        value={date ? toLocalInput(date) : ''}
        max={toLocalInput(new Date().toISOString())}
        onChange={(v) => {
          if (!v) { apply(null); return true; }
          // A local time, read as such — never Date.parse on the bare string.
          const at = fieldValueToDate(v);
          if (!at || at.getTime() > Date.now()) return false;
          apply(at.toISOString());
          return true;
        }}
      />
    </div>
  );
}
