import { useEffect, useRef, useState } from 'preact/hooks';
import type { AppContext, Card } from '../../types';
import { t } from '../../services/i18nService';
import { TrashIcon, PlusIcon, AddClipIcon, ClipAttachedIcon } from '../../components/icons';
import { downloadIcon } from '../../components/playbackIcons';
import { confirmModal } from '../../components/modal';
import { findByExternalId, fetchTuneById, tuneResultToCard } from '../../services/theSessionService';
import { showDeckChoiceModal, decksContainingCard, hasAnyDeck, isInEveryDeck, deckLinkIcon } from '../../components/deckSelector';
import { primeCachedTuneNames, cachedTuneName, ensureTuneNameIndex } from '../../services/tuneNameIndexService';
import { fileToEntry, titleCaseTuneName } from '../../utils';
import { extractClipMp3 } from '../audio/clipExtract';
import { getContext } from '../../store';
import type { IndexProgress } from '../recognition/indexStore';
import type { Detection } from '../model';

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


/** ISO timestamp → 'YYYY-MM-DDTHH:mm' local time, what a datetime-local input shows/expects. */
export function toLocalInput(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ── What a recognised tune is called ─────────────────────────────────────────
// A detection carries a TheSession tune id and a name from the recognition
// index — and that index holds its names ENTIRELY in lower case (0 capitals
// across its 46 867 aliases, measured on the real file), because matching
// ignores case. So "mcgoldrick's", where the same tune imported as a card
// reads "McGoldrick's".
//
// The id is the durable thing, so the name is looked UP from it, in the order
// of how much each source is worth (decided with the user, 2026-09-10):
//
//   1. The card, if one exists — it may have been renamed by hand, and then
//      it is the only name the user recognises as theirs.
//   2. TheSession's name index, if this device has it — the authoritative
//      spelling, offline, free.
//   3. Otherwise: start fetching that index, and re-case the recogniser's own
//      name in the meantime. Rules are tolerable here because nothing is
//      stored from them and they are corrected the moment the index lands.

/** Loads the cached name lookup, and fetches the index when this device has
 *  none. Re-renders its component at each step, so a name improves under the
 *  user rather than waiting for the next navigation.
 *
 *  Call it once per screen that shows detection names. */
export function useTuneNames(): void {
  const [, bump] = useState(0);
  useEffect(() => {
    let alive = true;
    void primeCachedTuneNames().then(async (hasIndex) => {
      if (alive) bump(n => n + 1);
      if (hasIndex) return;
      // ~24 MB, once per device, and only for someone who has actually opened
      // a screen full of recognised tunes. Failure is silent on purpose: this
      // improves a label, it is not a feature anybody is waiting on.
      try { await ensureTuneNameIndex(); } catch { return; }
      if (alive) bump(n => n + 1);
    });
    return () => { alive = false; };
  }, []);
}

/** `text` is what to show; `exact` is true when it came from a card or from
 *  TheSession's index — false while it is still the re-cased guess, which is
 *  worth knowing for anything that would otherwise treat it as authoritative. */
export function tuneName(d: { tuneId: string; displayName: string }): { text: string; exact: boolean } {
  const card = findByExternalId(`thesession:${d.tuneId}`, getContext().user.cards);
  if (card) return { text: card.name, exact: true };

  const indexed = cachedTuneName(d.tuneId);
  if (indexed) return { text: indexed, exact: true };

  return { text: titleCaseTuneName(d.displayName), exact: false };
}

/** Colors for Detection['bucket'] — shared by DetectionCard.tsx's
 *  confidence badge and AlternatesPopover.tsx's per-option score (living here
 *  rather than in either of those, since DetectionCard.tsx imports
 *  AlternatesPopover.tsx — a shared leaf avoids the circular import). */
export const BUCKET_BADGE: Record<Detection['bucket'], string> = {
  high: 'bg-green-500/10 text-green-500',
  medium: 'bg-amber-500/10 text-amber-500',
  low: 'bg-elevated text-dim border border-border',
};

/** Same color code as BUCKET_BADGE, text-only (no pill background/border) —
 *  for coloring a plain score readout, e.g. AlternatesPopover.tsx's per-option
 *  percentage, without stacking a second badge-looking element next to it. */
export const BUCKET_TEXT: Record<Detection['bucket'], string> = {
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
 *  arrow. `getName`/`getDefaultName` abstract over Analysis/LiveSession/
 *  ImportSession, which don't share a base type. */
export function TitleRow({ getName, getDefaultName, onRename, onDelete, onShare }: {
  getName: () => string;
  getDefaultName: () => string;
  onRename: (name: string) => void;
  onDelete: () => void;
  /** Only the finished-session summary offers sharing — shows a button left
   *  of delete when set. */
  onShare?: () => void;
}) {
  // The deck-target button that used to sit here is gone (2026-09-06). It set a
  // destination once for the whole page, which every later add then applied in
  // silence; the deck choice now happens at each add, in its own modal, where
  // the user is actually looking. See components/deckSelector.tsx.
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { if (editing) inputRef.current?.focus(); }, [editing]);

  const startEdit = () => { setDraft(getName() || getDefaultName()); setEditing(true); };
  const commit = () => {
    const val = draft.trim();
    if (val) onRename(val);
    setEditing(false);
  };

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
          title={t('common.clickToRename')}
          onClick={startEdit}
        >
          {getName() || getDefaultName()}
        </h1>
      )}

      {onShare && (
        <button
          class="btn-ghost px-2 shrink-0 inline-flex items-center justify-center"
          title={t('sessions.export.title')}
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

/** The subset of Analysis the clip-extraction helpers actually need —
 *  lets a still-in-progress LiveSession/ImportSession (no Analysis row
 *  saved yet) build a lightweight literal instead. */
export interface ClipSessionRef {
  id: string;
  name: string;
  date: string | null;
  duration: number;
}

/** Stable identity of a clip, embedded in the filename: survives session
 *  renames and detection relabels (session id fragment + start second). */
export function clipTag(session: ClipSessionRef, ann: Detection): string {
  return `[${session.id.slice(0, 8)}·${Math.round(ann.start)}]`;
}

export function clipFileName(session: ClipSessionRef, ann: Detection): string {
  const sessionName = session.name;
  const range = `${fmtTime(ann.start)}–${fmtTime(ann.end ?? session.duration)}`.replace(/:/g, 'm');
  return `${ann.displayName} — ${sessionName} (${range}) ${clipTag(session, ann)}.mp3`;
}

/** True when this exact clip is already attached, whatever it was renamed to look like. */
export function isClipAttached(session: ClipSessionRef, ann: Detection): boolean {
  const card = findByExternalId(`thesession:${ann.tuneId}`, getContext().user.cards);
  if (!card) return false;
  const tag = clipTag(session, ann);
  return card.content.attachments.some(a => a.type === 'file' && a.name.includes(tag));
}

/** Extracts the detection's audio slice as a standalone MP3 file and attaches
 *  it to the card — independent from the session file. `audio` is already
 *  resolved by the caller (loadSessionAudio for a saved session, or a
 *  lazily-assembled Blob for a still-in-progress live/import one — see
 *  ClipControls below). */
export async function attachClip(
  ctx: AppContext,
  session: ClipSessionRef,
  ann: Detection,
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
 *  getDetections() already returns, so the edit is naturally included
 *  whenever that session is next saved, no separate persist step required
 *  (`persist`, when given, is for the summary's "write it out right now" case
 *  only). `previewBound` plays a 3s preview at the new bound when given —
 *  omitted for a live recording, which has no seekable file to preview from
 *  (raw mic capture, not played-back audio); the value still updates, just
 *  silently. */
export function BoundControls({ ann, getDuration, persist, refresh, previewBound }: {
  ann: Detection;
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
 *  import-in-progress feeds — a finalized detection can show up before a
 *  session is fully done (see ViterbiResult.convergedThroughIndex), so this
 *  isn't summary-only. `getAudio` is a lazy Blob provider so a live recording
 *  only pays to assemble its (still-growing) chunk dump when the user
 *  actually clicks, not on every render. `audioAvailable` mirrors the
 *  summary's existing "hidden once the session's audio has been forgotten"
 *  rule — always true for live/import, where there's no such action yet. */
export function ClipControls({ ann, session, audioAvailable, getAudio, ctx, onAttached, aligned }: {
  ann: Detection;
  session: ClipSessionRef;
  audioAvailable: boolean;
  getAudio: () => Promise<Blob | undefined>;
  ctx: AppContext;
  onAttached?: () => void;
  /** Keep both slots even when their button is absent, so that several of
   *  these stacked one under the other line their glyphs up. Off by default:
   *  in a free-flowing row (the analysis summary's, which also holds the bound
   *  controls and a merge link) a reserved empty slot is just a hole. */
  aligned?: boolean;
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

  // doAttach leaves `attaching` set on failure — the control stays disabled
  // and carries the reason, which is the behaviour this had before it became a
  // glyph. The reason has to stay READABLE, so a failed slot gives up its fixed
  // width: a message in a 24px box would be a message nobody can read, and on a
  // phone there is no tooltip to fall back on. One row out of line is a cheap
  // price, and it points at the row that went wrong.
  const failed = !!attachText?.startsWith('⚠');

  /** A slot rather than nothing, when the caller asks for it — see `aligned`.
   *
   *  ⚠️ A plain function returning a vnode, NOT a component — never write
   *  `const Slot = (props) => ...` and render it as `<Slot>`. A component
   *  declared inside a render is a NEW function on every pass, so Preact reads
   *  it as a different type and unmounts the old subtree to mount a fresh one
   *  each time. The buttons in it were then destroyed between mousedown and
   *  mouseup and the browser never fired a click at all: the control looked
   *  perfectly normal and did nothing (2026-09-12). Calling a function inlines
   *  the vnode into this component's own tree, where the diff can keep it. */
  const slot = (children: preact.ComponentChildren, wide = false) =>
    aligned && !wide ? <span class="w-6 flex items-center justify-center shrink-0">{children}</span> : <>{children}</>;

  return (
    <>
      {slot(audioAvailable && (
        <button
          class="text-dim hover:text-accent transition-colors cursor-pointer shrink-0 flex items-center disabled:opacity-50"
          title={downloadTitle}
          disabled={downloading}
          dangerouslySetInnerHTML={{ __html: downloadIcon(13) }}
          onClick={() => { void doDownload(); }}
        />
      ))}

      {/* Add clip as a standalone MP3 attachment (known card only) — hidden
         once the session's audio has been forgotten, unless a clip was
         already extracted before that (nothing left to extract, but still
         worth showing as done).

         A glyph rather than the words it used to be: it sits in a row of
         glyphs, and one text link among them broke both the alignment and the
         eye. The waveform says which object, the plus and the tick say which
         of the two states it is in. While the MP3 is being cut the percentage
         replaces the glyph — the same trade the summary's download makes, and
         for the same reason: two hours of audio takes a while, and a control
         that looked idle would be pressed again. */}
      {known && (already || audioAvailable) && slot(
        <button
          class={`shrink-0 flex items-center transition-colors ${
            already ? 'text-green-500 cursor-default'
              : failed ? 'text-danger cursor-default'
              : `text-accent ${attaching ? 'cursor-default' : 'hover:text-accent/70 cursor-pointer'}`}`}
          title={already ? t('sessions.attached') : attachText ?? t('sessions.attach')}
          aria-label={already ? t('sessions.attached') : t('sessions.attach')}
          disabled={!already && attaching}
          onClick={already ? undefined : () => { void doAttach(); }}
        >
          {already ? <ClipAttachedIcon size={13} />
            : failed ? <span class="text-[11px]">{attachText}</span>
            : attachText ? <span class="text-[10px] font-mono tabular-nums">{attachText}</span>
            : <AddClipIcon size={13} />}
        </button>,
        failed,
      )}
    </>
  );
}

// ── The one button that turns a recognised tune into a card ──────────────────
// Lifted out of DetectionCard (2026-09-12) when the tune ranking needed the
// same control: this is a subtle enough flow — fetch, then ask, then write,
// with a re-check inside the transaction — that a second copy of it would be
// a second thing to get wrong. DetectionCard renders it per DETECTION, the
// ranking per TUNE; neither knows anything the other does not.

export interface TuneDeckButtonProps {
  tuneId: string;
  ctx: AppContext;
  /** Decks pinned on the page this belongs to — they come back ticked in the
   *  deck choice modal. */
  getPinnedDeckIds?: () => Set<string>;
  onCardAdded?: () => void;
}

export function TuneDeckButton({ tuneId, ctx, getPinnedDeckIds, onCardAdded }: TuneDeckButtonProps) {
  const known = findByExternalId(`thesession:${tuneId}`, getContext().user.cards);
  const [busy, setBusy] = useState(false);

  /** Writes the already-fetched card. Split from the fetch on purpose: the tune
   *  is downloaded BEFORE the deck question is asked, so a failed lookup never
   *  wastes the user's answer, and dismissing the modal imports nothing at all.
   *
   *  The gap between fetch and commit is wide enough for the same tune to have
   *  arrived by another route in the meantime, so the externalId is re-checked
   *  inside the transaction rather than trusted from before it. */
  const commitAdd = async (card: Card, deckIds: string[]) => {
    setBusy(true);
    try {
      await ctx.mutate(s => {
        const existing = card.externalId ? findByExternalId(card.externalId, s.cards) : undefined;
        const id = existing?.id ?? card.id;
        if (!existing) s.cards[id] = card;
        for (const deckId of deckIds) {
          const deck = s.decks[deckId];
          if (deck && !deck.entries.some(e => e.cardId === id)) deck.entries.push({ cardId: id });
        }
      });
      onCardAdded?.();
    } finally {
      setBusy(false);
    }
  };

  const doLink = async (deckIds: string[]) => {
    if (!known) return;
    setBusy(true);
    try {
      await ctx.mutate(s => {
        for (const deckId of deckIds) {
          const deck = s.decks[deckId];
          if (deck && !deck.entries.some(e => e.cardId === known.id)) deck.entries.push({ cardId: known.id });
        }
      });
    } finally {
      setBusy(false);
    }
  };

  // Every add and every link asks where the card goes. With no deck at all
  // there is nothing to ask, so creating goes straight through — and the link
  // button is not rendered in the first place, since linking to nothing is not
  // an action.
  const onAddClick = (e: MouseEvent) => {
    e.stopPropagation();
    void (async () => {
      setBusy(true);
      let card: Card;
      try {
        card = tuneResultToCard(await fetchTuneById(Number(tuneId)));
      } catch {
        setBusy(false);   // nothing was fetched, so nothing is asked and nothing is written
        return;
      }
      setBusy(false);
      if (!hasAnyDeck()) { void commitAdd(card, []); return; }
      showDeckChoiceModal({
        pinned: getPinnedDeckIds?.() ?? new Set(),
        onConfirm: (deckIds) => { void commitAdd(card, deckIds); },
      });
    })();
  };

  const onLinkClick = (e: MouseEvent) => {
    e.stopPropagation();
    if (!known) return;
    showDeckChoiceModal({
      pinned: getPinnedDeckIds?.() ?? new Set(),
      alreadyIn: decksContainingCard(known.id),
      onConfirm: (deckIds) => { void doLink(deckIds); },
    });
  };

  const round = 'w-6 h-6 p-0 rounded-full flex items-center justify-center shrink-0 cursor-pointer transition-colors bg-accent/10 text-accent hover:bg-accent/20 disabled:opacity-50';

  if (!known) {
    return (
      <button class={round} title={t('sessions.addCard')} disabled={busy} onClick={onAddClick}>
        <PlusIcon size={12} />
      </button>
    );
  }
  if (!hasAnyDeck()) return null;
  // Dimmed, not disabled, once the card is in every deck: there is nothing
  // left to add, but this is also the only place that shows WHERE it already
  // sits, so it stays open for a look.
  return (
    <button
      class={`${round} ${isInEveryDeck(known.id) ? 'opacity-40' : ''}`}
      title={isInEveryDeck(known.id) ? t('deckChoice.inEveryDeck') : t('sessions.linkToDeck')}
      disabled={busy}
      dangerouslySetInnerHTML={{ __html: deckLinkIcon }}
      onClick={onLinkClick}
    />
  );
}
