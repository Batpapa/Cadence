import init, { FolkFriendWASM } from '../../../vendor/folkfriend/folkfriend.js';
import { followScore, contourToMidi, FEATURE_PITCHES, type FollowResult } from '../scoreFollow';
import { openAudioInput } from '../audio/clipExtract';
import { getSettingContour } from './indexStore';
import { FF_PCM_WINDOW, FF_TEMPO_MIN_BPM, FF_TEMPO_MAX_BPM } from '../sessionConfig';
import { Novelty } from '../liveTempo';

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
/** The engine's cleaned features of a stretch, `fps` frames a second — all an
 *  alignment needs of the audio. */
export interface HeardSpan { values: Float32Array; fps: number }
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
  | {
    type: 'follow'; audio: Blob; score: number[]; settingId?: string; from: number; to: number | null; samples?: false;
    /** What [from, to) gave the engine, kept from an alignment of it: not
     *  decoded nor listened to again — another score on the same stretch
     *  (N3b: an edit aligned anew). No samples are sent then. */
    features?: HeardSpan;
  }
  | { type: 'decode'; audio: Blob; from: number; to: number }
  /** The tempo's novelty of [from, to) (liveTempo.ts), for a detection's
   *  curve worked out when asked (2026-11-01): the novelty is never saved.
   *  Sent as it is worked out, so the curve grows (2026-11-02, the user). */
  | { type: 'tempo'; audio: Blob; from: number; to: number }
  /** The whole recording written out as ABC (transcribeRecording.tsx). */
  | { type: 'transcribe'; audio: Blob };
export type ScoreFollowResponse =
  | { type: 'progress'; stage: FollowStage; ratio: number }
  /** The stretch, mono, at its own rate — sent before the alignment is done.
   *  `from`/`to`: the stretch as asked, in the recording's time — what
   *  decodes it again to the same first sample. */
  | { type: 'decoded'; pcm: Float32Array; rate: number; from: number; to: number }
  /** `heard`: what the stretch gave the engine, when the stretch did not
   *  depend on the score — a range given, or a recording short enough to be
   *  read whole — for the next score on it. */
  | { type: 'followed'; result: FollowResult; heard?: HeardSpan }
  /** The next stretch of novelty: `fps` frames a second, from the request's `from`. */
  | { type: 'novelty'; fps: number; values: Float32Array }
  | { type: 'tempo-done' }
  /** The transcription: FolkFriend's ABC (a K: line and the bars), and the
   *  crotchets a minute of the quaver grid it was quantised on. */
  | { type: 'transcribed'; abc: string; bpm: number }
  /** Longer than a transcription is followed whole (LONG_S). */
  | { type: 'too-long'; seconds: number; max: number }
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
let ffClean: FolkFriendWASM | null = null;
let ptr = 0;
let ptrClean = 0;

async function engine(): Promise<FolkFriendWASM> {
  if (ff) return ff;
  await init(new URL('../../../vendor/folkfriend/folkfriend_bg.wasm', import.meta.url));
  ff = new FolkFriendWASM();
  ptr = ff.alloc_single_pcm_window();
  return ff;
}

// ── Cleaned features (2026-11-07) ─────────────────────────────────────────────
// Alignment and locate read the pitch-class engine's cleaning of each frame —
// its harmonic part (strums, bodhrán and attacks taken out), each note minus
// its median over 10 s (drones, held chords), the 3 strongest notes kept —
// rather than take_features'. Measured on the annotated sessions
// (experiments/score-follow, real.js and locate.js): 17 tunes followed over
// less than 80 % of their span instead of 20, ends nearer the annotations
// (90th percentile 5.0 / 3.6 s instead of 5.5 / 4.6), passes more regular,
// a wrong score claiming 12 % of a span at the 90th percentile instead of 89 %;
// in an 85-minute recording 22 of 26 tunes found where they were played
// instead of 20, and 7 of 24 tunes never played « found » instead of 15.
// The tempo ('tempo' below) keeps the default instance: no gain measured there.
async function cleanEngine(): Promise<FolkFriendWASM> {
  if (ffClean) return ffClean;
  await engine(); // the module's init
  ffClean = new FolkFriendWASM();
  ffClean.enable_clean_features();
  ptrClean = ffClean.alloc_single_pcm_window();
  return ffClean;
}

/** A new rate makes a new feature extractor, which starts in the default mode:
 *  the cleaned one is switched back on with it. */
function setCleanRate(f: FolkFriendWASM, rate: number): void {
  f.set_sample_rate(rate);
  f.enable_clean_features();
}

/** The cleaned features fed since the last take, at `fps` frames a second. */
function takeClean(f: FolkFriendWASM, fps: number): Float32Array {
  return f.take_clean_features(Math.round(10 * fps), false, Math.max(1, Math.round(fps)), 3);
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
  // Taken every 5 minutes of audio: each take starts the cleaning afresh (its
  // 10-second drone median, the harmonic filter's edges), as in the bench.
  let takeEvery = SCAN_TAKE_EVERY;
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
    const take = () => { const p = takeClean(f, rate / FF_PCM_WINDOW); if (p.length) parts.push(p); };
    for await (const sample of sink.samples()) {
      try {
        if (!factor) {
          rate = sample.sampleRate;
          factor = 1;
          while (rate > FF_RATE_MAX) { rate /= 2; factor *= 2; }
          setCleanRate(f, rate);
          f.flush_pcm_buffer();
          takeEvery = Math.round((300 * rate) / FF_PCM_WINDOW);
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
          f.get_allocated_pcm_window(ptrClean).set(window);
          f.feed_single_pcm_window(ptrClean);
          fill = 0;
          if (++fed % takeEvery === 0) take();
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

/** What a wrong score puts on the score, as a share of the notes, for locate's
 *  worth below: 0.5, the old MATCH_USABLE — kept there on the cleaned features
 *  (2026-11-07) because the zones it picks were measured best there: with the
 *  translated 0.66, 20 of 26 tunes found where they were played in the
 *  85-minute bench instead of 22. Only the verdict on the zone found moved to
 *  MATCH_USABLE. */
const LOCATE_WRONG_SHARE = 0.5;

/** Where in a long recording `score` is played, in its seconds: the best of
 *  its windows, joined by those the playing goes on into. A window is worth
 *  the notes it puts on the score beyond what a wrong score would
 *  (LOCATE_WRONG_SHARE of them): longer and truer both count, a wrong tune is
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
    const worth = hits - LOCATE_WRONG_SHARE * counted;
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

// ── A recording written out (2026-11-23, the user: a hidden gesture) ─────────
// FolkFriend's own transcription, with its octaves: the 48-note engine — not
// the analyser's pitch classes, which have none. Put back between D4 and C#5
// for the ABC (contourShift.ts), every note above C#5 came out an octave low
// (the user, the same day). Measured against Ableton's melody MIDI of three
// of the user's test recordings, exact pitches, repeated notes merged: the
// 48-note engine 96.9 / 71.4 / 56.6 % in agreement (clean, ornaments, several
// notes at once), the pitch classes folded 62.1 / 53.3 / 44.7 %, each class
// at the octave nearest the note before 8.4 / 15.2 / 41.2 % (leaps of a fifth
// are everywhere) — the classes alone, octave ignored, 95.8 / 75.2 / 59.6 %.
// What is given up: the pitch classes' tuning correction — a recording a
// quarter-tone off is transcribed worse. The analyser's tempo range. Over the
// whole recording at once rather than window by window: each note's length is
// rounded on its own, so a tempo that drifts a little is absorbed. Measured
// in Node on a 13th Moon session: 6 minutes in 0.7 s.

/** The transcription of `pcm` at `rate`, or null when no notes were heard.
 *  Its own engine, thrown away after; the tempo range is the module's (a
 *  worker is made for each request). */
function transcribe(pcm: Float32Array, rate: number): { abc: string; bpm: number } | null {
  const f = new FolkFriendWASM();
  try {
    f.set_sample_rate(rate);
    f.set_tempo_range(FF_TEMPO_MIN_BPM, FF_TEMPO_MAX_BPM);
    const at = f.alloc_single_pcm_window();
    const n = Math.floor(pcm.length / FF_PCM_WINDOW);
    for (let i = 0; i < n; i++) {
      f.get_allocated_pcm_window(at).set(pcm.subarray(i * FF_PCM_WINDOW, (i + 1) * FF_PCM_WINDOW));
      f.feed_single_pcm_window(at);
    }
    const raw = JSON.parse(f.transcribe_pcm_buffer_debug()) as { contour: string; features: { best_bpm: number } } | { error: string };
    if ('error' in raw || raw.contour.length < 2) return null;
    return { abc: f.contour_to_abc(raw.contour), bpm: raw.features.best_bpm };
  } finally {
    f.free();
  }
}

/** At most this often — a message per frame would cost more than the work. */
const PROGRESS_EVERY_MS = 80;

/** The better of the drawn score's alignment and the index contour's (the
 *  header), over `features` — or null when neither aligns. */
function alignBest(
  features: Float32Array, fps: number, score: number[], contour: Parameters<typeof contourToMidi>[0] | null,
  progress: (stage: FollowStage, ratio: number) => void,
): FollowResult | null {
  const scores = [...(score.length >= 2 ? [score] : []), ...(contour ? [contourToMidi(contour)] : [])];
  // The alignments one after the other, their progress one forward run
  // over the tempo and align stages together — a bar that went back to
  // the tempo search for the second score would read as starting over.
  // (The client gives tempo 0.55–0.8 and align 0.8–1: `x` of the two
  // together is tempo x·9/5 below 5/9, align (x − 5/9)·9/4 above.)
  const together = (x: number) => (x < 5 / 9 ? progress('tempo', x * 9 / 5) : progress('align', (x - 5 / 9) * 9 / 4));
  let result: FollowResult | null = null;
  for (let k = 0; k < scores.length; k++) {
    const r = followScore(features, scores[k]!, { fps },
      p => together((k + (p.stage === 'tempo' ? p.ratio / 2 : 0.5 + p.ratio / 2)) / scores.length));
    if (r && (!result || r.perFrame > result.perFrame)) result = r;
  }
  return result;
}

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
      if (msg.type === 'tempo') {
        progress('decode', 0);
        const d = await decodeSpan(msg.audio, msg.from, msg.to, r => progress('decode', r));
        if (!d) { ctx.postMessage({ type: 'failed', reason: 'no_audio' }); return; }
        const f = await engine();
        f.set_sample_rate(d.rate);
        f.flush_pcm_buffer();
        f.take_features();
        // At the recording's own rate, as for an alignment: the windows are
        // counted in frames of it.
        const fps = d.rate / FF_PCM_WINDOW;
        const novelty = new Novelty();
        // Two seconds at a time: the page works the new windows out at each.
        const every = Math.round(2 * fps);
        let fed = 0;
        for (let i = 0; i + FF_PCM_WINDOW <= d.pcm.length; i += FF_PCM_WINDOW) {
          f.get_allocated_pcm_window(ptr).set(d.pcm.subarray(i, i + FF_PCM_WINDOW));
          f.feed_single_pcm_window(ptr);
          if (++fed % every !== 0 && i + 2 * FF_PCM_WINDOW <= d.pcm.length) continue;
          const values = novelty.of(f.take_features());
          ctx.postMessage({ type: 'novelty', fps, values }, [values.buffer]);
          progress('tempo', i / d.pcm.length);
        }
        ctx.postMessage({ type: 'tempo-done' });
        return;
      }
      if (msg.type === 'transcribe') {
        const duration = await durationOf(msg.audio);
        if (duration === null) { ctx.postMessage({ type: 'failed', reason: 'no_audio' }); return; }
        // Followed whole afterwards: a longer one would be searched for the
        // tune (locate), which a score of the whole recording is not.
        if (duration > LONG_S) { ctx.postMessage({ type: 'too-long', seconds: duration, max: LONG_S }); return; }
        progress('decode', 0);
        const d = await decodeSpan(msg.audio, 0, duration, r => progress('decode', r));
        if (!d) { ctx.postMessage({ type: 'failed', reason: 'no_audio' }); return; }
        progress('listen', 0);
        await engine(); // the module's init
        const written = transcribe(d.pcm, d.rate);
        if (!written) { ctx.postMessage({ type: 'failed', reason: 'no_contour' }); return; }
        ctx.postMessage({ type: 'transcribed', ...written });
        return;
      }
      let from = msg.from;
      let to = msg.to;
      /** The stretch was found by the score: another score may find another. */
      let located = false;
      if (to === null) {
        const duration = await durationOf(msg.audio);
        if (duration === null) { ctx.postMessage({ type: 'failed', reason: 'no_audio' }); return; }
        to = duration;
        if (duration > LONG_S) {
          if (msg.score.length < 2) { ctx.postMessage({ type: 'failed', reason: 'no_contour' }); return; }
          progress('scan', 0);
          const scan = await scanFeatures(msg.audio, await cleanEngine(), r => progress('scan', r));
          if (!scan) { ctx.postMessage({ type: 'failed', reason: 'no_audio' }); return; }
          const zone = locate(scan.features, scan.fps, msg.score, r => progress('locate', r));
          if (!zone) { ctx.postMessage({ type: 'failed', reason: 'no_alignment' }); return; }
          from = zone.from;
          to = Math.min(zone.to, duration);
          located = true;
        }
      }
      const span = { from, to };
      if (msg.features) {
        // Heard already: the tempo and the alignment alone.
        if (msg.score.length < 2 && !msg.settingId) { ctx.postMessage({ type: 'failed', reason: 'no_contour' }); return; }
        const contour = msg.settingId ? await getSettingContour(msg.settingId).catch(() => null) : null;
        if (msg.score.length < 2 && !contour) { ctx.postMessage({ type: 'failed', reason: 'no_contour' }); return; }
        progress('listen', 1);
        const result = alignBest(msg.features.values, msg.features.fps, msg.score, contour, progress);
        if (!result) { ctx.postMessage({ type: 'failed', reason: 'no_alignment' }); return; }
        ctx.postMessage({ type: 'followed', result, heard: msg.features }, [msg.features.values.buffer]);
        return;
      }
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
        decoding, cleanEngine(),
        msg.settingId ? getSettingContour(msg.settingId).catch(() => null) : Promise.resolve(null),
      ]);
      if (msg.score.length < 2 && !contour) { ctx.postMessage({ type: 'failed', reason: 'no_contour' }); return; }
      if (!decoded) { ctx.postMessage({ type: 'failed', reason: 'no_audio' }); return; }

      setCleanRate(f, decoded.rate);
      f.flush_pcm_buffer();
      const { pcm } = decoded;
      const n = Math.floor(pcm.length / FF_PCM_WINDOW);
      for (let i = 0; i < n; i++) {
        f.get_allocated_pcm_window(ptrClean).set(pcm.subarray(i * FF_PCM_WINDOW, (i + 1) * FF_PCM_WINDOW));
        f.feed_single_pcm_window(ptrClean);
        if ((i & 127) === 0) progress('listen', i / n);
      }
      const fps = decoded.rate / FF_PCM_WINDOW;
      const features = takeClean(f, fps);
      progress('listen', 1);
      const result = alignBest(features, fps, msg.score, contour, progress);
      if (!result) { ctx.postMessage({ type: 'failed', reason: 'no_alignment' }); return; }
      if (located) ctx.postMessage({ type: 'followed', result });
      // Copied, not transferred: a few MB, and whether the engine's array
      // owns its buffer is wasm-bindgen's business.
      else ctx.postMessage({ type: 'followed', result, heard: { values: features, fps } });
    } catch (err) {
      ctx.postMessage({ type: 'error', message: String(err) });
    }
  })();
};
