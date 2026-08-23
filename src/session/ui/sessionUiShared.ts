import type { AppContext } from '../../types';
import { t } from '../../services/i18nService';
import { iconElement, TrashIcon } from '../../components/icons';
import { downloadIcon } from '../../components/playbackIcons';
import { confirmModal } from '../../components/modal';
import { findByExternalId } from '../../services/theSessionService';
import { fileToEntry } from '../../utils';
import { extractClipMp3 } from '../audio/clipExtract';
import { showDeckPickerPopover, deckLinkIcon } from '../../components/deckSelector';
import { getContext } from '../../store';
import type { IndexProgress } from '../recognition/indexStore';
import type { SessionAnnotation } from '../model';

// ── Shared imperative UI helpers ──────────────────────────────────────────────
// Small DOM-building utilities used by more than one of the session
// containers (LiveSession/ImportAnalysis/SessionSummary). Living here — a
// plain leaf module with no dependency on any of them — is what lets them
// all import from it without a circular dependency between containers. Not
// converted to JSX this migration: each one is called from a ref-mounted
// "install into this container" point (titleAndDeleteRow/editableDateRow) or
// from an imperative extraControls callback the container hands to
// AnnotationCard (appendBoundControls/appendClipControls) — imperative-in/
// imperative-out, same DOM tree they'd otherwise build with JSX.

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

export function indexProgressText(p: IndexProgress): string {
  if (p.phase === 'downloading') {
    const mb = (p.loadedBytes / 1048576).toFixed(1);
    const total = p.totalBytes ? ` / ${(p.totalBytes / 1048576).toFixed(0)}` : '';
    return t('sessions.downloadingIndex', { mb: `${mb}${total}` });
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
 *  ImportSession, which don't share a base type. Returns a `refreshTitle()` to
 *  call when something else (e.g. the date) changes what the default name shows. */
export function titleAndDeleteRow(body: HTMLElement, opts: {
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
}): { refreshTitle: () => void; refreshDeckBtn: () => void } {
  const titleH1 = document.createElement('h1');
  titleH1.className = 'text-xl font-semibold text-primary cursor-text hover:text-accent transition-colors flex-1 min-w-0 truncate';
  titleH1.title = 'Click to rename';
  titleH1.textContent = opts.getName() || opts.getDefaultName();

  const titleInp = document.createElement('input');
  titleInp.type = 'text';
  titleInp.className = 'text-xl font-semibold bg-transparent border-b border-accent outline-none text-primary flex-1 min-w-0 hidden';

  const refreshTitle = () => { titleH1.textContent = opts.getName() || opts.getDefaultName(); };

  const stopEditing = () => {
    titleInp.classList.add('hidden');
    titleH1.classList.remove('hidden');
  };
  titleInp.addEventListener('blur', () => {
    const val = titleInp.value.trim();
    if (val) opts.onRename(val);
    refreshTitle();
    stopEditing();
  });
  titleInp.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') titleInp.blur();
    if (e.key === 'Escape') stopEditing();
  });
  titleH1.addEventListener('click', () => {
    titleInp.value = opts.getName() || opts.getDefaultName();
    titleH1.classList.add('hidden');
    titleInp.classList.remove('hidden');
    titleInp.focus();
  });

  const deckBtn = document.createElement('button');
  const updateDeckBtn = () => {
    const ids = opts.getTargetDeckIds();
    const suffix = ids === undefined ? ' (?)' : ids.size > 0 ? ` (${ids.size})` : '';
    deckBtn.innerHTML = `${deckLinkIcon}${suffix}`;
    deckBtn.className = `inline-flex items-center gap-1 text-xs transition-colors cursor-pointer shrink-0 ${
      ids === undefined ? 'text-warn hover:text-primary' : ids.size > 0 ? 'text-accent' : 'text-dim hover:text-primary'
    }`;
    deckBtn.title = t('newCard.selectDecks');
  };
  updateDeckBtn();
  deckBtn.onclick = () => {
    const ids = opts.ensureTargetDeckIds();
    updateDeckBtn(); // reflect the undefined→Set transition even before any checkbox is touched
    showDeckPickerPopover(ids, updateDeckBtn);
  };

  const deleteBtn = document.createElement('button');
  deleteBtn.className = 'btn-danger px-2 shrink-0';
  deleteBtn.title = t('sessions.deleteTitle');
  deleteBtn.appendChild(iconElement(TrashIcon, 14));
  deleteBtn.onclick = () => confirmModal(
    t('sessions.delete.title'),
    t('sessions.delete.message', { name: opts.getName() || opts.getDefaultName() }),
    t('common.delete'),
    opts.onDelete,
  );

  const titleRow = document.createElement('div');
  titleRow.className = 'flex items-center gap-2';
  titleRow.append(titleH1, titleInp, deckBtn);
  if (opts.onShare) {
    const shareBtn = document.createElement('button');
    shareBtn.className = 'btn-ghost px-2 shrink-0 inline-flex items-center justify-center';
    shareBtn.title = t('sessions.share.button');
    shareBtn.innerHTML = SHARE_ICON_TRIGGER;
    shareBtn.onclick = opts.onShare;
    titleRow.appendChild(shareBtn);
  }
  titleRow.appendChild(deleteBtn);
  body.appendChild(titleRow);

  return { refreshTitle, refreshDeckBtn: updateDeckBtn };
}

/** Editable + erasable session-start date row — shared by a finished session
 *  and an import in progress (both can be genuinely dateless: no trustworthy
 *  t=0 for a file). A live recording always has one and shows it read-only
 *  instead — editing it mid-recording isn't offered here. */
export function editableDateRow(body: HTMLElement, opts: {
  getDate: () => string | null;
  setDate: (date: string | null) => void;
  onChange?: () => void;
}): void {
  const dateRow = document.createElement('div');
  dateRow.className = 'flex items-center gap-2 mt-2';
  const dateInp = document.createElement('input');
  dateInp.type = 'datetime-local';
  dateInp.className = 'input text-sm';
  dateInp.value = opts.getDate() ? toLocalInput(opts.getDate()!) : '';
  dateInp.max = toLocalInput(new Date().toISOString());
  const dateClear = document.createElement('button');
  dateClear.className = 'text-xs text-dim hover:text-danger cursor-pointer shrink-0';
  dateClear.textContent = t('sessions.dateClear');
  const dateNow = document.createElement('button');
  dateNow.className = 'text-xs text-dim hover:text-accent cursor-pointer shrink-0';
  dateNow.textContent = t('sessions.dateNow');
  const syncBtns = () => {
    const has = !!opts.getDate();
    dateClear.style.display = has ? '' : 'none';
    dateNow.style.display   = has ? 'none' : '';
  };
  const applyDate = (date: string | null) => {
    opts.setDate(date);
    dateInp.value = date ? toLocalInput(date) : '';
    syncBtns();
    opts.onChange?.();
  };
  dateInp.addEventListener('change', () => {
    if (!dateInp.value) { applyDate(null); return; }
    // 'YYYY-MM-DDTHH:mm' without offset parses as local time — what the picker shows.
    const ms = Date.parse(dateInp.value);
    if (Number.isNaN(ms) || ms > Date.now()) { dateInp.value = opts.getDate() ? toLocalInput(opts.getDate()!) : ''; return; }
    applyDate(new Date(ms).toISOString());
  });
  dateClear.onclick = () => applyDate(null);
  dateNow.onclick = () => applyDate(new Date().toISOString());
  syncBtns();
  dateRow.append(dateInp, dateNow, dateClear);
  body.appendChild(dateRow);
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
 *  appendClipControls). */
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

/** ±5s start/end bound adjustment, shared by the summary, live, and
 *  import-in-progress feeds — see appendClipControls's doc just below for why
 *  a finalized annotation can now show up before a session is fully done.
 *  Mutates `ann` in place — for a live/import session that's enough on its
 *  own: `ann` is the SAME object getAnnotations() already returns, so the
 *  edit is naturally included whenever that session is next saved, no
 *  separate persist step required (`opts.persist`, when given, is for the
 *  summary's "write it out right now" case only). `opts.previewBound` plays
 *  a 3s preview at the new bound when given — omitted for a live recording,
 *  which has no seekable file to preview from (raw mic capture, not
 *  played-back audio); the value still updates, just silently. */
export function appendBoundControls(
  controls: HTMLElement,
  ann: SessionAnnotation,
  getDuration: () => number,
  opts: { persist?: () => void; refresh?: () => void; previewBound?: (t: number) => void } = {},
): void {
  const boundCtl = (label: string, get: () => number, set: (v: number) => void) => {
    const wrap = document.createElement('span');
    wrap.className = 'flex items-center gap-1 text-[11px] text-dim';
    const minus = document.createElement('button');
    minus.className = 'px-1 rounded hover:bg-elevated cursor-pointer';
    minus.textContent = '−5s';
    const val = document.createElement('span');
    val.className = 'font-mono tabular-nums';
    val.textContent = `${label} ${fmtTime(get())}`;
    const plus = document.createElement('button');
    plus.className = 'px-1 rounded hover:bg-elevated cursor-pointer';
    plus.textContent = '+5s';
    const apply = (delta: number) => {
      set(Math.max(0, Math.min(getDuration(), get() + delta)));
      val.textContent = `${label} ${fmtTime(get())}`;
      opts.persist?.();
      opts.refresh?.();
      opts.previewBound?.(get());
    };
    minus.onclick = () => apply(-5);
    plus.onclick = () => apply(+5);
    wrap.append(minus, val, plus);
    return wrap;
  };

  controls.appendChild(boundCtl('▸', () => ann.start, v => { ann.start = v; }));
  controls.appendChild(boundCtl('◂', () => ann.end ?? getDuration(), v => { ann.end = v; }));
}

/** Download-clip + attach-to-card controls, shared by the summary, live, and
 *  import-in-progress feeds — previously summary-only: a finalized annotation
 *  used to only exist once a session was fully done, but now the live/import
 *  feed can show one too — see ViterbiResult.convergedThroughIndex.
 *  `getAudio` is a lazy Blob provider so a live recording only pays to
 *  assemble its (still-growing) chunk dump when the user actually clicks,
 *  not on every render. `audioAvailable` mirrors the summary's existing
 *  "hidden once the session's audio has been forgotten" rule — always true
 *  for live/import, where there's no such action yet. */
export function appendClipControls(
  controls: HTMLElement,
  ann: SessionAnnotation,
  ref: ClipSessionRef,
  audioAvailable: boolean,
  getAudio: () => Promise<Blob | undefined>,
  ctx: AppContext,
  onAttached?: () => void,
): void {
  if (audioAvailable) {
    const downloadClipBtn = document.createElement('button');
    downloadClipBtn.className = 'text-dim hover:text-accent transition-colors cursor-pointer shrink-0 flex items-center';
    downloadClipBtn.title = t('sessions.downloadClip');
    downloadClipBtn.innerHTML = downloadIcon(13);
    downloadClipBtn.onclick = async () => {
      downloadClipBtn.disabled = true;
      downloadClipBtn.classList.add('opacity-50');
      try {
        const audio = await getAudio();
        if (!audio) throw new Error(t('sessions.clip.unavailable'));
        const mp3 = await extractClipMp3(audio, ann.start, ann.end ?? ref.duration, ratio => {
          downloadClipBtn.title = t('sessions.extracting', { pct: Math.round(ratio * 100) });
        });
        const url = URL.createObjectURL(mp3);
        const a = document.createElement('a');
        a.href = url;
        a.download = clipFileName(ref, ann);
        a.click();
        URL.revokeObjectURL(url);
      } catch (err) {
        downloadClipBtn.title = `⚠ ${String(err)}`;
      } finally {
        downloadClipBtn.disabled = false;
        downloadClipBtn.classList.remove('opacity-50');
        downloadClipBtn.title = t('sessions.downloadClip');
      }
    };
    controls.appendChild(downloadClipBtn);
  }

  // Add clip as a standalone MP3 attachment (known card only) — fresh state,
  // the card may be brand new. Hidden once the session's audio has been
  // forgotten, unless a clip was already extracted before that (nothing left
  // to extract, but still worth showing as done).
  const known = findByExternalId(`thesession:${ann.tuneId}`, getContext().user.cards);
  const already = known ? isClipAttached(ref, ann) : false;
  if (known && (already || audioAvailable)) {
    const attachBtn = document.createElement('button');
    attachBtn.className = already
      ? 'text-[11px] text-green-500 cursor-default'
      : 'text-[11px] text-accent hover:underline cursor-pointer';
    attachBtn.textContent = already ? t('sessions.attached') : t('sessions.attach');
    if (!already) {
      attachBtn.onclick = async () => {
        attachBtn.disabled = true;
        attachBtn.classList.remove('hover:underline', 'cursor-pointer');
        try {
          const audio = await getAudio();
          if (!audio) throw new Error(t('sessions.clip.unavailable'));
          await attachClip(ctx, ref, ann, audio, ratio => {
            attachBtn.textContent = t('sessions.extracting', { pct: Math.round(ratio * 100) });
          });
          onAttached?.();
        } catch (err) {
          attachBtn.textContent = `⚠ ${String(err)}`;
        }
      };
    }
    controls.appendChild(attachBtn);
  }
}
