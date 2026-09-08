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

/** Bitrate for the recorded file, in bits per second.
 *
 *  Left unset until 2026-09-08, which meant every browser picked its own — so
 *  the size of an hour of session was neither known nor stable. Now stated, and
 *  stated for a MONO stream (see sources.ts): the recording tap down-mixes, so
 *  this whole budget goes to one channel.
 *
 *  Opus at 64 kbit/s mono is transparent enough for a room full of instruments,
 *  which is the only thing this file ever contains. AAC (Safari's `audio/mp4`,
 *  the only other candidate) is a weaker codec at the same rate, so it gets
 *  more rather than a worse recording.
 *
 *  This is also why converting these files to MP3 would not shrink them: MP3
 *  loses to Opus at equal rate. The lever on size is the rate and the channel
 *  count, both of which are set right here. */
function recorderBitrate(mime: string): number {
  return mime.includes('mp4') ? 96_000 : 64_000;
}

export class SessionFileRecorder {
  private recorder: MediaRecorder;
  private recordingId: string;
  private seq = 0;
  private startedAt = 0;
  private pausedMs = 0;
  private pausedAt = 0;
  private pendingWrites: Promise<void>[] = [];
  readonly mimeType: string;

  constructor(stream: MediaStream, recordingId: string) {
    this.recordingId = recordingId;
    this.mimeType = pickRecorderMime();
    this.recorder = new MediaRecorder(stream, {
      ...(this.mimeType ? { mimeType: this.mimeType } : {}),
      audioBitsPerSecond: recorderBitrate(this.mimeType),
    });
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

  pause(): void {
    if (this.recorder.state !== 'recording') return;
    this.recorder.pause();
    this.pausedAt = Date.now();
  }

  resume(): void {
    if (this.recorder.state !== 'paused') return;
    this.pausedMs += Date.now() - this.pausedAt;
    this.recorder.resume();
  }

  /** Stops and returns the final session file (duration-fixed for webm). */
  async stop(): Promise<{ blob: Blob; mimeType: string; durationMs: number }> {
    // Stopping directly from a paused state (no resume() in between) still
    // needs the trailing pause gap folded in.
    if (this.recorder.state === 'paused') this.pausedMs += Date.now() - this.pausedAt;

    const stopped = new Promise<void>(resolve => {
      this.recorder.onstop = () => resolve();
    });
    if (this.recorder.state !== 'inactive') this.recorder.stop();
    await stopped;
    await Promise.all(this.pendingWrites);

    const durationMs = Date.now() - this.startedAt - this.pausedMs;
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
