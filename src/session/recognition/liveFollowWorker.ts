import init, { FolkFriendWASM } from '../../../vendor/folkfriend/folkfriend.js';
import { LiveFollower, TAP_STRIDE, type LiveEstimate } from '../liveFollow';
import { FF_PCM_WINDOW } from '../sessionConfig';
import type { StampedChunk } from '../audio/pcmWorklet';
import type { FrameBatch } from './versionWatchWorker';

// ── Play-along worker ────────────────────────────────────────────────────────
// The microphone, one FolkFriend window at a time (the stamped worklet posts
// exactly that, straight here), through the engine's features into the live
// follower — each window's estimate posted to the page, which carries it to
// the moment it draws (playAlongClient.ts). The engine has no tune index: the
// score is given, as for the recording's alignment (scoreFollowWorker.ts).
//
// What was heard is kept — features and levels, not the sound — for the
// developer's download: a run that went wrong replays in the bench
// (experiments/score-follow/live.mjs) with the same follower.

export type LiveFollowRequest =
  /** `rate`: the context's sample rate. `port`: where the worklet's chunks
   *  arrive — dropped until there is a score. */
  | { type: 'start'; rate: number; port: MessagePort }
  /** What to follow, one MIDI pitch per quaver of a pass, as drawn: from
   *  scratch, the follower's clock starting at the next chunk — and what was
   *  kept for the download with it, a take being of one score. */
  | { type: 'score'; score: number[] }
  | { type: 'dump' }
  /** Where every frame's features and level go too, in batches: the
   *  versions' watch (versionWatchWorker.ts). */
  | { type: 'tap'; port: MessagePort };

export type LiveFollowResponse =
  /** `origin`: the context's sample frame of the first sample followed —
   *  the follower's clock starts there. */
  | { type: 'estimate'; estimate: LiveEstimate; origin: number; frames: number }
  | { type: 'dump'; features: Float32Array; levels: Float32Array; rate: number; score: number[]; origin: number }
  | { type: 'error'; message: string };

interface WorkerScope {
  postMessage(msg: LiveFollowResponse, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent<LiveFollowRequest>) => void) | null;
}
const ctx = self as unknown as WorkerScope;

const MIDI_NUM = 48;
/** What is kept for the download: twenty minutes, about 11 MB. */
const KEEP_FRAMES = Math.round(20 * 60 * (48000 / FF_PCM_WINDOW));

let ff: FolkFriendWASM | null = null;
let ptr = 0;
let follower: LiveFollower | null = null;
let score: number[] = [];
let rate = 48000;
let origin = -1;
let frames = 0;
const kept: { features: Float32Array[]; levels: number[] } = { features: [], levels: [] };
/** The versions' watch, and the frames not posted to it yet. */
let tap: MessagePort | null = null;
const TAP_BATCH = 8;
let tapped = new Float32Array(TAP_BATCH * TAP_STRIDE);
let tapN = 0;
/** Samples waiting for a window to fill, should a chunk not be one. */
let pending = new Float32Array(0);

/** Following `s` from the next chunk on. */
function follow(s: number[]): void {
  follower = new LiveFollower(s, { fps: rate / FF_PCM_WINDOW });
  origin = -1;
  frames = 0;
  kept.features = [];
  kept.levels = [];
  pending = new Float32Array(0);
  ff?.flush_pcm_buffer();
}

function onChunk(chunk: StampedChunk): void {
  if (!ff || !follower) return;
  if (origin < 0) origin = chunk.end - chunk.pcm.length;
  let pcm = chunk.pcm;
  if (pending.length) {
    const joined = new Float32Array(pending.length + pcm.length);
    joined.set(pending);
    joined.set(pcm, pending.length);
    pcm = joined;
  }
  let at = 0;
  for (; at + FF_PCM_WINDOW <= pcm.length; at += FF_PCM_WINDOW) {
    const win = pcm.subarray(at, at + FF_PCM_WINDOW);
    let level = 0;
    for (let i = 0; i < win.length; i++) level += win[i]! * win[i]!;
    level /= win.length;
    ff.get_allocated_pcm_window(ptr).set(win);
    ff.feed_single_pcm_window(ptr);
    const features = ff.take_features();
    if (features.length < MIDI_NUM) continue;
    const frame = features.subarray(0, MIDI_NUM);
    const estimate = follower.push(frame, level);
    frames++;
    if (kept.levels.length < KEEP_FRAMES) { kept.features.push(frame.slice()); kept.levels.push(level); }
    if (tap) {
      tapped.set(frame, tapN * TAP_STRIDE);
      tapped[tapN * TAP_STRIDE + MIDI_NUM] = level;
      if (++tapN === TAP_BATCH) {
        const batch: FrameBatch = { frames: tapped };
        tap.postMessage(batch, [tapped.buffer]);
        tapped = new Float32Array(TAP_BATCH * TAP_STRIDE);
        tapN = 0;
      }
    }
    ctx.postMessage({ type: 'estimate', estimate, origin, frames });
  }
  pending = pcm.slice(at);
}

ctx.onmessage = (e) => {
  const msg = e.data;
  if (msg.type === 'start') {
    void (async () => {
      try {
        await init(new URL('../../../vendor/folkfriend/folkfriend_bg.wasm', import.meta.url));
        ff = new FolkFriendWASM();
        ptr = ff.alloc_single_pcm_window();
        rate = msg.rate;
        ff.set_sample_rate(rate);
        ff.flush_pcm_buffer();
        if (score.length) follow(score);
        // Out of the try above, an error here went up to the page uncaught
        // (ffWorker.ts's live path, 2026-11-02). Said once: an engine that
        // failed is not fed again.
        let failed = false;
        msg.port.onmessage = (ev: MessageEvent<StampedChunk>) => {
          if (failed) return;
          try {
            onChunk(ev.data);
          } catch (err) {
            failed = true;
            ctx.postMessage({ type: 'error', message: err instanceof Error ? err.stack ?? err.message : String(err) });
          }
        };
      } catch (err) {
        ctx.postMessage({ type: 'error', message: String(err) });
      }
    })();
  } else if (msg.type === 'score') {
    score = msg.score;
    // Before the engine is ready, `start` takes it from here.
    if (ff) follow(score);
  } else if (msg.type === 'tap') {
    tap = msg.port;
    tapN = 0;
  } else if (msg.type === 'dump') {
    const features = new Float32Array(kept.features.length * MIDI_NUM);
    kept.features.forEach((f, k) => features.set(f, k * MIDI_NUM));
    const levels = Float32Array.from(kept.levels);
    ctx.postMessage({ type: 'dump', features, levels, rate, score, origin }, [features.buffer, levels.buffer]);
  }
};
