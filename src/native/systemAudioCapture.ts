import { registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import { initialLiveNotification } from './liveForeground';
import type { LiveNotificationState } from './liveNotification';

/**
 * A live on what the phone itself plays, in the Android app — what tab
 * capture is on a computer (asked for by the group, 2026-10-14). Android has
 * no getDisplayMedia; the samples come from the app's own plugin
 * (android/…/SystemAudioCapturePlugin.java, playback capture behind the
 * system's screen-capture consent), and are turned back here into the one
 * thing the live pipeline takes: a MediaStream. Everything downstream — the
 * meter, the recording, the recognition — is the microphone's path, unchanged.
 *
 * The samples cross the bridge in 100 ms chunks and play into a
 * MediaStreamAudioDestinationNode through a small worklet that buffers a
 * quarter of a second against the bridge's jitter. Nothing reaches the
 * speakers: the user already hears the app that plays.
 *
 * Imported dynamically, and only when the plugin exists (hasNativePlugin).
 */

interface SystemAudioCapturePlugin {
  start(opts: { notification: Omit<LiveNotificationState, 'elapsedMs' | 'paused'> }): Promise<{ sampleRate: number }>;
  stop(): Promise<void>;
  addListener(event: 'pcm', fn: (e: { data: string }) => void): Promise<PluginListenerHandle>;
  addListener(event: 'ended', fn: () => void): Promise<PluginListenerHandle>;
}

const SystemAudioCapture = registerPlugin<SystemAudioCapturePlugin>('SystemAudioCapture');

/** What the plugin sends (SystemAudioCapture.java). Fixed, so the context
 *  feeding the stream can be built before the consent, at the right rate. */
const CAPTURE_SAMPLE_RATE = 48000;

/** The plugin refused for good: Android 9 or older. */
export class SystemAudioUnsupportedError extends Error {
  constructor() { super('system-audio-unsupported'); this.name = 'SystemAudioUnsupportedError'; }
}

const PROCESSOR_NAME = 'cadence-pcm-feeder';

/** `prime`: what is buffered before the first sample goes out, and again after
 *  running dry. `max`: past this, the oldest samples go — the page was busy
 *  and the delay must not grow for the rest of the live. */
const PROCESSOR_SOURCE = `
class PcmFeeder extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.prime = options.processorOptions.prime;
    this.max = options.processorOptions.max;
    this.queue = [];
    this.head = 0;
    this.buffered = 0;
    this.primed = false;
    this.port.onmessage = (e) => {
      const chunk = e.data;
      this.queue.push(chunk);
      this.buffered += chunk.length;
      while (this.buffered > this.max && this.queue.length > 1) {
        const dropped = this.queue.shift();
        this.buffered -= dropped.length - this.head;
        this.head = 0;
      }
    };
  }
  process(_inputs, outputs) {
    const out = outputs[0][0];
    if (!this.primed) {
      if (this.buffered < this.prime) return true;
      this.primed = true;
    }
    let i = 0;
    while (i < out.length && this.queue.length > 0) {
      const chunk = this.queue[0];
      const n = Math.min(out.length - i, chunk.length - this.head);
      out.set(chunk.subarray(this.head, this.head + n), i);
      i += n;
      this.head += n;
      this.buffered -= n;
      if (this.head === chunk.length) { this.queue.shift(); this.head = 0; }
    }
    if (i < out.length) this.primed = false;
    return true;
  }
}
registerProcessor('${PROCESSOR_NAME}', PcmFeeder);
`;

/** base64 16-bit little-endian mono → Float32. */
function decodeChunk(base64: string): Float32Array {
  const bin = atob(base64);
  const out = new Float32Array(bin.length >> 1);
  for (let i = 0; i < out.length; i++) {
    const lo = bin.charCodeAt(2 * i);
    const hi = bin.charCodeAt(2 * i + 1);
    const v = (hi << 8) | lo;
    out[i] = (v >= 0x8000 ? v - 0x10000 : v) / 0x8000;
  }
  return out;
}

export interface SystemAudioStream {
  stream: MediaStream;
  /** Ends the capture and the graph feeding the stream. */
  stop(): void;
}

/** Asks Android for the consent and opens the capture. Rejects with a
 *  NotAllowedError for a refusal — the same name a browser's share picker
 *  gives, so the live goes back to the library without a word, as there. */
export async function openSystemAudio(): Promise<SystemAudioStream> {
  const ctx = new AudioContext({ sampleRate: CAPTURE_SAMPLE_RATE });
  const listeners: PluginListenerHandle[] = [];
  let stopped = false;
  const teardown = () => {
    if (stopped) return;
    stopped = true;
    listeners.forEach(l => void l.remove());
    void ctx.close().catch(() => { /* already closed */ });
  };

  try {
    const url = URL.createObjectURL(new Blob([PROCESSOR_SOURCE], { type: 'application/javascript' }));
    try { await ctx.audioWorklet.addModule(url); } finally { URL.revokeObjectURL(url); }
    const feeder = new AudioWorkletNode(ctx, PROCESSOR_NAME, {
      numberOfInputs: 0,
      outputChannelCount: [1],
      processorOptions: { prime: CAPTURE_SAMPLE_RATE / 4, max: CAPTURE_SAMPLE_RATE * 2 },
    });
    const dest = ctx.createMediaStreamDestination();
    dest.channelCount = 1;
    feeder.connect(dest);
    const track = dest.stream.getAudioTracks()[0]!;

    // Before start(): the first chunks follow its answer closely.
    listeners.push(await SystemAudioCapture.addListener('pcm', ({ data }) => {
      const pcm = decodeChunk(data);
      feeder.port.postMessage(pcm, [pcm.buffer]);
    }));
    listeners.push(await SystemAudioCapture.addListener('ended', () => {
      // The user's "Stop sharing", or the system's: what a browser does when
      // a shared tab closes — the track ends, and the live with it
      // (LiveStreamSource.watchTrack). A track stopped by script fires
      // nothing, so the event is sent by hand.
      teardown();
      track.stop();
      track.dispatchEvent(new Event('ended'));
    }));

    try {
      await SystemAudioCapture.start({ notification: initialLiveNotification() });
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === 'denied') throw new DOMException('Capture refused', 'NotAllowedError');
      if (code === 'unsupported') throw new SystemAudioUnsupportedError();
      throw err;
    }
    if (ctx.state === 'suspended') await ctx.resume();

    return {
      stream: dest.stream,
      stop: () => {
        if (stopped) return;
        teardown();
        void SystemAudioCapture.stop().catch(() => { /* service already gone */ });
      },
    };
  } catch (err) {
    teardown();
    throw err;
  }
}
