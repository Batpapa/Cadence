import { useEffect, useRef, useState } from 'preact/hooks';
import type { AppContext } from '../../types';
import { t } from '../../services/i18nService';
import { focusIfDesktop } from '../../utils';
import { showModal, closeModal, renderModalBody } from '../../components/modal';
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

function ShareChoiceCard({ icon, label, desc, accentColor, onClick }: {
  icon: string; label: string; desc: string; accentColor: string; onClick: () => void;
}) {
  const [hover, setHover] = useState(false);
  return (
    <button
      class="flex items-center gap-3.5 w-full px-4 py-3.5 rounded-xl border border-border bg-bg text-left cursor-pointer"
      style={{ transition: 'border-color 0.15s, background 0.15s', borderColor: hover ? accentColor : undefined, background: hover ? `${accentColor}12` : undefined }}
      title={desc}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={onClick}
    >
      <span class="shrink-0 flex items-center" style={{ color: accentColor }} dangerouslySetInnerHTML={{ __html: icon }} />
      <div class="flex-1 text-sm font-medium text-primary">{label}</div>
      <span class="text-dim text-base leading-none shrink-0">›</span>
    </button>
  );
}

/** Same look as theSessionImport.ts's mkInputRow, without the unused info span. */
function KeyEntryStep({ onImported }: { onImported: (session: RecordedSession) => void }) {
  const [key, setKey] = useState('');
  const [status, setStatus] = useState('');
  const [importing, setImporting] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { focusIfDesktop(inputRef.current!); }, []);

  const doImport = () => {
    setImporting(true);
    setStatus(t('newCard.import.importing'));
    void importSharedSession(key.trim()).then(session => {
      closeModal();
      onImported(session);
    }).catch(e => {
      setStatus(t('theSession.error', { message: e instanceof Error ? e.message : String(e) }));
      setImporting(false);
    });
  };

  return (
    <>
      <div class="flex gap-2">
        <div class="flex-1 flex items-center bg-bg border border-border rounded px-3 py-2 transition-colors focus-within:border-accent">
          <input
            ref={inputRef}
            type="text"
            maxLength={6}
            class="flex-1 min-w-0 bg-transparent outline-none text-sm text-primary placeholder:text-dim"
            placeholder={t('newCard.share.placeholder')}
            value={key}
            onInput={(e) => setKey((e.target as HTMLInputElement).value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && key.trim().length === 6) doImport(); }}
          />
        </div>
        <button class="btn-primary text-xs shrink-0" disabled={importing || key.trim().length !== 6} onClick={doImport}>
          {t('newCard.share.importBtn')}
        </button>
      </div>
      <p class="text-xs text-muted min-h-[1.25rem]">{status}</p>
    </>
  );
}

function ImportSessionBody({ ctx }: { ctx: AppContext }) {
  const [step, setStep] = useState<'choice' | 'key'>('choice');

  if (step === 'key') {
    return <KeyEntryStep onImported={(session) => ctx.navigate({ view: 'sessions', sessionId: session.id })} />;
  }

  return (
    <div class="space-y-2">
      <ShareChoiceCard
        icon={SHARE_ICON_FILE_DOWN}
        label={t('library.export.file')}
        desc={t('sessions.share.fileImportDesc')}
        accentColor="var(--color-warn)"
        onClick={() => {
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
        }}
      />
      <ShareChoiceCard
        icon={SHARE_ICON_SHARE}
        label={t('newCard.share.label')}
        desc={t('newCard.share.desc')}
        accentColor="var(--color-accent)"
        onClick={() => setStep('key')}
      />
    </div>
  );
}

export function showImportSessionModal(ctx: AppContext): void {
  const { el, cleanup } = renderModalBody(<ImportSessionBody ctx={ctx} />);
  showModal(t('sessions.share.importTitle'), el, [], true, '28rem', cleanup);
}

/** The import phases that have a screen of their own. Exported so the view
 *  and the "one job at a time" guard below cannot drift apart. */
export const IMPORT_RUNNING_PHASES = ['initializing', 'decoding', 'analyzing', 'saving'];

/** Whether a recognition job is on screen right now — the SAME question the
 *  sessions view asks to decide what to render.
 *
 *  It used to be asked twice, differently: the view looked at the job's
 *  PHASE, the guard merely at the object's existence. Any session left
 *  behind in a phase the view does not show — idle, done, error, cancelled —
 *  therefore put the library on screen (nothing appears to be running) while
 *  silently refusing every import. Picking a file did nothing at all, with
 *  no way to tell that from a broken app. One definition, two readers. */
export function liveScreenActive(): boolean {
  const phase = activeLive.value?.getPhase();
  return !!phase && phase !== 'idle' && phase !== 'done';
}
export function importScreenActive(): boolean {
  const phase = activeImport.value?.getPhase();
  return !!phase && IMPORT_RUNNING_PHASES.includes(phase);
}
const recognitionBusy = () => liveScreenActive() || importScreenActive() || importStarting.value;

export async function startImport(ctx: AppContext, file: File): Promise<void> {
  // Never silently: a file the user picked that produces nothing and says
  // nothing is indistinguishable from an app that has stopped working.
  if (recognitionBusy()) { alertModal(t('sessions.import'), t('sessions.alreadyRunning')); return; }
  importStarting.value = true;

  try {
    await preflightImport(ctx, file);
  } catch (err) {
    // preflight probes the file and loads the streaming decoder; anything it
    // throws used to escape into a floating rejection nobody ever saw.
    alertModal(t('sessions.import'), String(err));
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
  if (recognitionBusy()) { alertModal(t('sessions.import'), t('sessions.alreadyRunning')); return; }
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
