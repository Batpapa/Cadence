import { WakeLockManager } from './audio/capture';
import { MicSource } from './audio/sources';
import { SessionFileRecorder } from './audio/recorder';
import { RecognitionClient } from './recognitionClient';
import { saveSessionMeta, saveSessionAudio } from './db';
import type { RecordedSession, SessionAnnotation, WindowResult } from './model';
import type { AnnotationEvent } from './recognition/aggregator';
import type { IndexProgress } from './recognition/indexStore';

// ── Live session orchestrator ─────────────────────────────────────────────────
// One MediaStream, two parallel consumers:
//   MediaRecorder → IndexedDB chunks → session file
//   MicSource (worklet → MessagePort) → recognition worker → annotations
// Time source of truth is the worker's sample counter; recorder and worklet
// start in the same frame (residual offset < 300 ms, accepted).

export type LiveSessionPhase = 'idle' | 'initializing' | 'recording' | 'stopping' | 'done' | 'error';

export interface LiveSessionCallbacks {
  onPhase?: (phase: LiveSessionPhase) => void;
  onIndexProgress?: (p: IndexProgress) => void;
  onWindow?: (result: WindowResult, abc: string | null) => void;
  onAnnotations?: (events: AnnotationEvent[], all: SessionAnnotation[]) => void;
  onError?: (message: string) => void;
}

export class LiveSession {
  private cb: LiveSessionCallbacks;
  private phase: LiveSessionPhase = 'idle';

  private mic = new MicSource();
  private recognition: RecognitionClient | null = null;
  private recorder: SessionFileRecorder | null = null;
  private wakeLock = new WakeLockManager();
  private annotations = new Map<string, SessionAnnotation>();

  readonly sessionId = crypto.randomUUID();
  startedAt = 0;

  constructor(callbacks: LiveSessionCallbacks = {}) {
    this.cb = callbacks;
  }

  /** Rebind UI callbacks (the modal can close and reopen while recording). */
  setCallbacks(callbacks: LiveSessionCallbacks): void {
    this.cb = callbacks;
  }

  private setPhase(phase: LiveSessionPhase): void {
    this.phase = phase;
    this.cb.onPhase?.(phase);
  }

  getPhase(): LiveSessionPhase { return this.phase; }

  getAnnotations(): SessionAnnotation[] {
    return [...this.annotations.values()].sort((a, b) => a.start - b.start);
  }

  /** Mic level 0–1 for the VU meter (poll from UI). */
  getLevel(): number {
    return this.mic.getLevel();
  }

  async start(): Promise<void> {
    try {
      this.setPhase('initializing');

      await this.mic.open();

      // Recognition worker: WASM + index (may trigger the big first download).
      this.recognition = new RecognitionClient(this.mic.sampleRate, {
        onIndexProgress: p => this.cb.onIndexProgress?.(p),
        onWindow: (result, abc) => this.cb.onWindow?.(result, abc),
        onAnnotations: events => this.applyEvents(events),
        onError: message => this.cb.onError?.(message),
      });
      await this.recognition.ready;

      // Hot path: worklet → worker via dedicated MessageChannel.
      await this.mic.start(this.recognition);

      // Recorder starts in the same frame as the worklet is now live.
      // recordingStream: graph-routed, NOT the raw track (silent-recording bug).
      this.recorder = new SessionFileRecorder(this.mic.recordingStream, this.sessionId);
      this.recorder.start();
      this.startedAt = Date.now();

      await this.wakeLock.start();
      this.setPhase('recording');
    } catch (err) {
      this.cleanup();
      this.setPhase('error');
      this.cb.onError?.(String(err));
      throw err;
    }
  }

  private applyEvents(events: AnnotationEvent[]): void {
    for (const ev of events) {
      const existing = this.annotations.get(ev.annotation.id);
      if (existing?.userConfirmed) {
        // The user relabelled this annotation — keep their tune identity,
        // only track timing/confidence coming from the aggregator.
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

  /** User picked an alternate ("it's rather this one"): swap tune identity,
   *  keep the interval — it comes from temporal segmentation, not identification. */
  relabel(annotationId: string, alt: { tuneId: string; settingId: string; displayName: string }): void {
    const ann = this.annotations.get(annotationId);
    if (!ann) return;
    this.annotations.set(annotationId, {
      ...ann,
      tuneId: alt.tuneId,
      settingId: alt.settingId,
      displayName: alt.displayName,
      userConfirmed: true,
    });
    this.cb.onAnnotations?.([], this.getAnnotations());
  }

  /** Stops everything and persists the session (audio + annotations). */
  async stop(): Promise<RecordedSession> {
    this.setPhase('stopping');
    try {
      const fileResult = await this.recorder!.stop();
      const { events, tFinal } = await this.recognition!.stop();
      this.applyEvents(events);

      const session: RecordedSession = {
        id: this.sessionId,
        name: '',
        date: new Date(this.startedAt).toISOString(),
        duration: Math.max(tFinal, fileResult.durationMs / 1000),
        mimeType: fileResult.mimeType,
        source: 'live',
        annotations: this.getAnnotations(),
      };
      await saveSessionAudio(session.id, fileResult.blob);
      await saveSessionMeta(session);

      this.setPhase('done');
      return session;
    } finally {
      this.cleanup();
    }
  }

  private cleanup(): void {
    this.wakeLock.stop();
    this.recognition?.dispose();
    this.recognition = null;
    this.mic.stop();
  }
}
