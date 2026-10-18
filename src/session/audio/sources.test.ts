import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FileSource, MicSource, type RecognitionSink } from './sources';
import { FILE_CHUNK_S } from '../sessionConfig';

// ── FileSource emission logic (decoding is browser-only, PCM is injected) ─────

const RATE = 22050;
const CHUNK = Math.round(FILE_CHUNK_S * RATE);

/** PCM where sample i has value i — lets us verify exact sequencing. */
function rampPcm(seconds: number): Float32Array {
  const pcm = new Float32Array(Math.round(seconds * RATE));
  for (let i = 0; i < pcm.length; i++) pcm[i] = i;
  return pcm;
}

class CollectingSink implements RecognitionSink {
  chunks: Float32Array[] = [];
  acksBeforeResolve = 0; // pending microtasks before each ack, to exercise backpressure
  connectWorkletPort(): void { throw new Error('not used by FileSource'); }
  async feedPcmWithAck(chunk: Float32Array): Promise<void> {
    this.chunks.push(chunk);
    for (let i = 0; i < this.acksBeforeResolve; i++) await Promise.resolve();
  }
}

describe('FileSource', () => {
  it('reports duration from sample count', () => {
    const src = new FileSource(rampPcm(25), RATE);
    expect(src.duration).toBeCloseTo(25);
  });

  it('emits sequential chunks covering the whole signal, last one partial', async () => {
    const pcm = rampPcm(2.5); // 2 full chunks + half chunk
    const src = new FileSource(pcm, RATE);
    const sink = new CollectingSink();
    await src.start(sink);

    expect(sink.chunks).toHaveLength(3);
    expect(sink.chunks[0]!.length).toBe(CHUNK);
    expect(sink.chunks[1]!.length).toBe(CHUNK);
    expect(sink.chunks[2]!.length).toBe(pcm.length - 2 * CHUNK);

    // Sample counter continuity: concatenation reproduces the ramp exactly.
    let expected = 0;
    for (const chunk of sink.chunks) {
      for (let i = 0; i < chunk.length; i++) {
        if (chunk[i] !== expected) throw new Error(`sample ${expected} out of order`);
        expected++;
      }
    }
    expect(expected).toBe(pcm.length);
  });

  it('emits copies — chunks survive the source buffer being reused', async () => {
    const pcm = rampPcm(1);
    const src = new FileSource(pcm, RATE);
    const sink = new CollectingSink();
    await src.start(sink);
    pcm.fill(-1);
    expect(sink.chunks[0]![0]).toBe(0); // untouched by the mutation above
  });

  it('awaits each ack before sending the next chunk (backpressure)', async () => {
    const src = new FileSource(rampPcm(3), RATE);
    let inFlight = 0;
    let maxInFlight = 0;
    const sink: RecognitionSink = {
      connectWorkletPort: () => {},
      feedPcmWithAck: async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise(r => setTimeout(r, 1));
        inFlight--;
      },
    };
    await src.start(sink);
    expect(maxInFlight).toBe(1);
  });

  it('stop() halts emission at the next chunk boundary', async () => {
    const src = new FileSource(rampPcm(10), RATE);
    const sink = new CollectingSink();
    const origFeed = sink.feedPcmWithAck.bind(sink);
    sink.feedPcmWithAck = async (chunk) => {
      await origFeed(chunk);
      if (sink.chunks.length === 2) src.stop();
    };
    await src.start(sink);
    expect(sink.chunks).toHaveLength(2); // not 10
  });

  it('a file shorter than one chunk is emitted as a single partial chunk', async () => {
    const pcm = rampPcm(0.4);
    const src = new FileSource(pcm, RATE);
    const sink = new CollectingSink();
    await src.start(sink);
    expect(sink.chunks).toHaveLength(1);
    expect(sink.chunks[0]!.length).toBe(pcm.length);
  });
});

// ── Live microphone: the iPhone pause that gives the microphone back ─────────
// Web Audio and getUserMedia faked as a graph of plain objects: what matters
// is which node feeds which, which tracks are stopped, and what the audio
// session and the context are left in. What iOS then does with them is for a
// real iPhone to tell.

class FakeNode {
  outs = new Set<FakeNode>();
  constructor(readonly kind: string, readonly stream?: FakeStream) {}
  connect(n: FakeNode): void { this.outs.add(n); }
  disconnect(): void { this.outs.clear(); }
}

class FakeTrack {
  stopped = false;
  private ended: Array<() => void> = [];
  label = 'mic';
  addEventListener(_: string, fn: () => void): void { this.ended.push(fn); }
  getSettings(): object { return {}; }
  stop(): void { this.stopped = true; }
  /** The system ending the track on its own. */
  end(): void { this.ended.forEach(fn => fn()); }
}

class FakeStream {
  track = new FakeTrack();
  getAudioTracks(): FakeTrack[] { return [this.track]; }
  getTracks(): FakeTrack[] { return [this.track]; }
}

class FakeContext {
  state = 'running';
  sampleRate = 48000;
  nodes: FakeNode[] = [];
  audioWorklet = { addModule: async () => {} };
  private make(kind: string, stream?: FakeStream): FakeNode { const n = new FakeNode(kind, stream); this.nodes.push(n); return n; }
  createMediaStreamSource(s: FakeStream): FakeNode { return this.make('source', s); }
  createAnalyser(): FakeNode { return Object.assign(this.make('analyser'), { fftSize: 0 }); }
  createMediaStreamDestination(): FakeNode { return Object.assign(this.make('dest'), { stream: {} }); }
  private listeners: Array<() => void> = [];
  addEventListener(_: string, fn: () => void): void { this.listeners.push(fn); }
  private set(state: string): void { this.state = state; this.listeners.forEach(fn => fn()); }
  /** Set while the system still holds the audio: a resume is refused. */
  refuseResume = false;
  async suspend(): Promise<void> { this.set('suspended'); }
  async resume(): Promise<void> { if (this.refuseResume) throw new Error('InvalidStateError'); this.set('running'); }
  async close(): Promise<void> { this.set('closed'); }
  /** iOS taking the audio session over: WebKit's own state. */
  interrupt(): void { this.set('interrupted'); }
}

let ctx: FakeContext;
let opened: FakeStream[];
let refuseNext: Error | null;
let workletMessages: unknown[];
let audioSession: { type: string };

/** Who feeds `target`, among the sources the context ever made. */
const feeding = (target: FakeNode | undefined): FakeStream[] =>
  ctx.nodes.filter(n => n.kind === 'source' && target && n.outs.has(target)).map(n => n.stream!);
const node = (kind: string) => ctx.nodes.find(n => n.kind === kind);

function onDevice(userAgent: string, maxTouchPoints: number): void {
  audioSession = { type: 'auto' };
  vi.stubGlobal('navigator', {
    userAgent,
    maxTouchPoints,
    audioSession,
    mediaDevices: {
      getUserMedia: async () => {
        if (refuseNext) { const e = refuseNext; refuseNext = null; throw e; }
        const s = new FakeStream();
        opened.push(s);
        return s;
      },
    },
  });
}

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.2 Mobile/15E148 Safari/604.1';
const ANDROID = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Mobile Safari/537.36';

async function recordingMic(): Promise<MicSource> {
  const mic = new MicSource();
  await mic.open();
  await mic.start({ connectWorkletPort: () => {}, feedPcmWithAck: async () => {} });
  return mic;
}

describe('MicSource pause', () => {
  beforeEach(() => {
    ctx = new FakeContext();
    opened = [];
    refuseNext = null;
    workletMessages = [];
    vi.stubGlobal('AudioContext', function () { return ctx; });
    vi.stubGlobal('AudioWorkletNode', function (this: FakeNode) {
      const n = Object.assign(new FakeNode('worklet'), { port: { postMessage: (m: unknown) => workletMessages.push(m) } });
      ctx.nodes.push(n);
      return n;
    });
    vi.stubGlobal('URL', { createObjectURL: () => 'blob:worklet' });
    vi.spyOn(console, 'debug').mockImplementation(() => {});
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it('on an iPhone, gives the microphone back: tracks stopped, nothing plugged, session and context released', async () => {
    onDevice(IPHONE, 5);
    const mic = await recordingMic();
    expect(audioSession.type).toBe('play-and-record');

    await mic.suspend();
    expect(mic.micReleased).toBe(true);
    expect(opened[0]!.track.stopped).toBe(true);
    expect(feeding(node('dest'))).toEqual([]);
    expect(feeding(node('analyser'))).toEqual([]);
    expect(feeding(node('worklet'))).toEqual([]);
    expect(audioSession.type).toBe('auto');
    expect(ctx.state).toBe('suspended');
    mic.stop();
  });

  it('on an iPhone, the resume plugs a NEW microphone into the same recording, meter and worklet', async () => {
    onDevice(IPHONE, 5);
    const mic = await recordingMic();
    const dest = node('dest');
    await mic.suspend();
    await mic.resume();

    expect(opened).toHaveLength(2);
    expect(mic.micReleased).toBe(false);
    expect(node('dest')).toBe(dest);                 // the recorder's input never changed
    expect(feeding(dest)).toEqual([opened[1]]);
    expect(feeding(node('analyser'))).toEqual([opened[1]]);
    expect(feeding(node('worklet'))).toEqual([opened[1]]);
    expect(audioSession.type).toBe('play-and-record');
    expect(ctx.state).toBe('running');
    expect(workletMessages.at(-1)).toEqual({ paused: false });
    mic.stop();
    expect(audioSession.type).toBe('auto');
  });

  it('a refused microphone leaves the pause exactly as it was, and Resume can be tried again', async () => {
    onDevice(IPHONE, 5);
    const mic = await recordingMic();
    await mic.suspend();
    refuseNext = Object.assign(new Error('busy'), { name: 'NotReadableError' });

    await expect(mic.resume()).rejects.toThrow('busy');
    expect(mic.micReleased).toBe(true);
    expect(audioSession.type).toBe('auto');
    expect(workletMessages.at(-1)).toEqual({ paused: true });

    await mic.resume();
    expect(feeding(node('dest'))).toEqual([opened[1]]);
    mic.stop();
  });

  it('the track given back ending later is not the microphone dying', async () => {
    onDevice(IPHONE, 5);
    const mic = await recordingMic();
    const onEnded = vi.fn();
    mic.onEnded = onEnded;
    await mic.suspend();
    await mic.resume();
    opened[0]!.track.end();
    expect(onEnded).not.toHaveBeenCalled();
    opened[1]!.track.end();
    expect(onEnded).toHaveBeenCalledTimes(1);
    mic.stop();
  });

  it('stopping while paused on an iPhone hands everything back once', async () => {
    onDevice(IPHONE, 5);
    const mic = await recordingMic();
    await mic.suspend();
    mic.stop();
    expect(ctx.state).toBe('closed');
    expect(audioSession.type).toBe('auto');
    expect(mic.micReleased).toBe(false);
  });

  // A recording whose context the system stopped goes on growing with nothing
  // in it (a 5-byte file, tester's iPhone, 2026-10-16): said at once, which is
  // what pauses the recording (LiveSession), and said again when it is back,
  // which resumes it.
  it('says when the system stops the audio, and when the system gives it back', async () => {
    onDevice(IPHONE, 5);
    const mic = await recordingMic();
    const onStall = vi.fn();
    mic.onStall = onStall;

    ctx.interrupt();
    expect(mic.stalled).toBe(true);
    expect(onStall.mock.calls).toEqual([[true]]);

    await ctx.resume();                  // the call is over
    expect(mic.stalled).toBe(false);
    expect(onStall.mock.calls).toEqual([[true], [false]]);
    mic.stop();
  });

  it('the pause the system forced keeps the iPhone microphone, so its end can be seen', async () => {
    onDevice(IPHONE, 5);
    const mic = await recordingMic();
    const onStall = vi.fn();
    mic.onStall = onStall;
    ctx.interrupt();
    await mic.suspend(true);

    expect(mic.micReleased).toBe(false);
    expect(opened[0]!.track.stopped).toBe(false);
    expect(feeding(node('dest'))).toEqual([opened[0]]);
    expect(ctx.state).toBe('interrupted');          // not suspended by us
    expect(workletMessages.at(-1)).toEqual({ paused: true });

    await ctx.resume();
    expect(onStall.mock.calls).toEqual([[true], [false]]);
    mic.stop();
  });

  it('a Resume tapped while the system still holds the audio is refused, then goes through', async () => {
    onDevice(IPHONE, 5);
    const mic = await recordingMic();
    ctx.interrupt();
    await mic.suspend(true);

    ctx.refuseResume = true;
    await expect(mic.resume()).rejects.toThrow();
    expect(mic.stalled).toBe(true);
    expect(workletMessages.at(-1)).toEqual({ paused: true });

    ctx.refuseResume = false;
    await mic.resume();
    expect(ctx.state).toBe('running');
    expect(mic.stalled).toBe(false);
    expect(opened).toHaveLength(1);                  // the same microphone
    expect(workletMessages.at(-1)).toEqual({ paused: false });
    mic.stop();
  });

  it('a pause that suspends the context on purpose is not a stall, nor is stopping', async () => {
    onDevice(IPHONE, 5);
    const mic = await recordingMic();
    const onStall = vi.fn();
    mic.onStall = onStall;
    await mic.suspend();
    expect(ctx.state).toBe('suspended');
    expect(mic.stalled).toBe(false);
    await mic.resume();
    mic.stop();
    expect(onStall).not.toHaveBeenCalled();
  });

  it('a stall left when stopping is cleared, once', async () => {
    onDevice(IPHONE, 5);
    const mic = await recordingMic();
    const onStall = vi.fn();
    mic.onStall = onStall;
    ctx.interrupt();
    mic.stop();
    expect(onStall.mock.calls).toEqual([[true], [false]]);
  });

  it('anywhere else the pause keeps the microphone, as before', async () => {
    onDevice(ANDROID, 5);
    const mic = await recordingMic();
    await mic.suspend();
    expect(mic.micReleased).toBe(false);
    expect(opened[0]!.track.stopped).toBe(false);
    expect(feeding(node('dest'))).toEqual([opened[0]]);
    expect(ctx.state).toBe('running');

    await mic.resume();
    expect(opened).toHaveLength(1);
    expect(workletMessages.at(-1)).toEqual({ paused: false });
    mic.stop();
  });
});
