import fixWebmDuration from 'fix-webm-duration';
import {
  listDraftSessions, collectChunks, clearChunks, saveSessionAudio, saveSessionMeta, loadSessionAudio,
  loadSessionWindows, deleteSessionWindows, deleteSession,
} from './db';
import { RECORDER_TIMESLICE_MS, ANALYSIS_HOP_S } from './sessionConfig';
import { IncrementalViterbiSegmenter } from './recognition/viterbiSegmenter';
import type { Analysis, DetectionEvent, Detection, WindowResult } from './model';

// ── Crash/refresh recovery ─────────────────────────────────────────────────────
// A live recording writes its audio chunks to IndexedDB continuously (see
// audio/recorder.ts) and its raw per-window recognition results progressively
// (see liveSession.ts's onWindow handler), tagged `status: 'recording'`. A
// refresh or crash mid-session leaves that draft row, its chunks, and its
// windows dump orphaned — there is no manual resume: the next time the
// library loads, any such session is silently finalized with whatever made
// it to IndexedDB before the interruption, exactly as if the user had
// pressed stop at that point. Only a recovery that FAILS reaches the user —
// see "When recovery fails" below.

/** Replays raw windows through a FRESH detector in one shot — never trusts a
 *  persisted detection snapshot (2026-08-15): a snapshot taken at an
 *  arbitrary instant (here, whatever made it to IndexedDB before a crash) can
 *  catch a short-lived, not-yet-confirmed guess (minSegmentWindows/'retract'
 *  in viterbiSegmenter.ts) that blanket-finalizing would wrongly resurrect as
 *  a real detection.
 *
 *  A clean LiveSession.stop()/ImportSession.save() does NOT need this
 *  extra replay (2026-08-21): viterbiSegmenter.ts now only marks a segment
 *  `finalized` once ViterbiResult.convergedThroughIndex proves no future
 *  window could ever revise it (see its doc — this replaced an EMPIRICAL
 *  finalizationLagSeconds time guess that turned out not to be a real
 *  guarantee, per a 2026-08-21 bug report of two duplicate "Rolling Waves"
 *  results from one performance), so a clean finish's live-accumulated
 *  detection map is already provably identical to what this function would
 *  produce. This function stays needed only where there's no live map left
 *  to trust at all — a crash/refresh loses it entirely, leaving just the raw
 *  windows dump to replay.
 *
 *  Loses any userConfirmed/liked edits made before the crash (including a
 *  manual tune-identity override via selectAlternate(), 2026-08-25 — same
 *  userConfirmed flag) — those only ever lived in the in-memory detection
 *  map, never persisted independently of it. Accepted tradeoff (explicit
 *  user call): correctness of the recognition result matters more than
 *  preserving mid-session manual edits across a crash. */
export function recomputeDetections(windows: WindowResult[], hopS: number = ANALYSIS_HOP_S): Detection[] {
  const segmenter = new IncrementalViterbiSegmenter(hopS);
  const store = new Map<string, Detection>();
  const apply = (events: DetectionEvent[]) => {
    for (const ev of events) {
      if (ev.type === 'retract') { store.delete(ev.id); continue; }
      store.set(ev.detection.id, ev.detection);
    }
  };
  apply(segmenter.feedAll(windows));
  apply(segmenter.finalize());
  return [...store.values()].sort((a, b) => a.start - b.start);
}

async function finalizeOrphan(session: Analysis): Promise<void> {
  const chunks = await collectChunks(session.id);
  const mimeType = session.mimeType || 'audio/webm';
  let blob = new Blob(chunks, { type: mimeType });
  // Chunk count × timeslice is a better duration estimate than wall-clock
  // deltas here — it isn't thrown off by a backgrounded/suspended tab. But it
  // only holds while one chunk is one timeslice: a recording put back from its
  // Drive backup (liveBackup.ts) arrives as a few parts of many chunks each,
  // and would be stamped a few minutes long. Its draft carries the elapsed time
  // instead, so the larger of the two stands.
  const durationMs = Math.max(chunks.length * RECORDER_TIMESLICE_MS, session.duration * 1000);

  if (mimeType.includes('webm') && blob.size > 0) {
    try {
      blob = await fixWebmDuration(blob, durationMs, { logger: false });
    } catch { /* seeking degraded but audio intact */ }
  }

  const windows = await loadSessionWindows(session.id);
  const annotations = windows
    ? recomputeDetections(windows)
    // Fallback for a draft persisted before this replay mechanism existed
    // (no windows dump to replay) — same as before: trust the snapshot,
    // just stamp it final so it doesn't reach the summary screen looking
    // like it's still live.
    : session.annotations.map(a => ({ ...a, finalized: true }));

  await saveSessionAudio(session.id, blob);
  await saveSessionMeta({
    ...session,
    duration: Math.max(session.duration, durationMs / 1000),
    status: 'done',
    annotations,
  });
  await clearChunks(session.id);
  if (windows) await deleteSessionWindows(session.id);
}

// ── When recovery fails (2026-09-17) ───────────────────────────────────────────
// Recovery used to be all or nothing and silent: one orphan that threw stopped
// the loop, and the library — which only lists once recovery resolves — stayed
// empty, on every visit, with nothing on screen to say why. It now fails ONE
// recording at a time and reports it, and the UI makes the user decide
// (RecoveryFailureModal.tsx): retry, or abandon after being offered the audio.
//
// Two ways to fail, and only one of them reaches a catch. A thrown error (a
// full disk, a corrupt row) does. The tab being killed mid-recovery — out of
// memory on a phone, the likeliest way a multi-hour recording fails — runs no
// code at all. That one is caught at the NEXT attempt: a marker is written
// before the work and removed after it, whatever the outcome, so a marker still
// present means the previous attempt died with the tab. Retrying blindly there
// would kill the tab again on every visit.

export interface RecoveryFailure {
  session: Analysis;
  /** 'error': the attempt threw, and `message` says what. 'interrupted': an
   *  earlier attempt never finished — the tab died during it. */
  kind: 'error' | 'interrupted';
  message: string;
}

/** localStorage, not IndexedDB: it has to be on disk BEFORE the work that may
 *  kill the tab starts, and a synchronous write is the only one that is. Keyed
 *  by session id, which is a UUID, so no per-user scoping is needed. */
const ATTEMPT_KEY_PREFIX = 'cadence_recovery_attempt:';

function attemptMarked(sessionId: string): boolean {
  try { return localStorage.getItem(ATTEMPT_KEY_PREFIX + sessionId) !== null; } catch { return false; }
}

function markAttempt(sessionId: string, on: boolean): void {
  try {
    if (on) localStorage.setItem(ATTEMPT_KEY_PREFIX + sessionId, new Date().toISOString());
    else localStorage.removeItem(ATTEMPT_KEY_PREFIX + sessionId);
  } catch { /* storage refused — recovery still runs, it just cannot detect a crash */ }
}

/** Name of the lock anyone working on a draft holds: the live recording that
 *  writes it (liveSession.ts), and whoever recovers or abandons it. Web Locks
 *  are shared by every tab of the origin and released when a tab dies, which
 *  is exactly "someone alive is on this" — the thing a draft alone cannot say.
 *  Before them, a second tab opening the analyser took another tab's recording
 *  in progress for a crash orphan. */
function analysisLockName(sessionId: string): string {
  return `cadence-analysis-${sessionId}`;
}

/** Takes the analysis lock and keeps it until the returned function is called.
 *  Resolves once GRANTED — waiting behind whoever holds it. Where the browser
 *  has no Web Locks, resolves at once with a no-op: the behaviour before locks
 *  existed, not a refusal to record. */
export function holdAnalysisLock(sessionId: string): Promise<() => void> {
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  if (!locks) return Promise.resolve(() => {});
  return new Promise(granted => {
    void locks.request(analysisLockName(sessionId), () => new Promise<void>(release => {
      let released = false;
      granted(() => { if (!released) { released = true; release(); } });
    }));
  });
}

/** Runs `work` holding the lock, or returns `busy` straight away when another
 *  holder — a tab still recording it, or recovering it — has it. */
async function withAnalysisLockIfFree<T>(sessionId: string, busy: T, work: () => Promise<T>): Promise<T> {
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  if (!locks) return work();
  return locks.request(analysisLockName(sessionId), { ifAvailable: true }, lock => (lock ? work() : busy));
}

/** Recovers one orphan. Null when it is done — or no longer anyone's to do:
 *  held by another tab, or already finalized by one (the draft is re-read under
 *  the lock, the list it came from may be stale). */
async function recoverOrphan(session: Analysis, retry: boolean): Promise<RecoveryFailure | null> {
  return withAnalysisLockIfFree<RecoveryFailure | null>(session.id, null, async () => {
    const current = (await listDraftSessions()).find(s => s.id === session.id);
    if (!current) return null;
    if (!retry && attemptMarked(current.id)) return { session: current, kind: 'interrupted', message: '' };
    markAttempt(current.id, true);
    try {
      await finalizeOrphan(current);
      return null;
    } catch (err) {
      console.error('[sessions] recovery failed for ' + current.id, err);
      return { session: current, kind: 'error', message: err instanceof Error ? `${err.name}: ${err.message}` : String(err) };
    } finally {
      markAttempt(current.id, false);
    }
  });
}

/** Orphans currently in front of the user. Skipped by later passes — the
 *  library runs one on every visit, and without this a second visit would
 *  retry behind an open dialog, or stack a second dialog for the same one. */
const awaitingDecision = new Set<string>();
let inFlight: Promise<RecoveryFailure[]> | null = null;

/** Finalizes every orphaned draft it can, and returns the ones it could not.
 *  A failing orphan never stops the others. Every failure returned is marked
 *  as awaiting a decision until `settleRecoveryFailure` is called for it.
 *  Concurrent calls share one pass. */
export function recoverOrphanedSessions(excludeId?: string): Promise<RecoveryFailure[]> {
  inFlight ??= (async () => {
    // Every row in the local draft store is by construction an orphan — a
    // still-in-progress recording never makes it into AppState (see
    // saveSessionMeta's doc in db.ts), so anything left here at library-load
    // time is one a crash/refresh interrupted before it could finish — or one
    // another tab is recording, which the lock tells apart.
    const drafts = await listDraftSessions();
    const failures: RecoveryFailure[] = [];
    for (const session of drafts) {
      if (session.id === excludeId || awaitingDecision.has(session.id)) continue;
      const failure = await recoverOrphan(session, false);
      if (failure) { awaitingDecision.add(session.id); failures.push(failure); }
    }
    return failures;
  })().finally(() => { inFlight = null; });
  return inFlight;
}

/** The user asked to try again. Ignores the crash marker — that is the point
 *  of asking. Null on success. */
export async function retryRecovery(session: Analysis): Promise<RecoveryFailure | null> {
  const failure = await recoverOrphan(session, true);
  // In front of the user from here on, whoever called: the failure dialog, or
  // the Drive backup offer handing over to it. Settled when that dialog closes.
  if (failure) awaitingDecision.add(session.id);
  return failure;
}

/** The dialog for this orphan is closed, whatever was decided. */
export function settleRecoveryFailure(sessionId: string): void {
  awaitingDecision.delete(sessionId);
}

/** The recording as it stands, for the user to keep before abandoning —
 *  assembled from its chunks WITHOUT fixWebmDuration: that step loads the whole
 *  file into memory twice over, the likeliest thing to have killed the tab in
 *  the first place, and a Blob of Blobs copies nothing. The file plays; seeking
 *  in it is approximate. Falls back to an audio blob saved by an attempt that
 *  failed later on. Null when there is no audio at all. */
export async function orphanAudio(session: Analysis): Promise<Blob | null> {
  const chunks = await collectChunks(session.id);
  if (chunks.length > 0) return new Blob(chunks, { type: session.mimeType || chunks[0]!.type || 'audio/webm' });
  const saved = await loadSessionAudio(session.id);
  return saved && saved.size > 0 ? saved : null;
}

/** Deletes the orphan for good: draft, chunks, window rows, and any audio a
 *  failed attempt had already saved. Under the lock, and only if the draft is
 *  still there — another tab may have recovered it meanwhile, and deleting a
 *  finalized analysis is not what the user was asked about. */
export async function abandonRecovery(sessionId: string): Promise<void> {
  const release = await holdAnalysisLock(sessionId);
  try {
    const stillDraft = (await listDraftSessions()).some(s => s.id === sessionId);
    if (!stillDraft) return;
    await clearChunks(sessionId);
    await deleteSession(sessionId);
    // And its Drive backup, if any: abandoning is the end of the recording, and
    // a copy left there would be offered back at the next visit.
    void import('./liveBackup').then(m => m.discardLiveBackup(sessionId));
  } finally {
    release();
    markAttempt(sessionId, false);
  }
}
