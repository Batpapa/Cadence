import { WakeLockManager } from './audio/capture';
import { MicSource } from './audio/sources';
import { SessionFileRecorder } from './audio/recorder';
import { RecognitionClient } from './recognitionClient';
import { saveSessionMeta, saveSessionAudio, deleteSession } from './db';
import type { RecordedSession, SessionAnnotation, WindowResult } from './model';
import type { AnnotationEvent } from './recognition/aggregator';
import type { IndexProgress } from './recognition/indexStore';

// ── Live session orchestrator ─────────────────────────────────────────────────
// One MediaStream, two parallel consumers:
//   MediaRecorder → IndexedDB chunks → session file
//   MicSource (worklet → MessagePort) → recognition worker → annotations
// Time source of truth is the worker's sample counter; recorder and worklet
// start in the same frame (residual offset < 300 ms, accepted).

export type LiveSessionPhase = 'idle' | 'initializing' | 'recording' | 'paused' | 'stopping' | 'done' | 'error';

export interface LiveSessionCallbacks {
  onPhase?: (phase: LiveSessionPhase) => void;
  onIndexProgress?: (p: IndexProgress) => void;
  onWindow?: (result: WindowResult, abc: string | null) => void;
  onAnnotations?: (events: AnnotationEvent[], all: SessionAnnotation[]) => void;
  onError?: (message: string) => void;
  /** #17: forwarded straight from RecognitionClient — see its onLiveGap doc. */
  onLiveGap?: (seconds: number) => void;
}

export class LiveSession {
  private cb: LiveSessionCallbacks;
  private phase: LiveSessionPhase = 'idle';

  private mic = new MicSource();
  private recognition: RecognitionClient | null = null;
  private recorder: SessionFileRecorder | null = null;
  private wakeLock = new WakeLockManager();
  private annotations = new Map<string, SessionAnnotation>();
  private pauseStartedAt = 0;
  private pausedAccumMs = 0;
  /** Raw per-window results with a wall-clock cross-reference — diagnostic
   *  dump for comparing the worker's sample-counted clock (tWindowStart/End)
   *  against real elapsed time during a LIVE recording, the way importSession
   *  already does for file analysis (its `windows` field, no wall clock needed
   *  there since import runs faster than real time). `wallMs` is `Date.now()`
   *  minus `startedAt` MINUS accumulated paused time, so a pause/resume cycle
   *  doesn't masquerade as clock drift. */
  readonly windows: (WindowResult & { wallMs: number })[] = [];

  readonly sessionId = crypto.randomUUID();
  startedAt = 0;
  /** Editable during recording (renderLive title input) — same field `stop()` persists under. */
  name = '';
  /** Target deck(s) for cards created from this session's recognised tunes —
   *  in-memory only, not persisted with the session (resets next time).
   *  `undefined` = never touched the picker yet (forces it open on first "Add card"). */
  targetDeckIds: Set<string> | undefined = undefined;
  /** Manual transposition (semitones, -12..12) applied to the ongoing
   *  analysis — e.g. a session played in Bb. In-memory only, resets to 0
   *  next recording. */
  pitchShift = 0;

  /** Live-adjustable: affects analysis windows from now on, not past ones. */
  setPitchShift(semitones: number): void {
    this.pitchShift = semitones;
    this.recognition?.setPitchShift(semitones);
  }

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

  /** Elapsed recording time, excluding time spent paused. */
  getElapsedMs(): number {
    if (!this.startedAt) return 0;
    const pausedSoFar = this.phase === 'paused'
      ? this.pausedAccumMs + (Date.now() - this.pauseStartedAt)
      : this.pausedAccumMs;
    return Date.now() - this.startedAt - pausedSoFar;
  }

  /** Writes the in-progress session so a crash/refresh can be recovered later. */
  private persistDraft(): void {
    const session: RecordedSession = {
      id: this.sessionId,
      name: this.name,
      date: new Date(this.startedAt).toISOString(),
      duration: this.getElapsedMs() / 1000,
      mimeType: this.recorder?.mimeType ?? '',
      source: 'live',
      status: 'recording',
      annotations: this.getAnnotations(),
    };
    void saveSessionMeta(session).catch(() => { /* best-effort — stop() still writes the final copy */ });
  }

  async start(): Promise<void> {
    try {
      this.setPhase('initializing');

      await this.mic.open();

      // Recognition worker: WASM + index (may trigger the big first download).
      this.recognition = new RecognitionClient(this.mic.sampleRate, {
        onIndexProgress: p => this.cb.onIndexProgress?.(p),
        onWindow: (result, abc) => {
          // A window firing implies phase === 'recording' (analysis is fed by
          // the worklet, which pause() suspends) — no "currently paused" branch needed.
          this.windows.push({ ...result, wallMs: Date.now() - this.startedAt - this.pausedAccumMs });
          this.cb.onWindow?.(result, abc);
        },
        onAnnotations: events => this.applyEvents(events),
        onError: message => this.cb.onError?.(message),
        onLiveGap: seconds => this.cb.onLiveGap?.(seconds),
      });
      if (this.pitchShift !== 0) this.recognition.setPitchShift(this.pitchShift);
      await this.recognition.ready;

      // Hot path: worklet → worker via dedicated MessageChannel.
      await this.mic.start(this.recognition);

      // Recorder starts in the same frame as the worklet is now live.
      // recordingStream: graph-routed, NOT the raw track (silent-recording bug).
      this.recorder = new SessionFileRecorder(this.mic.recordingStream, this.sessionId);
      this.recorder.start();
      this.startedAt = Date.now();
      this.persistDraft();

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
          liked: existing.liked,
        });
      } else {
        // The aggregator never knows about the like marker — carry it forward
        // across updates the same as any other user choice.
        this.annotations.set(ev.annotation.id, { ...ev.annotation, liked: existing?.liked ?? false });
      }
    }
    this.persistDraft();
    this.cb.onAnnotations?.(events, this.getAnnotations());
  }

  /** Toggle the "I liked this tune" marker — no bearing on recognition. */
  toggleLike(annotationId: string): void {
    const ann = this.annotations.get(annotationId);
    if (!ann) return;
    this.annotations.set(annotationId, { ...ann, liked: !ann.liked });
    this.persistDraft();
  }

  /** Pauses the whole capture graph (recognition feed + recorder) in one shot —
   *  the worker's sample clock simply stops advancing, no offset bookkeeping needed. */
  async pause(): Promise<void> {
    if (this.phase !== 'recording') return;
    this.recorder?.pause();
    await this.mic.suspend();
    this.pauseStartedAt = Date.now();
    this.setPhase('paused');
  }

  async resume(): Promise<void> {
    if (this.phase !== 'paused') return;
    await this.mic.resume();
    this.recorder?.resume();
    this.pausedAccumMs += Date.now() - this.pauseStartedAt;
    this.recognition?.notifyLiveResume();
    this.setPhase('recording');
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
        name: this.name,
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

  /** Discards an in-progress recording entirely: stops all resources and
   *  deletes whatever draft/chunks were already persisted. Unlike stop(),
   *  nothing is saved. */
  async cancel(): Promise<void> {
    this.setPhase('stopping');
    try {
      await this.recorder?.stop(); // flushes pending writes and clears chunks
    } finally {
      this.cleanup();
    }
    await deleteSession(this.sessionId); // remove the progressively-persisted draft
    this.setPhase('idle');
  }

  private cleanup(): void {
    this.wakeLock.stop();
    this.recognition?.dispose();
    this.recognition = null;
    this.mic.stop();
  }
}
