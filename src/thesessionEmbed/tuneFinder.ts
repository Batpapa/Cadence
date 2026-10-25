import { createLiveSource, createFileSource, probeAudioDuration, canCaptureDeviceAudio, canPlayFile, type LiveStreamSource, type PcmSource } from '../session/audio/sources';
import { WakeLockManager, NoCapturedAudioError, DisplayCaptureUnsupportedError } from '../session/audio/capture';
import { RecognitionClient } from '../session/recognitionClient';
import { DetectionTracker } from '../session/detectionState';
import { ANALYSIS_SAMPLE_RATE, HOP_S_IMPORT, IMPORT_MIN_S, importWarnMinutes } from '../session/sessionConfig';
import { fetchRemoteFile, refusalMessage, RemoteFileError, MAX_REMOTE_ANALYSIS_BYTES } from '../services/remoteFile';
import { isMobileDevice, isAppleTouchDevice } from '../utils';
import type { Detection, DetectionAlternate } from '../session/model';
import type { IndexProgress } from '../session/recognition/indexStore';
import { MemoryRecorder } from './memoryRecorder';

// ── Listen-and-name, with nothing kept ────────────────────────────────────────
// The analyser's pipelines with everything an analysis needs taken out: no
// recorder, no draft, no analysis lock, no Drive backup, no user. The four
// sources are the analyser's own — the microphone and the capture of the
// computer's sound through LiveSession's source and worklet, a file or a link
// through ImportSession's decoder at its hop — feeding the same worker and the
// same tracker, so what this names is what the analyser would name.
//
// One worker per run, disposed at the end, as both orchestrators do: the
// worker's wall-clock catch-up (ffWorker.ts's padToWallClock) anchors on the
// first live chunk it sees, and a stray chunk from the previous run would make
// it pad the whole idle time as silence. It also gives the ~30 MB index back
// to the page between runs, which matters more on someone else's site. The
// run's tracker outlives it: a detection can still be confirmed afterwards,
// as in the analyser's summary, and its sound kept to play the detections
// back: the file itself for a recording, a MemoryRecorder for a live run.

export type SourceKind = 'mic' | 'device' | 'file' | 'link';

export type FinderError =
  | 'mic-denied' | 'no-mic' | 'no-shared-audio' | 'capture-not-allowed' | 'unsupported'
  | 'too-short' | 'too-long' | 'cant-decode' | 'bad-url' | 'link' | 'not-recording' | 'failed';

export type FinderStatus =
  | { kind: 'idle' }
  /** The browser's microphone prompt, or its share picker. */
  | { kind: 'opening' }
  | { kind: 'downloading'; received: number; total: number | null }
  /** Reading the file before the analysis: its length, how it decodes. */
  | { kind: 'checking' }
  | { kind: 'loading'; progress: IndexProgress | null }
  | { kind: 'listening' }
  | { kind: 'analysing'; analyzedS: number; totalS: number }
  | { kind: 'stopping' }
  | { kind: 'error'; error: FinderError; detail: string };

/** One listening or one analysed recording, and what was heard in it. */
export interface Run {
  /** Its place among the runs, which is how a confirmation finds it. */
  index: number;
  kind: SourceKind;
  /** The file's name; empty for the live sources. */
  label: string;
  startedAt: number;
  /** In the order they were played. */
  detections: Detection[];
}

interface RunState {
  kind: SourceKind;
  label: string;
  startedAt: number;
  tracker: DetectionTracker;
  /** What its detections are played from; null when the browser could not
   *  play it back (a QuickTime or AVI video, typically). */
  sound: Blob | MemoryRecorder | null;
}

/** A failure that already knows what to tell the user. */
class FinderFailure extends Error {
  constructor(readonly error: FinderError, readonly detail = '') { super(error); }
}

/** What the page needs and the browser may lack. Checked before asking for
 *  anything: a permission prompt followed by "cannot work here" is worse than
 *  saying so at once. getUserMedia is also missing outside a secure context,
 *  which an http:// embed would be. */
export function finderSupported(): boolean {
  return typeof WebAssembly === 'object'
    && typeof Worker === 'function'
    && typeof AudioWorkletNode === 'function'
    && !!navigator.mediaDevices?.getUserMedia;
}

/** The capture tab is offered wherever the analyser offers it: hidden where
 *  getDisplayMedia does not exist (phones), shown otherwise. */
export const canOfferCapture = canCaptureDeviceAudio;

/** On top of that, a cross-origin frame only gets getDisplayMedia when the
 *  embedding page grants it, `allow="display-capture"` on the iframe — which
 *  The Session's does not today. Chromium says so up front (featurePolicy);
 *  elsewhere the share picker's refusal tells. Offered anyway, and refused
 *  with the reason: hiding it would leave the page's owner no way to learn
 *  that one attribute brings it. */
function frameAllowsCapture(): boolean {
  const policy = (document as Document & { featurePolicy?: { allowsFeature(f: string): boolean } }).featurePolicy;
  return policy ? policy.allowsFeature('display-capture') : true;
}

const isRecording = (mime: string) => mime.startsWith('audio/') || mime.startsWith('video/');

function errorName(err: unknown): unknown {
  return (err as { name?: unknown } | null)?.name;
}

function classify(err: unknown): FinderFailure {
  if (err instanceof FinderFailure) return err;
  if (err instanceof NoCapturedAudioError) return new FinderFailure('no-shared-audio');
  if (err instanceof DisplayCaptureUnsupportedError) return new FinderFailure('unsupported');
  if (err instanceof RemoteFileError) {
    return err.refusal.why === 'unsupported'
      ? new FinderFailure('not-recording')
      : new FinderFailure('link', refusalMessage(err.refusal, MAX_REMOTE_ANALYSIS_BYTES));
  }
  const name = errorName(err);
  // Safari says SecurityError where the others say NotAllowedError, for the
  // same refusal (and for a frame not allowed the microphone at all).
  if (name === 'NotAllowedError' || name === 'SecurityError') return new FinderFailure('mic-denied');
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return new FinderFailure('no-mic');
  // The same reading of a decoder's refusal as the analyser's import screen.
  const msg = String(err);
  if (msg.includes('decod') || msg.includes('Decod') || msg.includes('EncodingError')) return new FinderFailure('cant-decode');
  return new FinderFailure('failed', String((err as Error)?.message ?? err));
}

export class TuneFinder {
  private live: LiveStreamSource | null = null;
  private fileSource: PcmSource | null = null;
  private download: AbortController | null = null;
  private recognition: RecognitionClient | null = null;
  private recorder: MemoryRecorder | null = null;
  /** Every run since the page opened, oldest first. */
  private all: RunState[] = [];
  /** The run in progress, the last of `all`; null between runs. */
  private active: RunState | null = null;
  private wakeLock = new WakeLockManager();
  /** Bumped by every stop and failure: a start still awaiting a prompt, a
   *  download or the index sees it changed and gives up instead of going on. */
  private run = 0;

  status: FinderStatus = { kind: 'idle' };
  listeningSince = 0;
  /** The analyser's manual transposition, ENGINE sign (see
   *  PitchShiftControl.tsx: a session a tone down is +2 here). Live-adjustable
   *  while listening; a file takes the value it starts with. */
  private pitchShift = 0;

  constructor(private readonly onChange: () => void) {}

  /** Every run since the page opened, oldest first, the current one last. */
  runs(): Run[] {
    return this.all.map((r, index) => ({
      index, kind: r.kind, label: r.label, startedAt: r.startedAt, detections: r.tracker.list(),
    }));
  }

  /** The source of the run in progress, if any. */
  get running(): SourceKind | null {
    return this.active?.kind ?? null;
  }

  /** The analyser's confirmation, from its alternatives picker: any tune
   *  confirms the detection, the decoder's own pick included, and `null`
   *  hands it back to the decoder (DetectionTracker.confirm). */
  confirm(runIndex: number, detectionId: string, pick: DetectionAlternate | null): void {
    this.all[runIndex]?.tracker.confirm(detectionId, pick);
    this.onChange();
  }

  /** Whether a run's detections can be played now. Not a live run still
   *  going: through the speakers, the microphone would hear the replay and
   *  name it again — the analyser's live screen has no play button either. */
  canPlay(runIndex: number): boolean {
    const r = this.all[runIndex];
    return !!r?.sound && !(r === this.active && (r.kind === 'mic' || r.kind === 'device'));
  }

  /** The file a run's detections are played from, as it stands. */
  sound(runIndex: number): Promise<Blob> | null {
    const s = this.all[runIndex]?.sound;
    if (!s) return null;
    return s instanceof MemoryRecorder ? s.file() : Promise.resolve(s);
  }

  /** Signal level 0–1 for the meter (poll from the UI). */
  /** In the engine's sign — the widget flips it, as Cadence does. */
  setPitchShift(semitones: number): void {
    this.pitchShift = semitones;
    // Only a live run takes it on the way: a file analysed at two pitches
    // would be wrong at one of them (the analyser's own rule, 2026-09-13).
    if (this.active && (this.active.kind === 'mic' || this.active.kind === 'device')) {
      this.recognition?.setPitchShift(semitones);
    }
  }

  getPitchShift(): number { return this.pitchShift; }

  level(): number {
    return this.status.kind === 'listening' ? this.live?.getLevel() ?? 0 : 0;
  }

  /** Back to idle from an error, which otherwise stays until the next run. */
  dismissError(): void {
    if (this.status.kind === 'error') this.set({ kind: 'idle' });
  }

  private set(status: FinderStatus): void {
    this.status = status;
    this.onChange();
  }

  private begin(kind: SourceKind, label: string): number | null {
    if (this.active) return null;
    if (!finderSupported()) {
      this.set({ kind: 'error', error: 'unsupported', detail: '' });
      return null;
    }
    this.active = { kind, label, startedAt: Date.now(), tracker: new DetectionTracker(), sound: null };
    this.all = [...this.all, this.active];
    return ++this.run;
  }

  // ── The microphone, the capture ──

  /** Call straight from the click: the prompt or the share picker is opened
   *  before anything is awaited, while the gesture is still live (see
   *  LiveStreamSource.open — the picker refuses otherwise). */
  startLive(kind: 'mic' | 'device'): void {
    if (kind === 'device' && !frameAllowsCapture()) {
      this.set({ kind: 'error', error: 'capture-not-allowed', detail: '' });
      return;
    }
    const run = this.begin(kind, '');
    if (run === null) return;
    const source = createLiveSource(kind);
    this.live = source;
    // The device unplugged, the shared tab closed, the browser's own "Stop
    // sharing": keep what was heard, as the analyser does.
    source.onEnded = () => { void this.stop(); };
    this.set({ kind: 'opening' });
    this.bootLive(run, source).catch(err => this.failed(run, err));
  }

  private async bootLive(run: number, source: LiveStreamSource): Promise<void> {
    await source.open();
    if (run !== this.run) return;
    this.set({ kind: 'loading', progress: null });
    const recognition = this.newRecognition(run, source.sampleRate);
    await recognition.ready;
    if (run !== this.run) return;

    await source.start(recognition);
    if (run !== this.run) return;
    // Started right after the worklet, as LiveSession starts its recorder: the
    // two clocks then agree to a few hundred milliseconds. The graph-routed
    // stream, not the raw track — see LiveStreamSource.recordingStream.
    // Without MediaRecorder the run is still analysed, just not playable.
    try {
      this.recorder = new MemoryRecorder(source.recordingStream);
      this.recorder.start();
      this.active!.sound = this.recorder;
    } catch (err) {
      console.warn('[thesession-embed] no recorder, detections will not be playable', err);
      this.recorder = null;
    }
    this.listeningSince = Date.now();
    // A phone left on the table must not sleep mid-tune. Refused in a frame
    // the embedding page did not allow it (`screen-wake-lock`), which
    // WakeLockManager already swallows.
    void this.wakeLock.start();
    this.set({ kind: 'listening' });
  }

  // ── A file, a link ──

  analyseFile(file: File): void {
    const run = this.begin('file', file.name);
    if (run === null) return;
    this.set({ kind: 'checking' });
    this.bootFile(run, file).catch(err => this.failed(run, err));
  }

  /** A DIRECT link to a recording only, as in the analyser (see
   *  LinkImportModal.tsx for why a page that plays one is not read), and
   *  only from a server that lets a page read it (CORS). */
  analyseLink(url: string): void {
    let parsed: URL | null = null;
    try { parsed = new URL(url.trim()); } catch { /* said below */ }
    if (!parsed || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) {
      this.set({ kind: 'error', error: 'bad-url', detail: '' });
      return;
    }
    const run = this.begin('link', parsed.host);
    if (run === null) return;
    const ctrl = new AbortController();
    this.download = ctrl;
    this.set({ kind: 'downloading', received: 0, total: null });
    fetchRemoteFile(parsed.href, {
      signal: ctrl.signal,
      maxBytes: MAX_REMOTE_ANALYSIS_BYTES,
      onProgress: (received, total) => {
        if (run === this.run) this.set({ kind: 'downloading', received, total });
      },
    }).then(remote => {
      if (run !== this.run) return;
      this.download = null;
      if (!isRecording(remote.blob.type)) throw new FinderFailure('not-recording');
      if (this.active) this.active.label = remote.name;
      this.set({ kind: 'checking' });
      return this.bootFile(run, new File([remote.blob], remote.name, { type: remote.blob.type }));
    }).catch(err => this.failed(run, err));
  }

  /** ImportSession's run, minus what it keeps: the audio, the analysis, the
   *  video's sound extracted for playback (nothing is played here, and the
   *  decoder reads a video's audio track as it is). */
  private async bootFile(run: number, file: File): Promise<void> {
    if (this.active && canPlayFile(file)) this.active.sound = file;
    const duration = await probeAudioDuration(file);
    if (duration !== null && duration < IMPORT_MIN_S) throw new FinderFailure('too-short', String(IMPORT_MIN_S));

    // The analyser's guard against the one-shot decode, without its "go
    // ahead anyway" choice: a tab killed for lack of memory would be The
    // Session's tab, whatever the person chose.
    const { StreamingFileSource } = await import('../session/audio/streamingFileSource');
    const probe = await StreamingFileSource.probe(file);
    probe.source?.stop();
    const limitMin = importWarnMinutes(isMobileDevice() || isAppleTouchDevice());
    if (!probe.source && duration !== null && duration > limitMin * 60) {
      throw new FinderFailure('too-long', String(limitMin));
    }
    if (run !== this.run) return;

    this.set({ kind: 'loading', progress: null });
    const recognition = this.newRecognition(run, ANALYSIS_SAMPLE_RATE, true);
    await recognition.ready;
    if (run !== this.run) return;

    const source = await createFileSource(file);
    if (run !== this.run) { source.stop(); return; }
    this.fileSource = source;
    const totalS = source.duration ?? 0;
    if (totalS < IMPORT_MIN_S) throw new FinderFailure('too-short', String(IMPORT_MIN_S));

    void this.wakeLock.start();
    this.set({ kind: 'analysing', analyzedS: 0, totalS });
    await source.start(recognition); // resolves once fully emitted, or stopped
    if (run !== this.run) return;    // stopped: stop() took it from here

    this.set({ kind: 'stopping' });
    const { events } = await recognition.stop();
    if (run !== this.run) return;
    this.active?.tracker.finish(events);
    this.end({ kind: 'idle' }, true);
  }

  private newRecognition(run: number, sampleRate: number, fromFile = false): RecognitionClient {
    const tracker = this.active!.tracker;
    const recognition = new RecognitionClient(sampleRate, {
      onIndexProgress: progress => {
        if (run === this.run && this.status.kind === 'loading') this.set({ kind: 'loading', progress });
      },
      onWindow: result => {
        if (run === this.run && this.status.kind === 'analysing') {
          this.set({ kind: 'analysing', analyzedS: result.tWindowEnd, totalS: this.status.totalS });
        }
      },
      onDetections: events => {
        if (run !== this.run) return;
        tracker.apply(events);
        this.onChange();
      },
      // Before `ready`, its rejection reports it; after, nothing else would —
      // the run is dead either way.
      onError: message => {
        if (run === this.run && (this.status.kind === 'listening' || this.status.kind === 'analysing')) {
          this.failed(run, new Error(message));
        }
      },
    }, fromFile ? { hopS: HOP_S_IMPORT } : {});
    if (this.pitchShift !== 0) recognition.setPitchShift(this.pitchShift);
    this.recognition = recognition;
    return recognition;
  }

  // ── Ending a run ──

  /** Stops listening or analysing — or cancels a start still in progress.
   *  What was heard stays on screen; the decoder's last word on the open tune
   *  is awaited. */
  async stop(): Promise<void> {
    const active = this.active;
    if (!active || this.status.kind === 'stopping') return;
    const wasRunning = this.status.kind === 'listening' || this.status.kind === 'analysing';
    const recognition = this.recognition;
    this.run++;
    this.release();
    if (wasRunning && recognition) {
      this.set({ kind: 'stopping' });
      const { events } = await recognition.stop();
      active.tracker.finish(events);
    }
    recognition?.dispose();
    // A file cancelled before its analysis began has no answer to keep; one
    // cancelled midway has a partial one, empty or not.
    this.end({ kind: 'idle' }, wasRunning);
  }

  private failed(run: number, err: unknown): void {
    if (run !== this.run) return;
    // Closing the share picker is a decision, not a failure: back to where it
    // was, nothing said — as in the analyser.
    const name = errorName(err);
    const dismissed = this.active?.kind === 'device'
      && (name === 'NotAllowedError' || name === 'AbortError' || name === 'NotFoundError');
    this.run++;
    this.recognition?.dispose();
    this.release();
    if (dismissed) {
      this.end({ kind: 'idle' });
      return;
    }
    console.error('[thesession-embed]', err);
    const failure = classify(err);
    this.end({ kind: 'error', error: failure.error, detail: failure.detail });
  }

  private release(): void {
    // Before the source: stopping the recorder flushes its last chunk, which
    // a stream already ended may not give.
    void this.recorder?.stop();
    this.recorder = null;
    this.download?.abort();
    this.download = null;
    this.live?.stop();
    this.live = null;
    this.fileSource?.stop();
    this.fileSource = null;
    this.recognition = null;
    this.wakeLock.stop();
  }

  /** Closes the run in progress. A live run that heard nothing leaves no
   *  trace, nor one that failed before a tune; a file analysed without a tune
   *  found does (`analysed`) — "nothing found in it" is its answer. */
  private end(status: FinderStatus, analysed = false): void {
    this.recognition?.dispose();
    this.recognition = null;
    const run = this.active;
    if (run && run.tracker.list().length === 0 && !(analysed && (run.kind === 'file' || run.kind === 'link'))) {
      this.all = this.all.filter(r => r !== run);
    }
    this.active = null;
    this.wakeLock.stop();
    this.set(status);
  }
}
