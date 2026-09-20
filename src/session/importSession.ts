import { WakeLockManager } from './audio/capture';
import { createFileSource } from './audio/sources';
import type { PcmSource } from './audio/sources';
import { RecognitionClient } from './recognitionClient';
import { saveSessionMeta, saveSessionAudio } from './db';
import { ANALYSIS_SAMPLE_RATE, HOP_S_IMPORT, IMPORT_MIN_S } from './sessionConfig';
import type { Analysis, Detection, WindowResult, DetectionEvent, DetectionAlternate } from './model';
import { alternatePickFields, withManualAlternate, manualAlternateRemovalFields } from './model';
import { applyDetectionEvents } from './detectionState';
import type { IndexProgress } from './recognition/indexStore';

// ── Import session orchestrator ───────────────────────────────────────────────
// Turns a user-provided audio file into a full Cadence session: the original
// file is stored AS-IS (no re-encoding, native seeking) and the recognition
// pipeline runs over the decoded PCM faster than real time, through the exact
// same worker path as live capture.

export type ImportPhase = 'idle' | 'initializing' | 'decoding' | 'analyzing' | 'extracting' | 'saving' | 'done' | 'cancelled' | 'error';

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
  onDetections?: (events: DetectionEvent[], all: Detection[]) => void;
  /** 0 → 1 while a video's audio is being copied out of it (phase
   *  'extracting'). Never called for a file that keeps its own bytes. */
  onExtractProgress?: (ratio: number) => void;
  /** The file to play from now on — a video's extracted audio, which the
   *  browser can open where the video itself could not. Fires once, before the
   *  analysis starts, and only when a file was actually replaced. */
  onPlaybackFile?: (file: File) => void;
  onError?: (message: string) => void;
}

export class ImportSession {
  private cb: ImportSessionCallbacks;
  private phase: ImportPhase = 'idle';
  /** The file the user picked, whatever it holds. Keeps its name, its date and
   *  its type — what the analysis is CALLED comes from here. */
  readonly file: File;
  /** Set once a video has been reduced to its sound — see keepAudioOnly. */
  private audioFile: File | null = null;

  /** What is analysed, played and stored: the extracted audio when there was a
   *  picture to leave behind, the file itself otherwise. */
  get playbackFile(): File { return this.audioFile ?? this.file; }

  private recognition: RecognitionClient | null = null;
  private source: PcmSource | null = null;
  private wakeLock = new WakeLockManager();
  private annotations = new Map<string, Detection>();
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
  /** Editable during analysis. No trustworthy t=0 for a file: a new import
   *  starts on a guess from the file's modification time (see fileStartDate),
   *  null when that says nothing — and the user corrects or erases it here or
   *  in the summary. */
  dateOverride: string | null = null;
  /** Overrides the persisted session's `source` on save() — only set when
   *  re-analyzing an existing session (sessionModule.ts's startReanalyze), so
   *  a live recording re-processed this way still shows as "live" in the
   *  library, not "import". null = the normal fresh-import behavior. */
  sourceOverride: Analysis['source'] | null = null;
  /** Decks PINNED in the deck choice modal while this import is open — they
   *  come back ticked on the next add or link, and that is all they do. Purely
   *  in-memory and never persisted: picking a destination is a decision about
   *  right now, not a preference (see components/deckSelector.tsx). */
  pinnedDeckIds: Set<string> = new Set();
  /** Manual transposition (semitones, -12..12) applied to the ongoing analysis.
   *  ENGINE sign: positive raises the transcribed contour to meet an index held
   *  at written pitch, so a recording a tone DOWN is +2 here — the opposite of
   *  what a musician says, flipped for display in PitchShiftControl.tsx.
   *  Set once, before start(), from the module's setting (sessionModule.tsx) —
   *  never changed while running since 2026-09-13: an import outruns anyone
   *  reaching for a control, and a change midway would analyse the file at two
   *  pitches. See TuneAnalyserModuleData.pitchShift. */
  pitchShift = 0;

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

  getDetections(): Detection[] {
    return [...this.annotations.values()].sort((a, b) => a.start - b.start);
  }

  /** Closed annotations — what a partial keep after cancellation would retain. */
  getClosedCount(): number {
    return this.getDetections().filter(a => a.end !== null).length;
  }

  /**
   * Runs the full import. Returns the saved session, or null when cancelled —
   * call keepPartial() afterwards to save what was recognised anyway. Deleting
   * the analysis (cancel({ discard: true })) never gets that offer.
   */
  async start(): Promise<Analysis | null> {
    try {
      this.setPhase('initializing');
      this.recognition = new RecognitionClient(ANALYSIS_SAMPLE_RATE, {
        onIndexProgress: p => this.cb.onIndexProgress?.(p),
        onWindow: result => this.onWindow(result),
        onDetections: events => this.applyEvents(events),
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

      // Before anything reads the file: a video is reduced to its sound, and
      // everything that follows — the analysis, the slice playback on this
      // screen, what is stored — works on that. See audioOnly().
      await this.keepAudioOnly();
      if (this.cancelRequested) {
        this.setPhase('cancelled');
        return null;
      }

      this.setPhase('decoding');
      this.source = await createFileSource(this.playbackFile);
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

  /** Set when the cancellation came from DELETE rather than from "Cancel"
   *  beside the progress bar. Two buttons, two meanings: cancelling stops the
   *  work and leaves what was recognised worth offering, deleting means the
   *  analysis goes — partial or not (2026-09-12). Only the caller that handles
   *  the outcome can tell them apart, so which one it was is recorded here
   *  rather than guessed there. */
  discardOnCancel = false;

  /** Stop the analysis; start() then resolves null (nothing saved). Safe to
   *  call at any phase — during initializing/decoding there's no `source`
   *  yet to stop(), so the two cancelRequested checks in start() (right
   *  after each of those phases) are what actually makes cancelling early
   *  take effect immediately instead of only once the file finishes
   *  analyzing on its own.
   *
   *  `discard` says this was the delete button: see discardOnCancel. */
  cancel(opts: { discard?: boolean } = {}): void {
    this.discardOnCancel = opts.discard === true;
    this.cancelRequested = true;
    this.source?.stop();
  }

  /** After a cancellation: save the partially analysed session anyway. */
  async keepPartial(): Promise<Analysis> {
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

  private applyEvents(events: DetectionEvent[]): void {
    applyDetectionEvents(this.annotations, events);
    this.cb.onDetections?.(events, this.getDetections());
  }

  /** Toggle the "I liked this tune" marker — no bearing on recognition. */
  toggleLike(annotationId: string): void {
    const ann = this.annotations.get(annotationId);
    if (!ann) return;
    this.annotations.set(annotationId, { ...ann, liked: !ann.liked });
  }

  /** Records the user's verdict on this detection's identity — see
   *  LiveSession's identical method for the full doc. */
  selectAlternate(annotationId: string, pick: DetectionAlternate | null): void {
    const ann = this.annotations.get(annotationId);
    if (!ann) return;
    this.annotations.set(annotationId, { ...ann, ...alternatePickFields(ann, pick) });
  }

  /** Adds a tune named by hand to this detection's variants, choosing nothing
   *  — see model.ts's withManualAlternate. */
  addManualAlternate(annotationId: string, tune: DetectionAlternate): void {
    const ann = this.annotations.get(annotationId);
    if (!ann) return;
    this.annotations.set(annotationId, { ...ann, manualAlternates: withManualAlternate(ann, tune) });
  }

  /** Removes a hand-named variant — see model.ts's manualAlternateRemovalFields. */
  removeManualAlternate(annotationId: string, tuneId: string): void {
    const ann = this.annotations.get(annotationId);
    if (!ann) return;
    this.annotations.set(annotationId, { ...ann, ...manualAlternateRemovalFields(ann, tuneId) });
  }

  /** Filename without extension — the default name shown/persisted until renamed. */
  defaultName(): string {
    return this.file.name.replace(/\.[^.]+$/, '');
  }

  /** The audio of an imported VIDEO, to store in place of the whole film.
   *
   *  Null whenever the file stays as it is — audio already, a container this
   *  cannot rewrite, or a copy that would not be exact (extractAudioOnly says
   *  which). A failure here is never the import's failure: it is logged, and
   *  the whole file is used exactly as it was before 2026-09-18.
   *
   *  It runs in its own phase because it is the one step whose cost follows
   *  the size of the FILE rather than the length of the music: a minute of 4K
   *  is hundreds of megabytes to read through for a few of sound. */
  /** Replaces the file everything downstream works on by its sound alone,
   *  when there is a picture to leave behind.
   *
   *  Done BEFORE the analysis rather than at save time (2026-09-18, second
   *  pass): the analysis then reads a few megabytes instead of seeking through
   *  a whole film, and — the reason the user asked — the slices become
   *  listenable while it runs, since neither QuickTime nor AVI can be played
   *  by the browser while an m4a or a WAV can.
   *
   *  The peak memory is the same either way: nothing here ever holds the video
   *  (the packets are streamed), and what is held is the extracted audio, a
   *  few MB, whichever end of the import it is made at. */
  private async keepAudioOnly(): Promise<void> {
    const stripped = await this.audioOnly();
    if (stripped) {
      // Keeps the original's base name, so the analysis is still called after
      // the file the user picked — defaultName() reads this one.
      const base = this.file.name.replace(/\.[^.]+$/, '');
      this.audioFile = new File([stripped.blob], `${base}.${stripped.extension}`, { type: stripped.blob.type });
    }
    // Announced even when nothing was replaced: this is the moment the screen
    // learns what it will be able to play, and "the file as it is" is an
    // answer to that question too.
    this.cb.onPlaybackFile?.(this.playbackFile);
  }

  private async audioOnly(): Promise<{ blob: Blob; extension: string } | null> {
    let announced = false;
    const announce = () => {
      // Only once it is known there IS something to try — the phase must not
      // flash by on the ordinary audio import, which answers immediately.
      if (!announced) { announced = true; this.setPhase('extracting'); }
    };
    /** Each attempt swallows its own failure: the copier THROWS on a container
     *  it cannot read (an AVI: UnsupportedInputFormatError), and that is not an
     *  error, it is the answer "not this way" — which the next attempt is there
     *  to take up. */
    const attempt = async (what: string, run: () => Promise<{ blob: Blob; extension: string } | null>) => {
      try {
        return await run();
      } catch (e) {
        console.debug(`[import] ${what} did not apply to this file`, e);
        return null;
      }
    };

    let stripped = await attempt('copying the audio out', async () => {
      const { extractAudioOnly } = await import('./audio/clipExtract');
      return extractAudioOnly(this.file, (ratio) => {
        announce();
        this.cb.onExtractProgress?.(ratio);
      });
    });

    // A container the copier cannot rewrite — an AVI, above all. Its audio may
    // still be raw PCM, and then it needs no muxer at all. Videos only: an
    // audio file is never rewritten, it is already what it should be.
    if (!stripped && this.file.type.startsWith('video/')) {
      announce();
      stripped = await attempt('writing the audio out as a WAV', async () => {
        const { extractPcmWav } = await import('./audio/streamingFileSource');
        return extractPcmWav(this.file);
      });
    }

    if (stripped) {
      console.debug(`[import] audio kept, picture dropped: ${(this.file.size / 1048576).toFixed(1)} MB → ${(stripped.blob.size / 1048576).toFixed(1)} MB`);
    } else if (this.file.type.startsWith('video/')) {
      console.warn('[import] the audio could not be separated from the picture — keeping the file whole', this.file.type);
    }
    return stripped;
  }

  private async save(): Promise<Analysis> {
    this.setPhase('saving');
    // this.getDetections() is now trustworthy as the FINAL result, not just
    // a live snapshot: viterbiSegmenter.ts only marks a segment `finalized`
    // once ViterbiResult.convergedThroughIndex (an exact, provable property
    // of the Viterbi decode — see its doc) shows no future window could ever
    // revise it, rather than the old finalizationLagSeconds time guess. A
    // finished import therefore already matches what a from-scratch
    // recomputeDetections() replay (still used by recovery.ts for crash
    // recovery, where the live detection map is gone) would produce — no
    // need to pay for that extra replay here too (2026-08-21).
    const session: Analysis = {
      id: this.sessionId,
      name: this.name || this.defaultName(),
      // No trustworthy t=0 for a file (mtime survives transfers erratically):
      // whatever the date field holds — the modification-time guess, or what
      // the user made of it.
      date: this.dateOverride,
      // Prefer the worker's own sample-accurate clock over source.duration
      // when the latter was only a pre-decode estimate that undershot it
      // (see analyzedDurationS) — never persist a session shorter than what
      // was actually analyzed.
      duration: Math.max(this.source!.duration!, this.analyzedDurationS),
      // Of what is STORED, which is not the file that was picked when it was a
      // video: the player reads this to decide how to open the recording.
      mimeType: this.playbackFile.type || 'application/octet-stream',
      source: this.sourceOverride ?? 'import',
      annotations: this.getDetections(),
    };
    // A video's picture is dropped before anything is stored — see
    // extractAudioOnly for what is and is not allowed to happen to the file.
    // Everything else is stored untouched: no webm duration bug, native
    // seeking, and the exact bytes that were analysed.
    await saveSessionAudio(session.id, this.playbackFile);
    await saveSessionMeta(session);
    this.setPhase('done');
    return session;
  }
}
