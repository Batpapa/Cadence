import { LiveCursor, type LiveEstimate } from './liveFollow';
import type { LiveFollowRequest, LiveFollowResponse } from './recognition/liveFollowWorker';
import type { VersionWatchRequest, VersionWatchResponse } from './recognition/versionWatchWorker';
import { attachStampedPcmWorklet } from './audio/pcmWorklet';
import { openMicForMusic, WakeLockManager } from './audio/capture';
import { beginCaptureSession, endCaptureSession } from '../services/audioSession';
import { MemoryRecorder } from '../thesessionEmbed/memoryRecorder';
import { ANALYSIS_SAMPLE_RATE, FF_PCM_WINDOW, FF_SAMPLE_RATE_MIN, FF_SAMPLE_RATE_MAX } from './sessionConfig';

// ── Play-along: the score following what is being played, live ──────────────
// Since 2026-10-31 (the user; out of developer mode 2026-11-01). The microphone
// — its only source since then: a tab's sound, offered to the developer to
// try it on a video, is gone — through a worklet posting
// one FolkFriend window at a time, stamped on the context's clock, to the
// live follower's worker (liveFollowWorker.ts). Its estimates come back late:
// by the microphone's latency, the window, the follower's lag. The page
// carries each to the moment it draws (LiveCursor): what the microphone hears
// NOW is the sample the context will label
//     its time now + the output's latency + the input's,
// as a sample captured is output, in a pass-through, at the time it is
// labelled with — so the round trip is the two latencies. The browser says
// the output's (`outputLatency`); Chrome says the input's
// (`getSettings().latency`); the rest is the capture latency set by hand, kept on the
// device, and one frame of the screen's.

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
  /** Every version of the file followed too, to tell which one is being
   *  played (versionWatchWorker.ts): `onOffer` hears the one offered in
   *  place of `shown`, or null. Again replaces the watch before. */
  watchVersions(scores: number[][], shown: number, onOffer: (version: number | null) => void): VersionWatchHandle;
  /** A take of what the microphone hears, started now (2026-11-01, the
   *  user: the take kept on the card) — held in memory, on the stream the
   *  follower listens to: no second microphone. It ends with the source. */
  recordTake(): MemoryRecorder;
  /** How loud the microphone is now, 0-1 — the take's level meter, scaled as
   *  the analyser's own (MicSource.getLevel). */
  level(): number;
  /** What was heard, for the bench: JSON. */
  dump(): Promise<Blob>;
  stop(): void;
}

export interface VersionWatchHandle {
  /** Another version on screen. */
  setShown(shown: number): void;
  /** Turned down: not offered again. */
  mute(version: number): void;
  stop(): void;
}

/** One frame of the screen: what is drawn now is seen at the next. */
const DISPLAY_S = 1 / 60;

const OFFSET_KEY = 'cadence_play_along_offset_ms';

/** Read once: the cursor asks at every frame. */
let offsetMs: number | null = null;

/** The capture latency set by hand — the correction of the cursor's lead,
 *  in ms: per device and for all its users (2026-11-01, the user),
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

/** Starts listening to the microphone — following nothing until
 *  `setScore`. Call it from the tap: it is asked for before anything is
 *  awaited — an iPhone's audio session must allow recording first.
 *  `onEnded`: the microphone went (unplugged, taken by the system). */
export async function startPlayAlong(onEnded: () => void): Promise<PlayAlong> {
  beginCaptureSession();
  const opening = openMicForMusic();
  let stream: MediaStream;
  try {
    stream = await opening;
  } catch (err) {
    endCaptureSession();
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
  // Handled here, not left to reach the page (recognitionClient.ts).
  worker.onerror = (e) => { e.preventDefault(); console.error('[play-along]', e.message); };
  const start: LiveFollowRequest = { type: 'start', rate, port: channel.port2 };
  worker.postMessage(start, [channel.port2]);

  const input = ctx.createMediaStreamSource(stream);
  const node = await attachStampedPcmWorklet(ctx, input, channel.port1, FF_PCM_WINDOW);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  input.connect(analyser);
  const levelData = new Uint8Array(analyser.fftSize);
  const wake = new WakeLockManager();
  void wake.start();

  let watcher: Worker | null = null;
  const stopWatch = () => { watcher?.terminate(); watcher = null; };

  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    stopWatch();
    try { input.disconnect(); node.disconnect(); analyser.disconnect(); } catch { /* already gone */ }
    stream.getTracks().forEach(trk => trk.stop());
    void ctx.close().catch(() => { /* closing */ });
    worker.terminate();
    wake.stop();
    endCaptureSession();
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
    watchVersions: (scores, shown, onOffer) => {
      stopWatch();
      const w = new Worker(new URL('./recognition/versionWatchWorker.ts', import.meta.url), { type: 'module' });
      watcher = w;
      const ch = new MessageChannel();
      w.onmessage = (e: MessageEvent<VersionWatchResponse>) => { if (watcher === w) onOffer(e.data.version); };
      w.onerror = (e) => { e.preventDefault(); console.error('[play-along] version watch', e.message); };
      const post = (req: VersionWatchRequest, transfer: Transferable[] = []) => w.postMessage(req, transfer);
      post({ type: 'start', scores, shown, fps: rate / FF_PCM_WINDOW, port: ch.port2 }, [ch.port2]);
      const tap: LiveFollowRequest = { type: 'tap', port: ch.port1 };
      worker.postMessage(tap, [ch.port1]);
      return {
        setShown: (v) => post({ type: 'shown', shown: v }),
        mute: (v) => post({ type: 'mute', version: v }),
        stop: () => { if (watcher === w) stopWatch(); },
      };
    },
    level: () => {
      analyser.getByteTimeDomainData(levelData);
      let sum = 0;
      for (let i = 0; i < levelData.length; i++) {
        const v = (levelData[i]! - 128) / 128;
        sum += v * v;
      }
      return Math.min(1, Math.sqrt(sum / levelData.length) * 4);
    },
    recordTake: () => {
      const recorder = new MemoryRecorder(stream);
      recorder.start();
      return recorder;
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
