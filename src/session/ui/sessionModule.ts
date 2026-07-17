import type { AppContext, SessionRating } from '../../types';
import { t } from '../../services/i18nService';
import { fileToEntry } from '../../utils';
import { iconElement, TrashIcon, MicIcon, FileAudioIcon } from '../../components/icons';
import { playIcon, pauseIcon } from '../../components/playbackIcons';
import { confirmModal, showModal, closeModal } from '../../components/modal';
import { findByExternalId, fetchTuneById, tuneResultToCard } from '../../services/theSessionService';
import { LiveSession } from '../liveSession';
import { ImportSession } from '../importSession';
import { probeAudioDuration, canPlayFile } from '../audio/sources';
import { extractClipMp3 } from '../audio/clipExtract';
import { makeAbcNoteButton } from './abcPreview';
import { IMPORT_WARN_MINUTES, IMPORT_MIN_S } from '../sessionConfig';
import { listSessions, deleteSession, loadSessionAudio, saveSessionMeta } from '../db';
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
/** Bodies whose drag & drop listeners are already wired (renderLibrary re-runs). */
const dropWiredBodies = new WeakSet<HTMLElement>();
/** Synchronous re-entrancy guard: startImport awaits before setting activeImport. */
let importStarting = false;

export function isSessionRecording(): boolean {
  return activeLive !== null || activeImport !== null;
}

export interface SessionModuleHost {
  header: HTMLElement;
  body: HTMLElement;
  ctx: AppContext;
  onBack: () => void;         // back to the modules list
  closeModal: () => void;
  makeCloseBtn: () => HTMLElement;
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

/** Builds the module header; returns the title element so screens with an
 *  editable name (summary) can keep it in sync. */
function moduleHeader(host: SessionModuleHost, title: string, onBack: () => void): HTMLElement {
  host.header.innerHTML = '';
  const leftGroup = document.createElement('div');
  leftGroup.className = 'flex items-center gap-2';

  // Same back button as the library / TheSession-import headers.
  const backBtn = document.createElement('button');
  backBtn.className = 'text-dim hover:text-primary transition-colors cursor-pointer shrink-0';
  backBtn.textContent = '←';
  backBtn.onclick = onBack;

  const titleEl = document.createElement('h2');
  titleEl.className = 'text-xs font-semibold text-muted uppercase tracking-widest';
  titleEl.textContent = title;

  leftGroup.append(backBtn, titleEl);
  host.header.append(leftGroup, host.makeCloseBtn());
  return titleEl;
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
  onRelabel?: (ann: SessionAnnotation, alt: SessionAnnotation['alternates'][number]) => void;
  onOpenCard?: (cardId: string) => void;
  onCardAdded?: () => void;
  /** Play/stop this annotation's audio slice; shows a ▶ button when provided. */
  onPlay?: (ann: SessionAnnotation) => void;
  playingId?: string | null;
  extraControls?: (el: HTMLElement) => void; // summary-only controls appended to the card
  /** Unix ms of the session's t=0. When set, closed annotations of known cards
   *  get the "log this as a review" control (summary screen only). */
  sessionStartMs?: number;
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

  const nameEl = document.createElement('span');
  nameEl.className = 'text-sm font-semibold text-primary capitalize truncate flex-1';
  nameEl.textContent = ann.displayName;

  const badge = document.createElement('span');
  badge.className = `text-[10px] px-1.5 py-0.5 rounded-full shrink-0 ${BUCKET_BADGE[ann.bucket]}`;
  badge.textContent = ann.userConfirmed ? '✓' : t(`sessions.confidence.${ann.bucket}`);

  row1.append(nameEl, badge);

  const row2 = document.createElement('div');
  row2.className = 'text-xs text-muted';
  const range = ann.end === null
    ? `${fmtTime(ann.start)} · ${t('sessions.inProgress')}`
    : `${fmtTime(ann.start)} – ${fmtTime(ann.end)}`;
  row2.textContent = `${ann.dance} · ${ann.meter} · ${range}`;

  const row3 = document.createElement('div');
  row3.className = 'flex items-center gap-3 flex-wrap';

  if (known) {
    const openBtn = document.createElement('button');
    openBtn.className = 'text-xs text-accent hover:underline cursor-pointer';
    openBtn.textContent = t('sessions.openCard');
    openBtn.onclick = () => opts.onOpenCard?.(known.id);
    row3.appendChild(openBtn);
    if (opts.sessionStartMs !== undefined && ann.end !== null) {
      row3.appendChild(reviewLogControl(known.id, opts.sessionStartMs + ann.end * 1000, opts.ctx));
    }
  } else {
    const addBtn = document.createElement('button');
    addBtn.className = 'text-xs text-accent hover:underline cursor-pointer';
    addBtn.textContent = t('sessions.addCard');
    addBtn.onclick = async () => {
      addBtn.disabled = true;
      addBtn.textContent = '…';
      try {
        const tune = await fetchTuneById(Number(ann.tuneId));
        const card = tuneResultToCard(tune);
        await opts.ctx.mutate(s => { s.cards[card.id] = card; });
        opts.onCardAdded?.();
      } catch {
        addBtn.disabled = false;
        addBtn.textContent = t('sessions.addCard');
      }
    };
    row3.appendChild(addBtn);
  }

  // Redundant once the card exists — its page already links to the source.
  if (!known) {
    const tsLink = document.createElement('a');
    tsLink.className = 'text-xs text-dim hover:text-primary hover:underline';
    tsLink.href = `https://thesession.org/tunes/${ann.tuneId}`;
    tsLink.target = '_blank';
    tsLink.rel = 'noopener';
    tsLink.textContent = t('sessions.viewOnTheSession');
    row3.appendChild(tsLink);
  }

  el.append(row1, row2, row3);

  // Alternates: tap the card body to expand; each candidate can be explored
  // (sheet + synth, TheSession page) before being elected.
  if (ann.alternates.length > 0 && opts.onRelabel) {
    const altWrap = document.createElement('div');
    altWrap.className = 'space-y-0.5 hidden pt-1 border-t border-border/50';
    for (const alt of ann.alternates) {
      const altRow = document.createElement('div');
      altRow.className = 'flex items-center gap-2 px-2 py-1 rounded hover:bg-elevated transition-colors text-[11px]';

      const altName = document.createElement('span');
      altName.className = 'truncate capitalize text-muted flex-1';
      altName.textContent = `${alt.displayName} (${Math.round(alt.meanScore * 100)}%)`;

      const altAbc = makeAbcNoteButton(alt.settingId, alt.displayName, 11);

      const altTs = document.createElement('a');
      altTs.className = 'text-dim hover:text-primary shrink-0';
      altTs.href = `https://thesession.org/tunes/${alt.tuneId}`;
      altTs.target = '_blank';
      altTs.rel = 'noopener';
      altTs.textContent = '↗';
      altTs.title = t('sessions.viewOnTheSession');
      altTs.onclick = (e) => e.stopPropagation();

      const altPick = document.createElement('button');
      altPick.className = 'text-accent hover:underline cursor-pointer shrink-0';
      altPick.textContent = t('sessions.relabel');
      altPick.onclick = (e) => { e.stopPropagation(); opts.onRelabel!(ann, alt); };

      altRow.append(altName, altAbc, altTs, altPick);
      altWrap.appendChild(altRow);
    }
    el.appendChild(altWrap);
    row1.classList.add('cursor-pointer');
    row1.onclick = () => altWrap.classList.toggle('hidden');
  }

  opts.extraControls?.(el);
  return el;
}

// ── Screen: library ───────────────────────────────────────────────────────────

function renderLibrary(host: SessionModuleHost): void {
  moduleHeader(host, t('sessions.moduleTitle'), host.onBack);
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
  fileInput.accept = 'audio/*';
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

  const listWrap = document.createElement('div');
  listWrap.className = 'mt-4 space-y-2';
  body.appendChild(listWrap);

  void listSessions().then(sessions => {
    if (sessions.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'text-xs text-dim text-center py-4';
      empty.textContent = t('sessions.empty');
      listWrap.appendChild(empty);
      return;
    }
    for (const session of sessions) {
      const row = document.createElement('div');
      row.className = 'flex items-center gap-3 p-3 rounded-lg border border-border bg-bg hover:border-accent/50 transition-colors cursor-pointer group';
      row.onclick = () => renderSummary(host, session);

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

      const delBtn = document.createElement('button');
      delBtn.className = 'text-dim hover:text-danger transition-colors cursor-pointer shrink-0 opacity-0 group-hover:opacity-100';
      delBtn.title = t('common.delete');
      delBtn.appendChild(iconElement(TrashIcon, 12));
      delBtn.onclick = (e) => {
        e.stopPropagation();
        confirmModal(t('sessions.delete.title'), t('sessions.delete.message', { name: session.name || defaultSessionName(session.date) }), t('common.delete'), () => {
          void deleteSession(session.id).then(() => renderLibrary(host));
        });
      };
      row.appendChild(delBtn);

      listWrap.appendChild(row);
    }
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
  if (duration !== null && duration > IMPORT_WARN_MINUTES * 60) {
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
  activeImport = imp;
  renderImportAnalysis(host);

  try {
    const session = await imp.start();
    if (session) {
      lastImportDump = { sessionId: session.id, windows: [...imp.windows] };
      activeImport = null;
      renderSummary(host, session);
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
            activeImport = null;
            renderSummary(host, session2);
          });
        },
      );
      // If the user dismisses the modal, the library below is already rendered.
    }
    activeImport = null;
    renderLibrary(host);
  } catch (err) {
    activeImport = null;
    const msg = String(err);
    if (msg.includes('too-short')) {
      alertModal(t('sessions.import'), t('sessions.tooShort', { n: IMPORT_MIN_S }));
    } else if (msg.includes('decod') || msg.includes('Decod') || msg.includes('EncodingError')) {
      alertModal(t('sessions.import'), t('sessions.cantDecode'));
    } else {
      alertModal(t('sessions.import'), msg);
    }
    renderLibrary(host);
  }
}

function renderImportAnalysis(host: SessionModuleHost): void {
  const imp = activeImport;
  if (!imp) { renderLibrary(host); return; }

  moduleHeader(host, t('sessions.import'), () => renderLibrary(host));
  const body = host.body;
  body.innerHTML = '';

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

  topRow.append(label, pctEl, cancelBtn);

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
  activeLive = new LiveSession({});
  renderLive(host);
  void activeLive.start().catch(() => { /* error surfaced via onError callback */ });
}

function renderLive(host: SessionModuleHost): void {
  const live = activeLive;
  if (!live) { renderLibrary(host); return; }

  moduleHeader(host, t('sessions.moduleTitle'), () => renderLibrary(host));
  const body = host.body;
  body.innerHTML = '';

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

  const stopBtn = document.createElement('button');
  stopBtn.className = 'btn-danger px-3 shrink-0';
  stopBtn.textContent = t('sessions.stop');

  statusBar.append(recDot, recLbl, chrono, vu, stopBtn);

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

  // Mobile browsers may suspend a backgrounded tab and interrupt the recording.
  const bgWarning = document.createElement('p');
  bgWarning.className = 'text-xs text-amber-500 mt-2 text-center hidden';
  bgWarning.textContent = t('sessions.bgWarning');
  const onVisibility = () => {
    if (document.visibilityState === 'visible' && live.getPhase() === 'recording') {
      bgWarning.classList.remove('hidden');
      setTimeout(() => bgWarning.classList.add('hidden'), 8000);
    }
  };
  document.addEventListener('visibilitychange', onVisibility);

  body.append(statusBar, initStatus, bgWarning, feed, stateZone, abcTicker);

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

  const startTimers = () => {
    chronoId = window.setInterval(() => {
      chrono.textContent = fmtLongTime((Date.now() - live.startedAt) / 1000);
    }, 1000);
    rafId = requestAnimationFrame(vuLoop);
  };

  const renderFeed = (annotations: SessionAnnotation[]) => {
    const nearBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 80;
    feed.innerHTML = '';
    for (const ann of annotations) {
      feed.appendChild(annotationCard(ann, {
        ctx: host.ctx,
        onRelabel: (a, alt) => { live.relabel(a.id, alt); },
        onOpenCard: (cardId) => { host.closeModal(); host.ctx.navigate({ view: 'card', cardId }); },
        onCardAdded: () => renderFeed(live.getAnnotations()),
      }));
    }
    if (nearBottom) body.scrollTop = body.scrollHeight;
  };

  live.setCallbacks({
    onPhase: (phase) => {
      if (phase === 'recording') {
        initStatus.textContent = '';
        startTimers();
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
    startTimers();
    renderFeed(live.getAnnotations());
  } else if (live.getPhase() === 'initializing') {
    initStatus.textContent = t('sessions.initializing');
  }

  stopBtn.onclick = async () => {
    stopBtn.disabled = true;
    stopBtn.classList.add('opacity-50');
    cleanup();
    try {
      const session = await live.stop();
      activeLive = null;
      renderSummary(host, session);
    } catch (err) {
      activeLive = null;
      initStatus.textContent = `⚠ ${String(err)}`;
    }
  };
}

// ── Screen: summary ───────────────────────────────────────────────────────────

function renderSummary(host: SessionModuleHost, session: RecordedSession): void {
  const headerTitle = moduleHeader(host, session.name || defaultSessionName(session.date), () => renderLibrary(host));
  const syncHeader = () => { headerTitle.textContent = session.name || defaultSessionName(session.date); };
  const body = host.body;
  body.innerHTML = '';

  const persist = () => { void saveSessionMeta(session); };

  // ── Title
  const titleInp = document.createElement('input');
  titleInp.type = 'text';
  titleInp.className = 'input text-sm w-full';
  titleInp.placeholder = t('sessions.titlePlaceholder');
  titleInp.value = session.name || defaultSessionName(session.date);
  titleInp.addEventListener('blur', () => {
    const val = titleInp.value.trim();
    if (val) { session.name = val; persist(); syncHeader(); }
  });
  body.appendChild(titleInp);

  // ── Session start date (t=0 of every review logged from this session).
  // Optional: live sessions arrive with one, imports without. Erasable — the
  // review-log controls only exist while a date is set.
  const toLocalInput = (iso: string): string => {
    const d = new Date(iso);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };
  const dateRow = document.createElement('div');
  dateRow.className = 'flex items-center gap-2 mt-2';
  const dateInp = document.createElement('input');
  dateInp.type = 'datetime-local';
  dateInp.className = 'input text-sm';
  dateInp.value = session.date ? toLocalInput(session.date) : '';
  dateInp.max = toLocalInput(new Date().toISOString());
  const dateClear = document.createElement('button');
  dateClear.className = 'text-xs text-dim hover:text-danger cursor-pointer shrink-0';
  dateClear.textContent = t('sessions.dateClear');
  const dateNow = document.createElement('button');
  dateNow.className = 'text-xs text-dim hover:text-accent cursor-pointer shrink-0';
  dateNow.textContent = t('sessions.dateNow');
  const syncBtns = () => {
    dateClear.style.display = session.date ? '' : 'none';
    dateNow.style.display   = session.date ? 'none' : '';
  };
  const applyDate = (date: string | null) => {
    session.date = date;
    dateInp.value = date ? toLocalInput(date) : '';
    syncBtns();
    syncHeader(); // an unnamed session's default name embeds the date
    persist();
    renderList(); // review-log controls (dis)appear / re-anchor on the new t=0
  };
  dateInp.addEventListener('change', () => {
    if (!dateInp.value) { applyDate(null); return; }
    // 'YYYY-MM-DDTHH:mm' without offset parses as local time — what the picker shows.
    const ms = Date.parse(dateInp.value);
    if (Number.isNaN(ms) || ms > Date.now()) { dateInp.value = session.date ? toLocalInput(session.date) : ''; return; }
    applyDate(new Date(ms).toISOString());
  });
  dateClear.onclick = () => applyDate(null);
  dateNow.onclick = () => applyDate(new Date().toISOString());
  syncBtns();
  dateRow.append(dateInp, dateNow, dateClear);
  body.appendChild(dateRow);

  // ── Audio player
  const audio = document.createElement('audio');
  audio.controls = true;
  audio.className = 'w-full mt-3';
  let audioUrl: string | null = null;
  void loadSessionAudio(session.id).then(blob => {
    if (!blob) return;
    audioUrl = URL.createObjectURL(blob);
    audio.src = audioUrl;
  });
  host.registerCleanup(() => { if (audioUrl) URL.revokeObjectURL(audioUrl); });
  body.appendChild(audio);

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

  // Calibration tool: raw window dump (scores/margins) of the just-finished import.
  if (lastImportDump?.sessionId === session.id) {
    const dump = lastImportDump;
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
        onPlay: playSlice,
        playingId,
        sessionStartMs: session.date === null ? undefined : Date.parse(session.date),
        onRelabel: (a, alt) => {
          a.tuneId = alt.tuneId;
          a.settingId = alt.settingId;
          a.displayName = alt.displayName;
          a.userConfirmed = true;
          persist();
          renderList();
          renderBar();
        },
        onOpenCard: (cardId) => { host.closeModal(); host.ctx.navigate({ view: 'card', cardId }); },
        onCardAdded: () => renderList(),
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
          // fresh state, the card may be brand new
          const known = findByExternalId(`thesession:${ann.tuneId}`, getContext().user.cards);
          if (known) {
            const already = isClipAttached(session, ann);
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
