import { WakeLockManager } from './audio/capture';
import { FileSource } from './audio/sources';
import { RecognitionClient } from './recognitionClient';
import { saveSessionMeta, saveSessionAudio } from './db';
import { ANALYSIS_SAMPLE_RATE, HOP_S_IMPORT, IMPORT_MIN_S } from './sessionConfig';
import type { RecordedSession, SessionAnnotation, WindowResult } from './model';
import type { AnnotationEvent } from './recognition/aggregator';
import type { IndexProgress } from './recognition/indexStore';

// ── Import session orchestrator ───────────────────────────────────────────────
// Turns a user-provided audio file into a full Cadence session: the original
// file is stored AS-IS (no re-encoding, native seeking) and the recognition
// pipeline runs over the decoded PCM faster than real time, through the exact
// same worker path as live capture.

export type ImportPhase = 'idle' | 'initializing' | 'decoding' | 'analyzing' | 'saving' | 'done' | 'cancelled' | 'error';

export interface ImportProgress {
  analyzedS: number;
  totalS: number;
  /** Estimated seconds of wall time remaining, null before the rate stabilises. */
  etaS: number | null;
}

export interface ImportSessionCallbacks {
  onPhase?: (phase: ImportPhase) => void;
  onIndexProgress?: (p: IndexProgress) => void;
  onProgress?: (p: ImportProgress) => void;
  onAnnotations?: (events: AnnotationEvent[], all: SessionAnnotation[]) => void;
  onError?: (message: string) => void;
}

export class ImportSession {
  private cb: ImportSessionCallbacks;
  private phase: ImportPhase = 'idle';
  /** The original file — also the playback source while analysis is running. */
  readonly file: File;

  private recognition: RecognitionClient | null = null;
  private source: FileSource | null = null;
  private wakeLock = new WakeLockManager();
  private annotations = new Map<string, SessionAnnotation>();
  /** Raw per-window results — the AGG_CONFIG calibration dump. */
  readonly windows: WindowResult[] = [];
  private cancelRequested = false;
  private analysisStartedAt = 0;

  readonly sessionId = crypto.randomUUID();

  constructor(file: File, callbacks: ImportSessionCallbacks = {}) {
    this.file = file;
    this.cb = callbacks;
  }

  /** Rebind UI callbacks (the modal can close and reopen during an import). */
  setCallbacks(callbacks: ImportSessionCallbacks): void {
    this.cb = callbacks;
  }

  private setPhase(phase: ImportPhase): void {
    this.phase = phase;
    console.debug(`[import] phase: ${phase}`);
    this.cb.onPhase?.(phase);
  }

  getPhase(): ImportPhase { return this.phase; }

  getAnnotations(): SessionAnnotation[] {
    return [...this.annotations.values()].sort((a, b) => a.start - b.start);
  }

  /** Closed annotations — what a partial keep after cancellation would retain. */
  getClosedCount(): number {
    return this.getAnnotations().filter(a => a.end !== null).length;
  }

  /**
   * Runs the full import. Returns the saved session, or null when cancelled —
   * call keepPartial() afterwards to save what was recognised anyway.
   */
  async start(): Promise<RecordedSession | null> {
    try {
      this.setPhase('initializing');
      this.recognition = new RecognitionClient(ANALYSIS_SAMPLE_RATE, {
        onIndexProgress: p => this.cb.onIndexProgress?.(p),
        onWindow: result => this.onWindow(result),
        onAnnotations: events => this.applyEvents(events),
        onError: message => this.cb.onError?.(message),
      }, { hopS: HOP_S_IMPORT });
      const version = await this.recognition.ready;
      console.debug(`[import] engine ready (FolkFriend ${version})`);

      this.setPhase('decoding');
      this.source = await FileSource.fromFile(this.file);
      console.debug(`[import] decoded: ${this.source.duration.toFixed(1)}s @ ${this.source.sampleRate}Hz`);
      if (this.source.duration < IMPORT_MIN_S) {
        throw new Error(`too-short:${Math.round(this.source.duration)}`);
      }

      await this.wakeLock.start();
      this.setPhase('analyzing');
      this.analysisStartedAt = Date.now();
      await this.source.start(this.recognition); // resolves when fully emitted or stopped

      const { events } = await this.recognition.stop();

      if (this.cancelRequested) {
        this.applyEvents(events);
        this.setPhase('cancelled');
        return null;
      }

      this.applyEvents(events);
      return await this.save();
    } catch (err) {
      this.setPhase('error');
      this.cb.onError?.(String(err));
      throw err;
    } finally {
      this.wakeLock.stop();
      this.recognition?.dispose();
      this.recognition = null;
    }
  }

  /** Stop the analysis; start() then resolves null (nothing saved). */
  cancel(): void {
    this.cancelRequested = true;
    this.source?.stop();
  }

  /** After a cancellation: save the partially analysed session anyway. */
  async keepPartial(): Promise<RecordedSession> {
    this.setPhase('saving');
    return this.save();
  }

  private onWindow(result: WindowResult): void {
    this.windows.push(result);
    const totalS = this.source?.duration ?? 0;
    const analyzedS = result.tWindowEnd;
    const elapsed = (Date.now() - this.analysisStartedAt) / 1000;
    // Cumulative throughput is stable enough after a few windows for an ETA.
    const etaS = elapsed > 3 && analyzedS > 0
      ? Math.max(0, (totalS - analyzedS) * (elapsed / analyzedS))
      : null;
    this.cb.onProgress?.({ analyzedS, totalS, etaS });
  }

  private applyEvents(events: AnnotationEvent[]): void {
    for (const ev of events) {
      const existing = this.annotations.get(ev.annotation.id);
      if (existing?.userConfirmed) {
        this.annotations.set(ev.annotation.id, {
          ...ev.annotation,
          tuneId: existing.tuneId,
          settingId: existing.settingId,
          displayName: existing.displayName,
          dance: existing.dance,
          meter: existing.meter,
          userConfirmed: true,
        });
      } else {
        this.annotations.set(ev.annotation.id, ev.annotation);
      }
    }
    this.cb.onAnnotations?.(events, this.getAnnotations());
  }

  private async save(): Promise<RecordedSession> {
    this.setPhase('saving');
    const session: RecordedSession = {
      id: this.sessionId,
      name: this.file.name.replace(/\.[^.]+$/, ''),
      // No trustworthy t=0 for a file (mtime survives transfers erratically):
      // start dateless, the user sets it in the summary if they want reviews.
      date: null,
      duration: this.source!.duration,
      mimeType: this.file.type || 'application/octet-stream',
      source: 'import',
      annotations: this.getAnnotations(),
    };
    // Store the original file untouched: no webm duration bug, native seeking.
    await saveSessionAudio(session.id, this.file);
    await saveSessionMeta(session);
    this.setPhase('done');
    return session;
  }
}
