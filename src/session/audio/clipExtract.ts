import { Mp3Encoder } from '@breezystack/lamejs';

// ── Clip extraction: session audio slice → standalone MP3 ────────────────────
// Decodes ONLY the [start, end] slice of the session audio, and encodes it to
// MP3 (mono, 128 kbps). MP3 keeps card attachments small enough for the Drive
// sync, which re-uploads the whole user state on every change (~1 MB per
// minute of clip vs ~16 MB in WAV).

const CLIP_SAMPLE_RATE = 44100;
const CLIP_KBPS = 128;
/** lamejs wants multiples of 576 samples; 1152 frames × 32 ≈ 0.8 s per batch. */
const ENCODE_BATCH = 1152 * 32;

/** Room before `start` so a codec needing a few priming frames (AAC/Opus
 *  decoder delay) has real preceding audio to warm up from — trimmed back
 *  out to the exact requested range afterward using each decoded AudioData's
 *  own timestamp, so it never leaks into the extracted clip. */
const PRE_ROLL_S = 1;

/** Reported progress is split into a decode phase [0, DECODE_PHASE_RATIO)
 *  and an encode phase [DECODE_PHASE_RATIO, 1] — see extractClipMp3. */
const DECODE_PHASE_RATIO = 0.5;

type RangeDecodeResult = { pcm: Float32Array; sampleRate: number } | null;

async function decodeRangeWork(
  demuxer: InstanceType<typeof import('web-demuxer').WebDemuxer>,
  file: File, start: number, end: number,
  onProgress?: (ratio: number) => void,
): Promise<RangeDecodeResult> {
  await demuxer.load(file);

  const config = await demuxer.getDecoderConfig('audio');
  const support = await AudioDecoder.isConfigSupported(config);
  if (!support.supported) return null;

  const chunks: { timestampS: number; mono: Float32Array }[] = [];
  let nativeSampleRate = config.sampleRate;
  let decodeError: unknown = null;

  const decoder = new AudioDecoder({
    output: (audioData) => {
      nativeSampleRate = audioData.sampleRate;
      const frames = audioData.numberOfFrames;
      const channels = audioData.numberOfChannels;
      const mono = new Float32Array(frames);
      const tmp = new Float32Array(frames);
      for (let ch = 0; ch < channels; ch++) {
        audioData.copyTo(tmp, { planeIndex: ch, format: 'f32-planar' });
        for (let i = 0; i < frames; i++) mono[i]! += tmp[i]! / channels;
      }
      chunks.push({ timestampS: audioData.timestamp / 1e6, mono });
      audioData.close();
    },
    error: (e) => { decodeError = e; },
  });
  decoder.configure(config);

  const readStart = Math.max(0, start - PRE_ROLL_S);
  const totalSpanS = Math.max(end - readStart, 1e-6);
  // Reading + decoding each packet is the slow part in practice (confirmed
  // on mobile: real time, not instant even for the streamed path) — report
  // progress off each packet's own container timestamp as it's read, rather
  // than only once the whole range has been pulled in. Throttled by time,
  // not by packet count, since packet duration/count varies a lot by codec.
  let lastTickAt = 0;
  const stream = demuxer.read('audio', readStart, end);
  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (decodeError) throw decodeError;
      if (done) break;
      decoder.decode(value);
      if (onProgress) {
        const now = Date.now();
        if (now - lastTickAt >= 100) {
          lastTickAt = now;
          const packetTsS = value.timestamp / 1e6;
          onProgress(Math.max(0, Math.min(1, (packetTsS - readStart) / totalSpanS)));
        }
      }
    }
    await decoder.flush();
    if (decodeError) throw decodeError;
  } finally {
    reader.releaseLock();
  }
  decoder.close();

  if (chunks.length === 0) return null;
  chunks.sort((a, b) => a.timestampS - b.timestampS);

  const firstTs = chunks[0]!.timestampS;
  const totalFrames = chunks.reduce((sum, c) => sum + c.mono.length, 0);
  const merged = new Float32Array(totalFrames);
  let off = 0;
  for (const c of chunks) { merged.set(c.mono, off); off += c.mono.length; }

  const trimStart = Math.max(0, Math.round((start - firstTs) * nativeSampleRate));
  const trimEnd = Math.min(merged.length, Math.round((end - firstTs) * nativeSampleRate));
  if (trimEnd <= trimStart) return null;

  return { pcm: merged.slice(trimStart, trimEnd), sampleRate: nativeSampleRate };
}

/** Attempts to decode ONLY the [start, end] slice of `file` via web-demuxer +
 *  WebCodecs AudioDecoder — memory and decode time scale with the CLIP
 *  length, not the whole session's duration. Decoding the full session
 *  (previously done via a single decodeAudioData(wholeFile) call) could
 *  visibly freeze the UI for a long recording, just to pull a few seconds
 *  out of it — same reasoning streamingFileSource.ts already applies to the
 *  live/import analysis path. Returns null on any unsupported browser/codec/
 *  failure (confirmed real-world case: web-demuxer's WASM demuxer rejecting
 *  outright with "get_av_stream failed" on a re-muxed YouTube-sourced MP3 —
 *  a clean rejection, not a hang, so plain try/catch is enough here) so the
 *  caller falls back to the old whole-file decode unconditionally — never a
 *  regression for a case that worked before. */
async function tryDecodeRangeViaWebCodecs(
  file: File, start: number, end: number, onProgress?: (ratio: number) => void,
): Promise<RangeDecodeResult> {
  if (typeof AudioDecoder === 'undefined') return null;

  // Lazy — web-demuxer must never sit in the main bundle for everyone who
  // never opens a session (same reason streamingFileSource.ts is always
  // dynamically imported everywhere else it's used).
  let webDemuxerMod;
  try {
    webDemuxerMod = await import('web-demuxer');
  } catch {
    return null;
  }
  const { WEB_DEMUXER_WASM_URL } = await import('./streamingFileSource');
  const demuxer = new webDemuxerMod.WebDemuxer({ wasmFilePath: WEB_DEMUXER_WASM_URL.href });

  try {
    return await decodeRangeWork(demuxer, file, start, end, onProgress);
  } catch {
    return null;
  } finally {
    demuxer.destroy();
  }
}

/** decodeAudioData() has no native progress API — ticks a fake, asymptotically
 *  slowing progress toward `ceiling` while it's in flight, so the fallback
 *  decode below (the one case that can genuinely take a while — see
 *  decodeRangeViaFullDecode) shows the user something moving instead of a
 *  stuck percentage that looks frozen. Snaps to `ceiling` the moment the real
 *  work resolves; never claims to be exact since there's nothing to measure
 *  it against. */
async function withCreepingProgress<T>(work: Promise<T>, onTick: (ratio: number) => void, ceiling: number): Promise<T> {
  let ratio = 0;
  onTick(ratio);
  const timer = setInterval(() => {
    ratio += (ceiling - ratio) * 0.1;
    onTick(ratio);
  }, 250);
  try {
    return await work;
  } finally {
    clearInterval(timer);
  }
}

/** Fallback: decode the WHOLE session file, then slice out [start, end] —
 *  slow for a long recording, but always correct. Only reached when
 *  tryDecodeRangeViaWebCodecs() can't (older browser, unsupported codec, or
 *  any decode failure). */
async function decodeRangeViaFullDecode(
  sessionAudio: Blob, start: number, end: number, onProgress?: (ratio: number) => void,
): Promise<Float32Array> {
  const arrayBuf = await sessionAudio.arrayBuffer();
  const ctx = new OfflineAudioContext(1, 1, CLIP_SAMPLE_RATE);
  const decoded = onProgress
    ? await withCreepingProgress(ctx.decodeAudioData(arrayBuf), onProgress, 0.95)
    : await ctx.decodeAudioData(arrayBuf);

  const from = Math.max(0, Math.floor(start * CLIP_SAMPLE_RATE));
  const to = Math.min(decoded.length, Math.ceil(end * CLIP_SAMPLE_RATE));
  if (to <= from) throw new Error('empty clip range');

  const mono = new Float32Array(to - from);
  for (let ch = 0; ch < decoded.numberOfChannels; ch++) {
    const data = decoded.getChannelData(ch);
    for (let i = 0; i < mono.length; i++) mono[i]! += data[from + i]! / decoded.numberOfChannels;
  }
  return mono;
}

/** Seconds of slack added on each side of an annotation before cutting.
 *
 *  An annotation's bounds used to be the raw span of the observation windows,
 *  which happened to run about 5s wide on each side and gave every clip a
 *  comfortable lead-in for free. Since 2026-09-01 they are the ESTIMATED
 *  musical boundaries (median error ~1s), which is what the timeline and the
 *  detection want but leaves a clip starting exactly on the first note — and
 *  the estimate is unbiased, so it is late as often as early. This restores
 *  deliberately what the old imprecision gave by accident. Clamped to the
 *  recording by the range checks below, so the edges of a session are safe. */
const CLIP_PAD_S = 3;

export async function extractClipMp3(
  sessionAudio: Blob,
  start: number,
  end: number,
  onProgress?: (ratio: number) => void,
): Promise<Blob> {
  start = Math.max(0, start - CLIP_PAD_S);
  end = end + CLIP_PAD_S;
  const file = new File([sessionAudio], 'session-audio', { type: sessionAudio.type });
  const streamed = await tryDecodeRangeViaWebCodecs(
    file, start, end,
    onProgress && (ratio => onProgress(ratio * DECODE_PHASE_RATIO)),
  );

  let mono: Float32Array;
  if (streamed) {
    onProgress?.(DECODE_PHASE_RATIO); // in case the loop's last throttled tick landed short of it
    if (streamed.sampleRate === CLIP_SAMPLE_RATE) {
      mono = streamed.pcm;
    } else {
      const { resamplePcm } = await import('./streamingFileSource');
      mono = await resamplePcm(streamed.pcm as Float32Array<ArrayBuffer>, streamed.sampleRate, CLIP_SAMPLE_RATE);
    }
  } else {
    mono = await decodeRangeViaFullDecode(
      sessionAudio, start, end,
      onProgress && (ratio => onProgress(ratio * DECODE_PHASE_RATIO)),
    );
  }

  if (mono.length === 0) throw new Error('empty clip range');

  // Float32 → Int16, then encode in batches, yielding to keep the UI alive
  // (lamejs is pure JS, ~5-15× realtime).
  const encoder = new Mp3Encoder(1, CLIP_SAMPLE_RATE, CLIP_KBPS);
  const parts: Uint8Array[] = [];
  const int16 = new Int16Array(ENCODE_BATCH);

  for (let off = 0; off < mono.length; off += ENCODE_BATCH) {
    const n = Math.min(ENCODE_BATCH, mono.length - off);
    for (let i = 0; i < n; i++) {
      const v = Math.max(-1, Math.min(1, mono[off + i]!));
      int16[i] = v < 0 ? v * 32768 : v * 32767;
    }
    const chunk = encoder.encodeBuffer(n === ENCODE_BATCH ? int16 : int16.subarray(0, n));
    if (chunk.length > 0) parts.push(new Uint8Array(chunk));
    const encodeRatio = Math.min(1, (off + n) / mono.length);
    onProgress?.(DECODE_PHASE_RATIO + encodeRatio * (1 - DECODE_PHASE_RATIO));
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  const tail = encoder.flush();
  if (tail.length > 0) parts.push(new Uint8Array(tail));

  return new Blob(parts as BlobPart[], { type: 'audio/mpeg' });
}
