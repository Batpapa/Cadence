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

/** Replays raw windows through a FRESH detector, exactly as a clean stop()
 *  would have — never trusts a persisted annotation snapshot (2026-08-15):
 *  a snapshot taken at an arbitrary instant can catch a short-lived,
 *  not-yet-confirmed guess (minSegmentWindows/'retract' in
 *  viterbiSegmenter.ts) that blanket-finalizing would wrongly resurrect as a
 *  real detection. Loses any userConfirmed/liked edits the user made during
 *  the live session before the crash — those only ever lived in the
 *  in-memory annotation map, never persisted independently of it. Accepted
 *  tradeoff (explicit user call): correctness of the recognition result
 *  matters more than preserving mid-session manual edits across a crash. */
export function recomputeAnnotations(windows: WindowResult[]): SessionAnnotation[] {
  const segmenter = new IncrementalViterbiSegmenter(ANALYSIS_HOP_S);
  const store = new Map<string, SessionAnnotation>();
  const apply = (events: AnnotationEvent[]) => {
    for (const ev of events) {
      if (ev.type === 'retract') { store.delete(ev.id); continue; }
      store.set(ev.annotation.id, ev.annotation);
    }
  };
  for (const w of windows) apply(segmenter.step(w));
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
