import { signal } from '@preact/signals';
import type { AppContext, SessionRating } from '../../types';
import { t } from '../../services/i18nService';
import { fileToEntry, focusIfDesktop, isTouchPrimaryDevice } from '../../utils';
import { iconElement, TrashIcon, MicIcon, FileAudioIcon, PlusIcon, heartIconElement, ImportTrayIcon, ResetIcon } from '../../components/icons';
import { playIcon, pauseIcon, stopIcon, downloadIcon } from '../../components/playbackIcons';
import { confirmModal, showModal, closeModal } from '../../components/modal';
import { findByExternalId, fetchTuneById, tuneResultToCard } from '../../services/theSessionService';
import { LiveSession } from '../liveSession';
import { ImportSession } from '../importSession';
import { probeAudioDuration, canPlayFile } from '../audio/sources';
import { extractClipMp3 } from '../audio/clipExtract';
import { makeAbcNoteButton } from './abcPreview';
import { IMPORT_WARN_MINUTES, IMPORT_MIN_S, SHARE_MAX_AUDIO_BYTES } from '../sessionConfig';
import { listSessions, deleteSession, loadSessionAudio, saveSessionMeta, forgetSessionAudio } from '../db';
import { recoverOrphanedSessions } from '../recovery';
import { showDeckPickerPopover, deckLinkIcon } from '../../components/deckSelector';
import { shareSession, importSharedSession, exportSessionFile, importSessionFile } from '../../services/sessionShareService';
import { getContext } from '../../store';
import type { RecordedSession, SessionAnnotation, WindowResult } from '../model';
import type { IndexProgress } from '../recognition/indexStore';

// ── Session module UI (hosted inside the Modules modal) ──────────────────────
// Screens: library (past sessions) → live (recording) / import (file analysis)
// → summary (edit). The active LiveSession / ImportSession are module-level
// state: closing the modal does NOT stop them — reopening the module lands
// back on the running screen.

let activeLive: LiveSession | null = null;
let activeImport: ImportSession | null = null;
/** Playback warning for the current import (format analysable but not playable). */
let importPlaybackWarn = false;
/** Raw window dump of the last completed import — AGG_CONFIG calibration tool. */
let lastImportDump: { sessionId: string; windows: WindowResult[] } | null = null;
/** Same idea for the last completed LIVE session, plus a wall-clock cross
 *  reference per window (see LiveSession.windows) — lets a #16 drift
 *  investigation compare the worker's sample-counted clock against real
 *  elapsed time directly, which an import dump can't do (import runs faster
 *  than real time). */
let lastLiveDump: { sessionId: string; windows: (WindowResult & { wallMs: number })[] } | null = null;
/** Bodies whose drag & drop listeners are already wired (renderLibrary re-runs). */
const dropWiredBodies = new WeakSet<HTMLElement>();
/** Synchronous re-entrancy guard: startImport awaits before setting activeImport. */
let importStarting = false;

/** Reactive mirror of activeLive/activeImport — plain module vars aren't observable
 *  by Preact, so the chrome (header dot, modules page) needs a signal to update live
 *  without the user having to reopen the Modules page. */
export const sessionRecordingSignal = signal(false);

function setActiveLive(v: LiveSession | null): void {
  activeLive = v;
  sessionRecordingSignal.value = activeLive !== null || activeImport !== null;
}

function setActiveImport(v: ImportSession | null): void {
  activeImport = v;
  sessionRecordingSignal.value = activeLive !== null || activeImport !== null;
}

export interface SessionModuleHost {
  header: HTMLElement;
  body: HTMLElement;
  ctx: AppContext;
  closeModal: () => void;
  registerCleanup: (fn: () => void) => void;
}

function fmtTime(s: number): string {
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(Math.max(0, s) % 60)).padStart(2, '0')}`;
}

function fmtLongTime(s: number): string {
  const h = Math.floor(s / 3600);
  if (h > 0) return `${h}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  return fmtTime(s);
}

function defaultSessionName(dateIso: string | null): string {
  return dateIso
    ? t('sessions.defaultName', { date: new Date(dateIso).toLocaleDateString() })
    : t('sessions.defaultNameNoDate');
}

/** ISO timestamp → 'YYYY-MM-DDTHH:mm' local time, what a datetime-local input shows/expects. */
function toLocalInput(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function indexProgressText(p: IndexProgress): string {
  if (p.phase === 'downloading') {
    const mb = (p.loadedBytes / 1048576).toFixed(1);
    const total = p.totalBytes ? ` / ${(p.totalBytes / 1048576).toFixed(0)}` : '';
    return t('sessions.downloadingIndex', { mb: `${mb}${total}` });
  }
  return t('sessions.processingIndex');
}

const IMPORT_RUNNING_PHASES = ['initializing', 'decoding', 'analyzing', 'saving'];

export function renderSessionModule(host: SessionModuleHost): void {
  if (activeLive && activeLive.getPhase() !== 'idle' && activeLive.getPhase() !== 'done') {
    renderLive(host);
  } else if (activeImport && IMPORT_RUNNING_PHASES.includes(activeImport.getPhase())) {
    renderImportAnalysis(host);
  } else {
    renderLibrary(host);
  }
}

function fmtEta(etaS: number): string {
  if (etaS >= 90) return `${Math.round(etaS / 60)} min`;
  return `${Math.round(etaS)} s`;
}

// ── Shared bits ───────────────────────────────────────────────────────────────

// Same icon glyphs as the card import/export flow (theSessionImport.ts's
// mkChoiceCard SVGs / library.tsx's export trigger) — kept as a local copy
// rather than shared, matching how those two already don't share code with
// each other either. Two "file" variants: arrow OUT of a tray for export
// (library.tsx's actual export-button icon), arrow INTO a tray for import
// (theSessionImport.ts's .cdc-file icon) — same tray, opposite arrow.
const SHARE_ICON_FILE_UP = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>';
// Same glyph, small size — exact match of library.tsx's icon-only export trigger.
const SHARE_ICON_TRIGGER = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>';
const SHARE_ICON_FILE_DOWN = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="3" x2="12" y2="15"/></svg>';
const SHARE_ICON_SHARE = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>';

/** Builds the module header; returns the title element so screens with an
 *  editable name (summary) can keep it in sync.
 *  `onBack` is null for screens now reachable via real routes (their back
 *  navigation is the app's own history) — still used by the live/import
 *  screens, which stay local state and have no route of their own. */
function moduleHeader(host: SessionModuleHost, title: string, onBack: (() => void) | null): HTMLElement {
  host.header.innerHTML = '';
  const leftGroup = document.createElement('div');
  leftGroup.className = 'flex items-center gap-3 mb-4';

  // Same back button as the library / TheSession-import headers.
  if (onBack) {
    const backBtn = document.createElement('button');
    backBtn.className = 'text-dim hover:text-primary transition-colors cursor-pointer shrink-0 text-lg leading-none';
    backBtn.textContent = '←';
    backBtn.onclick = onBack;
    leftGroup.appendChild(backBtn);
  }

  const titleEl = document.createElement('h1');
  titleEl.className = 'text-xl font-semibold text-primary';
  titleEl.textContent = title;

  leftGroup.appendChild(titleEl);
  host.header.append(leftGroup);
  return titleEl;
}

/** Card.tsx-style header shared by the three "one particular session/recording"
 *  screens (a finished session, a live recording, an import in progress): plain
 *  heading that turns into an input on click, plus a delete button — no back
 *  arrow. `getName`/`getDefaultName` abstract over RecordedSession/LiveSession/
 *  ImportSession, which don't share a base type. Returns a `refreshTitle()` to
 *  call when something else (e.g. the date) changes what the default name shows. */
function titleAndDeleteRow(body: HTMLElement, opts: {
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
 *  instead (see renderLive) — editing it mid-recording isn't offered here. */
function editableDateRow(body: HTMLElement, opts: {
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

/** Compact "− N +" stepper for the manual pitch shift applied to an ongoing
 *  live/import analysis (e.g. a session played in Bb). Plain +/- taps rather
 *  than a slider — with only 25 discrete steps, big touch targets beat
 *  dragging a thin range input on a phone. Live-adjustable: takes effect on
 *  the next analysis window. Sits inline in the status bar, next to the
 *  stop/cancel button — no label, just the tooltip. */
function pitchShiftControl(opts: {
  get: () => number;
  set: (semitones: number) => void;
}): HTMLElement {
  const row = document.createElement('div');
  row.className = 'flex items-center gap-1 text-xs shrink-0';
  row.title = t('sessions.pitchShift.hint');

  const stepBtn = (glyph: string): HTMLButtonElement => {
    const b = document.createElement('button');
    b.className = 'btn-ghost border border-border w-6 h-6 p-0 rounded-full flex items-center justify-center shrink-0 leading-none';
    b.textContent = glyph;
    return b;
  };
  const minusBtn = stepBtn('−');
  const plusBtn = stepBtn('+');

  const valueEl = document.createElement('span');
  valueEl.className = 'font-mono tabular-nums text-center shrink-0';
  valueEl.style.width = '2em';

  const refresh = () => {
    const v = opts.get();
    valueEl.textContent = v === 0 ? '0' : `${v > 0 ? '+' : ''}${v}`;
    valueEl.classList.toggle('text-dim', v === 0);
    valueEl.classList.toggle('text-accent', v !== 0);
    valueEl.classList.toggle('font-semibold', v !== 0);
    minusBtn.disabled = v <= -12;
    plusBtn.disabled = v >= 12;
    minusBtn.classList.toggle('opacity-40', minusBtn.disabled);
    plusBtn.classList.toggle('opacity-40', plusBtn.disabled);
  };

  minusBtn.onclick = () => { opts.set(Math.max(-12, opts.get() - 1)); refresh(); };
  plusBtn.onclick  = () => { opts.set(Math.min(12, opts.get() + 1)); refresh(); };

  refresh();
  row.append(minusBtn, valueEl, plusBtn);
  return row;
}

const BUCKET_BADGE: Record<SessionAnnotation['bucket'], string> = {
  high: 'bg-green-500/10 text-green-500',
  medium: 'bg-amber-500/10 text-amber-500',
  low: 'bg-elevated text-dim border border-border',
};


const BUCKET_SEGMENT: Record<SessionAnnotation['bucket'], string> = {
  high: 'rgb(34 197 94 / 0.75)',
  medium: 'rgb(245 158 11 / 0.75)',
  low: 'rgb(120 120 120 / 0.55)',
};

interface AnnotationCardOptions {
  ctx: AppContext;
  onOpenCard?: (cardId: string) => void;
  onCardAdded?: () => void;
  /** Play/stop this annotation's audio slice; shows a ▶ button when provided. */
  onPlay?: (ann: SessionAnnotation) => void;
  playingId?: string | null;
  extraControls?: (el: HTMLElement) => void; // summary-only controls appended to the card
  /** Unix ms of the session's t=0. When set, closed annotations of known cards
   *  get the "log this as a review" control (summary + live feed; the import
   *  feed has no date until the user sets one in the summary). */
  sessionStartMs?: number;
  /** Deck(s) a card created from this annotation via "Add card" should link into.
   *  `undefined` = never touched — "Add card" forces the picker open first (auto-
   *  creating once it closes) instead of creating immediately, same rule as the
   *  title row's deck icon these three share the underlying Set with. */
  getTargetDeckIds?: () => Set<string> | undefined;
  ensureTargetDeckIds?: () => Set<string>;
  onTargetDeckIdsChanged?: () => void;
  /** "I liked this tune" marker — purely personal, unrelated to any card. */
  onToggleLike?: (annotationId: string) => void;
}

// ── Review logging from a recognised tune ─────────────────────────────────────
// "I played it at this session" = one review entry at the annotation's end
// time, in the same history the card view and FSRS read. The exact timestamp
// doubles as the marker that this annotation was already logged: when an entry
// exists at that instant the four rating buttons are replaced by a single
// remove control.

const RATING_GLYPHS: Array<{ rating: SessionRating; glyph: string; cls: string; labelKey: string }> = [
  { rating: 'again', glyph: '✗', cls: 'text-danger',  labelKey: 'rating.again' },
  { rating: 'hard',  glyph: '△', cls: 'text-warn',    labelKey: 'rating.hard' },
  { rating: 'good',  glyph: '○', cls: 'text-accent',  labelKey: 'rating.good' },
  { rating: 'easy',  glyph: '✓', cls: 'text-success', labelKey: 'rating.easy' },
];

function reviewLogControl(cardId: string, ts: number, ctx: AppContext): HTMLElement {
  const wrap = document.createElement('span');
  wrap.className = 'inline-flex items-center gap-1.5';

  const render = () => {
    wrap.innerHTML = '';
    const user = getContext().user;
    const existing = user.cardWorks[`${user.currentProfileId}:${cardId}`]?.history.find(e => e.ts === ts);

    if (existing) {
      const glyph = RATING_GLYPHS.find(r => r.rating === existing.rating);
      const del = document.createElement('button');
      del.className = 'text-xs text-muted cursor-pointer inline-flex items-center gap-1 hover:text-danger';
      del.title = new Date(ts).toLocaleString();
      const mark = document.createElement('span');
      mark.className = glyph?.cls ?? '';
      mark.textContent = glyph?.glyph ?? '';
      const lbl = document.createElement('span');
      lbl.className = 'hover:underline';
      lbl.textContent = t('sessions.review.remove');
      del.append(mark, lbl);
      del.onclick = () => {
        void ctx.mutate(s => {
          const h = s.cardWorks[`${s.currentProfileId}:${cardId}`]?.history;
          const i = h?.findIndex(e => e.ts === ts) ?? -1;
          if (h && i !== -1) h.splice(i, 1);
        }).then(render);
      };
      wrap.appendChild(del);
      return;
    }

    const label = document.createElement('span');
    label.className = 'text-xs text-dim';
    label.textContent = t('sessions.review.log');
    wrap.appendChild(label);

    for (const { rating, glyph, cls, labelKey } of RATING_GLYPHS) {
      const btn = document.createElement('button');
      btn.className = `text-xs cursor-pointer transition-transform hover:scale-125 ${cls}`;
      btn.textContent = glyph;
      btn.title = t(labelKey);
      btn.onclick = () => {
        void ctx.mutate(s => {
          const key = `${s.currentProfileId}:${cardId}`;
          if (!s.cardWorks[key]) s.cardWorks[key] = { profileId: s.currentProfileId, cardId, history: [] };
          s.cardWorks[key]!.history.push({ ts, rating });
          s.cardWorks[key]!.history.sort((a, b) => a.ts - b.ts);
        }).then(render);
      };
      wrap.appendChild(btn);
    }
  };

  render();
  return wrap;
}

function annotationCard(ann: SessionAnnotation, opts: AnnotationCardOptions): HTMLElement {
  // Fresh state, not the snapshot captured at modal-open time: a card added a
  // second ago (onCardAdded) must flip this card to the "known" rendering.
  const user = getContext().user;
  const known = findByExternalId(`thesession:${ann.tuneId}`, user.cards);
  const isOpen = ann.end === null;

  const el = document.createElement('div');
  el.className = `p-3 rounded-lg border bg-bg space-y-1.5 ${isOpen ? 'border-accent/60' : 'border-border'}`;
  el.dataset['annId'] = ann.id;

  const row1 = document.createElement('div');
  row1.className = 'flex items-center gap-2';

  if (isOpen) {
    const pulse = document.createElement('span');
    pulse.className = 'w-2 h-2 rounded-full bg-accent animate-pulse shrink-0';
    row1.appendChild(pulse);
  }

  if (opts.onPlay) {
    const playing = opts.playingId === ann.id;
    const playBtn = document.createElement('button');
    playBtn.className = `w-6 h-6 p-0 rounded-full flex items-center justify-center shrink-0 cursor-pointer transition-colors ${
      playing ? 'bg-accent text-white' : 'bg-accent/10 text-accent hover:bg-accent/20'}`;
    playBtn.innerHTML = playing ? pauseIcon(10) : playIcon(10);
    playBtn.title = t('sessions.playSlice');
    playBtn.onclick = (e) => { e.stopPropagation(); opts.onPlay!(ann); };
    row1.appendChild(playBtn);
  }

  // Sheet + synth preview of the matched setting (inert when no ABC exists).
  row1.appendChild(makeAbcNoteButton(ann.settingId, ann.displayName));

  if (!known) {
    const addBtn = document.createElement('button');
    addBtn.className = 'w-6 h-6 p-0 rounded-full flex items-center justify-center shrink-0 cursor-pointer transition-colors bg-accent/10 text-accent hover:bg-accent/20';
    addBtn.title = t('sessions.addCard');
    addBtn.appendChild(iconElement(PlusIcon, 12));
    const doAdd = async () => {
      addBtn.disabled = true;
      addBtn.classList.add('opacity-50');
      try {
        const tune = await fetchTuneById(Number(ann.tuneId));
        const card = tuneResultToCard(tune);
        await opts.ctx.mutate(s => {
          s.cards[card.id] = card;
          for (const deckId of opts.getTargetDeckIds?.() ?? []) {
            const deck = s.decks[deckId];
            if (deck && !deck.entries.some(e => e.cardId === card.id)) deck.entries.push({ cardId: card.id });
          }
        });
        opts.onCardAdded?.();
      } catch {
        addBtn.disabled = false;
        addBtn.classList.remove('opacity-50');
      }
    };
    addBtn.onclick = (e) => {
      e.stopPropagation();
      // First "Add card" ever for this session: force a deliberate deck choice
      // (or explicit "none") before creating anything — same rule as the title
      // row's deck icon, sharing its underlying Set. Creates automatically once
      // the forced picker closes, no second click needed.
      if (opts.getTargetDeckIds?.() === undefined && opts.ensureTargetDeckIds) {
        const ids = opts.ensureTargetDeckIds();
        opts.onTargetDeckIdsChanged?.();
        showDeckPickerPopover(ids, () => opts.onTargetDeckIdsChanged?.(), () => { void doAdd(); });
      } else {
        void doAdd();
      }
    };
    row1.appendChild(addBtn);
  } else {
    // Card already exists: offer a quick link into the session's target
    // deck(s) instead — additive only, never unlinks from decks not selected.
    const linkBtn = document.createElement('button');
    linkBtn.className = 'w-6 h-6 p-0 rounded-full flex items-center justify-center shrink-0 cursor-pointer transition-colors bg-accent/10 text-accent hover:bg-accent/20';
    linkBtn.title = t('sessions.linkToDeck');
    linkBtn.innerHTML = deckLinkIcon;
    const doLink = async () => {
      linkBtn.disabled = true;
      linkBtn.classList.add('opacity-50');
      try {
        await opts.ctx.mutate(s => {
          for (const deckId of opts.getTargetDeckIds?.() ?? []) {
            const deck = s.decks[deckId];
            if (deck && !deck.entries.some(e => e.cardId === known.id)) deck.entries.push({ cardId: known.id });
          }
        });
      } finally {
        linkBtn.disabled = false;
        linkBtn.classList.remove('opacity-50');
      }
    };
    linkBtn.onclick = (e) => {
      e.stopPropagation();
      if (opts.getTargetDeckIds?.() === undefined && opts.ensureTargetDeckIds) {
        const ids = opts.ensureTargetDeckIds();
        opts.onTargetDeckIdsChanged?.();
        showDeckPickerPopover(ids, () => opts.onTargetDeckIdsChanged?.(), () => { void doLink(); });
      } else {
        void doLink();
      }
    };
    row1.appendChild(linkBtn);
  }

  // A name that "navigates to" the card page if it exists, else the exact
  // TheSession setting that matched (not just the tune page) — same URL shape
  // as the S: line in abcPreview.ts's showAbcPreview.
  const makeNavigableName = (label: string, tuneId: string, settingId: string, knownCardId: string | undefined): HTMLElement => {
    if (knownCardId) {
      const span = document.createElement('span');
      span.className = 'cursor-pointer hover:text-accent transition-colors';
      span.title = t('sessions.openCard');
      span.textContent = label;
      span.onclick = () => opts.onOpenCard?.(knownCardId);
      return span;
    }
    const a = document.createElement('a');
    a.className = 'cursor-pointer hover:text-accent transition-colors';
    a.title = t('sessions.viewOnTheSession');
    a.textContent = label;
    a.href = `https://thesession.org/tunes/${tuneId}#setting${settingId}`;
    a.target = '_blank';
    a.rel = 'noopener';
    return a;
  };

  const nameEl = makeNavigableName(ann.displayName, ann.tuneId, ann.settingId, known?.id);
  nameEl.classList.add('text-sm', 'font-semibold', 'text-primary', 'capitalize', 'truncate', 'flex-1');

  // Confidence pin — percentage appended (dropped the expandable "detection
  // options" panel entirely: confidence and the alternates' meanScore are
  // different metrics, comparing them side by side was misleading).
  const badge = document.createElement('span');
  badge.className = `text-[10px] px-1.5 py-0.5 rounded-full shrink-0 ${BUCKET_BADGE[ann.bucket]}`;
  badge.textContent = ann.userConfirmed ? '✓' : `${t(`sessions.confidence.${ann.bucket}`)} ${Math.round(ann.confidence * 100)}%`;

  row1.append(nameEl, badge);

  if (opts.onToggleLike) {
    const likeBtn = document.createElement('button');
    likeBtn.className = `shrink-0 cursor-pointer transition-colors ${ann.liked ? 'text-danger' : 'text-dim hover:text-danger'}`;
    likeBtn.title = t(ann.liked ? 'sessions.unlike' : 'sessions.like');
    likeBtn.appendChild(heartIconElement(ann.liked));
    likeBtn.onclick = (e) => { e.stopPropagation(); opts.onToggleLike!(ann.id); };
    row1.appendChild(likeBtn);
  }

  const row2 = document.createElement('div');
  row2.className = 'text-xs text-muted';
  const range = ann.end === null
    ? `${fmtLongTime(ann.start)} · ${t('sessions.inProgress')}`
    : `${fmtLongTime(ann.start)} – ${fmtLongTime(ann.end)}`;
  row2.textContent = `${ann.dance} · ${ann.meter} · ${range}`;

  const row3 = document.createElement('div');
  row3.className = 'flex items-center gap-3 flex-wrap';
  if (known && opts.sessionStartMs !== undefined && ann.end !== null) {
    row3.appendChild(reviewLogControl(known.id, opts.sessionStartMs + ann.end * 1000, opts.ctx));
  }

  el.append(row1, row2);
  if (row3.children.length > 0) el.appendChild(row3);

  opts.extraControls?.(el);
  return el;
}

// ── Screen: library ───────────────────────────────────────────────────────────

function renderLibrary(host: SessionModuleHost): void {
  moduleHeader(host, t('sessions.moduleTitle'), null);
  const body = host.body;
  body.innerHTML = '';

  const startBtn = document.createElement('button');
  startBtn.className = 'btn-primary w-full justify-center flex items-center gap-2';
  startBtn.appendChild(iconElement(MicIcon, 14));
  const startLbl = document.createElement('span');
  startLbl.textContent = t('sessions.start');
  startBtn.appendChild(startLbl);
  startBtn.onclick = () => { startLiveSession(host); };
  body.appendChild(startBtn);

  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  // No `accept` filter: on iOS Safari it's known to hide some m4a containers
  // depending on provenance (iCloud/Messages/third-party apps) — the card
  // attachment picker (attachmentList.ts) has never had this filter either.
  fileInput.style.display = 'none';
  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    if (file) void startImport(host, file);
  });

  const importBtn = document.createElement('button');
  importBtn.className = 'btn-ghost w-full justify-center flex items-center gap-2 mt-2 border border-border';
  importBtn.appendChild(iconElement(FileAudioIcon, 13));
  const importLbl = document.createElement('span');
  importLbl.textContent = t('sessions.import');
  importBtn.appendChild(importLbl);
  importBtn.title = t('sessions.importHint');
  importBtn.onclick = () => fileInput.click();
  body.append(fileInput, importBtn);

  const importSessionBtn = document.createElement('button');
  importSessionBtn.className = 'btn-ghost w-full justify-center flex items-center gap-2 mt-2 border border-border';
  importSessionBtn.appendChild(iconElement(ImportTrayIcon, 13));
  const importSessionLbl = document.createElement('span');
  importSessionLbl.textContent = t('sessions.share.importSession');
  importSessionBtn.appendChild(importSessionLbl);
  importSessionBtn.onclick = () => showImportSessionModal(host);
  body.appendChild(importSessionBtn);

  // Drag & drop an audio file anywhere on the library screen. renderLibrary
  // runs many times on the same body element (back from summary, deletions…):
  // wire the listeners only once per modal instance.
  if (!dropWiredBodies.has(body)) {
    dropWiredBodies.add(body);
    body.addEventListener('dragover', e => {
      e.preventDefault();
      body.classList.add('bg-accent/5');
    });
    body.addEventListener('dragleave', e => {
      if (!body.contains(e.relatedTarget as Node)) body.classList.remove('bg-accent/5');
    });
    body.addEventListener('drop', e => {
      e.preventDefault();
      body.classList.remove('bg-accent/5');
      const file = e.dataTransfer?.files[0];
      if (file && (file.type.startsWith('audio/') || !file.type)) void startImport(host, file);
    });
  }

  const searchInp = document.createElement('input');
  searchInp.type = 'text';
  searchInp.className = 'input text-sm mt-3';
  searchInp.placeholder = t('sessions.search');
  body.appendChild(searchInp);

  const listWrap = document.createElement('div');
  listWrap.className = 'mt-4 space-y-2';
  body.appendChild(listWrap);

  let allSessions: RecordedSession[] = [];

  const renderRows = (query: string) => {
    listWrap.innerHTML = '';
    const q = query.trim().toLowerCase();
    const sessions = q
      ? allSessions.filter(s => (s.name || defaultSessionName(s.date)).toLowerCase().includes(q))
      : allSessions;

    if (sessions.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'text-xs text-dim text-center py-4';
      empty.textContent = q ? t('sessions.noSearchResults') : t('sessions.empty');
      listWrap.appendChild(empty);
      return;
    }
    for (const session of sessions) {
      const row = document.createElement('div');
      row.className = 'flex items-center gap-3 p-3 rounded-lg border border-border bg-bg hover:border-accent/50 transition-colors cursor-pointer';
      row.onclick = () => host.ctx.navigate({ view: 'sessions', sessionId: session.id });

      const textWrap = document.createElement('div');
      textWrap.className = 'flex-1 min-w-0';

      const nameEl = document.createElement('div');
      nameEl.className = 'text-sm font-medium text-primary truncate flex items-center gap-1.5';
      const nameTxt = document.createElement('span');
      nameTxt.className = 'truncate';
      nameTxt.textContent = session.name || defaultSessionName(session.date);
      nameEl.appendChild(nameTxt);
      if (session.source === 'import') {
        const badge = document.createElement('span');
        badge.className = 'text-dim shrink-0 flex items-center';
        badge.title = t('sessions.importBadge');
        badge.appendChild(iconElement(FileAudioIcon, 11));
        nameEl.appendChild(badge);
      }

      const metaEl = document.createElement('div');
      metaEl.className = 'text-xs text-dim';
      const datePart = session.date ? `${new Date(session.date).toLocaleDateString()} · ` : '';
      metaEl.textContent = `${datePart}${fmtLongTime(session.duration)} · ${t('sessions.tunesCount', { n: session.annotations.length })}`;

      textWrap.append(nameEl, metaEl);
      row.appendChild(textWrap);

      listWrap.appendChild(row);
    }
  };

  searchInp.addEventListener('input', () => renderRows(searchInp.value));

  void recoverOrphanedSessions(activeLive?.sessionId).then(() => listSessions()).then(sessions => {
    allSessions = sessions;
    renderRows(searchInp.value);
  });
}

// ── Screen: file import ───────────────────────────────────────────────────────
// Turns an audio file into a full session: same recognition pipeline as live,
// faster than real time, with progress + ETA. The annotation feed reuses the
// live cards — watching them appear in accelerated time is the point.

function alertModal(title: string, message: string): void {
  const p = document.createElement('p');
  p.className = 'text-sm text-muted leading-relaxed';
  p.textContent = message;
  showModal(title, p, [{ label: t('common.close'), primary: true, onClick: closeModal }]);
}

// ── Share a session (annotations + optionally the audio) via a short key —
// same mechanism as card sharing (shareService.ts). ─────────────────────────

function mkShareChoiceCard(icon: string, label: string, desc: string, accentColor: string, onClick: () => void): HTMLElement {
  const btn = document.createElement('button');
  btn.className = 'flex items-center gap-3.5 w-full px-4 py-3.5 rounded-xl border border-border bg-bg text-left cursor-pointer';
  btn.style.cssText = 'transition: border-color 0.15s, background 0.15s;';
  btn.title = desc;
  const iconWrap = document.createElement('span');
  iconWrap.style.color = accentColor;
  iconWrap.className = 'shrink-0 flex items-center';
  iconWrap.innerHTML = icon;
  const labelEl = document.createElement('div');
  labelEl.className = 'flex-1 text-sm font-medium text-primary';
  labelEl.textContent = label;
  const arrow = document.createElement('span');
  arrow.className = 'text-dim text-base leading-none shrink-0';
  arrow.textContent = '›';
  btn.append(iconWrap, labelEl, arrow);
  btn.addEventListener('mouseenter', () => { btn.style.borderColor = accentColor; btn.style.background = `${accentColor}12`; });
  btn.addEventListener('mouseleave', () => { btn.style.borderColor = ''; btn.style.background = ''; });
  btn.onclick = onClick;
  return btn;
}

/** Same look as theSessionImport.ts's mkInputRow, without the unused info span. */
function mkShareInputRow(placeholder: string): { wrap: HTMLDivElement; inp: HTMLInputElement } {
  const wrap = document.createElement('div');
  wrap.className = 'flex-1 flex items-center bg-bg border border-border rounded px-3 py-2 transition-colors focus-within:border-accent';
  const inp = document.createElement('input');
  inp.type = 'text';
  inp.className = 'flex-1 min-w-0 bg-transparent outline-none text-sm text-primary placeholder:text-dim';
  inp.placeholder = placeholder;
  wrap.appendChild(inp);
  return { wrap, inp };
}

function showShareSessionModal(session: RecordedSession): void {
  const body = document.createElement('div');
  body.className = 'space-y-3';
  const status = document.createElement('p');
  status.className = 'text-xs text-muted text-center py-2';
  status.textContent = t('sessions.share.checking');
  body.appendChild(status);

  showModal(t('sessions.share.title'), body, []);

  void loadSessionAudio(session.id).then(loaded => {
    body.innerHTML = '';
    const audioBlob = loaded ?? null;

    let includeAudio = false;
    if (audioBlob) {
      const tooBig = audioBlob.size > SHARE_MAX_AUDIO_BYTES;
      includeAudio = !tooBig;

      const row = document.createElement('label');
      row.className = 'flex items-center gap-2 cursor-pointer select-none';
      const chk = document.createElement('input');
      chk.type = 'checkbox';
      chk.className = 'card-checkbox';
      chk.checked = includeAudio;
      const lbl = document.createElement('span');
      lbl.className = 'text-xs text-muted';
      lbl.textContent = t('sessions.share.includeAudio', { mb: (audioBlob.size / 1048576).toFixed(0) });
      chk.onchange = () => { includeAudio = chk.checked; };
      row.append(chk, lbl);
      body.appendChild(row);

      if (tooBig) {
        const warn = document.createElement('p');
        warn.className = 'text-xs text-warn';
        warn.textContent = t('sessions.share.tooBig');
        body.appendChild(warn);
      }
    } else {
      const lbl = document.createElement('p');
      lbl.className = 'text-xs text-dim';
      lbl.textContent = t('sessions.share.noAudio');
      body.appendChild(lbl);
    }

    const choices = document.createElement('div');
    choices.className = 'space-y-2 mt-1';
    choices.appendChild(mkShareChoiceCard(SHARE_ICON_FILE_UP, t('library.export.file'), t('sessions.share.fileDesc'), 'var(--color-warn)', () => {
      void exportSessionFile(session, includeAudio ? audioBlob : null);
      closeModal();
    }));
    choices.appendChild(mkShareChoiceCard(SHARE_ICON_SHARE, t('library.share.label'), t('library.share.desc'), 'var(--color-accent)', () => {
      void doUpload(includeAudio ? audioBlob : null);
    }));
    body.appendChild(choices);

    const doUpload = async (withAudio: Blob | null) => {
      body.innerHTML = '';
      status.textContent = t('sessions.share.uploading');
      body.appendChild(status);
      try {
        const { key, secondsRemaining } = await shareSession(session, withAudio);
        body.innerHTML = '';
        const keyEl = document.createElement('div');
        keyEl.className = 'text-center font-mono text-3xl font-bold tracking-[0.3em] text-primary py-2';
        keyEl.textContent = key;
        const copyBtn = document.createElement('button');
        copyBtn.className = 'btn-primary w-full text-sm';
        copyBtn.textContent = t('library.share.copy');
        copyBtn.onclick = () => {
          void navigator.clipboard.writeText(key);
          copyBtn.textContent = t('library.share.copied');
          setTimeout(() => { copyBtn.textContent = t('library.share.copy'); }, 2000);
        };
        const validity = document.createElement('p');
        validity.className = 'text-xs text-muted text-center';
        validity.textContent = t('library.share.validity', { minutes: Math.floor(secondsRemaining / 60) });
        body.append(keyEl, copyBtn, validity);
      } catch (e) {
        status.textContent = t('theSession.error', { message: e instanceof Error ? e.message : String(e) });
      }
    };
  });
}

function showImportSessionModal(host: SessionModuleHost): void {
  const body = document.createElement('div');
  body.className = 'space-y-2';

  body.appendChild(mkShareChoiceCard(SHARE_ICON_FILE_DOWN, t('library.export.file'), t('sessions.share.fileImportDesc'), 'var(--color-warn)', () => {
    closeModal();
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = '.cds';
    inp.onchange = () => {
      const file = inp.files?.[0];
      if (!file) return;
      void importSessionFile(file).then(session => {
        host.ctx.navigate({ view: 'sessions', sessionId: session.id });
      }).catch(e => alertModal(t('sessions.share.importTitle'), e instanceof Error ? e.message : String(e)));
    };
    inp.click();
  }));

  body.appendChild(mkShareChoiceCard(SHARE_ICON_SHARE, t('newCard.share.label'), t('newCard.share.desc'), 'var(--color-accent)', () => {
    renderKeyEntry();
  }));

  showModal(t('sessions.share.importTitle'), body, []);

  const renderKeyEntry = () => {
    body.innerHTML = '';
    const status = document.createElement('p');
    status.className = 'text-xs text-muted min-h-[1.25rem]';
    const { wrap: inputWrap, inp } = mkShareInputRow(t('newCard.share.placeholder'));
    inp.maxLength = 6;
    const importBtn = document.createElement('button');
    importBtn.className = 'btn-primary text-xs shrink-0';
    importBtn.textContent = t('newCard.share.importBtn');
    importBtn.disabled = true;
    const row = document.createElement('div');
    row.className = 'flex gap-2';
    row.append(inputWrap, importBtn);
    inp.addEventListener('input', () => { importBtn.disabled = inp.value.trim().length !== 6; });
    const doImport = () => {
      importBtn.disabled = true;
      status.textContent = t('newCard.import.importing');
      void importSharedSession(inp.value.trim()).then(session => {
        closeModal();
        host.ctx.navigate({ view: 'sessions', sessionId: session.id });
      }).catch(e => {
        status.textContent = t('theSession.error', { message: e instanceof Error ? e.message : String(e) });
        importBtn.disabled = false;
      });
    };
    importBtn.onclick = doImport;
    inp.addEventListener('keydown', e => { if (e.key === 'Enter' && inp.value.trim().length === 6) doImport(); });
    body.append(row, status);
    focusIfDesktop(inp);
  };
}

async function startImport(host: SessionModuleHost, file: File): Promise<void> {
  if (activeImport || activeLive || importStarting) return; // one recognition job at a time
  importStarting = true;

  try {
    await preflightImport(host, file);
  } finally {
    importStarting = false;
  }
}

async function preflightImport(host: SessionModuleHost, file: File): Promise<void> {
  const duration = await probeAudioDuration(file);
  if (duration !== null && duration < IMPORT_MIN_S) {
    alertModal(t('sessions.import'), t('sessions.tooShort', { n: IMPORT_MIN_S }));
    return;
  }

  // Chunk-by-chunk decoding (StreamingFileSource) keeps memory bounded
  // regardless of duration — the RAM warning below only applies to the
  // one-shot decodeAudioData fallback, so skip it when streaming will be used.
  const { StreamingFileSource } = await import('../audio/streamingFileSource');
  const streamProbe = await StreamingFileSource.tryCreate(file);
  streamProbe?.stop();
  const canStream = streamProbe !== null;

  if (!canStream && duration !== null && duration > IMPORT_WARN_MINUTES * 60) {
    // Non-dismissable two-button modal: the promise always settles, so the
    // importStarting guard can never get stuck.
    const proceed = await new Promise<boolean>(resolve => {
      const p = document.createElement('p');
      p.className = 'text-sm text-muted leading-relaxed';
      p.textContent = t('sessions.longFile.message', { min: Math.round(duration / 60) });
      showModal(t('sessions.longFile.title'), p, [
        { label: t('common.cancel'), onClick: () => { closeModal(); resolve(false); } },
        { label: t('common.confirm'), primary: true, onClick: () => { closeModal(); resolve(true); } },
      ], false);
    });
    if (!proceed) return;
  }

  importPlaybackWarn = !canPlayFile(file);

  const imp = new ImportSession(file, {});
  setActiveImport(imp);
  renderImportAnalysis(host);
  await finishImportRun(host, imp);
}

/** Runs an already-constructed ImportSession to completion and handles every
 *  outcome (saved / cancelled-with-partial / error) — shared by a fresh file
 *  import (preflightImport) and re-analyzing an existing session
 *  (startReanalyze), which only differ in how `imp` gets built.
 *  `onCancelledOrError` is where to land if nothing ends up saved — a fresh
 *  import has nowhere to go back to but the library; re-analyzing an
 *  existing session should fall back to that session's own (untouched)
 *  summary instead. */
async function finishImportRun(
  host: SessionModuleHost,
  imp: ImportSession,
  onCancelledOrError: () => void = () => renderLibrary(host),
): Promise<void> {
  try {
    const session = await imp.start();
    if (session) {
      lastImportDump = { sessionId: session.id, windows: [...imp.windows] };
      setActiveImport(null);
      host.ctx.navigate({ view: 'sessions', sessionId: session.id });
      return;
    }
    // Cancelled: offer to keep the partial result when enough was recognised.
    if (imp.getClosedCount() > 1) {
      confirmModal(
        t('sessions.keepPartial.title'),
        t('sessions.keepPartial.message', { n: imp.getClosedCount() }),
        t('sessions.keepPartial.keep'),
        () => {
          void imp.keepPartial().then(session2 => {
            lastImportDump = { sessionId: session2.id, windows: [...imp.windows] };
            setActiveImport(null);
            host.ctx.navigate({ view: 'sessions', sessionId: session2.id });
          });
        },
      );
      // If the user dismisses the modal, the fallback screen below is already rendered.
    }
    setActiveImport(null);
    onCancelledOrError();
  } catch (err) {
    setActiveImport(null);
    const msg = String(err);
    if (msg.includes('too-short')) {
      alertModal(t('sessions.import'), t('sessions.tooShort', { n: IMPORT_MIN_S }));
    } else if (msg.includes('decod') || msg.includes('Decod') || msg.includes('EncodingError')) {
      alertModal(t('sessions.import'), t('sessions.cantDecode'));
    } else {
      alertModal(t('sessions.import'), msg);
    }
    onCancelledOrError();
  }
}

/** Re-runs recognition on a finished session's own stored audio, as if it had
 *  just been picked as a file to import — replacing its annotations with the
 *  fresh results (name/date/source preserved, same session id so decks/likes
 *  tied to it stay put and existing card attachments, which are independent
 *  extracted files, are unaffected). Never available without stored audio
 *  (caller gates the triggering button on that; this is just a safety net). */
async function startReanalyze(host: SessionModuleHost, session: RecordedSession): Promise<void> {
  if (activeImport || activeLive || importStarting) return; // one recognition job at a time
  importStarting = true;
  try {
    const blob = await loadSessionAudio(session.id);
    if (!blob) return;
    const file = new File([blob], session.name || 'session', { type: blob.type || session.mimeType });
    const imp = new ImportSession(file, {}, session.id);
    imp.name = session.name;
    imp.dateOverride = session.date;
    imp.sourceOverride = session.source;
    setActiveImport(imp);
    host.ctx.navigate({ view: 'sessions' });
    await finishImportRun(host, imp, () => host.ctx.navigate({ view: 'sessions', sessionId: session.id }));
  } finally {
    importStarting = false;
  }
}

function renderImportAnalysis(host: SessionModuleHost): void {
  const imp = activeImport;
  if (!imp) { renderLibrary(host); return; }

  // Card.tsx-style header, same as a finished session / a live recording —
  // no back arrow. "Delete" reuses imp.cancel(): the existing cancellation
  // flow already offers to keep whatever was recognised so far (see below).
  host.header.innerHTML = '';
  const body = host.body;
  body.innerHTML = '';

  const ensureImpTargetDeckIds = () => { if (!imp.targetDeckIds) imp.targetDeckIds = new Set(); return imp.targetDeckIds; };
  const { refreshDeckBtn: refreshImpDeckBtn } = titleAndDeleteRow(body, {
    getName: () => imp.name,
    getDefaultName: () => imp.defaultName(),
    onRename: (val) => { imp.name = val; },
    onDelete: () => imp.cancel(),
    getTargetDeckIds: () => imp.targetDeckIds,
    ensureTargetDeckIds: ensureImpTargetDeckIds,
  });

  // No trustworthy t=0 for a file — dateless by default, editable here
  // already (not just afterward in the summary) since there's no reason to wait.
  editableDateRow(body, {
    getDate: () => imp.dateOverride,
    setDate: (date) => { imp.dateOverride = date; },
  });

  // ── Progress bar + status
  const statusBar = document.createElement('div');
  statusBar.className = 'p-3 rounded-lg border border-border bg-bg sticky top-0 space-y-2';

  const topRow = document.createElement('div');
  topRow.className = 'flex items-center gap-3';

  const label = document.createElement('span');
  label.className = 'text-xs text-muted flex-1 truncate';
  label.textContent = t('sessions.analyzing');

  const pctEl = document.createElement('span');
  pctEl.className = 'text-xs font-mono text-primary tabular-nums shrink-0';
  pctEl.textContent = '0%';

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn-danger px-3 shrink-0';
  cancelBtn.textContent = t('common.cancel');
  cancelBtn.onclick = () => {
    cancelBtn.disabled = true;
    cancelBtn.classList.add('opacity-50');
    imp.cancel();
  };

  const pitchCtrl = pitchShiftControl({
    get: () => imp.pitchShift,
    set: (semitones) => imp.setPitchShift(semitones),
  });

  topRow.append(label, pctEl, pitchCtrl, cancelBtn);

  const barOuter = document.createElement('div');
  barOuter.className = 'h-1.5 rounded-full bg-elevated overflow-hidden';
  const barFill = document.createElement('div');
  barFill.className = 'h-full bg-accent transition-[width] duration-200';
  barFill.style.width = '0%';
  barOuter.appendChild(barFill);

  const etaEl = document.createElement('p');
  etaEl.className = 'text-[11px] text-dim text-center';

  statusBar.append(topRow, barOuter, etaEl);

  const initStatus = document.createElement('p');
  initStatus.className = 'text-xs text-dim mt-2 text-center';

  const playWarn = document.createElement('p');
  playWarn.className = 'text-xs text-amber-500 mt-2 text-center';
  playWarn.textContent = t('sessions.playbackUnsupported');
  if (!importPlaybackWarn) playWarn.classList.add('hidden');

  // ── Annotation feed (same cards as live)
  const feed = document.createElement('div');
  feed.className = 'mt-3 space-y-2';

  body.append(statusBar, initStatus, playWarn, feed);

  // ── Slice playback straight from the original file, while analysis runs.
  const audioUrl = URL.createObjectURL(imp.file);
  const audio = new Audio(audioUrl);
  let playingId: string | null = null;
  let sliceEnd = 0;
  audio.addEventListener('timeupdate', () => {
    if (playingId !== null && audio.currentTime >= sliceEnd) audio.pause();
  });
  audio.addEventListener('pause', () => {
    if (playingId !== null) { playingId = null; renderFeed(imp.getAnnotations()); }
  });
  host.registerCleanup(() => { audio.pause(); URL.revokeObjectURL(audioUrl); });

  const playSlice = (ann: SessionAnnotation) => {
    if (playingId === ann.id) { audio.pause(); return; }
    playingId = ann.id;
    sliceEnd = ann.end ?? Number.POSITIVE_INFINITY;
    audio.currentTime = ann.start;
    void audio.play().catch(() => { playingId = null; });
    renderFeed(imp.getAnnotations());
  };

  const renderFeed = (annotations: SessionAnnotation[]) => {
    const nearBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 80;
    feed.innerHTML = '';
    for (const ann of annotations) {
      feed.appendChild(annotationCard(ann, {
        ctx: host.ctx,
        onPlay: importPlaybackWarn ? undefined : playSlice,
        playingId,
        onOpenCard: (cardId) => { host.closeModal(); host.ctx.navigate({ view: 'card', cardId }); },
        onCardAdded: () => renderFeed(imp.getAnnotations()),
        getTargetDeckIds: () => imp.targetDeckIds,
        ensureTargetDeckIds: ensureImpTargetDeckIds,
        onTargetDeckIdsChanged: refreshImpDeckBtn,
        onToggleLike: (id) => { imp.toggleLike(id); renderFeed(imp.getAnnotations()); },
      }));
    }
    if (nearBottom) body.scrollTop = body.scrollHeight;
  };

  imp.setCallbacks({
    onPhase: (phase) => {
      if (phase === 'initializing') initStatus.textContent = t('sessions.initializing');
      else if (phase === 'decoding') initStatus.textContent = t('sessions.decoding');
      else if (phase === 'analyzing') initStatus.textContent = '';
    },
    onIndexProgress: p => { initStatus.textContent = indexProgressText(p); },
    onProgress: ({ analyzedS, totalS, etaS }) => {
      const pct = totalS > 0 ? Math.min(100, (analyzedS / totalS) * 100) : 0;
      pctEl.textContent = `${Math.round(pct)}%`;
      barFill.style.width = `${pct}%`;
      etaEl.textContent = etaS !== null ? t('sessions.etaRemaining', { eta: fmtEta(etaS) }) : '';
    },
    onAnnotations: (_events, all) => renderFeed(all),
    onError: (message) => { initStatus.textContent = `⚠ ${message}`; },
  });

  // First render happens just before start() (phase 'idle'), or as a re-entry
  // after the modal was closed and reopened mid-import.
  if (imp.getPhase() === 'analyzing') renderFeed(imp.getAnnotations());
  else if (imp.getPhase() === 'decoding') initStatus.textContent = t('sessions.decoding');
  else initStatus.textContent = t('sessions.initializing');
}

// ── Screen: live recording ────────────────────────────────────────────────────

function startLiveSession(host: SessionModuleHost): void {
  setActiveLive(new LiveSession({}));
  renderLive(host);
  void activeLive!.start().catch(() => { /* error surfaced via onError callback */ });
}

function renderLive(host: SessionModuleHost): void {
  const live = activeLive;
  if (!live) { renderLibrary(host); return; }

  host.header.innerHTML = '';
  const body = host.body;
  body.innerHTML = '';

  // A live recording always has a start date, from the real startedAt (0 for
  // the first instant, before start() resolves — "now" is a fine approximation
  // until then). Shown read-only: no reason to let the user desync it from
  // the actual recording while it's still running.
  const effectiveDate = () => new Date(live.startedAt || Date.now()).toISOString();

  // ── Title + delete (same card.tsx-style pattern as a finished session:
  // no back arrow, plain heading, click to turn into an input)
  const ensureLiveTargetDeckIds = () => { if (!live.targetDeckIds) live.targetDeckIds = new Set(); return live.targetDeckIds; };
  const { refreshDeckBtn: refreshLiveDeckBtn } = titleAndDeleteRow(body, {
    getName: () => live.name,
    getDefaultName: () => defaultSessionName(effectiveDate()),
    onRename: (val) => { live.name = val; },
    // Same route as this live screen (`{ view: 'sessions' }`, no sessionId) —
    // navigate() would be a no-op here since the route object doesn't change
    // in a way Preact/the SessionsView effect would notice. Re-render locally.
    onDelete: () => { void live.cancel().then(() => { setActiveLive(null); renderLibrary(host); }); },
    getTargetDeckIds: () => live.targetDeckIds,
    ensureTargetDeckIds: ensureLiveTargetDeckIds,
  });

  // ── Session date — always set for a live recording, read-only.
  const dateDisplay = document.createElement('p');
  dateDisplay.className = 'text-sm text-primary mt-2 mb-3';
  dateDisplay.textContent = new Date(effectiveDate()).toLocaleString();
  body.appendChild(dateDisplay);

  // ── Status bar
  const statusBar = document.createElement('div');
  statusBar.className = 'flex items-center gap-3 p-3 rounded-lg border border-border bg-bg sticky top-0';

  const recDot = document.createElement('span');
  recDot.className = 'w-2.5 h-2.5 rounded-full bg-danger animate-pulse shrink-0';

  const recLbl = document.createElement('span');
  recLbl.className = 'text-xs font-mono font-bold text-danger';
  recLbl.textContent = 'REC';

  const chrono = document.createElement('span');
  chrono.className = 'text-sm font-mono text-primary tabular-nums';
  chrono.textContent = '0:00';

  const vu = document.createElement('div');
  vu.className = 'flex-1 h-1.5 rounded-full bg-elevated overflow-hidden';
  const vuFill = document.createElement('div');
  vuFill.className = 'h-full bg-accent transition-[width] duration-75';
  vuFill.style.width = '0%';
  vu.appendChild(vuFill);

  const pauseBtn = document.createElement('button');
  pauseBtn.className = 'btn-ghost border border-border w-8 h-8 p-0 rounded-full flex items-center justify-center shrink-0';
  pauseBtn.innerHTML = pauseIcon(12);
  pauseBtn.title = t('sessions.pause');

  const stopBtn = document.createElement('button');
  stopBtn.className = 'btn-danger px-3 shrink-0';
  stopBtn.textContent = t('sessions.stop');

  const pitchCtrl = pitchShiftControl({
    get: () => live.pitchShift,
    set: (semitones) => live.setPitchShift(semitones),
  });

  statusBar.append(recDot, recLbl, chrono, vu, pauseBtn, pitchCtrl, stopBtn);

  const initStatus = document.createElement('p');
  initStatus.className = 'text-xs text-dim mt-2 text-center';

  // ── Annotation feed
  const feed = document.createElement('div');
  feed.className = 'mt-3 space-y-2';

  // ── Bottom state zone
  const stateZone = document.createElement('p');
  stateZone.className = 'text-xs text-dim mt-3 text-center min-h-[1rem]';

  const abcTicker = document.createElement('p');
  abcTicker.className = 'text-[10px] font-mono text-dim/60 text-center truncate mt-1';

  // #17: on a touch-primary device (phone/tablet), the OS very likely blocks
  // microphone access outright once the app is backgrounded — confirmed by
  // listening back to a real recording (background noise present right
  // before and after locking, silent for the entire locked stretch) even
  // though the worker keeps ticking on schedule throughout (fed silence, not
  // missing chunks — no code-side trick fixes this: tried a MediaSession/
  // silent-audio "keep-alive" and it made no real difference, removed).
  // Desktop doesn't have this restriction (minimizing the window is
  // harmless, confirmed) — none of this applies there.
  const isTouchPrimary = isTouchPrimaryDevice();

  const foregroundReminder = document.createElement('p');
  foregroundReminder.className = 'text-[11px] text-dim mt-2 text-center';
  foregroundReminder.textContent = t('sessions.foregroundReminder');

  // Measured directly off document.hidden duration, not off any recognition-
  // side signal — the worker keeps ticking on schedule the whole time either
  // way (just fed silence by the OS), so there's no sample-count deficit to
  // detect for this specific cause, unlike a genuine worklet delivery gap.
  const bgWarning = document.createElement('p');
  bgWarning.className = 'text-xs text-amber-500 mt-2 text-center hidden';
  let hiddenAtMs: number | null = null;
  const onVisibility = () => {
    if (document.hidden) {
      hiddenAtMs = Date.now();
      return;
    }
    if (hiddenAtMs !== null && live.getPhase() === 'recording') {
      const hiddenS = (Date.now() - hiddenAtMs) / 1000;
      if (hiddenS > 2) {
        bgWarning.textContent = t('sessions.bgWarning', { duration: fmtLongTime(hiddenS) });
        bgWarning.classList.remove('hidden');
        setTimeout(() => bgWarning.classList.add('hidden'), 8000);
      }
    }
    hiddenAtMs = null;
  };
  if (isTouchPrimary) document.addEventListener('visibilitychange', onVisibility);

  body.append(statusBar, initStatus, ...(isTouchPrimary ? [foregroundReminder, bgWarning] : []), feed, stateZone, abcTicker);

  // ── Wiring
  let rafId = 0;
  let chronoId = 0;
  const cleanup = () => {
    cancelAnimationFrame(rafId);
    clearInterval(chronoId);
    document.removeEventListener('visibilitychange', onVisibility);
  };
  host.registerCleanup(cleanup);

  const vuLoop = () => {
    vuFill.style.width = `${Math.round(live.getLevel() * 100)}%`;
    rafId = requestAnimationFrame(vuLoop);
  };

  // Idempotent: safe to call again on resume without leaking a second interval/rAF loop.
  const startTimers = () => {
    clearInterval(chronoId);
    cancelAnimationFrame(rafId);
    chrono.textContent = fmtLongTime(live.getElapsedMs() / 1000);
    chronoId = window.setInterval(() => {
      chrono.textContent = fmtLongTime(live.getElapsedMs() / 1000);
    }, 1000);
    rafId = requestAnimationFrame(vuLoop);
  };

  const stopTimers = () => {
    clearInterval(chronoId);
    cancelAnimationFrame(rafId);
    vuFill.style.width = '0%';
  };

  const setPausedUi = (paused: boolean) => {
    recDot.classList.toggle('bg-danger', !paused);
    recDot.classList.toggle('animate-pulse', !paused);
    recDot.classList.toggle('bg-dim', paused);
    recLbl.textContent = paused ? t('sessions.paused') : 'REC';
    pauseBtn.innerHTML = paused ? playIcon(12) : pauseIcon(12);
    pauseBtn.title = paused ? t('sessions.resume') : t('sessions.pause');
  };

  const renderFeed = (annotations: SessionAnnotation[]) => {
    const nearBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 80;
    feed.innerHTML = '';
    for (const ann of annotations) {
      feed.appendChild(annotationCard(ann, {
        ctx: host.ctx,
        onOpenCard: (cardId) => { host.closeModal(); host.ctx.navigate({ view: 'card', cardId }); },
        onCardAdded: () => renderFeed(live.getAnnotations()),
        sessionStartMs: live.startedAt || undefined,
        getTargetDeckIds: () => live.targetDeckIds,
        ensureTargetDeckIds: ensureLiveTargetDeckIds,
        onTargetDeckIdsChanged: refreshLiveDeckBtn,
        onToggleLike: (id) => { live.toggleLike(id); renderFeed(live.getAnnotations()); },
      }));
    }
    if (nearBottom) body.scrollTop = body.scrollHeight;
  };

  live.setCallbacks({
    onPhase: (phase) => {
      if (phase === 'recording') {
        initStatus.textContent = '';
        setPausedUi(false);
        startTimers();
        dateDisplay.textContent = new Date(effectiveDate()).toLocaleString(); // startedAt is now the real value
      } else if (phase === 'paused') {
        setPausedUi(true);
        stopTimers();
      } else if (phase === 'error') {
        cleanup();
      }
    },
    onIndexProgress: p => { initStatus.textContent = indexProgressText(p); },
    onWindow: (result, abc) => {
      const hasOpen = live.getAnnotations().some(a => a.end === null);
      if (hasOpen) {
        stateZone.textContent = '';
      } else if (result.empty) {
        stateZone.textContent = t('sessions.listening');
      } else {
        stateZone.textContent = t('sessions.recognizing');
      }
      abcTicker.textContent = abc ?? '';
    },
    onAnnotations: (_events, all) => renderFeed(all),
    onError: (message) => { initStatus.textContent = `⚠ ${message}`; },
  });

  // If we re-entered a session already running (modal was closed and reopened):
  if (live.getPhase() === 'recording') {
    setPausedUi(false);
    startTimers();
    renderFeed(live.getAnnotations());
  } else if (live.getPhase() === 'paused') {
    setPausedUi(true);
    chrono.textContent = fmtLongTime(live.getElapsedMs() / 1000);
    renderFeed(live.getAnnotations());
  } else if (live.getPhase() === 'initializing') {
    initStatus.textContent = t('sessions.initializing');
  }

  pauseBtn.onclick = () => {
    if (live.getPhase() === 'recording') void live.pause();
    else if (live.getPhase() === 'paused') void live.resume();
  };

  stopBtn.onclick = async () => {
    stopBtn.disabled = true;
    stopBtn.classList.add('opacity-50');
    pauseBtn.disabled = true;
    pauseBtn.classList.add('opacity-50');
    cleanup();
    try {
      const session = await live.stop();
      lastLiveDump = { sessionId: session.id, windows: [...live.windows] };
      setActiveLive(null);
      host.ctx.navigate({ view: 'sessions', sessionId: session.id });
    } catch (err) {
      setActiveLive(null);
      initStatus.textContent = `⚠ ${String(err)}`;
    }
  };
}

// ── Screen: summary ───────────────────────────────────────────────────────────

export function renderSummary(host: SessionModuleHost, session: RecordedSession): void {
  // Card.tsx-style header: title+delete row is the whole header — no back
  // arrow, no close cross. Reachable only via a routed sessionId now, so the
  // app's own back/forward already covers navigating away.
  host.header.innerHTML = '';
  const body = host.body;
  body.innerHTML = '';

  const persist = () => { void saveSessionMeta(session); };
  // Not persisted — resets each time the summary is opened, on purpose.
  let targetDeckIds: Set<string> | undefined = undefined;
  const ensureSummaryTargetDeckIds = () => { if (!targetDeckIds) targetDeckIds = new Set(); return targetDeckIds; };

  const { refreshTitle, refreshDeckBtn } = titleAndDeleteRow(body, {
    getName: () => session.name,
    getDefaultName: () => defaultSessionName(session.date),
    onRename: (val) => { session.name = val; persist(); },
    onDelete: () => { void deleteSession(session.id).then(() => host.ctx.navigate({ view: 'sessions' })); },
    onShare: () => showShareSessionModal(session),
    getTargetDeckIds: () => targetDeckIds,
    ensureTargetDeckIds: ensureSummaryTargetDeckIds,
  });

  // ── Session start date (t=0 of every review logged from this session).
  // Optional: live sessions arrive with one, imports without. Erasable — the
  // review-log controls only exist while a date is set.
  editableDateRow(body, {
    getDate: () => session.date,
    setDate: (date) => { session.date = date; persist(); },
    onChange: () => {
      refreshTitle(); // unnamed session's default name embeds the date
      renderList(); // review-log controls (dis)appear / re-anchor on the new t=0
    },
  });

  // ── Audio player — custom transport over a native <audio> element (no
  // decodeAudioData/waveform: sessions can run for hours, and the native
  // element streams/seeks without materializing the whole thing in RAM).
  // `audio` is also the element the timeline bar and per-annotation slice
  // playback below seek/play on directly.
  const audio = document.createElement('audio');
  audio.className = 'hidden';
  let audioUrl: string | null = null;

  const playerPlayBtn = document.createElement('button');
  playerPlayBtn.className = 'w-7 h-7 p-0 rounded-full flex items-center justify-center shrink-0 bg-accent/10 text-accent hover:bg-accent/20 transition-colors';
  playerPlayBtn.innerHTML = playIcon(12);
  playerPlayBtn.onclick = () => { if (audio.paused) void audio.play(); else audio.pause(); };

  const playerStopBtn = document.createElement('button');
  playerStopBtn.className = 'w-7 h-7 p-0 rounded-full flex items-center justify-center shrink-0 text-dim hover:text-primary transition-colors';
  playerStopBtn.innerHTML = stopIcon(12);
  playerStopBtn.onclick = () => { audio.pause(); audio.currentTime = 0; };

  const seekInp = document.createElement('input');
  seekInp.type = 'range';
  seekInp.min = '0';
  seekInp.max = '0';
  seekInp.step = '0.1';
  seekInp.value = '0';
  seekInp.className = 'flex-1 min-w-[80px] accent-accent cursor-pointer';
  let seeking = false;
  seekInp.addEventListener('input', () => { seeking = true; audio.currentTime = parseFloat(seekInp.value); updateTime(); });
  seekInp.addEventListener('change', () => { seeking = false; });

  const timeLbl = document.createElement('span');
  timeLbl.className = 'text-[11px] font-mono text-dim shrink-0 tabular-nums';
  timeLbl.textContent = '0:00 / 0:00';
  const updateTime = () => { timeLbl.textContent = `${fmtLongTime(audio.currentTime)} / ${fmtLongTime(audio.duration || 0)}`; };

  const downloadBtn = document.createElement('a');
  downloadBtn.className = 'text-dim hover:text-accent transition-colors cursor-pointer shrink-0 flex items-center';
  downloadBtn.title = t('sessions.downloadAudio');
  downloadBtn.innerHTML = downloadIcon(14);

  const forgetBtn = document.createElement('button');
  forgetBtn.className = 'text-dim hover:text-danger transition-colors cursor-pointer shrink-0';
  forgetBtn.title = t('sessions.forgetAudio.hint');
  forgetBtn.appendChild(iconElement(TrashIcon, 14));
  forgetBtn.onclick = () => confirmModal(
    t('sessions.forgetAudio.title'),
    t('sessions.forgetAudio.message'),
    t('sessions.forgetAudio'),
    () => {
      void forgetSessionAudio(session.id).then(() => {
        if (audioUrl) { URL.revokeObjectURL(audioUrl); audioUrl = null; }
        playerRow.style.display = 'none';
      });
    },
  );

  const reanalyzeBtn = document.createElement('button');
  reanalyzeBtn.className = 'text-dim hover:text-accent transition-colors cursor-pointer shrink-0';
  reanalyzeBtn.title = t('sessions.reanalyze.hint');
  reanalyzeBtn.appendChild(iconElement(ResetIcon, 14));
  reanalyzeBtn.onclick = () => confirmModal(
    t('sessions.reanalyze.title'),
    t('sessions.reanalyze.message'),
    t('sessions.reanalyze.confirm'),
    () => { void startReanalyze(host, session); },
  );

  const playerRow = document.createElement('div');
  playerRow.className = 'flex items-center gap-2 mt-3 flex-wrap';
  playerRow.style.display = 'none';
  playerRow.append(playerPlayBtn, playerStopBtn, seekInp, timeLbl, downloadBtn, reanalyzeBtn, forgetBtn);
  body.append(playerRow, audio);

  audio.addEventListener('loadedmetadata', () => { seekInp.max = String(audio.duration || 0); updateTime(); });
  audio.addEventListener('timeupdate', () => { if (!seeking) seekInp.value = String(audio.currentTime); updateTime(); });
  audio.addEventListener('play',  () => { playerPlayBtn.innerHTML = pauseIcon(12); });
  audio.addEventListener('pause', () => { playerPlayBtn.innerHTML = playIcon(12); });

  void loadSessionAudio(session.id).then(blob => {
    if (!blob) return;
    audioUrl = URL.createObjectURL(blob);
    audio.src = audioUrl;
    downloadBtn.href = audioUrl;
    downloadBtn.download = `${(session.name || defaultSessionName(session.date)).replace(/[^\w-]+/g, '_')}.${(session.mimeType.split('/')[1] || 'webm').split(';')[0]}`;
    playerRow.style.display = '';
    renderList(); // audio just became known-available — "add clip to card" can now show
  });
  host.registerCleanup(() => { if (audioUrl) URL.revokeObjectURL(audioUrl); });

  // ── Timeline segment bar
  const bar = document.createElement('div');
  bar.className = 'relative h-5 rounded bg-elevated mt-3 overflow-hidden cursor-pointer';
  const renderBar = () => {
    bar.innerHTML = '';
    for (const ann of session.annotations) {
      const seg = document.createElement('div');
      const end = ann.end ?? session.duration;
      seg.className = 'absolute top-0 bottom-0 hover:brightness-125 transition-[filter]';
      seg.style.left = `${(ann.start / session.duration) * 100}%`;
      seg.style.width = `${Math.max(0.5, ((end - ann.start) / session.duration) * 100)}%`;
      seg.style.background = BUCKET_SEGMENT[ann.bucket];
      seg.title = ann.displayName;
      seg.onclick = (e) => {
        e.stopPropagation();
        audio.currentTime = ann.start;
        listWrap.querySelector(`[data-ann-id="${ann.id}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      };
      bar.appendChild(seg);
    }
  };
  bar.onclick = (e) => {
    const rect = bar.getBoundingClientRect();
    audio.currentTime = ((e.clientX - rect.left) / rect.width) * session.duration;
  };
  body.appendChild(bar);

  // ── Global actions
  const actions = document.createElement('div');
  actions.className = 'flex items-center gap-2 mt-3';

  // Calibration tool: raw window dump (scores/margins) of the just-finished
  // import or live recording — live windows additionally carry `wallMs`.
  const dump = lastImportDump?.sessionId === session.id ? lastImportDump
    : lastLiveDump?.sessionId === session.id ? lastLiveDump
    : null;
  if (dump) {
    const dumpBtn = document.createElement('button');
    dumpBtn.className = 'text-[11px] text-dim hover:text-primary hover:underline cursor-pointer ml-auto';
    dumpBtn.textContent = t('sessions.dumpWindows');
    dumpBtn.onclick = () => {
      const blob = new Blob([JSON.stringify(dump.windows, null, 1)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${(session.name || 'session').replace(/[^\w-]+/g, '_')}-windows.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    };
    actions.appendChild(dumpBtn);
  }

  body.appendChild(actions);

  // ── Annotation list
  const listWrap = document.createElement('div');
  listWrap.className = 'mt-3 space-y-2';
  body.appendChild(listWrap);

  const previewBound = (tSec: number) => {
    audio.currentTime = Math.max(0, tSec);
    void audio.play().catch(() => { /* not loaded yet */ });
    setTimeout(() => audio.pause(), 3000);
  };

  // ── Per-annotation slice playback (seeks the main player, pauses at the end bound)
  let playingId: string | null = null;
  let sliceEnd = 0;
  audio.addEventListener('timeupdate', () => {
    if (playingId !== null && audio.currentTime >= sliceEnd) audio.pause();
  });
  audio.addEventListener('pause', () => {
    if (playingId !== null) { playingId = null; renderList(); }
  });
  const playSlice = (ann: SessionAnnotation) => {
    if (playingId === ann.id) { audio.pause(); return; }
    playingId = ann.id;
    sliceEnd = ann.end ?? session.duration;
    audio.currentTime = ann.start;
    void audio.play().catch(() => { playingId = null; });
    renderList();
  };

  const renderList = () => {
    listWrap.innerHTML = '';
    session.annotations.forEach((ann, i) => {
      const card = annotationCard(ann, {
        ctx: host.ctx,
        onPlay: audioUrl ? playSlice : undefined,
        playingId,
        sessionStartMs: session.date === null ? undefined : Date.parse(session.date),
        onOpenCard: (cardId) => { host.closeModal(); host.ctx.navigate({ view: 'card', cardId }); },
        onCardAdded: () => renderList(),
        getTargetDeckIds: () => targetDeckIds,
        ensureTargetDeckIds: ensureSummaryTargetDeckIds,
        onTargetDeckIdsChanged: refreshDeckBtn,
        onToggleLike: (id) => {
          const target = session.annotations.find(a => a.id === id);
          if (!target) return;
          target.liked = !target.liked;
          persist();
          renderList();
        },
        extraControls: (el) => {
          const controls = document.createElement('div');
          controls.className = 'flex items-center gap-2 flex-wrap pt-1 border-t border-border/50';

          // Bound adjustment: ±5 s with a 3 s audio preview at the new bound.
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
              set(Math.max(0, Math.min(session.duration, get() + delta)));
              val.textContent = `${label} ${fmtTime(get())}`;
              persist();
              renderBar();
              previewBound(get());
            };
            minus.onclick = () => apply(-5);
            plus.onclick = () => apply(+5);
            wrap.append(minus, val, plus);
            return wrap;
          };

          controls.appendChild(boundCtl('▸', () => ann.start, v => { ann.start = v; }));
          controls.appendChild(boundCtl('◂', () => ann.end ?? session.duration, v => { ann.end = v; }));

          // Add clip as a standalone MP3 attachment (known card only) —
          // fresh state, the card may be brand new. Hidden once the session's
          // audio has been forgotten, unless a clip was already extracted
          // before that (nothing left to extract, but still worth showing as done).
          const known = findByExternalId(`thesession:${ann.tuneId}`, getContext().user.cards);
          const already = known ? isClipAttached(session, ann) : false;
          if (known && (already || audioUrl)) {
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
                  await attachClip(host.ctx, session, ann, ratio => {
                    attachBtn.textContent = t('sessions.extracting', { pct: Math.round(ratio * 100) });
                  });
                  renderList();
                } catch (err) {
                  attachBtn.textContent = `⚠ ${String(err)}`;
                }
              };
            }
            controls.appendChild(attachBtn);
          }

          // Merge with previous annotation of the same tune (false set change)
          const prev = session.annotations[i - 1];
          if (prev && prev.tuneId === ann.tuneId) {
            const mergeBtn = document.createElement('button');
            mergeBtn.className = 'text-[11px] text-accent hover:underline cursor-pointer';
            mergeBtn.textContent = t('sessions.merge');
            mergeBtn.onclick = () => {
              prev.end = ann.end;
              prev.evidence = [...prev.evidence, ...ann.evidence];
              prev.confidence = Math.max(prev.confidence, ann.confidence);
              prev.bucket = prev.confidence >= 0.7 ? 'high' : prev.confidence >= 0.5 ? 'medium' : 'low';
              session.annotations.splice(i, 1);
              persist();
              renderList();
              renderBar();
            };
            controls.appendChild(mergeBtn);
          }

          // Delete
          const delBtn = document.createElement('button');
          delBtn.className = 'text-dim hover:text-danger transition-colors cursor-pointer ml-auto';
          delBtn.title = t('common.delete');
          delBtn.appendChild(iconElement(TrashIcon, 11));
          delBtn.onclick = () => {
            session.annotations.splice(i, 1);
            persist();
            renderList();
            renderBar();
          };
          controls.appendChild(delBtn);

          el.appendChild(controls);
        },
      });
      card.dataset['annId'] = ann.id;
      listWrap.appendChild(card);
    });
  };

  renderBar();
  renderList();
}

/** Stable identity of a clip, embedded in the filename: survives session
 *  renames and annotation relabels (session id fragment + start second). */
function clipTag(session: RecordedSession, ann: SessionAnnotation): string {
  return `[${session.id.slice(0, 8)}·${Math.round(ann.start)}]`;
}

function clipFileName(session: RecordedSession, ann: SessionAnnotation): string {
  const sessionName = session.name || defaultSessionName(session.date);
  const range = `${fmtTime(ann.start)}–${fmtTime(ann.end ?? session.duration)}`.replace(/:/g, 'm');
  return `${ann.displayName} — ${sessionName} (${range}) ${clipTag(session, ann)}.mp3`;
}

/** True when this exact clip is already attached, whatever it was renamed to look like. */
function isClipAttached(session: RecordedSession, ann: SessionAnnotation): boolean {
  const card = findByExternalId(`thesession:${ann.tuneId}`, getContext().user.cards);
  if (!card) return false;
  const tag = clipTag(session, ann);
  return card.content.attachments.some(a => a.type === 'file' && a.name.includes(tag));
}

/** Extracts the annotation's audio slice as a standalone MP3 file and attaches
 *  it to the card — independent from the session file. */
async function attachClip(
  ctx: AppContext,
  session: RecordedSession,
  ann: SessionAnnotation,
  onProgress?: (ratio: number) => void,
): Promise<boolean> {
  // getContext(): ctx.user is a snapshot from modal-open time — cards added
  // since (e.g. via "Add to Cadence" on a result) would be missed.
  if (!findByExternalId(`thesession:${ann.tuneId}`, getContext().user.cards)) return false;
  if (isClipAttached(session, ann)) return true;

  const audio = await loadSessionAudio(session.id);
  if (!audio) throw new Error(t('sessions.clip.unavailable'));

  const mp3 = await extractClipMp3(audio, ann.start, ann.end ?? session.duration, onProgress);
  const entry = await fileToEntry(new File([mp3], clipFileName(session, ann), { type: 'audio/mpeg' }));
  await ctx.mutate(s => {
    const card = findByExternalId(`thesession:${ann.tuneId}`, s.cards);
    if (card) card.content.attachments.push({ type: 'file', ...entry });
  });
  return true;
}
