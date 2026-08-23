import { WakeLockManager } from './audio/capture';
import { createFileSource } from './audio/sources';
import type { PcmSource } from './audio/sources';
import { RecognitionClient } from './recognitionClient';
import { saveSessionMeta, saveSessionAudio } from './db';
import { ANALYSIS_SAMPLE_RATE, HOP_S_IMPORT, IMPORT_MIN_S } from './sessionConfig';
import type { RecordedSession, SessionAnnotation, WindowResult, AnnotationEvent } from './model';
import type { IndexProgress } from './recognition/indexStore';

// ── Import session orchestrator ───────────────────────────────────────────────
// Turns a user-provided audio file into a full Cadence session: the original
// file is stored AS-IS (no re-encoding, native seeking) and the recognition
// pipeline runs over the decoded PCM faster than real time, through the exact
// same worker path as live capture.

export type ImportPhase = 'idle' | 'initializing' | 'decoding' | 'analyzing' | 'saving' | 'done' | 'cancelled' | 'error';

// ── ETA estimation ─────────────────────────────────────────────────────────
// Pure helpers (exported for unit testing) backing onWindow()'s progress
// callback — a TRAILING rate over the last RATE_WINDOW_S of wall time, not a
// plain average since analysis started. That average-since-start version
// (2026-08-25 bug, reported by the user: "j'ai l'impression qu'il sous-
// estime systématiquement") anchored on whatever throughput the very first
// few windows happened to show — and StreamingFileSource can have a few
// chunks already decoded and queued (MAX_DECODE_QUEUE) the instant analysis
// starts, so those first windows can land unusually fast. That early burst
// permanently dragged the since-start average optimistic for the rest of
// the run, even once the real, slower steady-state rate took over. A
// trailing window self-corrects instead of anchoring on t=0 forever.

export interface RateSample { t: number; analyzedS: number }

export const RATE_WINDOW_S = 20;

/** Drops samples older than RATE_WINDOW_S, always keeping at least one
 *  (the most recent) so there's always something to compute against. */
export function pruneRateSamples(samples: RateSample[], now: number): RateSample[] {
  const cutoff = now - RATE_WINDOW_S * 1000;
  let i = 0;
  while (i < samples.length - 1 && samples[i]!.t < cutoff) i++;
  return samples.slice(i);
}

/** null until the trailing window covers enough real time (>3s) to trust —
 *  same "don't show a wild estimate from a single data point" gate the
 *  since-start version had, just measured against the window's own span
 *  instead of absolute elapsed time. */
export function estimateEtaS(samples: RateSample[], totalS: number, analyzedS: number, now: number): number | null {
  const oldest = samples[0];
  if (!oldest) return null;
  const spanS = (now - oldest.t) / 1000;
  const coveredS = analyzedS - oldest.analyzedS;
  return spanS > 3 && coveredS > 0 ? Math.max(0, (totalS - analyzedS) * (spanS / coveredS)) : null;
}

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
  private source: PcmSource | null = null;
  private wakeLock = new WakeLockManager();
  private annotations = new Map<string, SessionAnnotation>();
  /** Raw per-window results — the detectionTemporalConfig.ts calibration dump. */
  readonly windows: WindowResult[] = [];
  private cancelRequested = false;
  /** Backs the ETA in onWindow() — see the RateSample/estimateEtaS doc above. */
  private rateSamples: RateSample[] = [];
  /** Actual analyzed length (worker's own sample-accurate clock) — can exceed
   *  `source.duration` when that was only a pre-decode ESTIMATE (no Cues to
   *  compute it exactly for a Cue-less MediaRecorder webm) that undershot the
   *  real content; used as a floor for the persisted session duration so a
   *  long recording never gets saved shorter than what was actually analyzed. */
  private analyzedDurationS = 0;

  readonly sessionId: string;
  /** Editable during analysis (renderImportAnalysis title input) — same field save() persists under. */
  name = '';
  /** Editable during analysis — no trustworthy t=0 for a file, so this starts
   *  null unless the user sets it (same as a finished import's date in the summary). */
  dateOverride: string | null = null;
  /** Overrides the persisted session's `source` on save() — only set when
   *  re-analyzing an existing session (sessionModule.ts's startReanalyze), so
   *  a live recording re-processed this way still shows as "live" in the
   *  library, not "import". null = the normal fresh-import behavior. */
  sourceOverride: 'live' | 'import' | null = null;
  /** Target deck(s) for cards created from this import's recognised tunes —
   *  in-memory only, not persisted with the session (resets next time).
   *  `undefined` = never touched the picker yet (forces it open on first "Add card"). */
  targetDeckIds: Set<string> | undefined = undefined;
  /** Manual transposition (semitones, -12..12) applied to the ongoing
   *  analysis — e.g. a file recorded in Bb. In-memory only. */
  pitchShift = 0;

  /** Live-adjustable: affects analysis windows from now on, not past ones. */
  setPitchShift(semitones: number): void {
    this.pitchShift = semitones;
    this.recognition?.setPitchShift(semitones);
  }

  constructor(file: File, callbacks: ImportSessionCallbacks = {}, sessionId?: string) {
    this.file = file;
    this.cb = callbacks;
    this.sessionId = sessionId ?? crypto.randomUUID();
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
      if (this.pitchShift !== 0) this.recognition.setPitchShift(this.pitchShift);
      const version = await this.recognition.ready;
      console.debug(`[import] engine ready (FolkFriend ${version})`);

      // cancel() only has anything to actually stop() once `source` exists
      // (see its own doc) — a cancel requested during initializing/decoding
      // would otherwise be silently dropped and only take effect once the
      // FULL file finished analyzing normally, defeating the point of
      // cancelling early. Bail out here before starting anything that would
      // need stopping.
      if (this.cancelRequested) {
        this.setPhase('cancelled');
        return null;
      }

      this.setPhase('decoding');
      this.source = await createFileSource(this.file);
      console.debug(`[import] decoded: ${this.source.duration!.toFixed(1)}s @ ${this.source.sampleRate}Hz`);
      if (this.source.duration! < IMPORT_MIN_S) {
        throw new Error(`too-short:${Math.round(this.source.duration!)}`);
      }

      if (this.cancelRequested) {
        this.setPhase('cancelled');
        return null;
      }

      await this.wakeLock.start();
      this.setPhase('analyzing');
      await this.source.start(this.recognition); // resolves when fully emitted or stopped

      const { events, tFinal } = await this.recognition.stop();
      this.analyzedDurationS = tFinal;

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

  /** Stop the analysis; start() then resolves null (nothing saved). Safe to
   *  call at any phase — during initializing/decoding there's no `source`
   *  yet to stop(), so the two cancelRequested checks in start() (right
   *  after each of those phases) are what actually makes cancelling early
   *  take effect immediately instead of only once the file finishes
   *  analyzing on its own. */
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
    const now = Date.now();

    this.rateSamples = pruneRateSamples([...this.rateSamples, { t: now, analyzedS }], now);
    const etaS = estimateEtaS(this.rateSamples, totalS, analyzedS, now);
    this.cb.onProgress?.({ analyzedS, totalS, etaS });
  }

  private applyEvents(events: AnnotationEvent[]): void {
    for (const ev of events) {
      if (ev.type === 'retract') {
        // A guess the user hasn't touched never got confirmed — remove it
        // entirely, as if it had never been shown. Never erase an explicit
        // user choice, even if the algorithm itself would retract it.
        if (!this.annotations.get(ev.id)?.userConfirmed) this.annotations.delete(ev.id);
        continue;
      }
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
          liked: existing.liked,
        });
      } else {
        // The aggregator never knows about the like marker — carry it forward
        // across updates the same as any other user choice.
        this.annotations.set(ev.annotation.id, { ...ev.annotation, liked: existing?.liked ?? false });
      }
    }
    this.cb.onAnnotations?.(events, this.getAnnotations());
  }

  /** Toggle the "I liked this tune" marker — no bearing on recognition. */
  toggleLike(annotationId: string): void {
    const ann = this.annotations.get(annotationId);
    if (!ann) return;
    this.annotations.set(annotationId, { ...ann, liked: !ann.liked });
  }

  /** Filename without extension — the default name shown/persisted until renamed. */
  defaultName(): string {
    return this.file.name.replace(/\.[^.]+$/, '');
  }

  private async save(): Promise<RecordedSession> {
    this.setPhase('saving');
    // this.getAnnotations() is now trustworthy as the FINAL result, not just
    // a live snapshot: viterbiSegmenter.ts only marks a segment `finalized`
    // once ViterbiResult.convergedThroughIndex (an exact, provable property
    // of the Viterbi decode — see its doc) shows no future window could ever
    // revise it, rather than the old finalizationLagSeconds time guess. A
    // finished import therefore already matches what a from-scratch
    // recomputeAnnotations() replay (still used by recovery.ts for crash
    // recovery, where the live annotation map is gone) would produce — no
    // need to pay for that extra replay here too (2026-08-21).
    const session: RecordedSession = {
      id: this.sessionId,
      name: this.name || this.defaultName(),
      // No trustworthy t=0 for a file (mtime survives transfers erratically):
      // dateless unless the user set one during analysis or in the summary.
      date: this.dateOverride,
      // Prefer the worker's own sample-accurate clock over source.duration
      // when the latter was only a pre-decode estimate that undershot it
      // (see analyzedDurationS) — never persist a session shorter than what
      // was actually analyzed.
      duration: Math.max(this.source!.duration!, this.analyzedDurationS),
      mimeType: this.file.type || 'application/octet-stream',
      source: this.sourceOverride ?? 'import',
      annotations: this.getAnnotations(),
    };
    // Store the original file untouched: no webm duration bug, native seeking.
    await saveSessionAudio(session.id, this.file);
    await saveSessionMeta(session);
    this.setPhase('done');
    return session;
  }
}
