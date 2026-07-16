import fixWebmDuration from 'fix-webm-duration';
import { appendChunk, collectChunks, clearChunks } from '../db';
import { RECORDER_TIMESLICE_MS } from '../sessionConfig';

// ── Session file recorder ─────────────────────────────────────────────────────
// MediaRecorder wrapper: negotiated mime type, 5-second chunks appended to
// IndexedDB as they arrive (a crash at 1h50 loses nothing), final Blob
// concatenation, and webm duration-metadata repair (MediaRecorder webm blobs
// have no duration header, which breaks seeking).

const MIME_CANDIDATES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4', // Safari
];

export function pickRecorderMime(): string {
  for (const mime of MIME_CANDIDATES) {
    if (MediaRecorder.isTypeSupported(mime)) return mime;
  }
  return ''; // let the browser choose
}

export class SessionFileRecorder {
  private recorder: MediaRecorder;
  private recordingId: string;
  private seq = 0;
  private startedAt = 0;
  private pendingWrites: Promise<void>[] = [];
  readonly mimeType: string;

  constructor(stream: MediaStream, recordingId: string) {
    this.recordingId = recordingId;
    this.mimeType = pickRecorderMime();
    this.recorder = new MediaRecorder(stream, this.mimeType ? { mimeType: this.mimeType } : undefined);
    this.recorder.ondataavailable = (e: BlobEvent) => {
      console.debug(`[rec] chunk ${this.seq}: ${e.data.size} bytes`);
      if (e.data.size === 0) return;
      const p = appendChunk(this.recordingId, this.seq++, e.data)
        .catch(() => { /* storage pressure — keep recording, chunk lost */ });
      this.pendingWrites.push(p);
    };
  }

  start(): void {
    this.startedAt = Date.now();
    this.recorder.start(RECORDER_TIMESLICE_MS);
  }

  /** Stops and returns the final session file (duration-fixed for webm). */
  async stop(): Promise<{ blob: Blob; mimeType: string; durationMs: number }> {
    const stopped = new Promise<void>(resolve => {
      this.recorder.onstop = () => resolve();
    });
    if (this.recorder.state !== 'inactive') this.recorder.stop();
    await stopped;
    await Promise.all(this.pendingWrites);

    const durationMs = Date.now() - this.startedAt;
    const chunks = await collectChunks(this.recordingId);
    const mimeType = this.recorder.mimeType || this.mimeType || 'audio/webm';
    let blob = new Blob(chunks, { type: mimeType });
    console.debug(`[rec] final: ${chunks.length} chunks, ${blob.size} bytes, ${(durationMs / 1000).toFixed(1)}s, ${mimeType}`);

    if (mimeType.includes('webm')) {
      try {
        blob = await fixWebmDuration(blob, durationMs, { logger: false });
      } catch { /* seeking degraded but audio intact */ }
    }

    await clearChunks(this.recordingId);
    return { blob, mimeType, durationMs };
  }
}
