import { useEffect, useRef, useState } from 'preact/hooks';
import type { AppContext } from '../../types';
import { t } from '../../services/i18nService';
import { TrashIcon } from '../../components/icons';
import { downloadIcon } from '../../components/playbackIcons';
import { confirmModal } from '../../components/modal';
import { findByExternalId } from '../../services/theSessionService';
import { fileToEntry } from '../../utils';
import { extractClipMp3 } from '../audio/clipExtract';
import { showDeckPickerPopover, deckLinkIcon } from '../../components/deckSelector';
import { getContext } from '../../store';
import type { IndexProgress } from '../recognition/indexStore';
import type { SessionAnnotation } from '../model';

// ── Shared UI helpers ────────────────────────────────────────────────────────
// Small pieces used by more than one of the session containers
// (LiveSession/ImportAnalysis/SessionSummary). Living here — a plain leaf
// module with no dependency on any of them — is what lets them all import
// from it without a circular dependency between containers.
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

export function defaultSessionName(dateIso: string | null): string {
  return dateIso
    ? t('sessions.defaultName', { date: new Date(dateIso).toLocaleDateString() })
    : t('sessions.defaultNameNoDate');
}

/** ISO timestamp → 'YYYY-MM-DDTHH:mm' local time, what a datetime-local input shows/expects. */
export function toLocalInput(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Colors for SessionAnnotation['bucket'] — shared by AnnotationCard.tsx's
 *  confidence badge and AlternatesPopover.tsx's per-option score (living here
 *  rather than in either of those, since AnnotationCard.tsx imports
 *  AlternatesPopover.tsx — a shared leaf avoids the circular import). */
export const BUCKET_BADGE: Record<SessionAnnotation['bucket'], string> = {
  high: 'bg-green-500/10 text-green-500',
  medium: 'bg-amber-500/10 text-amber-500',
  low: 'bg-elevated text-dim border border-border',
};

/** Same color code as BUCKET_BADGE, text-only (no pill background/border) —
 *  for coloring a plain score readout, e.g. AlternatesPopover.tsx's per-option
 *  percentage, without stacking a second badge-looking element next to it. */
export const BUCKET_TEXT: Record<SessionAnnotation['bucket'], string> = {
  high: 'text-green-500',
  medium: 'text-amber-500',
  low: 'text-dim',
};

export function indexProgressText(p: IndexProgress): string {
  if (p.phase === 'downloading') {
    // No "/ N MB" total — see fetchIndex's doc in indexStore.ts for why the
    // download's Content-Length header can't be trusted as a decompressed
    // total (it isn't one).
    const mb = (p.loadedBytes / 1048576).toFixed(1);
    return t('sessions.downloadingIndex', { mb });
  }
  return t('sessions.processingIndex');
}

export function fmtEta(etaS: number): string {
  if (etaS >= 90) return `${Math.round(etaS / 60)} min`;
  return `${Math.round(etaS)} s`;
}

// Same glyph, small size — exact match of library.tsx's icon-only export trigger.
const SHARE_ICON_TRIGGER = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>';

/** Card.tsx-style header shared by the three "one particular session/recording"
 *  screens (a finished session, a live recording, an import in progress): plain
 *  heading that turns into an input on click, plus a delete button — no back
 *  arrow. `getName`/`getDefaultName` abstract over RecordedSession/LiveSession/
 *  ImportSession, which don't share a base type. */
export function TitleRow({ getName, getDefaultName, onRename, onDelete, onShare, getTargetDeckIds, ensureTargetDeckIds }: {
  getName: () => string;
  getDefaultName: () => string;
  onRename: (name: string) => void;
  onDelete: () => void;
  /** Only the finished-session summary offers sharing — shows a button left
   *  of delete when set. */
  onShare?: () => void;
  /** Target deck(s) new cards from this session's recognised tunes get linked
   *  to. `undefined` = never touched — the icon shows a "(?)" warning until
   *  the picker's been opened at least once (even choosing zero decks counts). */
  getTargetDeckIds: () => Set<string> | undefined;
  ensureTargetDeckIds: () => Set<string>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [, bump] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { if (editing) inputRef.current?.focus(); }, [editing]);

  const startEdit = () => { setDraft(getName() || getDefaultName()); setEditing(true); };
  const commit = () => {
    const val = draft.trim();
    if (val) onRename(val);
    setEditing(false);
  };

  const ids = getTargetDeckIds();
  const deckSuffix = ids === undefined ? ' (?)' : ids.size > 0 ? ` (${ids.size})` : '';

  return (
    <div class="flex items-center gap-2">
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
          class="text-xl font-semibold text-primary cursor-text hover:text-accent transition-colors flex-1 min-w-0 truncate"
          title="Click to rename"
          onClick={startEdit}
        >
          {getName() || getDefaultName()}
        </h1>
      )}

      <button
        class={`inline-flex items-center gap-1 text-xs transition-colors cursor-pointer shrink-0 ${
          ids === undefined ? 'text-warn hover:text-primary' : ids.size > 0 ? 'text-accent' : 'text-dim hover:text-primary'
        }`}
        title={t('newCard.selectDecks')}
        dangerouslySetInnerHTML={{ __html: `${deckLinkIcon}${deckSuffix}` }}
        onClick={() => {
          const liveIds = ensureTargetDeckIds();
          bump(x => x + 1); // reflect the undefined→Set transition even before any checkbox is touched
          showDeckPickerPopover(liveIds, () => bump(x => x + 1));
        }}
      />

      {onShare && (
        <button
          class="btn-ghost px-2 shrink-0 inline-flex items-center justify-center"
          title={t('sessions.share.button')}
          dangerouslySetInnerHTML={{ __html: SHARE_ICON_TRIGGER }}
          onClick={onShare}
        />
      )}

      <button
        class="btn-danger px-2 shrink-0"
        title={t('sessions.deleteTitle')}
        onClick={() => confirmModal(
          t('sessions.delete.title'),
          t('sessions.delete.message', { name: getName() || getDefaultName() }),
          t('common.delete'),
          onDelete,
        )}
      >
        <TrashIcon size={14} />
      </button>
    </div>
  );
}

/** Editable + erasable session-start date row — shared by a finished session
 *  and an import in progress (both can be genuinely dateless: no trustworthy
 *  t=0 for a file). A live recording always has one and shows it read-only
 *  instead — editing it mid-recording isn't offered here. */
export function DateRow({ getDate, setDate, onChange }: {
  getDate: () => string | null;
  setDate: (date: string | null) => void;
  onChange?: () => void;
}) {
  const date = getDate();
  const apply = (next: string | null) => { setDate(next); onChange?.(); };

  return (
    <div class="flex items-center gap-2 mt-2">
      <input
        type="datetime-local"
        class="input text-sm"
        value={date ? toLocalInput(date) : ''}
        max={toLocalInput(new Date().toISOString())}
        onChange={(e) => {
          const el = e.target as HTMLInputElement;
          if (!el.value) { apply(null); return; }
          // 'YYYY-MM-DDTHH:mm' without offset parses as local time — what the picker shows.
          const ms = Date.parse(el.value);
          if (Number.isNaN(ms) || ms > Date.now()) { el.value = date ? toLocalInput(date) : ''; return; }
          apply(new Date(ms).toISOString());
        }}
      />
      {date ? (
        <button class="text-xs text-dim hover:text-danger cursor-pointer shrink-0" onClick={() => apply(null)}>{t('sessions.dateClear')}</button>
      ) : (
        <button class="text-xs text-dim hover:text-accent cursor-pointer shrink-0" onClick={() => apply(new Date().toISOString())}>{t('sessions.dateNow')}</button>
      )}
    </div>
  );
}

/** The subset of RecordedSession the clip-extraction helpers actually need —
 *  lets a still-in-progress LiveSession/ImportSession (no RecordedSession row
 *  saved yet) build a lightweight literal instead. */
export interface ClipSessionRef {
  id: string;
  name: string;
  date: string | null;
  duration: number;
}

/** Stable identity of a clip, embedded in the filename: survives session
 *  renames and annotation relabels (session id fragment + start second). */
export function clipTag(session: ClipSessionRef, ann: SessionAnnotation): string {
  return `[${session.id.slice(0, 8)}·${Math.round(ann.start)}]`;
}

export function clipFileName(session: ClipSessionRef, ann: SessionAnnotation): string {
  const sessionName = session.name || defaultSessionName(session.date);
  const range = `${fmtTime(ann.start)}–${fmtTime(ann.end ?? session.duration)}`.replace(/:/g, 'm');
  return `${ann.displayName} — ${sessionName} (${range}) ${clipTag(session, ann)}.mp3`;
}

/** True when this exact clip is already attached, whatever it was renamed to look like. */
export function isClipAttached(session: ClipSessionRef, ann: SessionAnnotation): boolean {
  const card = findByExternalId(`thesession:${ann.tuneId}`, getContext().user.cards);
  if (!card) return false;
  const tag = clipTag(session, ann);
  return card.content.attachments.some(a => a.type === 'file' && a.name.includes(tag));
}

/** Extracts the annotation's audio slice as a standalone MP3 file and attaches
 *  it to the card — independent from the session file. `audio` is already
 *  resolved by the caller (loadSessionAudio for a saved session, or a
 *  lazily-assembled Blob for a still-in-progress live/import one — see
 *  ClipControls below). */
export async function attachClip(
  ctx: AppContext,
  session: ClipSessionRef,
  ann: SessionAnnotation,
  audio: Blob,
  onProgress?: (ratio: number) => void,
): Promise<boolean> {
  // getContext(): ctx.user is a snapshot from modal-open time — cards added
  // since (e.g. via "Add to Cadence" on a result) would be missed.
  if (!findByExternalId(`thesession:${ann.tuneId}`, getContext().user.cards)) return false;
  if (isClipAttached(session, ann)) return true;

  const mp3 = await extractClipMp3(audio, ann.start, ann.end ?? session.duration, onProgress);
  const entry = await fileToEntry(new File([mp3], clipFileName(session, ann), { type: 'audio/mpeg' }));
  await ctx.mutate(s => {
    const card = findByExternalId(`thesession:${ann.tuneId}`, s.cards);
    if (card) card.content.attachments.push({ type: 'file', ...entry });
  });
  return true;
}

function BoundStepper({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  return (
    <span class="flex items-center gap-1 text-[11px] text-dim">
      <button class="px-1 rounded hover:bg-elevated cursor-pointer" onClick={() => onChange(value - 5)}>−5s</button>
      <span class="font-mono tabular-nums">{label} {fmtTime(value)}</span>
      <button class="px-1 rounded hover:bg-elevated cursor-pointer" onClick={() => onChange(value + 5)}>+5s</button>
    </span>
  );
}

/** ±5s start/end bound adjustment, shared by the summary, live, and
 *  import-in-progress feeds. Mutates `ann` in place — for a live/import
 *  session that's enough on its own: `ann` is the SAME object
 *  getAnnotations() already returns, so the edit is naturally included
 *  whenever that session is next saved, no separate persist step required
 *  (`persist`, when given, is for the summary's "write it out right now" case
 *  only). `previewBound` plays a 3s preview at the new bound when given —
 *  omitted for a live recording, which has no seekable file to preview from
 *  (raw mic capture, not played-back audio); the value still updates, just
 *  silently. */
export function BoundControls({ ann, getDuration, persist, refresh, previewBound }: {
  ann: SessionAnnotation;
  getDuration: () => number;
  persist?: () => void;
  refresh?: () => void;
  previewBound?: (t: number) => void;
}) {
  const apply = (field: 'start' | 'end', v: number) => {
    const clamped = Math.max(0, Math.min(getDuration(), v));
    if (field === 'start') ann.start = clamped; else ann.end = clamped;
    persist?.();
    refresh?.();
    previewBound?.(clamped);
  };

  return (
    <>
      <BoundStepper label="▸" value={ann.start} onChange={(v) => apply('start', v)} />
      <BoundStepper label="◂" value={ann.end ?? getDuration()} onChange={(v) => apply('end', v)} />
    </>
  );
}

/** Download-clip + attach-to-card controls, shared by the summary, live, and
 *  import-in-progress feeds — a finalized annotation can show up before a
 *  session is fully done (see ViterbiResult.convergedThroughIndex), so this
 *  isn't summary-only. `getAudio` is a lazy Blob provider so a live recording
 *  only pays to assemble its (still-growing) chunk dump when the user
 *  actually clicks, not on every render. `audioAvailable` mirrors the
 *  summary's existing "hidden once the session's audio has been forgotten"
 *  rule — always true for live/import, where there's no such action yet. */
export function ClipControls({ ann, session, audioAvailable, getAudio, ctx, onAttached }: {
  ann: SessionAnnotation;
  session: ClipSessionRef;
  audioAvailable: boolean;
  getAudio: () => Promise<Blob | undefined>;
  ctx: AppContext;
  onAttached?: () => void;
}) {
  const [downloading, setDownloading] = useState(false);
  const [downloadTitle, setDownloadTitle] = useState(t('sessions.downloadClip'));
  const [attaching, setAttaching] = useState(false);
  const [attachText, setAttachText] = useState<string | null>(null);

  const known = findByExternalId(`thesession:${ann.tuneId}`, getContext().user.cards);
  const already = known ? isClipAttached(session, ann) : false;

  const doDownload = async () => {
    setDownloading(true);
    try {
      const audio = await getAudio();
      if (!audio) throw new Error(t('sessions.clip.unavailable'));
      const mp3 = await extractClipMp3(audio, ann.start, ann.end ?? session.duration, ratio => {
        setDownloadTitle(t('sessions.extracting', { pct: Math.round(ratio * 100) }));
      });
      const url = URL.createObjectURL(mp3);
      const a = document.createElement('a');
      a.href = url;
      a.download = clipFileName(session, ann);
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setDownloadTitle(`⚠ ${String(err)}`);
    } finally {
      setDownloading(false);
      setDownloadTitle(t('sessions.downloadClip'));
    }
  };

  const doAttach = async () => {
    setAttaching(true);
    try {
      const audio = await getAudio();
      if (!audio) throw new Error(t('sessions.clip.unavailable'));
      await attachClip(ctx, session, ann, audio, ratio => {
        setAttachText(t('sessions.extracting', { pct: Math.round(ratio * 100) }));
      });
      onAttached?.();
    } catch (err) {
      setAttachText(`⚠ ${String(err)}`);
    }
  };

  return (
    <>
      {audioAvailable && (
        <button
          class="text-dim hover:text-accent transition-colors cursor-pointer shrink-0 flex items-center disabled:opacity-50"
          title={downloadTitle}
          disabled={downloading}
          dangerouslySetInnerHTML={{ __html: downloadIcon(13) }}
          onClick={() => { void doDownload(); }}
        />
      )}

      {/* Add clip as a standalone MP3 attachment (known card only) — hidden
         once the session's audio has been forgotten, unless a clip was
         already extracted before that (nothing left to extract, but still
         worth showing as done). */}
      {known && (already || audioAvailable) && (
        <button
          class={already ? 'text-[11px] text-green-500 cursor-default' : `text-[11px] text-accent ${attaching ? '' : 'hover:underline cursor-pointer'}`}
          disabled={!already && attaching}
          onClick={already ? undefined : () => { void doAttach(); }}
        >
          {already ? t('sessions.attached') : attachText ?? t('sessions.attach')}
        </button>
      )}
    </>
  );
}
