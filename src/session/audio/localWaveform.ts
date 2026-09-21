import { openAudioInput } from './clipExtract';
import { PEAK_BUCKET_S } from '../ui/boundEditorModel';

// ── A waveform for one stretch of a recording ────────────────────────────────
// The session player has never drawn a waveform, and for good reason: an
// analysis can run for hours, and decodeAudioData on a whole recording would
// hold every sample of it in memory at once (see SessionSummary.tsx's own note
// on why it streams through a native <audio> element instead).
//
// The bound editor needs one anyway — but only over the minute or two around
// the detection being adjusted. mediabunny's AudioSampleSink decodes exactly
// the range it is asked for, so the cost is set by what is being LOOKED at,
// not by how long the recording is.
//
// What comes back is an envelope, not samples: one peak per PEAK_BUCKET_S
// (10 ms). That is all either strip can draw — the magnifier shows 8 s across
// a few hundred pixels — and it turns a minute of audio into 6 000 floats
// instead of three million.

/** The editor's whole window as an envelope, filled in by one or more reads.
 *
 *  One array rather than one per read, so the magnifier and the context strip
 *  cannot disagree about a sample they both cover — and so reading the
 *  magnifier's few seconds FIRST costs nothing afterwards: those buckets are
 *  already there when the long read walks past them. */
export interface PeakBuffer {
  /** Session time of bucket 0. */
  from: number;
  /** One peak per PEAK_BUCKET_S. Allocated for the whole window up front;
   *  a bucket nobody has read yet is zero, which is why `covered` exists —
   *  unread must be drawn as unread, never as silence. */
  peaks: Float32Array;
  /** Bucket ranges actually read, `[startInclusive, endExclusive)`, sorted and
   *  merged. Few in practice: the magnifier's range, then the long one. */
  covered: Array<[number, number]>;
  /** Largest peak seen, for scaling. A pub recording off a phone mic and a
   *  line-in capture are orders of magnitude apart, so a fixed full scale
   *  would flatten one of them into a line. */
  max: number;
}

export function makePeakBuffer(from: number, to: number): PeakBuffer {
  return { from, peaks: new Float32Array(Math.max(1, Math.ceil((to - from) / PEAK_BUCKET_S))), covered: [], max: 0 };
}

/** The bucket holding session time `t` — may fall outside the buffer. */
export const bucketOf = (buf: PeakBuffer, t: number): number => Math.floor((t - buf.from) / PEAK_BUCKET_S);

/** Has this instant been read? */
export function isRead(buf: PeakBuffer, t: number): boolean {
  const b = bucketOf(buf, t);
  for (const [lo, hi] of buf.covered) if (b >= lo && b < hi) return true;
  return false;
}

/** The loudest level over [a, b), scaled to [0, 1] by what has been seen so
 *  far — one pixel column's worth, however many buckets that spans. Zero for
 *  anything unread; callers check `isRead` first and draw that differently. */
export function levelOver(buf: PeakBuffer, a: number, b: number): number {
  const lo = Math.max(0, bucketOf(buf, a));
  const hi = Math.min(buf.peaks.length, Math.max(lo + 1, bucketOf(buf, b)));
  let m = 0;
  for (let i = lo; i < hi; i++) { const v = buf.peaks[i]!; if (v > m) m = v; }
  return buf.max > 0 ? m / buf.max : 0;
}

// largestCovered lived here until 2026-09-21: the widest unbroken stretch
// read so far, which was what the silence detector was allowed to look at (a
// hole between two reads would have been read as a pause). The silence snap
// marks are gone at the user's request — "plus juste de les lire à l'œil avec
// la forme de l'onde" — and this went with its only caller.

function addCover(buf: PeakBuffer, lo: number, hi: number): void {
  if (hi <= lo) return;
  const next: Array<[number, number]> = [];
  let a = lo, b = hi;
  for (const [x, y] of buf.covered) {
    if (y < a) next.push([x, y]);
    else if (x > b) { next.push([a, b]); a = x; b = y; }
    else { a = Math.min(a, x); b = Math.max(b, y); }
  }
  next.push([a, b]);
  buf.covered = next;
}

/** A read in flight. Cancel it when the editor closes or the window moves —
 *  a decode left running behind a closed modal keeps a file handle and a
 *  hardware decoder alive for nothing. */
export interface WaveRead {
  cancel: () => void;
}

/** Between two repaints while a window fills in. Roughly five a second: fast
 *  enough to read as filling, far short of a frame budget. */
const THROTTLE_MS = 200;

/** Reads [from, to] of `audio` into `buf`, calling `onChunk` as it fills.
 *
 *  Never throws: a recording in a container this app does not read, a codec
 *  this browser cannot decode, or a file that turns out to be damaged all end
 *  the same way — `onDone(false)` and no waveform there. The editor works
 *  without one (that is also the "recording is on another device" case), so
 *  there is nothing here worth interrupting the user for.
 *
 *  `onChunk` fires at most every THROTTLE_MS, plus once at the end: the strips
 *  repaint from it, and repainting per decoded packet would be a hundred times
 *  a second for no visible gain. */
export function readInto(
  audio: Blob,
  buf: PeakBuffer,
  from: number,
  to: number,
  onChunk: () => void,
  onDone: (ok: boolean) => void,
): WaveRead {
  let cancelled = false;

  void (async () => {
    let input: Awaited<ReturnType<typeof openAudioInput>>['input'] | null = null;
    try {
      const { mb, input: opened } = await openAudioInput(audio);
      input = opened;
      if (cancelled) return;

      const track = await input.getPrimaryAudioTrack();
      if (!track || !(await track.canDecode())) { if (!cancelled) onDone(false); return; }

      // 24-bit raw PCM is decoded by hand everywhere else in this app because
      // AudioData.copyTo() on it KILLS THE RENDERER — the whole tab, taking
      // Cadence with it (measured 2026-09-18; streamingFileSource.ts has the
      // full sequence). A waveform is not worth that risk: this one case
      // simply goes without.
      const codec = await track.getCodec();
      if (codec && codec.startsWith('pcm-s24')) { if (!cancelled) onDone(false); return; }

      const sink = new mb.AudioSampleSink(track);
      const startBucket = Math.max(0, bucketOf(buf, from));
      let reached = startBucket;
      let lastEmit = 0;
      let scratch = new Float32Array(0);

      for await (const sample of sink.samples(from, to)) {
        if (cancelled) { sample.close(); return; }
        try {
          // Channel 0 only. An envelope is a picture of the level, and the
          // second channel of a session recording says the same thing as the
          // first — copying it would double the work to change nothing that
          // can be seen at 10 ms per pixel.
          const frames = sample.numberOfFrames;
          const need = sample.allocationSize({ format: 'f32-planar', planeIndex: 0 }) / 4;
          if (scratch.length < need) scratch = new Float32Array(need);
          sample.copyTo(scratch, { format: 'f32-planar', planeIndex: 0 });

          const rate = sample.sampleRate;
          const base = sample.timestamp - buf.from;
          for (let i = 0; i < frames; i++) {
            const at = Math.floor((base + i / rate) / PEAK_BUCKET_S);
            if (at < 0 || at >= buf.peaks.length) continue;
            const v = Math.abs(scratch[i]!);
            if (v > buf.peaks[at]!) buf.peaks[at] = v;
            if (v > buf.max) buf.max = v;
          }
          reached = Math.max(reached, Math.min(buf.peaks.length, Math.ceil((base + frames / rate) / PEAK_BUCKET_S)));
        } finally {
          sample.close();
        }

        const now = performance.now();
        if (now - lastEmit >= THROTTLE_MS) {
          lastEmit = now;
          addCover(buf, startBucket, reached);
          onChunk();
        }
      }

      if (cancelled) return;
      // The iterator can stop short of `to` — a recording that simply ends
      // there. Nothing is missing, so the whole asked-for range counts as read
      // rather than leaving a sliver drawn as "still coming" forever.
      addCover(buf, startBucket, Math.min(buf.peaks.length, Math.max(reached, bucketOf(buf, to))));
      onChunk();
      onDone(true);
    } catch {
      if (!cancelled) onDone(false);
    } finally {
      try { input?.dispose(); } catch { /* nothing left to release */ }
    }
  })();

  return { cancel: () => { cancelled = true; } };
}
