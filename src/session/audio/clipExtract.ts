import type { InputFormat, OutputFormat } from 'mediabunny';

// ── Clip extraction: a slice of the session audio, copied packet for packet ──
// Nothing is decoded and nothing is re-encoded (2026-09-14). The encoded packets
// of the slice are copied into a new file of the SAME container as the recording
// — a webm stays a webm, an m4a stays an m4a — by mediabunny's Conversion with
// copying forced.
//
// It replaced a decode followed by an MP3 encode in JavaScript (lamejs), which
// was the whole cost: on 300 s of a real recording, reading and decoding took
// 1.8 s and encoding 44 s. Copying is near-instant, keeps the original quality,
// and a clip weighs no more than the stretch of recording it came from — which
// matters, since attachments travel inside the synced state.

type Mediabunny = typeof import('mediabunny');

/** Seconds of slack added on each side of a detection before cutting.
 *
 *  A detection's bounds used to be the raw span of the observation windows,
 *  which happened to run about 5s wide on each side and gave every clip a
 *  comfortable lead-in for free. Since 2026-09-01 they are the ESTIMATED
 *  musical boundaries (median error ~1s), which is what the timeline and the
 *  detection want but leaves a clip starting exactly on the first note — and
 *  the estimate is unbiased, so it is late as often as early. This restores
 *  deliberately what the old imprecision gave by accident. Clamped to the
 *  recording below, so the edges of a session are safe. */
const CLIP_PAD_S = 3;

/** How an audio file of a given container is labelled and written back out. */
interface Container {
  /** Always an audio/* type, never the container's generic one: attachments are
   *  routed by mime type, and a clip labelled video/webm would open as a video. */
  mimeType: string;
  extension: string;
  makeFormat: () => OutputFormat;
}

function containerOf(mb: Mediabunny, format: InputFormat): Container | null {
  if (format === mb.WEBM)     return { mimeType: 'audio/webm', extension: 'webm', makeFormat: () => new mb.WebMOutputFormat() };
  if (format === mb.MATROSKA) return { mimeType: 'audio/x-matroska', extension: 'mka', makeFormat: () => new mb.MkvOutputFormat() };
  // An audio-only MP4 is what everyone calls an .m4a. A QuickTime file's
  // packets go into the same container, the one every player knows.
  if (format === mb.MP4 || format === mb.QTFF) return { mimeType: 'audio/mp4', extension: 'm4a', makeFormat: () => new mb.Mp4OutputFormat() };
  if (format === mb.MP3)  return { mimeType: 'audio/mpeg', extension: 'mp3', makeFormat: () => new mb.Mp3OutputFormat() };
  if (format === mb.OGG)  return { mimeType: 'audio/ogg', extension: 'ogg', makeFormat: () => new mb.OggOutputFormat() };
  if (format === mb.WAVE) return { mimeType: 'audio/wav', extension: 'wav', makeFormat: () => new mb.WavOutputFormat() };
  if (format === mb.FLAC) return { mimeType: 'audio/flac', extension: 'flac', makeFormat: () => new mb.FlacOutputFormat() };
  if (format === mb.ADTS) return { mimeType: 'audio/aac', extension: 'aac', makeFormat: () => new mb.AdtsOutputFormat() };
  return null;
}

/** A recording opened for reading, with mediabunny itself handed back.
 *
 *  Exported so localWaveform.ts can read samples out of the same file through
 *  the same door: a second `Input` of its own would mean a second list of
 *  formats to keep in step with this one, and the whole point of the list is
 *  that it is short and deliberate. */
export async function openAudioInput(audio: Blob) {
  // Lazy: mediabunny has no business in the main bundle for everyone who never
  // cuts a clip.
  const mb = await import('mediabunny');
  const input = new mb.Input({
    source: new mb.BlobSource(audio),
    // Named rather than ALL_FORMATS, so the bundle only carries the demuxers of
    // formats a clip can also be written back out to (see containerOf).
    formats: [mb.WEBM, mb.MATROSKA, mb.MP4, mb.QTFF, mb.MP3, mb.OGG, mb.WAVE, mb.FLAC, mb.ADTS],
  });
  return { mb, input };
}


/** What an audio file really is, read from its content — for when its declared
 *  type says nothing (an import the browser could not type). Null when the
 *  content is not a format read here. */
export async function detectAudioFile(audio: Blob): Promise<{ mimeType: string; extension: string } | null> {
  try {
    const { mb, input } = await openAudioInput(audio);
    try {
      const container = containerOf(mb, await input.getFormat());
      return container && { mimeType: container.mimeType, extension: container.extension };
    } finally {
      input.dispose();
    }
  } catch {
    return null;
  }
}

/** The audio of `file`, with the picture left behind — or null when there is
 *  nothing to gain or nothing that can be done safely.
 *
 *  An analysis keeps its recording: that is what a clip is cut from and what
 *  the player plays. For a file imported from a camera or a phone, that
 *  recording is a VIDEO, and the picture is nearly all of its weight — 419 MB
 *  for 67 seconds of music in the file that prompted this (2026-09-18), against
 *  a few MB of sound. It sits in IndexedDB on the device and, when session
 *  audio is synced, goes up to Drive as well.
 *
 *  Nothing is decoded or re-encoded here either: the audio packets are copied
 *  into an audio-only container of the same family, exactly as extractClip
 *  copies a slice. Two properties are non-negotiable and both are checked
 *  rather than assumed:
 *
 *  • `shiftTolerance` is left at its default of 0 — no shift at all, so output
 *    timestamps match the input's to the sample. Every detection of the
 *    analysis is an absolute time into this file; a file shifted by a
 *    container's edit list would desynchronise all of them at once.
 *  • `mode: 'forced'`, so an audio track that cannot be copied as-is is never
 *    silently transcoded. It returns null instead, and the caller keeps the
 *    original file — heavy, but untouched and exactly what was analysed.
 *
 *  Null is therefore the ordinary answer for anything audio-only, anything in
 *  a container this module does not write, and anything that would need a
 *  shift or a re-encode. */
export async function extractAudioOnly(
  file: Blob,
  onProgress?: (ratio: number) => void,
): Promise<ExtractedClip | null> {
  const { mb, input } = await openAudioInput(file);
  try {
    // Nothing to strip: an audio file is left strictly alone, down to the
    // bytes — no remux, no risk, no time spent.
    if ((await input.getVideoTracks()).length === 0) return null;

    const container = containerOf(mb, await input.getFormat());
    if (!container) return null;

    const target = new mb.BufferTarget();
    const output = new mb.Output({ format: container.makeFormat(), target });
    const conversion = await mb.Conversion.init({
      input,
      output,
      video: { discard: true },
      copy: { mode: 'forced' },
      showWarnings: false,
    });
    if (!conversion.isValid) return null;
    if (onProgress) conversion.onProgress = ratio => onProgress(ratio);
    await conversion.execute();
    if (!target.buffer) return null;
    return { blob: new Blob([target.buffer], { type: container.mimeType }), extension: container.extension };
  } finally {
    input.dispose();
  }
}

export interface ExtractedClip {
  blob: Blob;
  /** Without the dot — the container's, so the file name tells the truth. */
  extension: string;
}

/** Cuts [start, end] (plus CLIP_PAD_S on each side) out of the session audio.
 *
 *  Throws when the recording's format is not one read here, or when its audio
 *  cannot be copied as-is: there is deliberately no encoder to fall back on. */
export async function extractClip(
  sessionAudio: Blob,
  start: number,
  end: number,
  onProgress?: (ratio: number) => void,
): Promise<ExtractedClip> {
  const { mb, input } = await openAudioInput(sessionAudio);
  try {
    const container = containerOf(mb, await input.getFormat());
    if (!container) throw new Error('clip_format_unsupported');

    const from = Math.max(0, start - CLIP_PAD_S);
    const to = Math.min(end + CLIP_PAD_S, await input.computeDuration());
    if (to <= from) throw new Error('empty clip range');

    const target = new mb.BufferTarget();
    const output = new mb.Output({ format: container.makeFormat(), target });
    const conversion = await mb.Conversion.init({
      input,
      output,
      // An imported video carries a picture track; a clip is for listening.
      video: { discard: true },
      trim: { start: from, end: to },
      copy: {
        // Never re-encode: a track that cannot be copied fails the clip rather
        // than being silently transcoded.
        mode: 'forced',
        // Whole packets around each bound instead of a cut inside one — a few
        // tens of milliseconds, next to the seconds of padding.
        boundaryPolicy: 'expand',
        // Timestamps may be shifted as copying requires: a clip is a file of its
        // own, nothing expects its timeline to line up with the recording's.
        shiftTolerance: Infinity,
      },
      showWarnings: false,
    });
    if (!conversion.isValid) {
      throw new Error('clip_cannot_copy: ' + conversion.discardedTracks.map(d => d.reason).join(', '));
    }
    if (onProgress) conversion.onProgress = ratio => onProgress(ratio);
    await conversion.execute();
    if (!target.buffer) throw new Error('clip_empty');
    return { blob: new Blob([target.buffer], { type: container.mimeType }), extension: container.extension };
  } finally {
    input.dispose();
  }
}
