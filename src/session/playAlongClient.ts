import { LiveCursor, type LiveEstimate } from './liveFollow';
import type { LiveFollowRequest, LiveFollowResponse } from './recognition/liveFollowWorker';
import { attachStampedPcmWorklet } from './audio/pcmWorklet';
import { openMicForMusic, openDeviceAudio, WakeLockManager } from './audio/capture';
import { beginCaptureSession, endCaptureSession } from '../services/audioSession';
import { ANALYSIS_SAMPLE_RATE, FF_PCM_WINDOW, FF_SAMPLE_RATE_MIN, FF_SAMPLE_RATE_MAX } from './sessionConfig';

// ── Play-along: the score following what is being played, live ──────────────
// Developer mode only for now (2026-10-31, the user). The microphone — or, on
// a computer, a tab's sound, to try it on a video — through a worklet posting
// one FolkFriend window at a time, stamped on the context's clock, to the
// live follower's worker (liveFollowWorker.ts). Its estimates come back late:
// by the microphone's latency, the window, the follower's lag. The page
// carries each to the moment it draws (LiveCursor): what the microphone hears
// NOW is the sample the context will label
//     its time now + the output's latency + the input's,
// as a sample captured is output, in a pass-through, at the time it is
// labelled with — so the round trip is the two latencies. The browser says
// the output's (`outputLatency`); Chrome says the input's
// (`getSettings().latency`); the rest is the developer's offset, kept on the
// device, and one frame of the screen's.

export type PlayAlongSource = 'mic' | 'tab';

/** What the diagnostic line shows. */
export interface PlayAlongStatus {
  estimate: LiveEstimate | null;
  /** Seconds. Input: null when the browser does not say. */
  inputLatency: number | null;
  outputLatency: number;
  /** How far ahead of the last frame heard the cursor is drawn, seconds. */
  horizon: number | null;
  rate: number;
}

export interface PlayAlong {
  /** What to follow: one MIDI pitch per quaver of a pass, as drawn — again
   *  for another version, the source kept. */
  setScore(score: number[]): void;
  /** Where the music is now: a quaver of one pass with its fraction, or
   *  null — read by the score at every frame. */
  position(): number | null;
  status(): PlayAlongStatus;
  /** What was heard, for the bench: JSON. */
  dump(): Promise<Blob>;
  stop(): void;
}

/** One frame of the screen: what is drawn now is seen at the next. */
const DISPLAY_S = 1 / 60;

const OFFSET_KEY = 'cadence_play_along_offset_ms';

/** Read once: the cursor asks at every frame. */
let offsetMs: number | null = null;

/** The developer's own correction of the cursor's lead, in ms: per device,
 *  as the latencies it makes up for are. */
export function playAlongOffset(): number {
  if (offsetMs !== null) return offsetMs;
  try {
    const v = Number(localStorage.getItem(OFFSET_KEY));
    offsetMs = Number.isFinite(v) ? v : 0;
  } catch {
    offsetMs = 0;
  }
  return offsetMs;
}

export function setPlayAlongOffset(ms: number): void {
  offsetMs = Math.round(ms);
  try {
    // Absent rather than stored at 0, like the other device prefs.
    if (ms) localStorage.setItem(OFFSET_KEY, String(Math.round(ms)));
    else localStorage.removeItem(OFFSET_KEY);
  } catch { /* private mode: it lasts as long as the page */ }
}

/** Starts listening to `source` — following nothing until `setScore`.
 *  Call it from the tap: the microphone and a tab's
 *  sound are asked for before anything is awaited — a tab's must be, and an
 *  iPhone's audio session must allow recording first. `onEnded`: the source
 *  went (a tab's sharing stopped from the browser's own bar). */
export async function startPlayAlong(source: PlayAlongSource, onEnded: () => void): Promise<PlayAlong> {
  if (source === 'mic') beginCaptureSession();
  const opening = source === 'mic' ? openMicForMusic() : openDeviceAudio();
  let stream: MediaStream;
  try {
    stream = await opening;
  } catch (err) {
    if (source === 'mic') endCaptureSession();
    throw err;
  }
  let ctx = new AudioContext();
  // FolkFriend refuses a rate outside its range (sources.ts): such a device
  // gets a 48 kHz context, which the browser resamples into.
  if (ctx.sampleRate < FF_SAMPLE_RATE_MIN || ctx.sampleRate > FF_SAMPLE_RATE_MAX) {
    void ctx.close().catch(() => { /* never started */ });
    ctx = new AudioContext({ sampleRate: ANALYSIS_SAMPLE_RATE });
  }
  if (ctx.state === 'suspended') await ctx.resume().catch(() => { /* the next tap will */ });
  const rate = ctx.sampleRate;
  const track = stream.getAudioTracks()[0];
  const settings = (track?.getSettings?.() ?? {}) as MediaTrackSettings & { latency?: number };
  const inputLatency = typeof settings.latency === 'number' && settings.latency >= 0 ? settings.latency : null;

  const worker = new Worker(new URL('./recognition/liveFollowWorker.ts', import.meta.url), { type: 'module' });
  const channel = new MessageChannel();
  let cursor: LiveCursor | null = null;
  let last: { estimate: LiveEstimate; origin: number; frames: number } | null = null;
  let dumpWaiter: ((r: Extract<LiveFollowResponse, { type: 'dump' }>) => void) | null = null;
  worker.onmessage = (e: MessageEvent<LiveFollowResponse>) => {
    const msg = e.data;
    if (msg.type === 'estimate') {
      last = msg;
      cursor?.update(msg.estimate);
    } else if (msg.type === 'dump') {
      dumpWaiter?.(msg);
      dumpWaiter = null;
    } else {
      console.error('[play-along]', msg.message);
    }
  };
  const start: LiveFollowRequest = { type: 'start', rate, port: channel.port2 };
  worker.postMessage(start, [channel.port2]);

  const input = ctx.createMediaStreamSource(stream);
  const node = await attachStampedPcmWorklet(ctx, input, channel.port1, FF_PCM_WINDOW);
  const wake = new WakeLockManager();
  void wake.start();

  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    try { input.disconnect(); node.disconnect(); } catch { /* already gone */ }
    stream.getTracks().forEach(trk => trk.stop());
    void ctx.close().catch(() => { /* closing */ });
    worker.terminate();
    wake.stop();
    if (source === 'mic') endCaptureSession();
  };
  track?.addEventListener('ended', () => { if (!stopped) { stop(); onEnded(); } });

  const outputLatency = () => ctx.outputLatency || 0;
  /** The context's label of the sample the microphone hears now (above). */
  const heardNow = (): number => {
    const ts = typeof ctx.getOutputTimestamp === 'function' ? ctx.getOutputTimestamp() : null;
    const base = ts && ts.contextTime !== undefined && ts.performanceTime
      ? ts.contextTime + (performance.now() - ts.performanceTime) / 1000 + outputLatency()
      // Without it, the time being rendered — the output's latency is then
      // already behind us.
      : ctx.currentTime;
    return base + (inputLatency ?? 0);
  };
  /** That moment, plus the screen's frame and the offset, on the follower's
   *  clock (seconds from its first sample). */
  const musicNow = (): number | null => {
    if (!last) return null;
    return heardNow() + DISPLAY_S + playAlongOffset() / 1000 - last.origin / rate;
  };

  return {
    setScore: (score) => {
      cursor = new LiveCursor(score.length);
      last = null;
      const req: LiveFollowRequest = { type: 'score', score };
      worker.postMessage(req);
    },
    position: () => {
      const now = musicNow();
      return now === null || !cursor ? null : cursor.position(now);
    },
    status: () => {
      const now = musicNow();
      return {
        estimate: last?.estimate ?? null,
        inputLatency,
        outputLatency: outputLatency(),
        horizon: now === null || !last ? null : now - (last.frames * FF_PCM_WINDOW) / rate,
        rate,
      };
    },
    dump: () => new Promise<Blob>((resolve) => {
      dumpWaiter = (r) => {
        const b64 = (a: Float32Array) => {
          const bytes = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
          let s = '';
          for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
          return btoa(s);
        };
        resolve(new Blob([JSON.stringify({
          kind: 'cadence-play-along', version: 1, rate: r.rate, score: r.score, origin: r.origin,
          frames: r.levels.length, inputLatency, outputLatency: outputLatency(), offsetMs: playAlongOffset(),
          userAgent: navigator.userAgent,
          // Little-endian Float32, base64: frames × 48 pitch energies, and
          // each frame's mean square.
          features: b64(r.features), levels: b64(r.levels),
        })], { type: 'application/json' }));
      };
      const req: LiveFollowRequest = { type: 'dump' };
      worker.postMessage(req);
    }),
    stop,
  };
}
