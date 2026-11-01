import { VersionWatch, TAP_STRIDE, versionMerge } from '../liveFollow';

// ── Play-along: which version is being played ────────────────────────────────
// Every version of the score viewer's file followed side by side
// (VersionWatch), on the frames the Play-along's worker computes anyway — it
// posts them here in batches (liveFollowWorker.ts, `tap`). A worker of its
// own: ten versions cost several times the follower drawing the cursor, which
// must never wait for them.

export type VersionWatchRequest =
  /** `scores`: every version as LiveFollower takes one; `shown`: the one on
   *  screen; `fps`: the frames' rate; `port`: where the frames arrive. */
  | { type: 'start'; scores: number[][]; shown: number; fps: number; port: MessagePort }
  | { type: 'shown'; shown: number }
  | { type: 'mute'; version: number };

export type VersionWatchResponse = { type: 'offer'; version: number | null };

/** On the tap: frames one after the other, each its MIDI_NUM pitch energies
 *  then its level. */
export interface FrameBatch { frames: Float32Array }

interface WorkerScope {
  postMessage(msg: VersionWatchResponse): void;
  onmessage: ((e: MessageEvent<VersionWatchRequest>) => void) | null;
}
const ctx = self as unknown as WorkerScope;

let watch: VersionWatch | null = null;
let offered: number | null = null;

ctx.onmessage = (e) => {
  const msg = e.data;
  if (msg.type === 'start') {
    watch = new VersionWatch(msg.scores, msg.shown, { fps: msg.fps, merge: versionMerge(msg.scores.length) });
    msg.port.onmessage = (ev: MessageEvent<FrameBatch>) => {
      if (!watch) return;
      const f = ev.data.frames;
      let o = offered;
      for (let at = 0; at + TAP_STRIDE <= f.length; at += TAP_STRIDE) {
        o = watch.push(f.subarray(at, at + TAP_STRIDE - 1), f[at + TAP_STRIDE - 1]);
      }
      if (o !== offered) { offered = o; ctx.postMessage({ type: 'offer', version: o }); }
    };
  } else if (msg.type === 'shown') {
    watch?.setShown(msg.shown);
    offered = null;
  } else if (msg.type === 'mute') {
    watch?.mute(msg.version);
    if (offered === msg.version) offered = null;
  }
};

