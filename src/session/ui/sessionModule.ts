import type { AppContext } from '../../types';
import { t } from '../../services/i18nService';
import { focusIfDesktop } from '../../utils';
import { showModal, closeModal } from '../../components/modal';
import { LiveSession } from '../liveSession';
import { ImportSession } from '../importSession';
import { probeAudioDuration, canPlayFile } from '../audio/sources';
import { IMPORT_WARN_MINUTES, IMPORT_MIN_S } from '../sessionConfig';
import { loadSessionAudio } from '../db';
import { importSharedSession, importSessionFile } from '../../services/sessionShareService';
import type { RecordedSession } from '../model';
import {
  activeLive, activeImport, setActiveLive, setActiveImport,
  lastImportDump, importStarting, importPlaybackWarn,
} from './sessionStore';

// ── Session orchestration ─────────────────────────────────────────────────────
// Actions that start/stop/import a session — everything that used to also
// imperatively mount a screen here now just flips a sessionStore signal:
// sessions.tsx's component tree reads activeLive/activeImport directly and
// re-renders on its own (@preact/signals tracks the reads), so there is
// nothing left to imperatively trigger from here. What remains is genuine
// orchestration with no natural home in a single screen component: starting
// a recording/import, the "import a shared session" modal, and re-analysis.

// Same icon glyphs as the card import/export flow (theSessionImport.ts's
// mkChoiceCard SVGs / library.tsx's export trigger) — kept as a local copy
// rather than shared, matching how those two already don't share code with
// each other either.
const SHARE_ICON_FILE_DOWN = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="3" x2="12" y2="15"/></svg>';
const SHARE_ICON_SHARE = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>';

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

export function showImportSessionModal(ctx: AppContext): void {
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
        ctx.navigate({ view: 'sessions', sessionId: session.id });
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
        ctx.navigate({ view: 'sessions', sessionId: session.id });
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

export async function startImport(ctx: AppContext, file: File): Promise<void> {
  if (activeImport.value || activeLive.value || importStarting.value) return; // one recognition job at a time
  importStarting.value = true;

  try {
    await preflightImport(ctx, file);
  } finally {
    importStarting.value = false;
  }
}

async function preflightImport(ctx: AppContext, file: File): Promise<void> {
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

  importPlaybackWarn.value = !canPlayFile(file);

  const imp = new ImportSession(file, {});
  setActiveImport(imp);
  await finishImportRun(ctx, imp);
}

/** Runs an already-constructed ImportSession to completion and handles every
 *  outcome (saved / cancelled-with-partial / error) — shared by a fresh file
 *  import (preflightImport) and re-analyzing an existing session
 *  (startReanalyze), which only differ in how `imp` gets built.
 *  `onCancelledOrError` is where to land if nothing ends up saved — a fresh
 *  import has nowhere else to go (the reactive tree falls back to the
 *  library on its own once activeImport goes null); re-analyzing an existing
 *  session overrides this to fall back to that session's own (untouched)
 *  summary instead, which DOES need an explicit navigate(). */
async function finishImportRun(
  ctx: AppContext,
  imp: ImportSession,
  onCancelledOrError: () => void = () => {},
): Promise<void> {
  try {
    const session = await imp.start();
    if (session) {
      lastImportDump.value = { sessionId: session.id, windows: [...imp.windows] };
      setActiveImport(null);
      ctx.navigate({ view: 'sessions', sessionId: session.id });
      return;
    }
    // Cancelled: offer to keep the partial result when enough was recognised.
    if (imp.getClosedCount() > 1) {
      // Deliberately NOT falling through to the unconditional fallback below
      // while this decision is pending (2026-08-23 bug fix): re-analyzing an
      // existing session reuses the SAME sessionId for both outcomes, and
      // SessionsView only reloads its data when the route's sessionId
      // actually CHANGES (see sessions.tsx's SessionByIdScreen effect).
      // Eagerly navigating to session.id here (to have "the fallback screen
      // already rendered" if the user dismisses) used to run BEFORE the
      // user's choice was known — so clicking "Keep" landed on the SAME
      // sessionId a second time, sessionId-unchanged, no reload: the screen
      // kept showing the stale pre-reanalysis result (A) instead of the
      // freshly-saved partial one (B). Only ever navigate ONCE, after the
      // outcome is known, so the sessionId always genuinely changes (or is
      // the first navigation to it this run).
      const dismiss = () => { setActiveImport(null); onCancelledOrError(); };
      const body = document.createElement('p');
      body.className = 'text-sm text-muted leading-relaxed';
      body.textContent = t('sessions.keepPartial.message', { n: imp.getClosedCount() });
      showModal(t('sessions.keepPartial.title'), body, [
        { label: t('common.cancel'), onClick: () => { closeModal(); dismiss(); } },
        {
          label: t('sessions.keepPartial.keep'), danger: true, onClick: () => {
            closeModal();
            void imp.keepPartial().then(session2 => {
              lastImportDump.value = { sessionId: session2.id, windows: [...imp.windows] };
              setActiveImport(null);
              ctx.navigate({ view: 'sessions', sessionId: session2.id });
            });
          },
        },
      ], true, '28rem', dismiss); // onDismiss covers the X button / outside click too
      return;
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
export async function startReanalyze(ctx: AppContext, session: RecordedSession): Promise<void> {
  if (activeImport.value || activeLive.value || importStarting.value) return; // one recognition job at a time
  importStarting.value = true;
  try {
    const blob = await loadSessionAudio(session.id);
    if (!blob) return;
    const file = new File([blob], session.name || 'session', { type: blob.type || session.mimeType });
    const imp = new ImportSession(file, {}, session.id);
    imp.name = session.name;
    imp.dateOverride = session.date;
    imp.sourceOverride = session.source;
    setActiveImport(imp);
    ctx.navigate({ view: 'sessions' });
    await finishImportRun(ctx, imp, () => ctx.navigate({ view: 'sessions', sessionId: session.id }));
  } finally {
    importStarting.value = false;
  }
}

export function startLiveSession(): void {
  setActiveLive(new LiveSession({}));
  void activeLive.value!.start().catch(() => { /* error surfaced via onError callback */ });
}
