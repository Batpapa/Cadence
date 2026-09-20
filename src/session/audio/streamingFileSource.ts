import { WebDemuxer } from 'web-demuxer';
import type { AudioSample, Input, InputAudioTrack } from 'mediabunny';
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
// If the browser lacks WebCodecs or the file cannot be read here,
// tryCreate() returns null and the caller falls back to
// FileSource/decodeAudioData — never a regression for a case that worked
// before, just no longer the only path.
//
// ── It reads through mediabunny since 2026-09-20, not web-demuxer ───────────
// web-demuxer CANNOT OPEN AN MP3. Measured that day on four files: an .m4a
// streamed, and every .mp3 failed at `get_av_stream` with the wasm printing
// "Cannot open input file" — a 52 MB one carrying an ID3 tag, a 14 MB one of
// raw frames with no tag, and that one again under a different name. So it
// was the container, not the size, the name or the tag.
//
// Every MP3 import had therefore been falling back to the whole-file decode,
// silently: 963 MB of RAM for the 36-minute file that prompted the search,
// under a warning threshold of 113 minutes on a desktop, so nothing was ever
// said about it. On a phone, where that threshold is 19 minutes, it is a dead
// tab.
//
// mediabunny reads it, and was already here for clips, for a video's audio
// and for the bound editor's waveform. It also hands back DECODED samples
// rather than encoded packets, so the AudioDecoder, its queue cap and the
// packet-span arithmetic that used to live here are all gone — see the #16
// note inside start() for what replaced the last of those, and why the
// replacement is a better measurement rather than merely a shorter one.
//
// web-demuxer stays for exactly one thing, at the bottom of this file:
// extractPcmWav, the AVI escape hatch, for the one container mediabunny
// cannot read. Its 3 MB of wasm is now fetched only for those files, instead
// of on every single import.

// Self-hosted (no CDN): webpack 5 resolves this as an asset URL, works in dev
// and prod alike — same pattern already used for the FolkFriend WASM (ffWorker.ts).
// The "mini" wasm build is smaller but doesn't export every function the JS
// wrapper calls (confirmed: "get_av_stream is not a function" at runtime) —
// the full build is required, lazily loaded so it never touches the main bundle.
export const WEB_DEMUXER_WASM_URL = new URL('../../../node_modules/web-demuxer/dist/wasm-files/web-demuxer.wasm', import.meta.url);


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

/** Chunks handed to the recognition worker but not yet acknowledged, beyond
 *  which the read loop waits. It is the one bound on how far decoding may run
 *  ahead of analysis, and it stands where the old code's MAX_DECODE_QUEUE did
 *  — same number, same job, one step further down the pipe: that one counted
 *  encoded packets given to a decoder, this one counts decoded chunks given
 *  to the worker. A chunk is one analysis hop, so eight of them is a few tens
 *  of seconds of mono audio at most. */
const MAX_IN_FLIGHT = 8;

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

/** Lets a half-opened input go without making a noise about it. A probe must
 *  never fail louder than the thing it was probing. */
function disposeInput(input: Input | null): void {
  try { input?.dispose(); } catch { /* nothing left to release */ }
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
  private iterator: AsyncGenerator<AudioSample, void, unknown> | null = null;

  private constructor(
    private readonly input: Input,
    private readonly track: InputAudioTrack,
    private readonly nativeRate: number,
    readonly duration: number,
  ) {}

  /** Probes support without decoding anything (container parse only) — null
   *  on any failure, so the caller can fall back to FileSource unconditionally. */
  static async tryCreate(file: File): Promise<StreamingFileSource | null> {
    return (await StreamingFileSource.probe(file)).source;
  }

  /** The same probe, but saying WHY when it fails.
   *
   *  One `try` per step rather than one around the lot: "nothing here can read
   *  this container" and "this browser cannot decode that codec" are two
   *  different answers to give someone whose import just failed, and a single
   *  catch cannot tell them apart. Still never throws — the caller's job is to
   *  fall back, not to handle an error. */
  static async probe(file: File): Promise<StreamProbe> {
    if (typeof AudioDecoder === 'undefined') return { source: null, reason: 'no-webcodecs' };

    let input: Input | null = null;
    try {
      const mb = await import('mediabunny');
      // ALL_FORMATS, unlike clipExtract's short named list: that one is short
      // because it only writes back the containers it can also read, and this
      // one only reads. An import is whatever the user happened to record on.
      input = new mb.Input({ source: new mb.BlobSource(file), formats: mb.ALL_FORMATS });
      await input.getFormat();
    } catch (e) {
      disposeInput(input);
      return { source: null, reason: 'container', detail: detailOf(e) };
    }

    let track: InputAudioTrack | null = null;
    try {
      track = await input.getPrimaryAudioTrack();
    } catch (e) {
      disposeInput(input);
      return { source: null, reason: 'no-audio-stream', detail: detailOf(e) };
    }
    if (!track) {
      disposeInput(input);
      return { source: null, reason: 'no-audio-stream' };
    }

    try {
      const codec = await track.getCodec();
      // 24-bit PCM is never handed to a decoder — see monoFromS24Bytes: it
      // takes the whole tab down. The whole-file path converts it by hand, so
      // falling back is the right answer here rather than a failure.
      if (codec && codec.startsWith(PCM_S24)) {
        disposeInput(input);
        return { source: null, reason: 'codec', detail: codec };
      }
      if (!(await track.canDecode())) {
        disposeInput(input);
        // The codec string is the whole answer here, and the one thing worth
        // reading back off a screenshot.
        return { source: null, reason: 'codec', detail: codec ?? '(unknown codec)' };
      }
    } catch (e) {
      disposeInput(input);
      return { source: null, reason: 'codec', detail: detailOf(e) };
    }

    try {
      const rate = await track.getSampleRate();
      const duration = await input.computeDuration();
      if (!(duration > 0) || !(rate > 0)) {
        disposeInput(input);
        return { source: null, reason: 'no-duration', detail: `${duration}s @ ${rate}Hz` };
      }
      return { source: new StreamingFileSource(input, track, rate, duration), reason: null };
    } catch (e) {
      disposeInput(input);
      return { source: null, reason: 'unknown', detail: detailOf(e) };
    }
  }

  async start(sink: RecognitionSink): Promise<void> {
    const { AudioSampleSink } = await import('mediabunny');

    let buffer: Float32Array[] = [];
    let buffered = 0;
    let rate = this.nativeRate;
    /** Native frames handed on so far, padding included — the counter the gap
     *  arithmetic below measures against. */
    let produced = 0;
    // Batched by HOP_S_IMPORT, not a larger arbitrary size: ffWorker.ts's ring
    // buffer only carries ANALYSIS_WINDOW_S + hopS of slack (one hop's worth),
    // and maybeAnalyzeLive() only catches up on a single missed hop per PCM
    // message — a bigger batch would silently skip whole analysis windows.
    const targetChunk = Math.round(HOP_S_IMPORT * rate);

    const push = (mono: Float32Array): void => {
      buffer.push(mono);
      buffered += mono.length;
      produced += mono.length;
    };

    // ── Feeding runs alongside decoding, not after it ────────────────────────
    // A flush is queued rather than awaited, and the queue is a CHAIN: each
    // link starts only once the previous one has been acknowledged, so chunks
    // still reach the recognition worker strictly in order. What changes is
    // who waits — the read loop no longer does, so mediabunny keeps decoding
    // while the worker chews on what it was already given.
    //
    // Measured on 2026-09-21, the file import that prompted this: awaiting the
    // flush inside the loop serialised the two halves and cost about a fifth
    // of the throughput against the old code, which had kept up to eight
    // decodes in flight. See MAX_IN_FLIGHT for the bound that replaces that
    // one.
    let pending: Promise<void> = Promise.resolve();
    let inFlight = 0;
    let flushError: unknown = null;

    const queueFlush = (final = false): void => {
      if (buffered === 0) return;
      if (!final && buffered < targetChunk) return;
      const merged = new Float32Array(buffered);
      let off = 0;
      for (const seg of buffer) { merged.set(seg, off); off += seg.length; }
      buffer = [];
      buffered = 0;
      // Captured here: by the time this link runs, the loop may have moved on
      // to a sample declaring a different rate.
      const from = rate;
      inFlight++;
      pending = pending
        .then(async () => {
          if (flushError) return;   // the chain has already failed; do not pile on
          await sink.feedPcmWithAck(await resamplePcm(merged, from, this.sampleRate));
        })
        .catch((e: unknown) => { flushError ??= e; })
        .finally(() => { inFlight--; });
    };

    // No end timestamp: read to the true end of stream. Never bound this by
    // `this.duration` — a duration is a computed number, the content is the
    // content, and an analysis cut minutes early is the expensive kind of
    // wrong. It happened once, on a 6h07 recording whose declared duration
    // undershot the container's own last timecode by eleven minutes.
    //
    this.iterator = new AudioSampleSink(this.track).samples();

    try {
      for await (const sample of this.iterator) {
        if (this.cancelled) { sample.close(); break; }
        try {
          rate = sample.sampleRate || rate;

          // #16 — the shortfall, measured rather than inferred.
          //
          // A decoder can hand back fewer samples than the file's timeline
          // says have gone by: comfort-noise and DTX packets over a quiet
          // stretch decode to nothing at all. Left alone that shortfall
          // accumulates, and every detection after it is reported earlier
          // than it really happened — minutes out, by the end of a long
          // recording.
          //
          // Each decoded sample carries the instant it belongs at, so the
          // shortfall is just where this one starts minus what has been
          // produced. Measured against the RUNNING TOTAL rather than from one
          // sample to the next, so a thousand gaps of a few milliseconds are
          // caught exactly as well as one long one. The previous version
          // compared encoded-packet spans instead and needed a second of
          // safety margin to avoid mistaking ordinary decode lag for a gap;
          // reading the decoded samples' own timestamps needs no such margin.
          const wantAt = Math.round(Math.max(0, sample.timestamp) * rate);
          if (wantAt > produced) push(new Float32Array(wantAt - produced)); // zero-filled

          const frames = sample.numberOfFrames;
          const channels = sample.numberOfChannels;
          const mono = new Float32Array(frames);
          if (channels === 1) {
            sample.copyTo(mono, { planeIndex: 0, format: 'f32-planar' });
          } else {
            const tmp = new Float32Array(frames);
            for (let ch = 0; ch < channels; ch++) {
              sample.copyTo(tmp, { planeIndex: ch, format: 'f32-planar' });
              for (let i = 0; i < frames; i++) mono[i]! += tmp[i]! / channels;
            }
          }
          push(mono);
        } finally {
          sample.close();
        }
        queueFlush();
        // The one place the read loop does wait: when enough chunks are
        // queued that reading further would grow memory without helping.
        // Draining the whole chain rather than just the oldest link keeps
        // this to one line — it happens rarely, and only because the worker
        // is the slower half at that moment.
        if (inFlight >= MAX_IN_FLIGHT) await pending;
        // A failed feed means the worker is gone; nothing below will fix it.
        if (flushError) throw flushError;
      }
      if (!this.cancelled) queueFlush(true);
      await pending;
      if (flushError) throw flushError;
    } catch (e) {
      // Cancelling tears the iterator down under a read that is still in
      // flight, and what comes back is that teardown, not a fault: an
      // InputDisposedError, or whatever the next read throws once the file is
      // gone. This method's contract is to RESOLVE when stopped — the import
      // treats a rejection as a failed analysis and puts the message in front
      // of the user, which is exactly what pressing Cancel used to do
      // (2026-09-21).
      if (!this.cancelled) throw e;
    } finally {
      this.iterator = null;
      // Nothing decoded here outlives this call, cancel or not — the chain is
      // at most MAX_IN_FLIGHT chunks and each one is already in the worker's
      // hands or about to be.
      await pending.catch(() => { /* already recorded in flushError */ });
      // Here rather than in stop(): the file is let go only once nothing is
      // reading from it any more. Also covers the ordinary end of the file,
      // which nothing else would have closed.
      disposeInput(this.input);
    }
  }

  stop(): void {
    this.cancelled = true;
    if (this.iterator) {
      // Ends a read currently waiting on the next decoded sample; start()'s
      // own `finally` then disposes. Disposing here as well would pull the
      // file out from under that pending read.
      void this.iterator.return(undefined).catch(() => { /* already finished */ });
      return;
    }
    // Never started, or already finished: nothing is reading, so this is the
    // one that has to let go. The probe-then-stop path in preflightImport
    // only ever comes through here.
    disposeInput(this.input);
  }
}
