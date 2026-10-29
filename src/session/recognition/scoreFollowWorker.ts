import init, { FolkFriendWASM } from '../../../vendor/folkfriend/folkfriend.js';
import { followScore, contourToMidi, type FollowResult } from '../scoreFollow';
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

export type FollowFailure = 'no_contour' | 'no_audio' | 'no_alignment';
/** `score`: one MIDI pitch per quaver of a pass of the tune, as drawn.
 *  `settingId`: the TheSession setting it is, whose index contour competes. */
export type ScoreFollowRequest = { type: 'follow'; audio: Blob; score: number[]; settingId?: string; from: number; to: number };
export type ScoreFollowResponse =
  | { type: 'progress'; stage: 'decode' | 'listen' | 'tempo' | 'align'; ratio: number }
  /** The stretch, mono, at its own rate — sent before the alignment is done. */
  | { type: 'decoded'; pcm: Float32Array; rate: number }
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

/** At most this often — a message per frame would cost more than the work. */
const PROGRESS_EVERY_MS = 80;

ctx.onmessage = (e) => {
  const msg = e.data;
  if (msg.type !== 'follow') return;
  void (async () => {
    try {
      let last = 0;
      const progress = (stage: 'decode' | 'listen' | 'tempo' | 'align', ratio: number) => {
        const now = performance.now();
        if (now - last < PROGRESS_EVERY_MS && ratio < 1) return;
        last = now;
        ctx.postMessage({ type: 'progress', stage, ratio });
      };
      progress('decode', 0);
      // The samples go back to the page the moment they are decoded — the
      // player plays them while the alignment runs, and the cursor then
      // follows the very samples it was aligned on, to the sample. A copy:
      // this side still needs them.
      const decoding = decodeSpan(msg.audio, msg.from, msg.to, r => progress('decode', r)).then((d) => {
        if (d) {
          const copy = d.pcm.slice();
          ctx.postMessage({ type: 'decoded', pcm: copy, rate: d.rate }, [copy.buffer]);
        }
        return d;
      });
      if (msg.score.length < 2) { ctx.postMessage({ type: 'failed', reason: 'no_contour' }); return; }
      const [decoded, f, contour] = await Promise.all([
        decoding, engine(),
        msg.settingId ? getSettingContour(msg.settingId).catch(() => null) : Promise.resolve(null),
      ]);
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
      const scores = [msg.score, ...(contour ? [contourToMidi(contour)] : [])];
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
