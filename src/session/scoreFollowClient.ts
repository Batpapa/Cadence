import type { FollowResult } from './scoreFollow';
import type { ScoreFollowRequest, ScoreFollowResponse, FollowFailure } from './recognition/scoreFollowWorker';

export type { FollowFailure } from './recognition/scoreFollowWorker';

// ── Following a detection's score in its recording ───────────────────────────
// Main-thread half of score following (scoreFollow.ts): hands the recording
// and the detection's range to the worker, which does everything else, and
// gives back the alignment in SESSION time. The main thread stays free for
// what the user is doing meanwhile — listening, with the score on screen.

/** Seconds read on each side of the detection: its bounds are a window's
 *  guess, and the aligner has a "not this tune" state for what is outside. */
const MARGIN_S = 3;

/** Session time of the decoded stretch's start — the alignment's and the
 *  player's time 0 — for a detection starting at `start`. */
export function followFrom(start: number): number {
  return Math.max(0, start - MARGIN_S);
}

/** Session time where the decoded stretch ends, for a detection ending at
 *  `end`. */
export function followTo(end: number): number {
  return end + MARGIN_S;
}

/** The audio a follow reads: the whole recording (`start` 0), or — when it is
 *  only on Drive — the stretch the follow needs, fetched on its own, `start`
 *  being the session time of its own time 0. */
export interface FollowAudio { blob: Blob; start: number }

export interface SessionFollow extends FollowResult {
  /** Session time of the alignment's time 0. */
  from: number;
}

/** Where the work is, for the waiting screen. `ratio` is the whole job's,
 *  from 0 to 1, weighted by what each step costs. */
export type FollowStage = 'decode' | 'listen' | 'tempo' | 'align';
export interface FollowStatus { stage: FollowStage; ratio: number }

// Share of the whole each step takes, in order — measured 2026-10-28.
const WEIGHTS: Record<FollowStage, [number, number]> = {
  decode: [0, 0.35],
  listen: [0.35, 0.55],
  tempo: [0.55, 0.8],
  align: [0.8, 1],
};
const overall = (stage: FollowStage, r: number) => WEIGHTS[stage][0] + (WEIGHTS[stage][1] - WEIGHTS[stage][0]) * Math.min(1, Math.max(0, r));

/** The stretch the alignment was made on, as the player gets it: mono, at
 *  the recording's own rate, starting at the alignment's time 0. */
export interface FollowSamples { pcm: Float32Array; rate: number }

/** Alignments already made in this page, so a tune reopened is followed at
 *  once. Keyed by what decides the result: the recording (by size — one
 *  session's audio does not change), the score and the detection's bounds.
 *  The samples are kept for the last one only: a few tens of MB each. */
const done = new Map<string, SessionFollow>();
let lastSamples: { key: string; samples: FollowSamples } | null = null;

/** Where `score` — one MIDI pitch per quaver of a pass (syncedScore.tsx's
 *  scoreContour) — is played in [start, end] of `audio`; or `settingId`'s
 *  index contour, when that fits the recording better (the worker's header). `onSamples` gets the
 *  stretch as soon as it is decoded, before the alignment is done — for
 *  playing it meanwhile. `signal` stops the worker — the score closed before
 *  it was done: on a phone, seconds of work nobody will see. The promise then
 *  never settles. */
export function followDetection(
  audio: FollowAudio, score: number[], settingId: string | undefined, start: number, end: number,
  onStatus: (s: FollowStatus) => void = () => {},
  signal?: AbortSignal,
  onSamples: (s: FollowSamples) => void = () => {},
): Promise<SessionFollow | FollowFailure> {
  const key = `${audio.blob.size}@${audio.start}|${score.join('.')}|${settingId ?? ''}|${start.toFixed(3)}|${end.toFixed(3)}`;
  const known = done.get(key);
  if (known && lastSamples?.key === key) {
    onSamples(lastSamples.samples);
    return Promise.resolve(known);
  }
  const from = followFrom(start);
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./recognition/scoreFollowWorker.ts', import.meta.url), { type: 'module' });
    signal?.addEventListener('abort', () => worker.terminate(), { once: true });
    worker.onmessage = (e: MessageEvent<ScoreFollowResponse>) => {
      const msg = e.data;
      if (msg.type === 'progress') { onStatus({ stage: msg.stage, ratio: overall(msg.stage, msg.ratio) }); return; }
      if (msg.type === 'decoded') {
        const samples = { pcm: msg.pcm, rate: msg.rate };
        lastSamples = { key, samples };
        onSamples(samples);
        return;
      }
      worker.terminate();
      if (msg.type === 'followed') {
        const follow = { ...msg.result, from };
        done.set(key, follow);
        resolve(follow);
      } else if (msg.type === 'failed') resolve(msg.reason);
      else reject(new Error(msg.message));
    };
    worker.onerror = (e) => { worker.terminate(); reject(new Error(e.message)); };
    // In the audio's own time: a passage fetched from Drive starts at `from`.
    // The alignment's time 0 stays `from` either way.
    worker.postMessage({
      type: 'follow', audio: audio.blob, score, settingId,
      from: Math.max(0, from - audio.start), to: followTo(end) - audio.start,
    } satisfies ScoreFollowRequest);
  });
}
