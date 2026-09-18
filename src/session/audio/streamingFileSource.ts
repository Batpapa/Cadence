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
export const WEB_DEMUXER_WASM_URL = new URL('../../../node_modules/web-demuxer/dist/wasm-files/web-demuxer.wasm', import.meta.url);

/** Cap on in-flight decode() calls not yet output — bounds decoder-side memory. */
const MAX_DECODE_QUEUE = 8;

// ── 24-bit PCM, decoded here rather than by the browser ──────────────────────
// Chromium CRASHES THE WHOLE TAB on this one, and takes the app with it —
// measured on 2026-09-18 with a QuickTime .MOV whose audio track is
// pcm_s24le (a camera or an editor writes these; the file that found it was
// 67 seconds of music in 419 MB). The sequence, reproduced down to a page with
// nothing else on it:
//
//   AudioDecoder.isConfigSupported({codec:'pcm-s24'})  → supported: true
//   decode(one 6144-byte packet)                       → output() fires
//   audioData.format                                   → 's32'   ← the lie
//   audioData.allocationSize({format:'f32-planar'})    → 4096    (plausible)
//   audioData.copyTo(...)                              → renderer gone
//
// The frames are three bytes wide and the AudioData says four, so the copy
// reads past the end of its own buffer. Any destination format does it, and
// only `copyTo` does it: an output left untouched closes cleanly. Nothing here
// can fix that, and nothing here needs it — the packets ARE the samples, so
// the conversion is a few lines, exactly the ones a decoder would run.
// The other raw widths (u8, s16, s32, f32) were checked in the same browser
// and convert correctly, so they keep going through AudioDecoder.
const PCM_S24 = 'pcm-s24';
const S24_BYTES = 3;

/** Interleaved little-endian 24-bit PCM, mixed down to mono floats in
 *  [-1, 1) — the same thing AudioDecoder's output plus the copyTo above would
 *  have produced. Takes bytes rather than a chunk so it can be tested without
 *  WebCodecs (jsdom has no EncodedAudioChunk). */
export function monoFromS24Bytes(bytes: Uint8Array, channels: number): Float32Array {
  const ch = Math.max(1, channels);
  const frames = Math.floor(bytes.length / (S24_BYTES * ch));
  const mono = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    for (let c = 0; c < ch; c++) {
      const at = (f * ch + c) * S24_BYTES;
      // Little-endian, and the top byte carries the sign: shifting it into the
      // high bits of a 32-bit int and back down sign-extends it in one step.
      const raw = (bytes[at]! | (bytes[at + 1]! << 8) | (bytes[at + 2]! << 16)) << 8;
      sum += (raw >> 8) / 8388608;   // 2^23
    }
    mono[f] = sum / ch;
  }
  return mono;
}

function monoFromS24(chunk: EncodedAudioChunk, channels: number): Float32Array {
  const bytes = new Uint8Array(chunk.byteLength);
  chunk.copyTo(bytes);
  return monoFromS24Bytes(bytes, channels);
}

/** Why chunked decoding is not available for a file.
 *
 *  Named, because the fallback it triggers is what kills a phone tab on a long
 *  recording — and until 2026-09-12 every one of these was swallowed by a bare
 *  `catch {}`, so a field report ("it fails on my phone at 20 minutes") could
 *  only ever be answered with a ranked list of guesses. The five cases were
 *  already distinct in the control flow; they just had no names. */
export type StreamFailure =
  | 'no-webcodecs'      // the browser has no AudioDecoder at all
  | 'container'         // the demuxer could not open the file (or its wasm never loaded)
  | 'no-audio-stream'   // opened, but no usable audio track
  | 'codec'             // the audio codec is not decodable here
  | 'no-duration'       // no usable duration declared
  | 'unknown';

export interface StreamProbe {
  /** Null when chunked decoding is unavailable — then `reason` says why. */
  source: StreamingFileSource | null;
  reason: StreamFailure | null;
  /** The library's own words, or the codec string. English, technical, and
   *  exactly what identifies a broken file in a screenshot from the field.
   *  Capped, because a wasm error can run to pages. */
  detail?: string;
}

function detailOf(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  return raw.length > 200 ? raw.slice(0, 200) + '…' : raw;
}

// ── Raw PCM out of a container nothing else here can rewrite ─────────────────
// clipExtract's extractAudioOnly copies a video's audio into an audio-only
// file of the same family, which is the right answer whenever mediabunny can
// read the container. It cannot read AVI — and an AVI is exactly the shape of
// file that needs this most: the ones this was measured on (a camera writing
// MJPEG video beside uncompressed sound, 2026-09-18) run 650 MB to 1 GB for a
// minute of music, of which 11 MB is the music.
//
// The demuxer here reads AVI perfectly well, and when the audio is RAW PCM
// there is nothing to mux: the packets are the samples, and a WAV is a header
// in front of them. So that is what this writes — no decoding, no re-encoding,
// every sample the file had, and a file every browser can play (which the AVI
// itself is not, so the clips of such an analysis were unlistenable too).
//
// Compressed audio in an unreadable container keeps its whole file, as before:
// wrapping an MP3 or AC-3 stream would need a muxer, and inventing one to save
// a few megabytes is not the trade this makes.

/** Bits per sample, and whether the WAV format tag must say "float", for the
 *  raw PCM codec strings WebCodecs defines — all little-endian by definition,
 *  which is also what a WAV holds. */
const PCM_WAV_LAYOUT: Record<string, { bits: number; float: boolean }> = {
  'pcm-u8':  { bits: 8,  float: false },
  'pcm-s16': { bits: 16, float: false },
  'pcm-s24': { bits: 24, float: false },
  'pcm-s32': { bits: 32, float: false },
  'pcm-f32': { bits: 32, float: true },
};

/** A 44-byte canonical WAV header for `dataBytes` of samples. */
export function wavHeader(dataBytes: number, sampleRate: number, channels: number, bits: number, float: boolean): Uint8Array<ArrayBuffer> {
  const header = new Uint8Array(44);
  const view = new DataView(header.buffer);
  const ascii = (at: number, s: string) => { for (let i = 0; i < s.length; i++) header[at + i] = s.charCodeAt(i); };
  const blockAlign = channels * (bits / 8);
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, float ? 3 : 1, true);   // 3 = IEEE float, 1 = integer
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bits, true);
  ascii(36, 'data');
  view.setUint32(40, dataBytes, true);
  return header;
}

/** The audio track of `file` as a WAV, or null when that is not the right
 *  thing to do here — no audio, or audio that is not raw PCM. Never throws for
 *  a file it simply cannot handle; the caller keeps the original. */
export async function extractPcmWav(file: File): Promise<{ blob: Blob; extension: string } | null> {
  let demuxer: WebDemuxer | null = null;
  try {
    demuxer = new WebDemuxer({ wasmFilePath: WEB_DEMUXER_WASM_URL.href });
    await demuxer.load(file);
    const config = await demuxer.getDecoderConfig('audio');
    const layout = PCM_WAV_LAYOUT[config.codec];
    const channels = config.numberOfChannels;
    const sampleRate = config.sampleRate;
    if (!layout || !channels || !sampleRate) return null;

    const parts: Uint8Array<ArrayBuffer>[] = [];
    let total = 0;
    const reader = demuxer.read('audio', 0).getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const bytes = new Uint8Array(value.byteLength);
        value.copyTo(bytes);
        parts.push(bytes);
        total += bytes.length;
      }
    } finally {
      reader.releaseLock();
    }
    if (total === 0) return null;

    return {
      blob: new Blob([wavHeader(total, sampleRate, channels, layout.bits, layout.float), ...parts], { type: 'audio/wav' }),
      extension: 'wav',
    };
  } catch {
    return null;
  } finally {
    discard(demuxer);
  }
}

/** `destroy()` on a demuxer that never finished loading can itself throw, and
 *  a probe must never fail louder than the thing it was probing. */
function discard(demuxer: WebDemuxer | null): void {
  try { demuxer?.destroy(); } catch { /* nothing to release */ }
}

/** Re-samples via a short OfflineAudioContext render — same mechanism
 *  decodeAudioData uses internally, never a hand-rolled resampler (accuracy
 *  matters here: sessionConfig.ts documents 22050 vs 48000 changing FolkFriend's
 *  transcription quality, so resampling quality isn't a detail to cut corners on). */
export async function resamplePcm(pcm: Float32Array<ArrayBuffer>, fromRate: number, toRate: number): Promise<Float32Array> {
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
    return (await StreamingFileSource.probe(file)).source;
  }

  /** The same probe, but saying WHY when it fails.
   *
   *  One `try` per step rather than one around the lot: "the demuxer could not
   *  open this container" and "this browser cannot decode that codec" are two
   *  different answers to give someone whose import just failed, and a single
   *  catch cannot tell them apart. Still never throws — the caller's job is to
   *  fall back, not to handle an error. */
  static async probe(file: File): Promise<StreamProbe> {
    if (typeof AudioDecoder === 'undefined') return { source: null, reason: 'no-webcodecs' };

    let demuxer: WebDemuxer | null = null;
    try {
      // Constructing it also starts fetching the wasm, so a failure here is
      // usually "the 3 MB module never arrived", not "the file is bad".
      demuxer = new WebDemuxer({ wasmFilePath: WEB_DEMUXER_WASM_URL.href });
      await demuxer.load(file);
    } catch (e) {
      discard(demuxer);
      return { source: null, reason: 'container', detail: detailOf(e) };
    }

    let config: AudioDecoderConfig;
    try {
      config = await demuxer.getDecoderConfig('audio');
    } catch (e) {
      discard(demuxer);
      return { source: null, reason: 'no-audio-stream', detail: detailOf(e) };
    }

    try {
      const support = await AudioDecoder.isConfigSupported(config);
      if (!support.supported) {
        discard(demuxer);
        // The codec string is the whole answer here, and the one thing worth
        // reading back off a screenshot.
        return { source: null, reason: 'codec', detail: config.codec };
      }
    } catch (e) {
      discard(demuxer);
      return { source: null, reason: 'codec', detail: detailOf(e) };
    }

    try {
      const info = await demuxer.getMediaInfo();
      if (!(info.duration > 0)) {
        discard(demuxer);
        return { source: null, reason: 'no-duration', detail: String(info.duration) };
      }
      return { source: new StreamingFileSource(demuxer, config, info.duration), reason: null };
    } catch (e) {
      discard(demuxer);
      return { source: null, reason: 'unknown', detail: detailOf(e) };
    }
  }

  async start(sink: RecognitionSink): Promise<void> {
    let nativeBuffer: Float32Array[] = [];
    let nativeBufferedSamples = 0;
    let nativeSampleRate = this.config.sampleRate;
    // #16: the container's own per-packet PTS (what the file declares each
    // encoded chunk's real-time span to be) — AudioDecoder can genuinely
    // return fewer decoded samples than that span implies (confirmed: a
    // growing multi-minute deficit over a long recording, e.g. DTX/comfort-
    // noise packets during quiet stretches). packetSpanS is the reference the
    // padding below catches up to.
    let prevPacketTsS: number | null = null;
    let packetSpanS = 0;
    let decodedFrames = 0;
    // Batched by HOP_S_IMPORT, not a larger arbitrary size: ffWorker.ts's ring
    // buffer only carries ANALYSIS_WINDOW_S + hopS of slack (one hop's worth),
    // and maybeAnalyzeLive() only catches up on a single missed hop per PCM
    // message — a bigger batch would silently skip whole analysis windows.
    const targetNativeChunkSamples = Math.round(HOP_S_IMPORT * this.config.sampleRate);
    let decodeError: unknown = null;

    const pushMono = (mono: Float32Array, frames: number): void => {
      nativeBuffer.push(mono);
      nativeBufferedSamples += frames;
      decodedFrames += frames;
    };

    // 24-bit PCM never reaches AudioDecoder — see monoFromS24: handing it one
    // takes the whole tab down. Everything else does, including the other raw
    // PCM widths, which Chrome converts correctly.
    const rawPcm = this.config.codec === PCM_S24 ? (chunk: EncodedAudioChunk) => monoFromS24(chunk, this.config.numberOfChannels) : null;
    const rawBytesPerFrame = rawPcm ? S24_BYTES * this.config.numberOfChannels : 0;

    if (!rawPcm) {
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
          pushMono(mono, frames);
        },
        error: (e) => { decodeError = e; },
      });
      this.decoder.configure(this.config);
    }

    // #16: pads with silence up to the packet-timestamp-implied sample count
    // whenever AudioDecoder under-produces (see packetSpanS above) — keeps
    // the fed sample count aligned with real file time regardless of *why*
    // the decoder fell behind. A margin (~1 s of native samples) is left
    // unpadded each time so ordinary decode-queue lag (bounded by
    // MAX_DECODE_QUEUE) is never mistaken for a real deficit.
    const DEFICIT_SAFETY_MARGIN_S = 1;
    let paddedNativeSamples = 0; // counts as "decoded" so it isn't repadded next flush

    // Sequential on purpose: only one flush (resample + feedPcmWithAck) is ever
    // in flight, so chunks reach the recognition worker strictly in order even
    // though decode() outputs can arrive asynchronously relative to the read loop.
    const flushIfReady = async (final = false): Promise<void> => {
      const expectedNativeSamples = Math.round(packetSpanS * nativeSampleRate);
      const actualNativeSamples = decodedFrames + paddedNativeSamples;
      const deficit = expectedNativeSamples - actualNativeSamples - Math.round(DEFICIT_SAFETY_MARGIN_S * nativeSampleRate);
      if (deficit > 0) {
        nativeBuffer.push(new Float32Array(deficit)); // zero-filled by construction
        nativeBufferedSamples += deficit;
        paddedNativeSamples += deficit;
      }

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

    // Never bound this by `this.duration` — that's web-demuxer's own duration
    // ESTIMATE (getMediaInfo(), no Cues to compute it exactly for a Cue-less
    // MediaRecorder webm), and it can undershoot the real content by several
    // minutes on a long file: confirmed on a 6h07 recording where the
    // estimate was ~11 minutes short of the container's own last Cluster
    // timecode, silently truncating the analysis that many minutes early.
    // Omitting `end` reads to the true end of stream instead.
    const stream = this.demuxer.read('audio', 0);
    this.reader = stream.getReader();

    try {
      while (!this.cancelled) {
        const { done, value } = await this.reader.read();
        if (decodeError) throw decodeError;
        if (done) break;

        // value.timestamp is microseconds since the start of the stream —
        // the container's own PTS, independent of anything AudioDecoder does.
        const packetTsS = value.timestamp / 1e6;
        if (prevPacketTsS !== null) packetSpanS += packetTsS - prevPacketTsS;
        prevPacketTsS = packetTsS;

        if (rawPcm) {
          // Raw samples: converted on the spot, so nothing is ever in flight
          // and there is no queue to wait on.
          pushMono(rawPcm(value), Math.floor(value.byteLength / rawBytesPerFrame));
        } else {
          this.decoder!.decode(value);
          if (this.decoder!.decodeQueueSize > MAX_DECODE_QUEUE) {
            await new Promise<void>(resolve => {
              this.decoder!.addEventListener('dequeue', () => resolve(), { once: true });
            });
          }
        }
        await flushIfReady();
      }
      if (!this.cancelled) {
        // Nothing to drain on the raw path — every packet was converted as it
        // arrived — so there is no decoder to flush either.
        await this.decoder?.flush();
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
