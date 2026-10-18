import { openMicForMusic, openDeviceAudio } from './capture';
import { attachPcmWorklet } from './pcmWorklet';
import { FILE_CHUNK_S, ANALYSIS_SAMPLE_RATE, DEBUG_LIVE_AUDIO, FF_SAMPLE_RATE_MIN, FF_SAMPLE_RATE_MAX } from '../sessionConfig';
import { beginCaptureSession, endCaptureSession } from '../../services/audioSession';
import { isAppleTouchDevice } from '../../utils';
import { isNative, hasNativePlugin } from '../../native/platform';

// ── PCM source abstraction ────────────────────────────────────────────────────
// The recognition pipeline consumes a stream of mono PCM chunks and its own
// sample counter — it never looks at the wall clock. Sources differ only in
// where samples come from and how fast they arrive.
//
// Design note: the interface hands sources a RecognitionSink instead of a bare
// onChunk callback so MicSource can keep the existing zero-copy fast path
// (worklet → MessagePort → worker, main thread out of the hot loop) with zero
// behaviour change in live mode. FileSource uses the acknowledged-chunk path,
// which gives natural backpressure. A future streaming decoder (WebCodecs
// AudioDecoder) can implement PcmSource the same way FileSource does.

export interface RecognitionSink {
  /** Zero-copy path: the sink receives chunks straight from an audio worklet. */
  connectWorkletPort(port: MessagePort): void;
  /** Acknowledged path: resolves once the worker has absorbed the chunk. */
  feedPcmWithAck(chunk: Float32Array): Promise<void>;
}

export interface PcmSource {
  readonly sampleRate: number;
  /** Total duration in seconds when known (file); undefined in live. */
  readonly duration?: number;
  /** Starts emission. Resolves when the source is wired (mic) or fully emitted (file). */
  start(sink: RecognitionSink): Promise<void>;
  stop(): void;
}

// ── Live stream sources (microphone, device audio) ───────────────────────────

/** Everything a live MediaStream needs, whatever produced it: the Web Audio
 *  graph, the VU meter, the recording tap and the worklet feed are identical
 *  for a microphone and for captured device audio. Subclasses differ by exactly
 *  one method — which stream to acquire.
 *  Two-phase: open() first (grabs the stream, fixes the sample rate), then
 *  start(). open() MUST be reached synchronously from a user gesture: device
 *  capture needs transient activation, and the mic prompt is better for it. */
export abstract class LiveStreamSource implements PcmSource {
  private _stream: MediaStream | null = null;
  private audioContext: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private recordingDest: MediaStreamAudioDestinationNode | null = null;
  private workletNode: AudioWorkletNode | null = null;
  /** The stream's two source nodes: one feeding the VU meter and the
   *  recording, one feeding the recognition worklet. Held so that a released
   *  pause can unplug them and plug a new stream in their place. */
  private recordInput: MediaStreamAudioSourceNode | null = null;
  private workletInput: MediaStreamAudioSourceNode | null = null;
  private stopping = false;
  private capturing = false;
  private released = false;

  /** Acquires the stream. The only microphone/tab-specific step. */
  protected abstract openStream(): Promise<MediaStream>;
  /** Tag for debug logging. */
  protected abstract get label(): string;
  /** Whether a pause gives the microphone back — see suspend(). */
  protected get releasesOnPause(): boolean { return false; }

  /** Paused with the microphone given back to the system. */
  get micReleased(): boolean { return this.released; }

  /** Fired when the stream dies on its own — the user pressing the browser's
   *  own "Stop sharing" button, the shared tab closing, a device unplugged.
   *  Never fired by our own stop(). */
  onEnded: (() => void) | null = null;

  /** Fired when sound stops reaching the recording, and when it comes back —
   *  see `stalled`. LiveSession pauses the recording on the first and
   *  resumes it on the second. */
  onStall: ((stalled: boolean) => void) | null = null;
  private lastStalled = false;

  /** The context stopped on its own: iOS took the audio session over (a
   *  phone call, Siri, a system prompt — WebKit's 'interrupted') or suspended
   *  it, and nothing reaches the recorder, the meter or the recognition any
   *  more: the file goes on growing with nothing in it. A recording made that
   *  way came out as a 5-byte file (tester's iPhone, 2026-10-16; the same 5
   *  bytes as a Safari recorder fed by a suspended context, simulator,
   *  2026-10-15). Not while the pause holds the context suspended on purpose
   *  (releaseMic), nor once stopping. */
  get stalled(): boolean {
    const state = this.audioContext?.state as string | undefined;
    return !!state && state !== 'running' && state !== 'closed' && !this.released && !this.stopping;
  }

  private checkStall = (): void => {
    const now = this.stalled;
    if (now === this.lastStalled) return;
    this.lastStalled = now;
    this.onStall?.(now);
  };

  async open(): Promise<void> {
    // Synchronously, still inside the gesture: the iPhone's audio session must
    // allow recording before the microphone is asked for (audioSession.ts).
    this.capturing = true;
    beginCaptureSession();
    try {
      this._stream = await this.openStream();
    } catch (err) {
      this.capturing = false;
      endCaptureSession();
      throw err;
    }
    this.audioContext = new AudioContext();
    // The context runs at the output device's rate, and FolkFriend refuses a
    // rate outside its range — silently: it went on assuming its default, and
    // a Mac whose audio interface was set to 88.2 or 96 kHz got recognition
    // computed on the wrong pitch. Such a device gets a 48 kHz context, which
    // the browser resamples into.
    if (this.audioContext.sampleRate < FF_SAMPLE_RATE_MIN || this.audioContext.sampleRate > FF_SAMPLE_RATE_MAX) {
      void this.audioContext.close().catch(() => { /* never started */ });
      this.audioContext = new AudioContext({ sampleRate: ANALYSIS_SAMPLE_RATE });
    }
    // Some browsers create suspended contexts outside a user gesture chain.
    if (this.audioContext.state === 'suspended') await this.audioContext.resume();
    // Watched from here to the end: one that did not start, or stops later, is
    // said at once — see `stalled`.
    this.audioContext.addEventListener('statechange', this.checkStall);
    this.checkStall();

    const track = this._stream.getAudioTracks()[0];
    console.debug(`[${this.label}] track:`, track?.label, JSON.stringify(track?.getSettings?.() ?? {}));

    this.watchTrack(track);

    const src = this.audioContext.createMediaStreamSource(this._stream);
    this.recordInput = src;

    // VU meter tap (main thread, independent from the recognition path).
    this.analyser = this.audioContext.createAnalyser();
    this.analyser.fftSize = 512;
    src.connect(this.analyser);

    // Recording tap: MediaRecorder consumes the graph's output, not the raw
    // track — recording a track that is simultaneously pulled by WebAudio
    // yields silence on some browsers. This way, what the VU meter shows is
    // exactly what lands in the file.
    this.recordingDest = this.audioContext.createMediaStreamDestination();
    // Mono (2026-09-08). This node defaults to TWO channels, so every session
    // was recorded in stereo — for a microphone, the same signal twice, and for
    // captured device audio, a stereo image nothing downstream ever uses: the
    // recognition worklet reads channel 0 alone, and clips are encoded mono.
    // Half the samples, no perceptible loss, and it is the file the user
    // downloads and (soon) may embed in their synced data.
    //
    // 'explicit' is what makes it a real down-mix rather than a channel being
    // dropped, and it is this node's spec default — set here anyway so the
    // intent survives someone reading only these two lines.
    this.recordingDest.channelCount = 1;
    this.recordingDest.channelCountMode = 'explicit';
    this.recordingDest.channelInterpretation = 'speakers';
    src.connect(this.recordingDest);
  }

  /** The source ending under us is a normal event for a captured surface (the
   *  browser's sharing bar has its own stop button) and an accident for a
   *  microphone — same handling either way. Our own stop() sets `stopping`
   *  first: track.stop() is specified NOT to fire this, but a source dying
   *  in the same tick for its own reasons would be indistinguishable. Only
   *  the CURRENT track counts: one given back by a released pause is history. */
  private watchTrack(track: MediaStreamTrack | undefined): void {
    if (!track) return;
    track.addEventListener('ended', () => {
      if (!this.stopping && this._stream?.getAudioTracks()[0] === track) this.onEnded?.();
    });
  }

  get sampleRate(): number {
    return this.audioContext?.sampleRate ?? 48000;
  }

  /** The raw stream (recognition worklet input). */
  get stream(): MediaStream {
    if (!this._stream) throw new Error('source not opened');
    return this._stream;
  }

  /** Graph-routed stream for MediaRecorder (see open() for why). */
  get recordingStream(): MediaStream {
    if (!this.recordingDest) throw new Error('source not opened');
    return this.recordingDest.stream;
  }

  /** Signal level 0–1 for the VU meter (poll from UI). */
  getLevel(): number {
    if (!this.analyser) return 0;
    const data = new Uint8Array(this.analyser.fftSize);
    this.analyser.getByteTimeDomainData(data);
    let sum = 0;
    for (let i = 0; i < data.length; i++) {
      const v = (data[i]! - 128) / 128;
      sum += v * v;
    }
    return Math.min(1, Math.sqrt(sum / data.length) * 4);
  }

  async start(sink: RecognitionSink): Promise<void> {
    if (!this._stream || !this.audioContext) throw new Error('source not opened');
    const channel = new MessageChannel();
    sink.connectWorkletPort(channel.port1);
    // A source node of its own, as before: the worklet never shared the one
    // feeding the meter and the recording.
    this.workletInput = this.audioContext.createMediaStreamSource(this._stream);
    this.workletNode = await attachPcmWorklet(this.audioContext, this.workletInput, channel.port2);
  }

  /** Pause/resume gate the WORKLET, not the AudioContext.
   *
   *  Suspending the context was the obvious implementation and it is what this
   *  did until 2026-09-08. It does not come back: a MediaStreamAudioSourceNode
   *  feeding a suspended context is not guaranteed to deliver again once the
   *  context resumes, and in Chromium it frequently does not — the context
   *  reports `running`, the worklet keeps being called, and its input is empty
   *  forever after. Reported as "the analysis feed is stuck", still stuck three
   *  minutes later.
   *
   *  So the context now runs uninterrupted for the whole session and the
   *  processor simply stops forwarding. The recording tap is unaffected because
   *  MediaRecorder has its own pause(); the VU meter keeps reading, and the UI
   *  already pins it to zero while not recording. */
  async suspend(keepMic = false): Promise<void> {
    if (DEBUG_LIVE_AUDIO) console.log(`[live] suspend: ctx=${this.audioContext?.state} node=${!!this.workletNode}`);
    this.workletNode?.port.postMessage({ paused: true });
    // `keepMic`: the pause the system forced (a stall). The context is the
    // system's to give back, and watching it is how the end of the
    // interruption is seen — released and suspended by us, it would say
    // nothing.
    if (this.releasesOnPause && !keepMic) await this.releaseMic();
  }

  /** iPhone: a pause gives the microphone back, so the camera can film.
   *
   *  While a page captures the microphone, WebKit puts iOS's audio session in
   *  PlayAndRecord with the VideoChat mode — a video call, as far as the
   *  system is concerned — and the camera refuses to film "during a call"
   *  (tester, 2026-10-12: impossible during a live, paused or not; fine after
   *  Stop). Android gives the microphone to the app in front and hands
   *  the one behind silence, so filming already works there.
   *
   *  What WebKit looks at (MediaSessionManagerCocoa.mm, updateSessionState):
   *  an active capture source, a session type forced by the page — our own
   *  navigator.audioSession 'play-and-record' — or audio playing while the
   *  category is still PlayAndRecord, which a running context counts as. So
   *  all three go: the tracks are stopped, the session type handed back, and
   *  the context suspended. That last one is safe HERE and nowhere else: the
   *  reason this class never suspends (see above) is a stream source that
   *  does not deliver again, and this pause replaces the source anyway.
   *
   *  The recorder is untouched: it reads `recordingDest`, which stays, so the
   *  file goes on where it stopped once a new microphone is plugged in. */
  private async releaseMic(): Promise<void> {
    if (this.released || !this._stream) return;
    this.released = true;
    this.recordInput?.disconnect();
    this.workletInput?.disconnect();
    this.recordInput = null;
    this.workletInput = null;
    const old = this._stream;
    this._stream = null;            // before stop(): its 'ended', if any, is history
    old.getTracks().forEach(trk => trk.stop());
    if (this.capturing) { this.capturing = false; endCaptureSession(); }
    await this.audioContext?.suspend().catch(() => { /* closed under us: stop() is coming */ });
    if (DEBUG_LIVE_AUDIO) console.log(`[live] micro rendu: ctx=${this.audioContext?.state}`);
  }

  /** The other half of releaseMic(). Reached synchronously from the Resume
   *  tap, like open(): the session type has to allow recording before the
   *  microphone is asked for. Throws as getUserMedia does — refused, or
   *  NotReadableError, which iOS has been seen to raise on a second capture —
   *  leaving the pause as it was, so Resume can be tried again or Stop pressed. */
  private async reacquireMic(): Promise<void> {
    const ctx = this.audioContext;
    if (!ctx) throw new Error('source not opened');
    this.capturing = true;
    beginCaptureSession();
    let stream: MediaStream;
    try {
      stream = await this.openStream();
    } catch (err) {
      this.capturing = false;
      endCaptureSession();
      throw err;
    }
    if (ctx.state !== 'running') await ctx.resume();
    this._stream = stream;
    this.watchTrack(stream.getAudioTracks()[0]);
    this.recordInput = ctx.createMediaStreamSource(stream);
    if (this.analyser) this.recordInput.connect(this.analyser);
    if (this.recordingDest) this.recordInput.connect(this.recordingDest);
    this.workletInput = ctx.createMediaStreamSource(stream);
    if (this.workletNode) this.workletInput.connect(this.workletNode);
    this.released = false;
  }

  async resume(): Promise<void> {
    if (this.released) await this.reacquireMic();
    // The context should never have stopped, but a browser may suspend it on
    // its own (backgrounded tab, autoplay policy) — resuming an already-running
    // context is a no-op, so this stays as a safety net.
    // 'interrupted' too: WebKit's own state for a context the system took over
    // (a phone call, Siri, an alarm), which never reads 'suspended'.
    const state = this.audioContext?.state as string | undefined;
    if (state === 'suspended' || state === 'interrupted') await this.audioContext!.resume();
    if (DEBUG_LIVE_AUDIO) console.log(`[live] resume: ctx=${this.audioContext?.state} node=${!!this.workletNode} track=${this.trackState()}`);
    this.workletNode?.port.postMessage({ paused: false });
    // Out of the pause with a context still not running — `released` turned
    // false without any statechange to say so.
    this.checkStall();
  }

  /** Compact track diagnostics for the pause/resume trace. */
  private trackState(): string {
    const t = this._stream?.getAudioTracks()[0];
    return t ? `${t.readyState}/muted=${t.muted}/enabled=${t.enabled}` : 'none';
  }

  stop(): void {
    this.stopping = true;
    this.onEnded = null;
    this.checkStall();   // stopping: never stalled any more, said once
    this.onStall = null;
    if (this.capturing) { this.capturing = false; endCaptureSession(); }
    this._stream?.getTracks().forEach(trk => trk.stop());
    this._stream = null;
    this.recordInput = null;
    this.workletInput = null;
    this.released = false;
    this.workletNode?.disconnect();
    this.workletNode = null;
    void this.audioContext?.close().catch(() => { /* already closed */ });
    this.audioContext = null;
    this.analyser = null;
  }
}

/** Microphone: getUserMedia with music constraints. */
export class MicSource extends LiveStreamSource {
  protected openStream(): Promise<MediaStream> { return openMicForMusic(); }
  protected get label(): string { return 'mic'; }
  /** iPhone and iPad only — see releaseMic(). Elsewhere the pause keeps the
   *  microphone, which is what the resume was built around. */
  protected get releasesOnPause(): boolean { return isAppleTouchDevice(); }
}

/** A browser tab, a window, or a whole screen's system audio — whatever the
 *  user picks in the browser's own share dialog. Chromium only; see
 *  openDeviceAudio() for what the other browsers do instead.
 *  In the Android app: what the phone's other apps play, through the app's own
 *  plugin (native/systemAudioCapture.ts). */
export class DeviceAudioSource extends LiveStreamSource {
  /** Ends the app's capture, which stopping the stream's track cannot reach. */
  private releaseNative: (() => void) | null = null;

  protected async openStream(): Promise<MediaStream> {
    // The browser's branch first and without an await before it: the share
    // picker needs the tap's transient activation (see openDeviceAudio).
    if (!isNative()) return openDeviceAudio();
    const { openSystemAudio } = await import('../../native/systemAudioCapture');
    const capture = await openSystemAudio();
    this.releaseNative = capture.stop;
    return capture.stream;
  }

  protected get label(): string { return 'device'; }

  stop(): void {
    super.stop();
    this.releaseNative?.();
    this.releaseNative = null;
  }
}

/** The two live sources, as chosen in the UI. A file import is not one of
 *  these: it runs through ImportSession, not LiveSession. */
export type LiveSourceKind = 'mic' | 'device';

export function createLiveSource(kind: LiveSourceKind): LiveStreamSource {
  return kind === 'device' ? new DeviceAudioSource() : new MicSource();
}

/** Whether the device-audio option is worth offering at all. False on iOS and
 *  Android's browsers, where getDisplayMedia does not exist. True in Firefox
 *  and Safari desktop, which HAVE the API but silently return no audio track —
 *  that case can only be caught after the fact, as NoCapturedAudioError.
 *  True in the Android app once its native side has the capture (an older
 *  install running today's page over the air does not). */
export function canCaptureDeviceAudio(): boolean {
  if (isNative()) return hasNativePlugin('SystemAudioCapture');
  return typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getDisplayMedia;
}

// ── FileSource ────────────────────────────────────────────────────────────────

/** Decoded-file source: streams sequential chunks as fast as the worker
 *  absorbs them (per-chunk acknowledgement = backpressure). The constructor
 *  takes raw PCM so emission logic stays unit-testable without Web Audio. */
export class FileSource implements PcmSource {
  private cancelled = false;

  constructor(
    private readonly pcm: Float32Array,
    readonly sampleRate: number,
  ) {}

  get duration(): number {
    return this.pcm.length / this.sampleRate;
  }

  /** Decode an audio file to mono PCM at the analysis rate.
   *  decodeAudioData resamples to the OfflineAudioContext rate automatically
   *  (never resample manually) and detaches the input ArrayBuffer. */
  static async fromFile(file: Blob, targetSampleRate = ANALYSIS_SAMPLE_RATE): Promise<FileSource> {
    const arrayBuf = await file.arrayBuffer();
    const ctx = new OfflineAudioContext(1, 1, targetSampleRate);
    const decoded = await ctx.decodeAudioData(arrayBuf);

    // Mix down to mono.
    const len = decoded.length;
    const pcm = new Float32Array(len);
    for (let ch = 0; ch < decoded.numberOfChannels; ch++) {
      const data = decoded.getChannelData(ch);
      for (let i = 0; i < len; i++) pcm[i]! += data[i]! / decoded.numberOfChannels;
    }
    return new FileSource(pcm, targetSampleRate);
  }

  async start(sink: RecognitionSink): Promise<void> {
    const chunkSize = Math.round(FILE_CHUNK_S * this.sampleRate);
    for (let off = 0; off < this.pcm.length && !this.cancelled; off += chunkSize) {
      // slice() copies: transferring a subarray's buffer would detach the whole file.
      const chunk = this.pcm.slice(off, Math.min(off + chunkSize, this.pcm.length));
      await sink.feedPcmWithAck(chunk);
    }
  }

  stop(): void {
    this.cancelled = true;
  }
}

/** Prefers chunk-by-chunk decoding (StreamingFileSource — memory bounded by
 *  chunk size, not file duration) over the one-shot FileSource/decodeAudioData
 *  path, falling back automatically when WebCodecs or the file's codec isn't
 *  supported. Never a regression: the fallback is exactly what ran before.
 *  Dynamic import: web-demuxer only needs to load for users who actually
 *  import a file, same convention as the other heavy/occasional deps (abcjs,
 *  audioPlayer.tsx) — keeps it out of the eagerly-loaded main bundle. */
export async function createFileSource(file: File): Promise<PcmSource> {
  const { StreamingFileSource } = await import('./streamingFileSource');
  return (await StreamingFileSource.tryCreate(file)) ?? FileSource.fromFile(file);
}

// ── File helpers ──────────────────────────────────────────────────────────────

/** How long the duration probe may take before the answer is "unknown". */
const PROBE_TIMEOUT_MS = 10_000;

/** Duration in seconds via metadata only (no decode) — for the memory guard.
 *  Returns null when the browser cannot read the file's metadata — or does
 *  not say within PROBE_TIMEOUT_MS: Safari on iOS may answer a blob URL with
 *  neither `loadedmetadata` nor `error`, and the import waited for ever. */
export function probeAudioDuration(file: Blob): Promise<number | null> {
  return new Promise(resolve => {
    const url = URL.createObjectURL(file);
    const audio = new Audio();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const done = (duration: number | null) => {
      clearTimeout(timer);
      audio.onloadedmetadata = null;
      audio.onerror = null;
      URL.revokeObjectURL(url);
      resolve(duration);
    };
    audio.preload = 'metadata';
    audio.onloadedmetadata = () => done(Number.isFinite(audio.duration) ? audio.duration : null);
    audio.onerror = () => done(null);
    timer = setTimeout(() => done(null), PROBE_TIMEOUT_MS);
    audio.src = url;
  });
}

/** True when the browser can play this file back (analysis may still work otherwise). */
export function canPlayFile(file: File): boolean {
  if (!file.type) return true; // unknown type — let the player try
  return new Audio().canPlayType(file.type) !== '';
}
