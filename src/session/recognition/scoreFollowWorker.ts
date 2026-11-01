import init, { FolkFriendWASM } from '../../../vendor/folkfriend/folkfriend.js';
import { followScore, contourToMidi, FEATURE_PITCHES, MATCH_USABLE, type FollowResult } from '../scoreFollow';
import { openAudioInput } from '../audio/clipExtract';
import { getSettingContour } from './indexStore';
import { FF_PCM_WINDOW } from '../sessionConfig';

// ── Score following worker ───────────────────────────────────────────────────
// All of the work, off the main thread — which is playing the recording and
// drawing the cursor meanwhile, and stuttered while the stretch was decoded
// there (measured 2026-10-28: 4 of the 6 seconds on a throttled phone CPU).
// Here, given the score as MIDI pitches (read off the drawn ABC on the page,
// syncedScore.tsx's scoreContour), and the setting's contour from the cached
// index when the version is one of TheSession's: each is aligned, and the one
// that fits the recording better is kept (perFrame, made for exactly that).
// Neither alone is enough (2026-10-29): the index unfolds some settings
// wrongly — Mick O'Connor's 16960 came out A A B for A A B B — while it plays
// ornaments as notes (a roll's upper note), as musicians do, where the
// drawing has none; measured on the 336 annotated tunes, the drawing alone
// left 13 covered under half against 6 for the index, and the better of the
// two did as well as the index everywhere, and better on 132. Then the
// detection's stretch
// of the recording decoded at its OWN rate (FolkFriend takes any rate; no
// resampling, which would need an OfflineAudioContext a worker does not
// have), the engine's features, the alignment. No tune index is loaded into
// the engine — the score is given — and the scalar build is enough: SIMD only
// speeds up index queries.

// A card's recording (2026-10-31, the user) has no detection to say where the
// tune is: `to` null, the whole of it — and a long one is first SEARCHED for
// the tune (`locate`), only the stretch found then being decoded and aligned
// as a detection's is. Aligned whole, an hour of recording would need its
// 700 MB of samples and gigabytes of alignment tables.

export type FollowFailure = 'no_contour' | 'no_audio' | 'no_alignment';
export type FollowStage = 'scan' | 'locate' | 'decode' | 'listen' | 'tempo' | 'align';
/** `score`: one MIDI pitch per quaver of a pass of the tune, as drawn — or
 *  empty, the index contour alone then (a detection's stretch only).
 *  `settingId`: the TheSession setting it is, whose index contour competes.
 *  `to` null: to the end of the recording, the tune being anywhere in it.
 *  `samples` false: the alignment alone, no 'decoded' message — nobody is
 *  going to play it (boundSuggestClient.ts).
 *  `decode`: the stretch alone — its alignment is known already, its samples
 *  are not (scoreFollowClient keeps those for the last one only). */
export type ScoreFollowRequest =
  | { type: 'follow'; audio: Blob; score: number[]; settingId?: string; from: number; to: number | null; samples?: false }
  | { type: 'decode'; audio: Blob; from: number; to: number };
export type ScoreFollowResponse =
  | { type: 'progress'; stage: FollowStage; ratio: number }
  /** The stretch, mono, at its own rate — sent before the alignment is done.
   *  `from`/`to`: the stretch as asked, in the recording's time — what
   *  decodes it again to the same first sample. */
  | { type: 'decoded'; pcm: Float32Array; rate: number; from: number; to: number }
  | { type: 'followed'; result: FollowResult }
  | { type: 'failed'; reason: FollowFailure }
  | { type: 'error'; message: string };

interface WorkerScope {
  postMessage(msg: ScoreFollowResponse, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent<ScoreFollowRequest>) => void) | null;
}
const ctx = self as unknown as WorkerScope;

/** FolkFriend's accepted rates (ff_config SAMPLE_RATE_MIN / _MAX). */
const FF_RATE_MAX = 66_974;

let ff: FolkFriendWASM | null = null;
let ptr = 0;

async function engine(): Promise<FolkFriendWASM> {
  if (ff) return ff;
  await init(new URL('../../../vendor/folkfriend/folkfriend_bg.wasm', import.meta.url));
  ff = new FolkFriendWASM();
  ptr = ff.alloc_single_pcm_window();
  return ff;
}

/** Mono samples of [from, to) of a recording at its own rate — only that
 *  stretch is decoded, however long the recording. Halved (pairs averaged)
 *  until the rate is one the engine takes: a 96 kHz import. Null when the
 *  recording cannot be decoded here. */
async function decodeSpan(audio: Blob, from: number, to: number, onRatio: (r: number) => void): Promise<{ pcm: Float32Array; rate: number } | null> {
  const { mb, input } = await openAudioInput(audio);
  try {
    const track = await input.getPrimaryAudioTrack();
    if (!track || !(await track.canDecode())) return null;
    // 24-bit raw PCM through AudioData.copyTo kills the renderer (see
    // localWaveform.ts): this case goes without.
    const codec = await track.getCodec();
    if (codec && codec.startsWith('pcm-s24')) return null;
    const sink = new mb.AudioSampleSink(track);
    const parts: Float32Array[] = [];
    let rate = 0, total = 0;
    let plane = new Float32Array(0);
    for await (const sample of sink.samples(from, to)) {
      try {
        rate = sample.sampleRate;
        const frames = sample.numberOfFrames;
        const channels = sample.numberOfChannels;
        const mono = new Float32Array(frames);
        for (let c = 0; c < channels; c++) {
          const need = sample.allocationSize({ format: 'f32-planar', planeIndex: c }) / 4;
          if (plane.length < need) plane = new Float32Array(need);
          sample.copyTo(plane, { format: 'f32-planar', planeIndex: c });
          for (let i = 0; i < frames; i++) mono[i]! += plane[i]! / channels;
        }
        parts.push(mono);
        total += frames;
        onRatio((sample.timestamp - from) / (to - from));
      } finally {
        sample.close();
      }
    }
    if (!rate || total === 0) return null;
    let pcm = new Float32Array(total);
    let at = 0;
    for (const p of parts) { pcm.set(p, at); at += p.length; }
    while (rate > FF_RATE_MAX) {
      const half = new Float32Array(pcm.length >> 1);
      for (let i = 0; i < half.length; i++) half[i] = (pcm[2 * i]! + pcm[2 * i + 1]!) / 2;
      pcm = half;
      rate /= 2;
    }
    return { pcm, rate };
  } finally {
    input.dispose();
  }
}

/** How long a recording is, in seconds; null when it cannot be read here. */
async function durationOf(audio: Blob): Promise<number | null> {
  try {
    const { input } = await openAudioInput(audio);
    try {
      return await input.computeDuration();
    } finally {
      input.dispose();
    }
  } catch {
    return null;
  }
}

/** A recording longer than this is searched for the tune before it is
 *  aligned. The alignment's tables grow with its length times the score's:
 *  6 min of a 300-quaver score is some 50 MB, and 96 MB was already a risk
 *  on a phone (measured 2026-10-31). */
const LONG_S = 6 * 60;
/** The search aligns the recording a window at a time, each overlapping the
 *  next by half: a tune shorter than the hop lies whole in one of them. */
const LOCATE_WINDOW_S = 4 * 60;
const LOCATE_HOP_S = 2 * 60;
/** Finds of two windows this close are one playing of the tune. */
const LOCATE_JOIN_S = 10;
/** Recording kept on each side of what the search found, as a detection's
 *  margin: the alignment then finds the bounds itself. */
const ZONE_MARGIN_S = 15;
/** The longest stretch then aligned: LONG_S, margins included. */
const ZONE_MAX_S = LONG_S - 2 * ZONE_MARGIN_S;
/** Feature frames taken out of the engine at a time while scanning. */
const SCAN_TAKE_EVERY = 2048;

/** The engine's features of a whole recording, fed as it is decoded — never
 *  all of its samples at once: an hour of them is 700 MB, its features 32.
 *  Brought within the engine's rates as decodeSpan does (pairs averaged).
 *  Null when the recording cannot be decoded here. */
async function scanFeatures(audio: Blob, f: FolkFriendWASM, onRatio: (r: number) => void): Promise<{ features: Float32Array; fps: number } | null> {
  const { mb, input } = await openAudioInput(audio);
  try {
    const track = await input.getPrimaryAudioTrack();
    if (!track || !(await track.canDecode())) return null;
    const codec = await track.getCodec();
    if (codec && codec.startsWith('pcm-s24')) return null;
    const duration = await input.computeDuration();
    const sink = new mb.AudioSampleSink(track);
    const window = new Float32Array(FF_PCM_WINDOW);
    const parts: Float32Array[] = [];
    let rate = 0, factor = 0, fill = 0, acc = 0, accN = 0, fed = 0;
    let plane = new Float32Array(0), mono = new Float32Array(0);
    const take = () => { const p = f.take_features(); if (p.length) parts.push(p); };
    for await (const sample of sink.samples()) {
      try {
        if (!factor) {
          rate = sample.sampleRate;
          factor = 1;
          while (rate > FF_RATE_MAX) { rate /= 2; factor *= 2; }
          f.set_sample_rate(rate);
          f.flush_pcm_buffer();
        }
        const frames = sample.numberOfFrames;
        const channels = sample.numberOfChannels;
        if (mono.length < frames) mono = new Float32Array(frames);
        mono.fill(0, 0, frames);
        for (let c = 0; c < channels; c++) {
          const need = sample.allocationSize({ format: 'f32-planar', planeIndex: c }) / 4;
          if (plane.length < need) plane = new Float32Array(need);
          sample.copyTo(plane, { format: 'f32-planar', planeIndex: c });
          for (let i = 0; i < frames; i++) mono[i]! += plane[i]! / channels;
        }
        for (let i = 0; i < frames; i++) {
          acc += mono[i]!;
          if (++accN < factor) continue;
          window[fill++] = acc / factor;
          acc = 0;
          accN = 0;
          if (fill < FF_PCM_WINDOW) continue;
          f.get_allocated_pcm_window(ptr).set(window);
          f.feed_single_pcm_window(ptr);
          fill = 0;
          if (++fed % SCAN_TAKE_EVERY === 0) take();
        }
        if (duration > 0) onRatio(sample.timestamp / duration);
      } finally {
        sample.close();
      }
    }
    take();
    if (!rate) return null;
    const features = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) { features.set(p, at); at += p.length; }
    return features.length ? { features, fps: rate / FF_PCM_WINDOW } : null;
  } finally {
    input.dispose();
  }
}

/** Where in a long recording `score` is played, in its seconds: the best of
 *  its windows, joined by those the playing goes on into. A window is worth
 *  the notes it puts on the score beyond what a wrong score would
 *  (MATCH_USABLE of them): longer and truer both count, a wrong tune is
 *  worth less than nothing. Null when no window holds the tune. */
function locate(features: Float32Array, fps: number, score: number[], onRatio: (r: number) => void): { from: number; to: number } | null {
  const frames = Math.floor(features.length / FEATURE_PITCHES);
  const win = Math.round(LOCATE_WINDOW_S * fps);
  const hop = Math.round(LOCATE_HOP_S * fps);
  const last = Math.max(0, frames - win);
  const count = Math.ceil(last / hop) + 1;
  const finds: Array<{ worth: number; start: number; end: number }> = [];
  for (let k = 0; k < count; k++) {
    const a = Math.min(k * hop, last);
    const r = followScore(features.subarray(a * FEATURE_PITCHES, Math.min(frames, a + win) * FEATURE_PITCHES), score, { fps },
      p => onRatio((k + (p.stage === 'tempo' ? p.ratio / 2 : 0.5 + p.ratio / 2)) / count));
    if (!r) continue;
    let hits = 0, counted = 0;
    for (let q = 0; q < r.hits.length; q++) { hits += r.hits[q]!; counted += r.counted[q]!; }
    const worth = hits - MATCH_USABLE * counted;
    if (worth > 0) finds.push({ worth, start: a / fps + r.times[0]!, end: a / fps + r.end });
  }
  onRatio(1);
  if (finds.length === 0) return null;
  finds.sort((x, y) => y.worth - x.worth);
  const best = finds[0]!;
  let { start, end } = best;
  for (let grew = true; grew;) {
    grew = false;
    for (const w of finds) {
      if (w.start > end + LOCATE_JOIN_S || w.end < start - LOCATE_JOIN_S) continue;
      if (w.start < start || w.end > end) { start = Math.min(start, w.start); end = Math.max(end, w.end); grew = true; }
    }
  }
  // Too long to align at once: the part around the best window's find.
  if (end - start > ZONE_MAX_S) {
    start = Math.max(start, Math.min((best.start + best.end) / 2 - ZONE_MAX_S / 2, end - ZONE_MAX_S));
    end = start + ZONE_MAX_S;
  }
  return { from: Math.max(0, start - ZONE_MARGIN_S), to: end + ZONE_MARGIN_S };
}

/** At most this often — a message per frame would cost more than the work. */
const PROGRESS_EVERY_MS = 80;

ctx.onmessage = (e) => {
  const msg = e.data;
  void (async () => {
    try {
      let last = 0;
      const progress = (stage: FollowStage, ratio: number) => {
        const now = performance.now();
        if (now - last < PROGRESS_EVERY_MS && ratio < 1) return;
        last = now;
        ctx.postMessage({ type: 'progress', stage, ratio });
      };
      if (msg.type === 'decode') {
        progress('decode', 0);
        const d = await decodeSpan(msg.audio, msg.from, msg.to, r => progress('decode', r));
        if (!d) { ctx.postMessage({ type: 'failed', reason: 'no_audio' }); return; }
        ctx.postMessage({ type: 'decoded', pcm: d.pcm, rate: d.rate, from: msg.from, to: msg.to }, [d.pcm.buffer]);
        return;
      }
      let from = msg.from;
      let to = msg.to;
      if (to === null) {
        const duration = await durationOf(msg.audio);
        if (duration === null) { ctx.postMessage({ type: 'failed', reason: 'no_audio' }); return; }
        to = duration;
        if (duration > LONG_S) {
          if (msg.score.length < 2) { ctx.postMessage({ type: 'failed', reason: 'no_contour' }); return; }
          progress('scan', 0);
          const scan = await scanFeatures(msg.audio, await engine(), r => progress('scan', r));
          if (!scan) { ctx.postMessage({ type: 'failed', reason: 'no_audio' }); return; }
          const zone = locate(scan.features, scan.fps, msg.score, r => progress('locate', r));
          if (!zone) { ctx.postMessage({ type: 'failed', reason: 'no_alignment' }); return; }
          from = zone.from;
          to = Math.min(zone.to, duration);
        }
      }
      const span = { from, to };
      progress('decode', 0);
      // The samples go back to the page the moment they are decoded — the
      // player plays them while the alignment runs, and the cursor then
      // follows the very samples it was aligned on, to the sample. A copy:
      // this side still needs them.
      const decoding = decodeSpan(msg.audio, span.from, span.to, r => progress('decode', r)).then((d) => {
        if (d && msg.samples !== false) {
          const copy = d.pcm.slice();
          ctx.postMessage({ type: 'decoded', pcm: copy, rate: d.rate, from: span.from, to: span.to }, [copy.buffer]);
        }
        return d;
      });
      if (msg.score.length < 2 && !msg.settingId) { ctx.postMessage({ type: 'failed', reason: 'no_contour' }); return; }
      const [decoded, f, contour] = await Promise.all([
        decoding, engine(),
        msg.settingId ? getSettingContour(msg.settingId).catch(() => null) : Promise.resolve(null),
      ]);
      if (msg.score.length < 2 && !contour) { ctx.postMessage({ type: 'failed', reason: 'no_contour' }); return; }
      if (!decoded) { ctx.postMessage({ type: 'failed', reason: 'no_audio' }); return; }

      f.set_sample_rate(decoded.rate);
      f.flush_pcm_buffer();
      const { pcm } = decoded;
      const n = Math.floor(pcm.length / FF_PCM_WINDOW);
      for (let i = 0; i < n; i++) {
        f.get_allocated_pcm_window(ptr).set(pcm.subarray(i * FF_PCM_WINDOW, (i + 1) * FF_PCM_WINDOW));
        f.feed_single_pcm_window(ptr);
        if ((i & 127) === 0) progress('listen', i / n);
      }
      const features = f.take_features();
      progress('listen', 1);
      const scores = [...(msg.score.length >= 2 ? [msg.score] : []), ...(contour ? [contourToMidi(contour)] : [])];
      // The alignments one after the other, their progress one forward run
      // over the tempo and align stages together — a bar that went back to
      // the tempo search for the second score would read as starting over.
      // (The client gives tempo 0.55–0.8 and align 0.8–1: `x` of the two
      // together is tempo x·9/5 below 5/9, align (x − 5/9)·9/4 above.)
      const together = (x: number) => (x < 5 / 9 ? progress('tempo', x * 9 / 5) : progress('align', (x - 5 / 9) * 9 / 4));
      let result: FollowResult | null = null;
      for (let k = 0; k < scores.length; k++) {
        const r = followScore(features, scores[k]!, { fps: decoded.rate / FF_PCM_WINDOW },
          p => together((k + (p.stage === 'tempo' ? p.ratio / 2 : 0.5 + p.ratio / 2)) / scores.length));
        if (r && (!result || r.perFrame > result.perFrame)) result = r;
      }
      if (!result) { ctx.postMessage({ type: 'failed', reason: 'no_alignment' }); return; }
      ctx.postMessage({ type: 'followed', result });
    } catch (err) {
      ctx.postMessage({ type: 'error', message: String(err) });
    }
  })();
};
