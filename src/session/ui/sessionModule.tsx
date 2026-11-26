import type { AppContext } from '../../types';
import { t } from '../../services/i18nService';
import { formatBytes } from '../../utils';
import { isMobileDevice, isAppleTouchDevice } from '../../services/device';
import { showModal, closeModal, alertModal, MODAL_W } from '../../components/modal';
import { LiveSession } from '../liveSession';
import { editSessionTree, placeSession, sessionTreeOf } from '../sessionTree';
import { ImportSession } from '../importSession';
import { probeAudioDuration, canPlayFile, type LiveSourceKind } from '../audio/sources';
import type { StreamProbe } from '../audio/streamingFileSource';
import { NoCapturedAudioError, DisplayCaptureUnsupportedError } from '../audio/capture';
import { importWarnMinutes, wholeFileDecodeBytes, IMPORT_MIN_S } from '../sessionConfig';
import { fileStartDate } from '../fileStartDate';
import { readRecordingStart } from '../audio/recordingDate';
import {
  loadSessionAudio
} from '../db';
import { type Analysis } from '../model';
import { appState } from '../../store';
import { nameTemplateSetting, launchNameTemplate } from '../sessionNaming';
import {
  activeLive, activeImport, setActiveLive, setActiveImport,
  lastImportDump, importStarting, importPlaybackWarn,
} from './sessionStore';
import { registerCardPanel } from '../../services/cardPanels';
import { registerCardPassages } from '../../components/cardAudioSync';
import { cardPassages } from './cardPassages';
import { DetectedIn } from './DetectedIn';
import { showLinkImportModal } from './LinkImportModal';

// ── Session orchestration ─────────────────────────────────────────────────────
// Actions that start/stop/import a session — everything that used to also
// imperatively mount a screen here now just flips a sessionStore signal:
// sessions.tsx's component tree reads activeLive/activeImport directly and
// re-renders on its own (@preact/signals tracks the reads), so there is
// nothing left to imperatively trigger from here. What remains is genuine
// orchestration with no natural home in a single screen component: starting
// a recording/import, and re-analysis. The "import a shared session" dialog
// and the module's settings have files of their own since 2026-11-26
// (importSessionModal.tsx, sessionSettingsModal.tsx).

/** The import phases that have a screen of their own. Exported so the view
 *  and the "one job at a time" guard below cannot drift apart. */
export const IMPORT_RUNNING_PHASES = ['initializing', 'decoding', 'analyzing', 'extracting', 'saving'];

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

/** "Import a link": the recording is downloaded first, then imported exactly
 *  as a picked file. Refused up front when a job is running, rather than
 *  after a download that could take minutes. */
export function startLinkImport(ctx: AppContext, folderId: string | null = null): void {
  if (recognitionBusy()) { alertModal(t('sessions.import'), t('sessions.alreadyRunning')); return; }
  showLinkImportModal((file) => { void startImport(ctx, file, folderId); });
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
  // An iPad is wide enough to pass for a desktop by its width, and its tab
  // dies as early as a phone's.
  const warnMinutes = importWarnMinutes(isMobileDevice() || isAppleTouchDevice());

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

  // A video says nothing yet: its audio is extracted before the analysis
  // starts, and THAT is what the screen will play — an m4a or a WAV, where the
  // video itself could not be opened at all. The import announces the file it
  // settled on (onPlaybackFile) and the answer is given there; warning here
  // would only flash a line that the next two seconds contradict. Nothing can
  // be played during those two seconds anyway: there is no detection yet.
  importPlaybackWarn.value = !file.type.startsWith('video/') && !canPlayFile(file);

  const imp = new ImportSession(file, {});
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
      ], { maxWidth: MODAL_W.m, onDismiss: dismiss }); // onDismiss covers the X button / outside click too
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
/** `audio`: the recording brought down from Drive for this re-analysis only
 *  (2026-11-05) — run on, and NOT stored here: the user did not ask to keep it
 *  on this device. Absent, the one stored here. */
export async function startReanalyze(ctx: AppContext, session: Analysis, audio?: Blob): Promise<void> {
  if (recognitionBusy()) { alertModal(t('sessions.import'), t('sessions.alreadyRunning')); return; }
  importStarting.value = true;
  try {
    const blob = audio ?? await loadSessionAudio(session.id);
    if (!blob) return;
    const file = new File([blob], session.name || 'session', { type: blob.type || session.mimeType });
    const imp = new ImportSession(file, {}, session.id);
    imp.name = session.name;
    imp.dateOverride = session.date;
    imp.sourceOverride = session.source;
    imp.notes = session.notes;
    // Still where the live recording was paused: the file is the same.
    imp.pauses = session.pauses ? [...session.pauses] : [];
    // The recording re-run is one already kept: "Keep the recordings" is about
    // new ones, and turned off it must not drop this one. One brought down
    // from Drive for the occasion stays off this device, as it came.
    imp.keepAudio = !audio;
    setActiveImport(imp);
    ctx.navigate({ view: 'sessions' });
    await finishImportRun(ctx, imp, () => ctx.navigate({ view: 'sessions', sessionId: session.id }));
  } finally {
    importStarting.value = false;
  }
}

/** Starts a live session on the chosen source. MUST be reached synchronously
 *  from the user's click: capturing a tab needs transient user activation,
 *  which the browser spends on the first await — see openDeviceAudio(). */
export function startLiveSession(ctx: AppContext, kind: LiveSourceKind = 'mic', folderId: string | null = null): void {
  const live = new LiveSession({}, kind);
  // The folder it starts in, for {folder}: read now and never again (the
  // user's rule, 2026-10-16) — see sessionNaming.ts.
  const folderName = folderId === null ? null : sessionTreeOf(appState.value).folders[folderId]?.name ?? null;
  live.nameTemplate = launchNameTemplate(nameTemplateSetting(appState.value), folderName);
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
    // The Android app's capture, on Android 9 or older. By name: the class
    // lives in a native-only module this one does not load.
    if (name === 'SystemAudioUnsupportedError') {
      setActiveLive(null);
      alertModal(t('sessions.source'), t('sessions.source.device.unsupportedApp'));
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
// Its passes, followed by a card's own score too (cardAudioSync.ts).
registerCardPassages(cardPassages);
