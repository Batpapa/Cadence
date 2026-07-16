import { Mp3Encoder } from '@breezystack/lamejs';

// ── Clip extraction: session audio slice → standalone MP3 ────────────────────
// Decodes the session file, cuts [start, end], and encodes to MP3 (mono,
// 128 kbps). MP3 keeps card attachments small enough for the Drive sync,
// which re-uploads the whole user state on every change (~1 MB per minute
// of clip vs ~16 MB in WAV).

const CLIP_SAMPLE_RATE = 44100;
const CLIP_KBPS = 128;
/** lamejs wants multiples of 576 samples; 1152 frames × 32 ≈ 0.8 s per batch. */
const ENCODE_BATCH = 1152 * 32;

export async function extractClipMp3(
  sessionAudio: Blob,
  start: number,
  end: number,
  onProgress?: (ratio: number) => void,
): Promise<Blob> {
  // Decode + mono mixdown (decodeAudioData resamples to the context rate).
  const arrayBuf = await sessionAudio.arrayBuffer();
  const ctx = new OfflineAudioContext(1, 1, CLIP_SAMPLE_RATE);
  const decoded = await ctx.decodeAudioData(arrayBuf);

  const from = Math.max(0, Math.floor(start * CLIP_SAMPLE_RATE));
  const to = Math.min(decoded.length, Math.ceil(end * CLIP_SAMPLE_RATE));
  if (to <= from) throw new Error('empty clip range');

  const mono = new Float32Array(to - from);
  for (let ch = 0; ch < decoded.numberOfChannels; ch++) {
    const data = decoded.getChannelData(ch);
    for (let i = 0; i < mono.length; i++) mono[i]! += data[from + i]! / decoded.numberOfChannels;
  }

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
    onProgress?.(Math.min(1, (off + n) / mono.length));
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  const tail = encoder.flush();
  if (tail.length > 0) parts.push(new Uint8Array(tail));

  return new Blob(parts as BlobPart[], { type: 'audio/mpeg' });
}
