import type { FollowResult } from './scoreFollow';
import type { ScoreFollowRequest, ScoreFollowResponse, FollowFailure, FollowStage } from './recognition/scoreFollowWorker';

export type { FollowFailure } from './recognition/scoreFollowWorker';

// ── Following a score in its recording ───────────────────────────────────────
// Main-thread half of score following (scoreFollow.ts): hands the recording
// and where the tune is — a detection's range, or anywhere in it for a card's
// recording — to the worker, which does everything else, and gives back the
// alignment in the recording's time (a session's, for a detection). The main
// thread stays free for what the user is doing meanwhile — listening, with
// the score on screen.

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
 *  being the session time of its own time 0. `id`: which recording, where
 *  several can be followed (a card's attachments) — two of one size are not
 *  the same one. */
export interface FollowAudio { blob: Blob; start: number; id?: string }

/** Where the tune is: a detection's range, in session time — or null, anywhere
 *  in the recording (a card's). */
type FollowRange = { start: number; end: number } | null;

export interface SessionFollow extends FollowResult {
  /** Session time of the alignment's time 0. */
  from: number;
  /** Seconds of recording the alignment was made over. */
  seconds: number;
}

/** Where the work is, for the waiting screen. `ratio` is the whole job's,
 *  from 0 to 1, weighted by what each step costs. */
export interface FollowStatus { stage: FollowStage; ratio: number }

// Share of the whole each step takes, in order — measured 2026-10-28. A long
// recording is first scanned and searched for the tune (scoreFollowWorker),
// which then dwarfs the rest.
const WEIGHTS: Record<FollowStage, [number, number]> = {
  scan: [0, 0],
  locate: [0, 0],
  decode: [0, 0.35],
  listen: [0.35, 0.55],
  tempo: [0.55, 0.8],
  align: [0.8, 1],
};
const WEIGHTS_LONG: Record<FollowStage, [number, number]> = {
  scan: [0, 0.35],
  locate: [0.35, 0.8],
  decode: [0.8, 0.85],
  listen: [0.85, 0.88],
  tempo: [0.88, 0.95],
  align: [0.95, 1],
};
const overall = (weights: Record<FollowStage, [number, number]>, stage: FollowStage, r: number) =>
  weights[stage][0] + (weights[stage][1] - weights[stage][0]) * Math.min(1, Math.max(0, r));

/** The stretch the alignment was made on, as the player gets it: mono, at
 *  the recording's own rate, starting at the alignment's time 0. */
/** `from`: where the samples start in the recording, in seconds — the
 *  session's time for a detection's passage. */
export interface FollowSamples { pcm: Float32Array; rate: number; from: number }

/** Alignments already made in this page, so a tune reopened is followed at
 *  once. Keyed by what decides the result: the recording (by size — one
 *  session's audio does not change — and its id when it has one), the score
 *  and where the tune is. With the stretch they were made on, in the
 *  recording's own time, to decode it again: the samples are kept for the
 *  last one only — a few tens of MB each. */
const done = new Map<string, { follow: SessionFollow; from: number; to: number }>();
let lastSamples: { key: string; samples: FollowSamples } | null = null;

/** Where `score` — one MIDI pitch per quaver of a pass (syncedScore.tsx's
 *  scoreContour) — is played in `range` of `audio`, or anywhere in it; or
 *  `settingId`'s index contour, when that fits the recording better (the
 *  worker's header). `onSamples` gets the stretch as soon as it is decoded,
 *  before the alignment is done — for playing it meanwhile; without it, a
 *  known alignment is answered as it is (a card's recordings compared).
 *  `signal` stops the worker — the score closed before it was done: on a
 *  phone, seconds of work nobody will see. The promise then never settles. */
export function followAudio(
  audio: FollowAudio, score: number[], settingId: string | undefined, range: FollowRange,
  onStatus: (s: FollowStatus) => void = () => {},
  signal?: AbortSignal,
  onSamples?: (s: FollowSamples) => void,
): Promise<SessionFollow | FollowFailure> {
  const where = range ? `${range.start.toFixed(3)}|${range.end.toFixed(3)}` : 'all';
  const key = `${audio.id ?? ''}|${audio.blob.size}@${audio.start}|${score.join('.')}|${settingId ?? ''}|${where}`;
  const known = done.get(key);
  if (known && (!onSamples || lastSamples?.key === key)) {
    if (onSamples) onSamples(lastSamples!.samples);
    return Promise.resolve(known.follow);
  }
  // Known, but not its samples: decoded again — the quick part of the work.
  const request: ScoreFollowRequest = known
    ? { type: 'decode', audio: audio.blob, from: known.from, to: known.to }
    // In the audio's own time: a passage fetched from Drive starts at `from`.
    // The alignment's time 0 stays `from` either way.
    : range
      ? { type: 'follow', audio: audio.blob, score, settingId, from: Math.max(0, followFrom(range.start) - audio.start), to: followTo(range.end) - audio.start }
      : { type: 'follow', audio: audio.blob, score, settingId, from: 0, to: null };
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./recognition/scoreFollowWorker.ts', import.meta.url), { type: 'module' });
    signal?.addEventListener('abort', () => worker.terminate(), { once: true });
    let weights = WEIGHTS;
    let span: { from: number; to: number; seconds: number } | null = null;
    worker.onmessage = (e: MessageEvent<ScoreFollowResponse>) => {
      const msg = e.data;
      if (msg.type === 'progress') {
        if (msg.stage === 'scan' || msg.stage === 'locate') weights = WEIGHTS_LONG;
        onStatus({ stage: msg.stage, ratio: overall(weights, msg.stage, msg.ratio) });
        return;
      }
      if (msg.type === 'decoded') {
        const samples = { pcm: msg.pcm, rate: msg.rate, from: audio.start + msg.from };
        span = { from: msg.from, to: msg.to, seconds: msg.pcm.length / msg.rate };
        lastSamples = { key, samples };
        onSamples?.(samples);
        if (known) { worker.terminate(); resolve(known.follow); }
        return;
      }
      worker.terminate();
      if (msg.type === 'followed') {
        // The 'decoded' message always comes first: the worker sends it
        // before it starts on the alignment.
        const at = span ?? { from: request.from, to: request.from, seconds: 0 };
        const follow = { ...msg.result, from: audio.start + at.from, seconds: at.seconds };
        done.set(key, { follow, from: at.from, to: at.to });
        resolve(follow);
      } else if (msg.type === 'failed') resolve(msg.reason);
      else reject(new Error(msg.message));
    };
    worker.onerror = (e) => { worker.terminate(); reject(new Error(e.message)); };
    worker.postMessage(request);
  });
}

/** The alignment alone of `score` — or of `settingId`'s index contour only,
 *  `score` empty — over [from, to) of `audio`, in its seconds: no samples
 *  sent back, nothing kept here. For a detection's bounds (boundSuggest.ts),
 *  which nobody listens to through this. `signal` as followAudio's. */
export function followSpan(
  audio: Blob, score: number[], settingId: string | undefined, from: number, to: number,
  signal?: AbortSignal,
): Promise<SessionFollow | FollowFailure> {
  const request: ScoreFollowRequest = { type: 'follow', audio, score, settingId, from, to, samples: false };
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./recognition/scoreFollowWorker.ts', import.meta.url), { type: 'module' });
    signal?.addEventListener('abort', () => worker.terminate(), { once: true });
    worker.onmessage = (e: MessageEvent<ScoreFollowResponse>) => {
      const msg = e.data;
      if (msg.type === 'progress' || msg.type === 'decoded') return;
      worker.terminate();
      if (msg.type === 'followed') resolve({ ...msg.result, from, seconds: to - from });
      else if (msg.type === 'failed') resolve(msg.reason);
      else reject(new Error(msg.message));
    };
    worker.onerror = (e) => { worker.terminate(); reject(new Error(e.message)); };
    worker.postMessage(request);
  });
}
