import { pickRecorderMime, recorderBitrate } from '../session/audio/recorder';
import { patchWebmDuration } from '../session/audio/webmDuration';

// ── A live run's sound, kept in memory so its detections can be played ───────
// The analyser's recorder without the database: same mime choice, same
// bitrate, same Duration repair, but the chunks stay in this page and go when
// it does. Nothing of a performance is written anywhere on someone else's
// site. 64 kbit/s mono is ~29 MB an hour.
//
// The chunks are short (1 s, against the analyser's 5) because a detection
// can be played as soon as it is closed, and what the recorder holds since
// its last chunk is not playable yet.

const TIMESLICE_MS = 1000;
/** How long stop() waits for the recorder to say it has stopped — the
 *  analyser's own limit (recorder.ts). */
const STOP_TIMEOUT_MS = 5000;

export class MemoryRecorder {
  private readonly recorder: MediaRecorder;
  private readonly chunks: Blob[] = [];
  private startedAt = 0;
  private stoppedAt = 0;
  private readonly mime: string;
  /** The last file handed out, while no chunk has come since. */
  private cached: { chunks: number; blob: Blob } | null = null;

  constructor(stream: MediaStream) {
    this.mime = pickRecorderMime();
    this.recorder = new MediaRecorder(stream, {
      ...(this.mime ? { mimeType: this.mime } : {}),
      audioBitsPerSecond: recorderBitrate(this.mime),
    });
    this.recorder.ondataavailable = (e: BlobEvent) => {
      if (e.data.size > 0) this.chunks.push(e.data);
    };
  }

  start(): void {
    this.startedAt = Date.now();
    this.recorder.start(TIMESLICE_MS);
  }

  /** Same guards as SessionFileRecorder.stop: a recorder already inactive has
   *  fired its `stop`, and one that never answers is not waited for forever. */
  async stop(): Promise<void> {
    if (this.stoppedAt) return;
    this.stoppedAt = Date.now();
    if (this.recorder.state === 'inactive') return;
    const stopped = new Promise<void>(resolve => {
      this.recorder.onstop = () => resolve();
      setTimeout(resolve, STOP_TIMEOUT_MS);
    });
    this.recorder.stop();
    await stopped;
  }

  /** Everything recorded so far, as one playable file. A MediaRecorder WebM
   *  has no Duration, and without one it does not seek — which is all playing
   *  a detection does. */
  async file(): Promise<Blob> {
    if (this.cached?.chunks === this.chunks.length) return this.cached.blob;
    const type = this.recorder.mimeType || this.mime || 'audio/webm';
    const parts = [...this.chunks];
    const durationMs = (this.stoppedAt || Date.now()) - this.startedAt;
    let blob = new Blob(parts, { type });
    if (type.includes('webm')) {
      try { blob = await patchWebmDuration(parts, type, durationMs); } catch { /* plays, seeks badly */ }
    }
    this.cached = { chunks: parts.length, blob };
    return blob;
  }
}
