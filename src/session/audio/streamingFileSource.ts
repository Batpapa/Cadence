import { WebDemuxer } from 'web-demuxer';
import type { PcmSource, RecognitionSink } from './sources';
import { ANALYSIS_SAMPLE_RATE, HOP_S_IMPORT } from '../sessionConfig';

// ── StreamingFileSource ────────────────────────────────────────────────────
// Decodes a file chunk-by-chunk via WebCodecs AudioDecoder instead of
// FileSource's one-shot decodeAudioData() — memory stays bounded by chunk
// size instead of scaling with file duration (a multi-hour recording no
// longer needs its whole decoded PCM held in RAM at once). Implements the
// same PcmSource interface FileSource does (this was the intended extension
// point — see the "future streaming decoder" note in sources.ts).
//
// WebCodecs decodes but doesn't read containers (mp4/m4a/…), so a demuxer
// (web-demuxer, WASM build of FFmpeg's libavformat — container parsing only,
// no codecs, kept small) supplies the encoded chunks. If the browser lacks
// WebCodecs or the file's codec isn't supported, tryCreate() returns null and
// the caller falls back to FileSource/decodeAudioData — never a regression
// for a case that worked before, just no longer the only path.

// Self-hosted (no CDN): webpack 5 resolves this as an asset URL, works in dev
// and prod alike — same pattern already used for the FolkFriend WASM (ffWorker.ts).
// The "mini" wasm build is smaller but doesn't export every function the JS
// wrapper calls (confirmed: "get_av_stream is not a function" at runtime) —
// the full build is required, lazily loaded so it never touches the main bundle.
const WASM_URL = new URL('../../../node_modules/web-demuxer/dist/wasm-files/web-demuxer.wasm', import.meta.url);

/** Cap on in-flight decode() calls not yet output — bounds decoder-side memory. */
const MAX_DECODE_QUEUE = 8;

/** Re-samples via a short OfflineAudioContext render — same mechanism
 *  decodeAudioData uses internally, never a hand-rolled resampler (accuracy
 *  matters here: sessionConfig.ts documents 22050 vs 48000 changing FolkFriend's
 *  transcription quality, so resampling quality isn't a detail to cut corners on). */
async function resamplePcm(pcm: Float32Array<ArrayBuffer>, fromRate: number, toRate: number): Promise<Float32Array> {
  if (fromRate === toRate) return pcm;
  const ctx = new OfflineAudioContext(1, Math.ceil(pcm.length * toRate / fromRate), toRate);
  const buffer = ctx.createBuffer(1, pcm.length, fromRate);
  buffer.copyToChannel(pcm, 0);
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.connect(ctx.destination);
  src.start();
  const rendered = await ctx.startRendering();
  return rendered.getChannelData(0).slice();
}

export class StreamingFileSource implements PcmSource {
  readonly sampleRate = ANALYSIS_SAMPLE_RATE;
  private cancelled = false;
  private decoder: AudioDecoder | null = null;
  private reader: ReadableStreamDefaultReader<EncodedAudioChunk> | null = null;

  private constructor(
    private readonly demuxer: WebDemuxer,
    private readonly config: AudioDecoderConfig,
    readonly duration: number,
  ) {}

  /** Probes support without decoding anything (container parse only) — null
   *  on any failure, so the caller can fall back to FileSource unconditionally. */
  static async tryCreate(file: File): Promise<StreamingFileSource | null> {
    if (typeof AudioDecoder === 'undefined') return null;

    let demuxer: WebDemuxer | null = null;
    try {
      demuxer = new WebDemuxer({ wasmFilePath: WASM_URL.href });
      await demuxer.load(file);

      const config = await demuxer.getDecoderConfig('audio');
      const support = await AudioDecoder.isConfigSupported(config);
      if (!support.supported) { demuxer.destroy(); return null; }

      const info = await demuxer.getMediaInfo();
      if (!(info.duration > 0)) {
        demuxer.destroy();
        return null;
      }

      return new StreamingFileSource(demuxer, config, info.duration);
    } catch {
      demuxer?.destroy();
      return null;
    }
  }

  async start(sink: RecognitionSink): Promise<void> {
    let nativeBuffer: Float32Array[] = [];
    let nativeBufferedSamples = 0;
    let nativeSampleRate = this.config.sampleRate;
    // Batched by HOP_S_IMPORT, not a larger arbitrary size: ffWorker.ts's ring
    // buffer only carries ANALYSIS_WINDOW_S + hopS of slack (one hop's worth),
    // and maybeAnalyzeLive() only catches up on a single missed hop per PCM
    // message — a bigger batch would silently skip whole analysis windows.
    const targetNativeChunkSamples = Math.round(HOP_S_IMPORT * this.config.sampleRate);
    let decodeError: unknown = null;

    this.decoder = new AudioDecoder({
      output: (audioData) => {
        nativeSampleRate = audioData.sampleRate;
        const frames = audioData.numberOfFrames;
        const channels = audioData.numberOfChannels;
        const mono = new Float32Array(frames);
        if (channels === 1) {
          audioData.copyTo(mono, { planeIndex: 0, format: 'f32-planar' });
        } else {
          const tmp = new Float32Array(frames);
          for (let ch = 0; ch < channels; ch++) {
            audioData.copyTo(tmp, { planeIndex: ch, format: 'f32-planar' });
            for (let i = 0; i < frames; i++) mono[i]! += tmp[i]! / channels;
          }
        }
        audioData.close();
        nativeBuffer.push(mono);
        nativeBufferedSamples += frames;
      },
      error: (e) => { decodeError = e; },
    });
    this.decoder.configure(this.config);

    // Sequential on purpose: only one flush (resample + feedPcmWithAck) is ever
    // in flight, so chunks reach the recognition worker strictly in order even
    // though decode() outputs can arrive asynchronously relative to the read loop.
    const flushIfReady = async (final = false): Promise<void> => {
      if (nativeBufferedSamples === 0) return;
      if (!final && nativeBufferedSamples < targetNativeChunkSamples) return;
      const merged = new Float32Array(nativeBufferedSamples);
      let off = 0;
      for (const seg of nativeBuffer) { merged.set(seg, off); off += seg.length; }
      nativeBuffer = [];
      nativeBufferedSamples = 0;
      const resampled = await resamplePcm(merged, nativeSampleRate, this.sampleRate);
      await sink.feedPcmWithAck(resampled);
    };

    const stream = this.demuxer.read('audio', 0, this.duration);
    this.reader = stream.getReader();

    try {
      while (!this.cancelled) {
        const { done, value } = await this.reader.read();
        if (decodeError) throw decodeError;
        if (done) break;

        this.decoder.decode(value);
        if (this.decoder.decodeQueueSize > MAX_DECODE_QUEUE) {
          await new Promise<void>(resolve => {
            this.decoder!.addEventListener('dequeue', () => resolve(), { once: true });
          });
        }
        await flushIfReady();
      }
      if (!this.cancelled) {
        await this.decoder.flush();
        if (decodeError) throw decodeError;
        await flushIfReady(true);
      }
    } finally {
      this.reader.releaseLock();
    }
  }

  stop(): void {
    this.cancelled = true;
    void this.reader?.cancel().catch(() => { /* already released/closed */ });
    if (this.decoder && this.decoder.state !== 'closed') this.decoder.close();
    this.demuxer.destroy();
  }
}
