import type { ComponentChild } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { AppContext } from '../../types';
import { t } from '../../services/i18nService';
import { focusIfDesktop, formatBytes, isMobileDevice } from '../../utils';
import { showModal, closeModal, closeAllModals, renderModalBody, alertModal, confirmModal } from '../../components/modal';
import { LiveSession } from '../liveSession';
import { editSessionTree, placeSession } from '../sessionTree';
import { ImportSession } from '../importSession';
import { probeAudioDuration, canPlayFile, type LiveSourceKind } from '../audio/sources';
import type { StreamProbe } from '../audio/streamingFileSource';
import { NoCapturedAudioError, DisplayCaptureUnsupportedError } from '../audio/capture';
import { importWarnMinutes, wholeFileDecodeBytes, IMPORT_MIN_S } from '../sessionConfig';
import { fileStartDate } from '../fileStartDate';
import { readRecordingStart } from '../audio/recordingDate';
import {
  loadSessionAudio, setSyncAudioByDefault, SYNC_AUDIO_BY_DEFAULT, pendingAudioUploads, uploadPendingAudio,
  setAutoLiveBackup, AUTO_LIVE_BACKUP_BY_DEFAULT,
} from '../db';
import { importSharedSession, importSessionFile } from '../../services/sessionShareService';
import { isDriveConnected } from '../../services/driveService';
import { TUNE_ANALYSER_MODULE_KEY, type Analysis, type TuneAnalyserModuleData } from '../model';
import { detectionsOnCards, pitchShiftSetting } from '../detections';
import { appState, mutate, getContext } from '../../store';
import { listLiveBackups, restoreLiveBackup, discardLiveBackup, type LiveBackupEntry } from '../liveBackup';
import { showRecoveryFailures } from './RecoveryFailureModal';
import { fmtSessionDateTime } from '../sessionNaming';
import { fmtLongTime } from './sessionUiShared';
import {
  activeLive, activeImport, setActiveLive, setActiveImport,
  lastImportDump, importStarting, importPlaybackWarn,
} from './sessionStore';
import { registerCardPanel } from '../../services/cardPanels';
import { DetectedIn } from './DetectedIn';

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
function KeyEntryStep({ onImported }: { onImported: (session: Analysis) => void }) {
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
  showModal(t('sessions.share.importTitle'), el, [], { maxWidth: '28rem', onDismiss: cleanup });
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

/** Files a brand-new analysis in the folder the library was showing.
 *
 *  Called with an id that does not exist as an analysis YET — the recording is
 *  still running, or the file is still being decoded. That is safe by
 *  construction: the tree only ever stores ids, and every read of it filters
 *  against the analyses that actually exist (sessionTree.ts's rootOrder /
 *  folderOrder), so the entry simply lies dormant until the analysis is saved.
 *  It also means the destination is already ticked in the folder chooser on the
 *  recording screen, where it can still be changed. */
function fileNewAnalysis(ctx: AppContext, sessionId: string, folderId: string | null): void {
  if (folderId === null) return; // the root is where an unplaced analysis already goes
  void ctx.mutate(s => editSessionTree(s, tr => placeSession(tr, sessionId, folderId)));
}

export async function startImport(ctx: AppContext, file: File, folderId: string | null = null): Promise<void> {
  // Never silently: a file the user picked that produces nothing and says
  // nothing is indistinguishable from an app that has stopped working.
  if (recognitionBusy()) { alertModal(t('sessions.import'), t('sessions.alreadyRunning')); return; }
  importStarting.value = true;

  try {
    await preflightImport(ctx, file, folderId);
  } catch (err) {
    // preflight probes the file and loads the streaming decoder; anything it
    // throws used to escape into a floating rejection nobody ever saw.
    alertModal(t('sessions.import'), String(err));
  } finally {
    importStarting.value = false;
  }
}

/** What the "too long for this browser" warning told the user, kept so that
 *  the failure it predicted can be named when it happens. Without it the
 *  import's catch only sees the decoder's own words — and Chrome reports a
 *  whole-file decode that ran out of room as an EncodingError, which read as
 *  "Format non décodable. Formats supportés : … M4A" on an M4A the browser had
 *  just opened (field report, 192 min, 2026-09-13). */
interface WholeFileWarning {
  min: number;
  need: string;
  limit: number;
  /** The probe's reason line, as the warning showed it. */
  why: string;
}

/** Why chunked decoding is unavailable: the sentence for the user, then the
 *  library's own words. Left in English on purpose — it is what we need read
 *  back to us from a phone we will never hold. */
function streamFailureLine(probe: StreamProbe): string {
  return t(`sessions.longFile.reason.${probe.reason ?? 'unknown'}`)
    + (probe.detail ? ` (${probe.detail})` : '');
}

/** The failure the long-file warning predicted: the arithmetic again, what to
 *  do about it, and the same reason line, so a screenshot of this one window
 *  still carries everything the warning did. */
function showWholeFileFailure(w: WholeFileWarning): void {
  const p = document.createElement('p');
  p.className = 'text-sm text-muted leading-relaxed';
  p.textContent = t('sessions.wholeFileFailed.message', { min: w.min, need: w.need, limit: w.limit });
  const hint = document.createElement('p');
  hint.className = 'text-sm text-muted leading-relaxed mt-2';
  hint.textContent = t('sessions.wholeFileFailed.hint', { limit: w.limit });
  const why = document.createElement('p');
  why.className = 'text-xs text-dim leading-relaxed mt-2';
  why.textContent = w.why;
  const body = document.createElement('div');
  body.append(p, hint, why);
  showModal(t('sessions.wholeFileFailed.title'), body, [{ label: t('common.close'), primary: true, onClick: closeModal }]);
}

async function preflightImport(ctx: AppContext, file: File, folderId: string | null = null): Promise<void> {
  const duration = await probeAudioDuration(file);
  if (duration !== null && duration < IMPORT_MIN_S) {
    alertModal(t('sessions.import'), t('sessions.tooShort', { n: IMPORT_MIN_S }));
    return;
  }

  // Chunk-by-chunk decoding (StreamingFileSource) keeps memory bounded
  // regardless of duration — the RAM warning below only applies to the
  // one-shot decodeAudioData fallback, so skip it when streaming will be used.
  const { StreamingFileSource } = await import('../audio/streamingFileSource');
  const probe = await StreamingFileSource.probe(file);
  probe.source?.stop();
  const canStream = probe.source !== null;

  // Logged whatever the duration, and even when nothing is shown: a short file
  // that falls back decodes fine, but it tells us the same thing about this
  // device as the long one that fails — and this is the line someone can read
  // back to us from a phone we will never hold.
  if (!canStream) {
    console.warn(`[sessions] chunked decoding unavailable (${probe.reason})`, probe.detail ?? '', file.type || '(no mime type)');
  }

  // The threshold follows the DEVICE, because the wall does: the same
  // whole-file decode that a desktop survives for an hour and a half kills a
  // phone tab in a quarter of an hour. A single number warned nobody on the
  // machine that needed it — see sessionConfig's derivation.
  const warnMinutes = importWarnMinutes(isMobileDevice());

  let wholeFileWarning: WholeFileWarning | undefined;
  if (!canStream && duration !== null && duration > warnMinutes * 60) {
    const warning: WholeFileWarning = {
      min: Math.round(duration / 60),
      need: formatBytes(wholeFileDecodeBytes(duration)),
      limit: warnMinutes,
      why: streamFailureLine(probe),
    };
    // Non-dismissable two-button modal: the promise always settles, so the
    // importStarting guard can never get stuck.
    const proceed = await new Promise<boolean>(resolve => {
      const p = document.createElement('p');
      p.className = 'text-sm text-muted leading-relaxed';
      // Says WHY, and gives both numbers the user can check: what this file
      // will cost, and where the limit is on this device. "Too long" alone is
      // a verdict; a verdict with its arithmetic is something to act on —
      // shorten the file, or move to a machine with room.
      p.textContent = t('sessions.longFile.message', { min: warning.min, need: warning.need, limit: warning.limit });
      // The precise reason, under the arithmetic. Two audiences in one line:
      // the sentence tells this user whether the fault is their file or their
      // browser (only one of those is worth acting on), and the technical
      // detail beside it is what we need read back to us.
      const why = document.createElement('p');
      why.className = 'text-xs text-dim leading-relaxed mt-2';
      why.textContent = warning.why;

      const body = document.createElement('div');
      body.append(p, why);

      showModal(t('sessions.longFile.title'), body, [
        { label: t('common.cancel'), onClick: () => { closeModal(); resolve(false); } },
        { label: t('common.confirm'), primary: true, onClick: () => { closeModal(); resolve(true); } },
      ], { dismissable: false });
    });
    if (!proceed) return;
    wholeFileWarning = warning;
  }

  importPlaybackWarn.value = !canPlayFile(file);

  const imp = new ImportSession(file, {});
  imp.pitchShift = pitchShiftSetting(appState.value);
  // A first guess at when it was recorded, in the date field from the start of
  // the analysis so it can be corrected there. The file's own record of it
  // first (recordingDate.ts — it survives being sent), its modification time
  // otherwise (fileStartDate). Only here, for a new import: re-analysing keeps
  // the date the analysis already has.
  imp.dateOverride = await readRecordingStart(file, duration)
    ?? fileStartDate(file.lastModified, duration, Date.now());
  fileNewAnalysis(ctx, imp.sessionId, folderId);
  setActiveImport(imp);
  await finishImportRun(ctx, imp, undefined, wholeFileWarning);
}

/** Runs an already-constructed ImportSession to completion and handles every
 *  outcome (saved / cancelled-with-partial / error) — shared by a fresh file
 *  import (preflightImport) and re-analyzing an existing session
 *  (startReanalyze), which only differ in how `imp` gets built.
 *  `onCancelledOrError` is where to land if nothing ends up saved — a fresh
 *  import has nowhere else to go (the reactive tree falls back to the
 *  library on its own once activeImport goes null); re-analyzing an existing
 *  session overrides this to fall back to that session's own (untouched)
 *  summary instead, which DOES need an explicit navigate().
 *  `wholeFileWarning` is set only when the user was warned this file would
 *  have to be decoded whole and went ahead anyway — then a decode failure is
 *  the one that warning predicted, not a bad format. */
async function finishImportRun(
  ctx: AppContext,
  imp: ImportSession,
  onCancelledOrError: () => void = () => {},
  wholeFileWarning?: WholeFileWarning,
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
    // ...unless DELETE is what cancelled it: that button means the analysis
    // goes, and asking whether to keep half of it answers a question nobody
    // was asking (2026-09-12).
    if (!imp.discardOnCancel && imp.getClosedCount() > 1) {
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
      ], { maxWidth: '28rem', onDismiss: dismiss }); // onDismiss covers the X button / outside click too
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
      if (wholeFileWarning) showWholeFileFailure(wholeFileWarning);
      else alertModal(t('sessions.import'), t('sessions.cantDecode'));
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
export async function startReanalyze(ctx: AppContext, session: Analysis): Promise<void> {
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
    // The setting as it is NOW, not as it was for the first analysis: this
    // re-runs the recording with what the user currently says about it.
    imp.pitchShift = pitchShiftSetting(appState.value);
    setActiveImport(imp);
    ctx.navigate({ view: 'sessions' });
    await finishImportRun(ctx, imp, () => ctx.navigate({ view: 'sessions', sessionId: session.id }));
  } finally {
    importStarting.value = false;
  }
}

/** Stores the instruments' pitch as the module's setting (engine semitones) —
 *  see TuneAnalyserModuleData.pitchShift. Written by the tuning fork on the
 *  module's screen and by the one on the live screen, so there is one value. */
export function setPitchShiftSetting(semitones: number): void {
  void mutate(s => {
    const m = (s.modules?.[TUNE_ANALYSER_MODULE_KEY] as TuneAnalyserModuleData | undefined) ?? { sessions: {} };
    // Absent is "as written", the one default this can have.
    if (semitones === 0) delete m.pitchShift; else m.pitchShift = semitones;
    s.modules = { ...(s.modules ?? {}), [TUNE_ANALYSER_MODULE_KEY]: m };
  });
}

/** Starts a live session on the chosen source. MUST be reached synchronously
 *  from the user's click: capturing a tab needs transient user activation,
 *  which the browser spends on the first await — see openDeviceAudio(). */
export function startLiveSession(ctx: AppContext, kind: LiveSourceKind = 'mic', folderId: string | null = null): void {
  const live = new LiveSession({}, kind);
  live.pitchShift = pitchShiftSetting(appState.value);
  fileNewAnalysis(ctx, live.sessionId, folderId);
  setActiveLive(live);
  void live.start().catch((err: unknown) => {
    // Acquisition failures are handled HERE rather than through onError,
    // because they happen before the live screen has had a chance to register
    // its callbacks — the failure would land on a listener that doesn't exist
    // yet, leaving the user parked on a recording screen that never records.
    // Anything failing later (index download, worker) still goes through
    // onError exactly as before.
    const name = err instanceof Error ? err.name : '';

    // Dismissing the browser's share picker is a decision, not a failure:
    // straight back to the library with nothing said. (The microphone keeps
    // its old behaviour — a denied mic permission is worth a message, and it
    // already gets one on the live screen.)
    if (kind === 'device' && (name === 'NotAllowedError' || name === 'AbortError' || name === 'NotFoundError')) {
      setActiveLive(null);
      return;
    }
    if (err instanceof NoCapturedAudioError) {
      setActiveLive(null);
      alertModal(t('sessions.source'), t('sessions.source.device.noAudio'));
      return;
    }
    if (err instanceof DisplayCaptureUnsupportedError) {
      setActiveLive(null);
      alertModal(t('sessions.source'), t('sessions.source.device.unsupported'));
      return;
    }
    /* anything else: surfaced via the onError callback, as before */
  });
}

// ── This module's contribution to the card page ───────────────────────────────
// At load, not at first use: appRoot imports SessionsView, which imports this
// file, so the registration has already happened by the time any card page
// renders. The panel decides for itself whether it has anything to say — see
// DetectedIn, which returns nothing for a card no session ever recognised.
registerCardPanel((cardId) => <DetectedIn cardId={cardId} />);

// ── This module's own settings ────────────────────────────────────────────────
// Behind a gear on the module's screen rather than inline on it: there is one
// preference today and it concerns what the module does ELSEWHERE (on card
// pages), which is not something the library screen is otherwise about.
//
// Stored on the module's slice, never on User — the core holds no flag about a
// panel it does not know exists. Saved on change with no confirmation, like the
// score playback preferences: one value, undone by setting it back.

function SettingRow({ checked, onToggle, label, hint, children }: {
  checked: boolean;
  onToggle: (next: boolean) => void;
  label: string;
  hint: string;
  children?: ComponentChild;
}) {
  return (
    <div>
      <label class="flex items-start gap-3 cursor-pointer select-none">
        <input
          type="checkbox"
          class="card-checkbox mt-0.5"
          checked={checked}
          onChange={(e) => onToggle((e.target as HTMLInputElement).checked)}
        />
        <span>
          <span class="text-sm text-primary">{label}</span>
          <span class="block text-xs text-muted mt-0.5">{hint}</span>
        </span>
      </label>
      {children}
    </div>
  );
}

/** Copies every recording this device holds that is not on Drive yet.
 *
 *  The setting above only ever applied to sessions saved AFTER it was switched
 *  on, which is not what "copy my recordings to Drive" sounds like — a user
 *  turned it on, saw nothing happen to their library, and reported the sync as
 *  broken. This is the missing half: the backlog, with its size stated before
 *  anything is spent, and disabled once there is none. */
function BackfillRow() {
  const [pending, setPending] = useState<{ ids: string[]; bytes: number } | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [result, setResult] = useState<{ ok: number; failed: number } | null>(null);

  const refresh = () => { void pendingAudioUploads().then(setPending); };
  useEffect(refresh, []);

  if (!pending) return null;

  const nothingToDo = pending.ids.length === 0;

  const run = () => {
    setResult(null);
    setProgress({ done: 0, total: pending.ids.length });
    void uploadPendingAudio((done, total) => setProgress({ done, total }))
      .then(r => { setResult(r); setProgress(null); refresh(); });
  };

  return (
    <div class="pt-3 border-t border-border space-y-2">
      <button class="btn-primary w-full text-sm" disabled={nothingToDo || progress !== null} onClick={run}>
        {progress
          ? t('sessions.syncAudio.backfill.running', { done: String(progress.done), total: String(progress.total) })
          : nothingToDo
            ? t('sessions.syncAudio.backfill.allDone')
            : t('sessions.syncAudio.backfill.action', {
              count: String(pending.ids.length),
              size: formatBytes(pending.bytes),
            })}
      </button>
      {result && (
        <p class={result.failed ? 'text-xs text-warn' : 'text-xs text-success'}>
          {result.failed
            ? t('sessions.syncAudio.backfill.partial', { ok: String(result.ok), failed: String(result.failed) })
            : t('sessions.syncAudio.backfill.done', { ok: String(result.ok) })}
        </p>
      )}
    </div>
  );
}

/** The live backups sitting on Drive, and what to do with each.
 *
 *  The automatic offer only ever appears on the device that recorded (see
 *  matchDevice), and that recognition can fail: a desktop browser whose data
 *  was cleared regenerates its id, and has no phone model to fall back on. This
 *  is the way in that never fails — someone who knows a backup exists comes
 *  looking for it here.
 *
 *  Opened on demand, never on the settings opening: listing costs Drive
 *  requests and may want a sign-in window, and most people have no backup at
 *  all. */
function DriveBackupsRow() {
  const [entries, setEntries] = useState<LiveBackupEntry[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    setLoading(true);
    setError(null);
    listLiveBackups(true)
      .then(setEntries)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  };

  const recover = (entry: LiveBackupEntry) => {
    if (!entry.meta) return;
    setBusyId(entry.sessionId);
    setError(null);
    restoreLiveBackup({ sessionId: entry.sessionId, folderId: entry.folderId, meta: entry.meta }, (done, total) => setProgress({ done, total }))
      .then(failure => {
        setBusyId(null);
        setProgress(null);
        if (failure) { showRecoveryFailures([failure], () => {}); return; }
        // Straight to what was just recovered: the library behind this dialog
        // read its list before any of this happened.
        closeAllModals();
        getContext().navigate({ view: 'sessions', sessionId: entry.sessionId });
      })
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : String(e));
        setBusyId(null);
        setProgress(null);
      });
  };

  const remove = (entry: LiveBackupEntry) => {
    confirmModal(
      t('sessions.liveBackup.offer.abandonTitle'),
      t('sessions.liveBackup.offer.abandonMessage'),
      t('sessions.liveBackup.offer.abandon'),
      () => {
        setBusyId(entry.sessionId);
        void discardLiveBackup(entry.sessionId, true).finally(() => {
          setBusyId(null);
          setEntries(list => (list ?? []).filter(e => e.sessionId !== entry.sessionId));
        });
      },
    );
  };

  return (
    <div class="pt-3 border-t border-border space-y-2">
      {entries === null ? (
        <button class="btn-ghost border border-border w-full text-sm" disabled={loading} onClick={load}>
          {loading ? t('sessions.liveBackup.list.loading') : t('sessions.liveBackup.list.show')}
        </button>
      ) : entries.length === 0 ? (
        <p class="text-xs text-muted">{t('sessions.liveBackup.list.empty')}</p>
      ) : (
        <div class="space-y-2">
          <p class="text-xs text-muted leading-relaxed">{t('sessions.liveBackup.list.hint')}</p>
          {entries.map(entry => (
            <div key={entry.sessionId} class="flex items-center gap-2 p-2 rounded border border-border">
              <div class="min-w-0 flex-1">
                <p class="text-sm text-primary truncate">
                  {entry.meta ? (entry.meta.name || t('sessions.liveBackup.offer.unnamed')) : t('sessions.liveBackup.list.unreadable')}
                </p>
                <p class="text-[11px] text-dim truncate">
                  {entry.meta ? `${fmtSessionDateTime(entry.meta.date)} · ${fmtLongTime(entry.meta.durationS)} · ` : ''}
                  {formatBytes(entry.bytes)}
                </p>
              </div>
              {entry.meta && (
                <button
                  class="btn-primary text-xs shrink-0"
                  disabled={busyId !== null}
                  onClick={() => recover(entry)}
                >
                  {busyId === entry.sessionId && progress
                    ? t('sessions.liveBackup.offer.downloading', { done: progress.done, total: progress.total })
                    : t('sessions.liveBackup.offer.recover')}
                </button>
              )}
              <button class="btn-danger text-xs shrink-0" disabled={busyId !== null} onClick={() => remove(entry)}>
                {t('sessions.liveBackup.list.delete')}
              </button>
            </div>
          ))}
        </div>
      )}
      {error && <p class="text-xs text-danger break-words">{t('sessions.liveBackup.list.failed', { error })}</p>}
    </div>
  );
}

function SessionSettingsBody() {
  // Read straight off appState rather than through db.ts's async accessors:
  // this component already re-renders on every state change, so the figures
  // below follow a session being embedded or dropped with nothing to refresh.
  const mod = appState.value.modules?.[TUNE_ANALYSER_MODULE_KEY] as TuneAnalyserModuleData | undefined;
  const synced = Object.values(mod?.syncedAudio ?? {});
  const syncedBytes = synced.reduce((sum, e) => sum + e.bytes, 0);
  // Copying recordings to Drive is meaningless without a Drive to copy them to,
  // and a checkbox that silently does nothing is worse than one that says why.
  const driveOn = isDriveConnected();

  return (
    <div class="space-y-4">
      <SettingRow
        checked={detectionsOnCards(appState.value)}
        label={t('sessions.detectionsOnCards')}
        hint={t('sessions.detectionsOnCards.hint')}
        onToggle={(next) => {
          void mutate(s => {
            const m = (s.modules?.[TUNE_ANALYSER_MODULE_KEY] as TuneAnalyserModuleData | undefined) ?? { sessions: {} };
            // Written only to turn it OFF — absence is the default here as
            // everywhere else in this codebase.
            if (next) delete m.detectionsOnCards; else m.detectionsOnCards = false;
            s.modules = { ...(s.modules ?? {}), [TUNE_ANALYSER_MODULE_KEY]: m };
          });
        }}
      />

      {/* Absent entirely without Drive rather than shown disabled: there is no
          Drive to copy to, so the setting has nothing to mean. */}
      {driveOn && (
        <SettingRow
          checked={mod?.syncAudioByDefault ?? SYNC_AUDIO_BY_DEFAULT}
          label={t('sessions.syncAudio')}
          hint={t('sessions.syncAudio.hint')}
          onToggle={(next) => { void setSyncAudioByDefault(next); }}
        >
          {/* Only once there is something to weigh: a zero here is noise. And no
              budget line — the limit is the user's own Drive quota, so this is
              information, not a gauge. */}
          {synced.length > 0 && (
            <p class="text-xs text-muted mt-2 ml-[27px]">
              {t(synced.length === 1 ? 'sessions.syncAudio.total' : 'sessions.syncAudio.totalPlural', {
                count: synced.length,
                size: formatBytes(syncedBytes),
              })}
            </p>
          )}
        </SettingRow>
      )}

      {/* Beside the "copy when saved" setting, because it answers the other half
          of the same worry: that one protects a finished recording, this one
          protects the recording being made. */}
      {driveOn && (
        <SettingRow
          checked={mod?.autoLiveBackup ?? AUTO_LIVE_BACKUP_BY_DEFAULT}
          label={t('sessions.autoLiveBackup')}
          hint={t('sessions.autoLiveBackup.hint')}
          onToggle={(next) => { void setAutoLiveBackup(next); }}
        />
      )}

      {driveOn && <BackfillRow />}
      {driveOn && <DriveBackupsRow />}
    </div>
  );
}

export function showSessionSettingsModal(): void {
  const { el, cleanup } = renderModalBody(<SessionSettingsBody />);
  // No footer: nothing to confirm, so nothing to press.
  showModal(t('sessions.settings.title'), el, [], { maxWidth: '26rem', onDismiss: cleanup });
}
