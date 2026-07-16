import { openMicForMusic } from './capture';
import { attachPcmWorklet } from './pcmWorklet';
import { FILE_CHUNK_S, ANALYSIS_SAMPLE_RATE } from '../sessionConfig';

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

// ── MicSource ─────────────────────────────────────────────────────────────────

/** Microphone source: getUserMedia (music constraints) + PCM worklet.
 *  Two-phase: open() first (grabs the mic, fixes the sample rate), then start(). */
export class MicSource implements PcmSource {
  private _stream: MediaStream | null = null;
  private audioContext: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private recordingDest: MediaStreamAudioDestinationNode | null = null;

  async open(): Promise<void> {
    this._stream = await openMicForMusic();
    this.audioContext = new AudioContext();
    // Some browsers create suspended contexts outside a user gesture chain.
    if (this.audioContext.state === 'suspended') await this.audioContext.resume();

    const track = this._stream.getAudioTracks()[0];
    console.debug('[mic] track:', track?.label, JSON.stringify(track?.getSettings?.() ?? {}));

    const src = this.audioContext.createMediaStreamSource(this._stream);

    // VU meter tap (main thread, independent from the recognition path).
    this.analyser = this.audioContext.createAnalyser();
    this.analyser.fftSize = 512;
    src.connect(this.analyser);

    // Recording tap: MediaRecorder consumes the graph's output, not the raw
    // track — recording a track that is simultaneously pulled by WebAudio
    // yields silence on some browsers. This way, what the VU meter shows is
    // exactly what lands in the file.
    this.recordingDest = this.audioContext.createMediaStreamDestination();
    src.connect(this.recordingDest);
  }

  get sampleRate(): number {
    return this.audioContext?.sampleRate ?? 48000;
  }

  /** The raw stream (recognition worklet input). */
  get stream(): MediaStream {
    if (!this._stream) throw new Error('MicSource not opened');
    return this._stream;
  }

  /** Graph-routed stream for MediaRecorder (see open() for why). */
  get recordingStream(): MediaStream {
    if (!this.recordingDest) throw new Error('MicSource not opened');
    return this.recordingDest.stream;
  }

  /** Mic level 0–1 for the VU meter (poll from UI). */
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
    if (!this._stream || !this.audioContext) throw new Error('MicSource not opened');
    const channel = new MessageChannel();
    sink.connectWorkletPort(channel.port1);
    await attachPcmWorklet(this.audioContext, this._stream, channel.port2);
  }

  stop(): void {
    this._stream?.getTracks().forEach(trk => trk.stop());
    this._stream = null;
    void this.audioContext?.close().catch(() => { /* already closed */ });
    this.audioContext = null;
    this.analyser = null;
  }
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

// ── File helpers ──────────────────────────────────────────────────────────────

/** Duration in seconds via metadata only (no decode) — for the memory guard.
 *  Returns null when the browser cannot read the file's metadata. */
export function probeAudioDuration(file: Blob): Promise<number | null> {
  return new Promise(resolve => {
    const url = URL.createObjectURL(file);
    const audio = new Audio();
    audio.preload = 'metadata';
    audio.onloadedmetadata = () => {
      URL.revokeObjectURL(url);
      resolve(Number.isFinite(audio.duration) ? audio.duration : null);
    };
    audio.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
    audio.src = url;
  });
}

/** True when the browser can play this file back (analysis may still work otherwise). */
export function canPlayFile(file: File): boolean {
  if (!file.type) return true; // unknown type — let the player try
  return new Audio().canPlayType(file.type) !== '';
}
