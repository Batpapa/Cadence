import fixWebmDuration from 'fix-webm-duration';
import { listSessions, collectChunks, clearChunks, saveSessionAudio, saveSessionMeta, loadSessionWindows, deleteSessionWindows } from './db';
import { RECORDER_TIMESLICE_MS, ANALYSIS_HOP_S } from './sessionConfig';
import { IncrementalViterbiSegmenter } from './recognition/viterbiSegmenter';
import type { AnnotationEvent, SessionAnnotation, WindowResult } from './model';

// ── Crash/refresh recovery ─────────────────────────────────────────────────────
// A live recording writes its audio chunks to IndexedDB continuously (see
// audio/recorder.ts) and its raw per-window recognition results progressively
// (see liveSession.ts's onWindow handler), tagged `status: 'recording'`. A
// refresh or crash mid-session leaves that draft row, its chunks, and its
// windows dump orphaned — there is no manual resume: the next time the
// library loads, any such session is silently finalized with whatever made
// it to IndexedDB before the interruption, exactly as if the user had
// pressed stop at that point.

/** Replays raw windows through a FRESH detector in one shot — never trusts a
 *  persisted annotation snapshot (2026-08-15): a snapshot taken at an
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
 *  annotation map is already provably identical to what this function would
 *  produce. This function stays needed only where there's no live map left
 *  to trust at all — a crash/refresh loses it entirely, leaving just the raw
 *  windows dump to replay.
 *
 *  Loses any userConfirmed/liked edits made before the crash (including a
 *  manual tune-identity override via selectAlternate(), 2026-08-25 — same
 *  userConfirmed flag) — those only ever lived in the in-memory annotation
 *  map, never persisted independently of it. Accepted tradeoff (explicit
 *  user call): correctness of the recognition result matters more than
 *  preserving mid-session manual edits across a crash. */
export function recomputeAnnotations(windows: WindowResult[], hopS: number = ANALYSIS_HOP_S): SessionAnnotation[] {
  const segmenter = new IncrementalViterbiSegmenter(hopS);
  const store = new Map<string, SessionAnnotation>();
  const apply = (events: AnnotationEvent[]) => {
    for (const ev of events) {
      if (ev.type === 'retract') { store.delete(ev.id); continue; }
      store.set(ev.annotation.id, ev.annotation);
    }
  };
  apply(segmenter.feedAll(windows));
  apply(segmenter.finalize());
  return [...store.values()].sort((a, b) => a.start - b.start);
}

export async function recoverOrphanedSessions(excludeId?: string): Promise<void> {
  const sessions = await listSessions();
  const orphaned = sessions.filter(s => s.status === 'recording' && s.id !== excludeId);

  for (const session of orphaned) {
    const chunks = await collectChunks(session.id);
    const mimeType = session.mimeType || 'audio/webm';
    let blob = new Blob(chunks, { type: mimeType });
    // Chunk count × timeslice is a better duration estimate than wall-clock
    // deltas here — it isn't thrown off by a backgrounded/suspended tab.
    const durationMs = chunks.length * RECORDER_TIMESLICE_MS;

    if (mimeType.includes('webm') && blob.size > 0) {
      try {
        blob = await fixWebmDuration(blob, durationMs, { logger: false });
      } catch { /* seeking degraded but audio intact */ }
    }

    const windows = await loadSessionWindows(session.id);
    const annotations = windows
      ? recomputeAnnotations(windows)
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
}
