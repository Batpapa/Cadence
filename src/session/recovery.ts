import fixWebmDuration from 'fix-webm-duration';
import { listSessions, collectChunks, clearChunks, saveSessionAudio, saveSessionMeta } from './db';
import { RECORDER_TIMESLICE_MS } from './sessionConfig';

// ── Crash/refresh recovery ─────────────────────────────────────────────────────
// A live recording writes its audio chunks to IndexedDB continuously (see
// audio/recorder.ts) and its metadata + annotations progressively (see
// liveSession.ts persistDraft()), tagged `status: 'recording'`. A refresh or
// crash mid-session leaves that draft row and its chunks orphaned — there is
// no manual resume: the next time the library loads, any such session is
// silently finalized with whatever made it to IndexedDB before the
// interruption, exactly as if the user had pressed stop at that point.

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

    await saveSessionAudio(session.id, blob);
    await saveSessionMeta({
      ...session,
      duration: Math.max(session.duration, durationMs / 1000),
      status: 'done',
    });
    await clearChunks(session.id);
  }
}
