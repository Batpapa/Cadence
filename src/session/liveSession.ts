import { WakeLockManager } from './audio/capture';
import { createLiveSource, type LiveStreamSource, type LiveSourceKind } from './audio/sources';
import { SessionFileRecorder } from './audio/recorder';
import { RecognitionClient } from './recognitionClient';
import { saveSessionMeta, saveSessionAudio, saveSessionWindows, deleteSessionWindows, deleteSession } from './db';
import type { Analysis, Detection, WindowResult, DetectionEvent, DetectionAlternate } from './model';
import { alternatePickFields } from './model';
import { generatedSessionName } from './sessionNaming';
import type { IndexProgress } from './recognition/indexStore';
import { DEBUG_LIVE_AUDIO } from './sessionConfig';

// ── Live session orchestrator ─────────────────────────────────────────────────
// One MediaStream, two parallel consumers:
//   MediaRecorder → IndexedDB chunks → session file
//   LiveStreamSource (worklet → MessagePort) → recognition worker → annotations
// Time source of truth is the worker's sample counter; recorder and worklet
// start in the same frame (residual offset < 300 ms, accepted).
//
// Where the stream comes from — the microphone or a captured browser tab — is
// decided once, at construction, and never appears again below: both are the
// same LiveStreamSource, and everything downstream of it is identical.

export type LiveSessionPhase = 'idle' | 'initializing' | 'recording' | 'paused' | 'stopping' | 'done' | 'error';

export interface LiveSessionCallbacks {
  onPhase?: (phase: LiveSessionPhase) => void;
  onIndexProgress?: (p: IndexProgress) => void;
  onWindow?: (result: WindowResult, abc: string | null) => void;
  onDetections?: (events: DetectionEvent[], all: Detection[]) => void;
  onError?: (message: string) => void;
  /** #17: forwarded straight from RecognitionClient — see its onLiveGap doc. */
  onLiveGap?: (seconds: number) => void;
  /** The audio source died on its own while recording — the user pressed the
   *  browser's own "Stop sharing" button, closed the captured tab, or unplugged
   *  the microphone. There is nothing left to record, so the UI should stop the
   *  session and KEEP what was captured up to here: everything already
   *  recognised is real, and the recorded audio is intact in IndexedDB. */
  onSourceEnded?: () => void;
}

export class LiveSession {
  private cb: LiveSessionCallbacks;
  private phase: LiveSessionPhase = 'idle';

  private source: LiveStreamSource;
  private recognition: RecognitionClient | null = null;
  private recorder: SessionFileRecorder | null = null;
  private wakeLock = new WakeLockManager();
  private annotations = new Map<string, Detection>();
  private pauseStartedAt = 0;
  private pausedAccumMs = 0;
  /** Raw per-window results with a wall-clock cross-reference — doubles as
   *  (a) a diagnostic dump for comparing the worker's sample-counted clock
   *  (tWindowStart/End) against real elapsed time during a LIVE recording,
   *  the way importSession already does for file analysis (its `windows`
   *  field, no wall clock needed there since import runs faster than real
   *  time), and (b) the crash-recovery source of truth (2026-08-15) — see
   *  persistDraft() and recovery.ts. `wallMs` is `Date.now()` minus
   *  `startedAt` MINUS accumulated paused time, so a pause/resume cycle
   *  doesn't masquerade as clock drift. */
  readonly windows: (WindowResult & { wallMs: number })[] = [];

  readonly sessionId = crypto.randomUUID();
  startedAt = 0;
  /** Editable during recording (renderLive title input) — same field `stop()` persists under. */
  name = '';
  /** Decks PINNED in the deck choice modal while this session is open — they
   *  come back ticked on the next add or link, and that is all they do. Purely
   *  in-memory and never persisted: picking a destination is a decision about
   *  right now, not a preference (see components/deckSelector.tsx). */
  pinnedDeckIds: Set<string> = new Set();
  /** Manual transposition (semitones, -12..12) applied to the ongoing analysis.
   *  ENGINE sign: positive raises the transcribed contour to meet an index held
   *  at written pitch, so a session played a tone DOWN is +2 here — the
   *  opposite of what a musician says, flipped for display in
   *  PitchShiftControl.tsx. In-memory only, resets to 0 next recording. */
  pitchShift = 0;

  /** Live-adjustable: affects analysis windows from now on, not past ones. */
  setPitchShift(semitones: number): void {
    this.pitchShift = semitones;
    this.recognition?.setPitchShift(semitones);
  }

  /** `sourceKind` is fixed for the life of the session: switching source
   *  mid-recording would break the worker's single sample clock, which is the
   *  session's only notion of time. */
  constructor(callbacks: LiveSessionCallbacks = {}, readonly sourceKind: LiveSourceKind = 'mic') {
    this.cb = callbacks;
    this.source = createLiveSource(sourceKind);
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

  getDetections(): Detection[] {
    return [...this.annotations.values()].sort((a, b) => a.start - b.start);
  }

  /** The MediaRecorder mime type once recording has actually started, '' before
   *  then — used to assemble a playable Blob from collectChunks() mid-recording
   *  (clip extraction on an already-finalized detection, sessionModule.ts). */
  get mimeType(): string {
    return this.recorder?.mimeType ?? '';
  }

  /** Signal level 0–1 for the VU meter (poll from UI). */
  getLevel(): number {
    return this.source.getLevel();
  }

  /** Elapsed recording time, excluding time spent paused. */
  getElapsedMs(): number {
    if (!this.startedAt) return 0;
    const pausedSoFar = this.phase === 'paused'
      ? this.pausedAccumMs + (Date.now() - this.pauseStartedAt)
      : this.pausedAccumMs;
    return Date.now() - this.startedAt - pausedSoFar;
  }

  /** Writes the in-progress session so a crash/refresh can be recovered
   *  later. `annotations` here is only ever a best-effort live snapshot —
   *  recovery.ts does NOT trust it; it replays the separately-persisted raw
   *  `windows` (see the onWindow handler below) through a fresh detector
   *  instead. Reason (2026-08-15): a snapshot taken at an arbitrary instant
   *  can catch a short-lived, not-yet-confirmed guess (see
   *  minSegmentWindows/'retract' in viterbiSegmenter.ts) that a crash would
   *  otherwise resurrect as if it were a real, finalized detection. */
  private persistDraft(): void {
    const session: Analysis = {
      id: this.sessionId,
      name: this.name,
      date: new Date(this.startedAt).toISOString(),
      duration: this.getElapsedMs() / 1000,
      mimeType: this.recorder?.mimeType ?? '',
      source: this.sourceKind === 'device' ? 'device' : 'live',
      status: 'recording',
      annotations: this.getDetections(),
    };
    void saveSessionMeta(session).catch(() => { /* best-effort — stop() still writes the final copy */ });
  }

  async start(): Promise<void> {
    try {
      this.setPhase('initializing');

      // FIRST, and with nothing awaited before it: tab capture needs transient
      // user activation, which an await between the click and the picker would
      // spend. setPhase above is synchronous, so the gesture is still live.
      this.source.onEnded = () => {
        // Only meaningful while there is something to interrupt: stop() and
        // cancel() clear the handler through source.stop() anyway, this guards
        // the window before recording actually begins.
        if (this.phase === 'recording' || this.phase === 'paused') this.cb.onSourceEnded?.();
      };
      await this.source.open();

      // Recognition worker: WASM + index (may trigger the big first download).
      this.recognition = new RecognitionClient(this.source.sampleRate, {
        onIndexProgress: p => this.cb.onIndexProgress?.(p),
        onWindow: (result, abc) => {
          // A window firing implies phase === 'recording' (analysis is fed by
          // the worklet, which pause() suspends) — no "currently paused" branch needed.
          this.windows.push({ ...result, wallMs: Date.now() - this.startedAt - this.pausedAccumMs });
          // Crash-recovery source of truth — kept in step with every window,
          // not just detection-changing ones, so a crash loses at most the
          // very last window's worth of signal (~stepSeconds).
          void saveSessionWindows(this.sessionId, this.windows).catch(() => { /* best-effort */ });
          this.cb.onWindow?.(result, abc);
        },
        onDetections: events => this.applyEvents(events),
        onError: message => this.cb.onError?.(message),
        onLiveGap: seconds => this.cb.onLiveGap?.(seconds),
      });
      if (this.pitchShift !== 0) this.recognition.setPitchShift(this.pitchShift);
      await this.recognition.ready;

      // Hot path: worklet → worker via dedicated MessageChannel.
      await this.source.start(this.recognition);

      // Recorder starts in the same frame as the worklet is now live.
      // recordingStream: graph-routed, NOT the raw track (silent-recording bug).
      this.recorder = new SessionFileRecorder(this.source.recordingStream, this.sessionId);
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

  private applyEvents(events: DetectionEvent[]): void {
    for (const ev of events) {
      if (ev.type === 'retract') {
        // A guess the user hasn't touched never got confirmed — remove it
        // entirely, as if it had never been shown. Never erase an explicit
        // user choice, even if the algorithm itself would retract it.
        if (!this.annotations.get(ev.id)?.userConfirmed) this.annotations.delete(ev.id);
        continue;
      }
      const existing = this.annotations.get(ev.detection.id);
      if (existing?.userConfirmed) {
        // The user relabelled this detection — keep their tune identity,
        // only track timing/confidence coming from the aggregator.
        this.annotations.set(ev.detection.id, {
          ...ev.detection,
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
        this.annotations.set(ev.detection.id, { ...ev.detection, liked: existing?.liked ?? false });
      }
    }
    this.persistDraft();
    this.cb.onDetections?.(events, this.getDetections());
  }

  /** Toggle the "I liked this tune" marker — no bearing on recognition. */
  toggleLike(annotationId: string): void {
    const ann = this.annotations.get(annotationId);
    if (!ann) return;
    this.annotations.set(annotationId, { ...ann, liked: !ann.liked });
    this.persistDraft();
  }

  /** Records the user's verdict on this detection's identity: any tune —
   *  including the decoder's own current pick — freezes it and protects it
   *  from retraction, `null` hands it back to the decoder. See
   *  model.ts's alternatePickFields, which owns that rule for all three
   *  writers (both engines and the finished-session summary). */
  selectAlternate(annotationId: string, pick: DetectionAlternate | null): void {
    const ann = this.annotations.get(annotationId);
    if (!ann) return;
    this.annotations.set(annotationId, { ...ann, ...alternatePickFields(ann, pick) });
    this.persistDraft();
  }

  /** Pauses the whole capture graph (recognition feed + recorder) in one shot —
   *  the worker's sample clock simply stops advancing, no offset bookkeeping needed. */
  async pause(): Promise<void> {
    if (this.phase !== 'recording') {
      if (DEBUG_LIVE_AUDIO) console.log(`[live] pause IGNOREE, phase=${this.phase}`);
      return;
    }
    if (DEBUG_LIVE_AUDIO) console.log('[live] --- PAUSE demandee ---');
    this.recorder?.pause();
    await this.source.suspend();
    this.pauseStartedAt = Date.now();
    this.setPhase('paused');
    if (DEBUG_LIVE_AUDIO) console.log('[live] pause effective');
  }

  async resume(): Promise<void> {
    if (this.phase !== 'paused') {
      if (DEBUG_LIVE_AUDIO) console.log(`[live] reprise IGNOREE, phase=${this.phase}`);
      return;
    }
    if (DEBUG_LIVE_AUDIO) console.log(`[live] --- REPRISE demandee apres ${((Date.now() - this.pauseStartedAt) / 1000).toFixed(1)}s de pause ---`);

    // BEFORE the audio restarts, never after. The worker pads its ring with
    // silence whenever the sample counter falls behind the wall clock (#16,
    // padToWallClock) — and a pause looks exactly like that: totalSamples has
    // not moved while real time has. notifyLiveResume is what tells it the gap
    // was deliberate, so it must arrive before the first post-resume chunk.
    //
    // It was a race, not a theoretical one. The worklet processor accumulates
    // 16384 samples before posting and `suspend()` does NOT reset that partial
    // fill, so a pause caught at 16000/16384 needs only 384 more samples — 8 ms
    // — to post, while resume()'s promise resolves through the audio thread and
    // back. When the chunk won, the worker padded the ENTIRE pause duration as
    // silence: the 15 s ring filled with nothing, and totalSamples — the
    // session's only clock — jumped forward by the whole pause, so every
    // detection after it was timestamped that far late.
    //
    // Sending it first costs nothing: the anchor is set a few ms early, far
    // inside LIVE_DEFICIT_SAFETY_MARGIN_S.
    this.recognition?.notifyLiveResume();

    await this.source.resume();
    this.recorder?.resume();
    this.pausedAccumMs += Date.now() - this.pauseStartedAt;
    this.setPhase('recording');
    if (DEBUG_LIVE_AUDIO) console.log('[live] reprise effective — la suite doit montrer des chunks worker');
  }

  /** Stops everything and persists the session (audio + annotations). */
  async stop(): Promise<Analysis> {
    this.setPhase('stopping');
    try {
      const fileResult = await this.recorder!.stop();
      const { events, tFinal } = await this.recognition!.stop();
      this.applyEvents(events);

      // this.getDetections() is now trustworthy as the FINAL result, not
      // just a live snapshot: viterbiSegmenter.ts only marks a segment
      // `finalized` once ViterbiResult.convergedThroughIndex (an exact,
      // provable property of the Viterbi decode — see its doc) shows no
      // future window could ever revise it, rather than the old
      // finalizationLagSeconds time guess. A clean stop() therefore already
      // matches what a from-scratch recomputeDetections() replay (still
      // used by recovery.ts for crash recovery, where the live detection
      // map is gone) would produce — no need to pay for that extra replay
      // here too (2026-08-21).
      const date = new Date(this.startedAt).toISOString();
      const source: Analysis['source'] = this.sourceKind === 'device' ? 'device' : 'live';
      const session: Analysis = {
        id: this.sessionId,
        // Named here, once, rather than derived at display time — see
        // sessionNaming.ts. `this.name` is whatever the user typed during the
        // recording, and it wins.
        name: this.name || generatedSessionName(source, date),
        date,
        duration: Math.max(tFinal, fileResult.durationMs / 1000),
        mimeType: fileResult.mimeType,
        source,
        annotations: this.getDetections(),
      };
      await saveSessionAudio(session.id, fileResult.blob);
      await saveSessionMeta(session);
      // A cleanly-stopped session no longer needs its crash-recovery replay
      // source — drop it rather than keeping a growing raw-windows dump
      // around forever for every past session.
      await deleteSessionWindows(session.id);

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
    this.source.stop();
  }
}
