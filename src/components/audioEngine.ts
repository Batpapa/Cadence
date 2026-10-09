// The library's own file, as text: an alias in webpack.config.js.
import signalsmithStretchSource from 'signalsmith-stretch.mjs?raw';
import type { FileEntry } from '../types';

// ── How the sound is made ────────────────────────────────────────────────────
// Signalsmith Stretch (npm `signalsmith-stretch`, MIT): its author's own Web
// Audio release, a WebAssembly time-stretcher in an AudioWorklet that plays a
// buffer by itself — tempo, transposition in (fractional) semitones, an A-B
// loop, all scheduled in the time the sound is HEARD, its own latency
// compensated. This engine only tells it what to play, and when.
//
// History, so nobody walks the same road again (2026-10-09). SoundTouch in a
// ScriptProcessorNode ran on the page's main thread and crackled throughout
// on a Galaxy A22. Moved to an AudioWorklet, it crackled for 2-3 s at every
// start (its JavaScript not yet optimised), clicked at every loop seam, at
// every stop and every seek — each fixed by hand in turn (warm-up, reserve,
// gain dips, output fades, deferred suspension) until the user asked whether
// we were reinventing the wheel. We were: a dedicated engine, compiled ahead
// of time, handles every one of these itself.
//
// No UI here (2026-10-10): the player's screen became Preact components
// (audioPlayer.tsx) and this is what was the sound half of the old
// hand-built player, unchanged in what it does.

let currentAudioCtx: AudioContext | null = null;
let currentDispose: (() => void) | null = null;

/** `playback`: this is listening, not playing an instrument, so a larger
 *  output buffer costs nothing and Chrome on Android takes one. */
function newPlayerContext(): AudioContext {
  return new AudioContext({ latencyHint: 'playback' });
}

export function stopCurrentAudio(): void {
  // Disconnect the node explicitly instead of relying on AudioContext.close()
  // alone — on some Android/Chrome builds close() didn't silence an in-flight
  // node immediately, letting a new instance's audio overlap the old one for
  // a moment (reported as "duplicated playback with a slight offset").
  currentDispose?.();
  void currentAudioCtx?.close();
  currentAudioCtx = null;
  currentDispose = null;
}

/** What a schedule() call can set (the library's README). Times in seconds:
 *  `output` on the context's clock, `input` and the loop in the file. */
interface StretchSchedule {
  output?: number;
  active?: boolean;
  input?: number;
  rate?: number;
  semitones?: number;
  loopStart?: number;
  loopEnd?: number;
}

/** The AudioWorkletNode the library returns, with the methods it attaches.
 *  It ships no types. */
type StretchNode = AudioWorkletNode & {
  schedule(change: StretchSchedule): Promise<unknown>;
  addBuffers(channels: Float32Array[]): Promise<number>;
  /** Input plus output latency, in seconds: how far ahead a change has to be
   *  scheduled to be taken exactly on time. */
  latency(): Promise<number>;
};

type StretchFactory = (ctx: BaseAudioContext) => Promise<StretchNode>;
let stretchFactory: Promise<StretchFactory> | null = null;

/** The library, loaded as the very file it ships. It builds its AudioWorklet
 *  module from its own functions' source text (`${Module}`), which a bundler's
 *  minifier would rewrite — renamed variables that no longer exist once that
 *  text runs alone in the worklet. Through a Blob URL it stays untouched, and
 *  is part of the bundle: nothing for the service worker to miss offline. */
function loadStretch(): Promise<StretchFactory> {
  stretchFactory ??= (async () => {
    const url = URL.createObjectURL(new Blob([signalsmithStretchSource], { type: 'text/javascript' }));
    const mod = await import(/* webpackIgnore: true */ url) as { default: StretchFactory };
    return mod.default;
  })();
  return stretchFactory;
}

async function decodeAudio(entry: FileEntry, ctx: AudioContext): Promise<AudioBuffer> {
  const bytes = atob(entry.data);
  const arr = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i)!;
  return ctx.decodeAudioData(arr.buffer);
}

function buildWaveformData(buffer: AudioBuffer, numBars = 120): number[] {
  const ch = buffer.getChannelData(0);
  const block = Math.floor(ch.length / numBars);
  const raw = Array.from({ length: numBars }, (_, i) => {
    let s = 0;
    for (let j = 0; j < block; j++) s += Math.abs(ch[i * block + j] ?? 0);
    return s / block;
  });
  const maxVal = Math.max(...raw, 1e-4);
  return raw.map(v => v / maxVal);
}

/** Tempo in %, transposition in semitones, fine pitch in cents. */
export interface AudioEffects { tempo: number; transpose: number; pitch: number }

/** One player's sound: a buffer, the region it loops or ends at, and the
 *  effects. `onPlayingChange` reports a stop the engine made by itself — the
 *  region's natural end, or another player taking the output over. */
export class AudioEngine {
  private audioCtx: AudioContext | null = null;
  private buffer: AudioBuffer | null = null;
  private stretch: StretchNode | null = null;
  /** How far ahead changes are scheduled — the node's own latency. */
  private lead = 0.1;

  // Where playback is, in the file's seconds: `anchorPos` comes out of the
  // node at context time `anchorOut`, advancing at `anchorRate` — the same
  // model the node keeps, re-anchored at every change sent to it.
  // `pausedPos` is the position while nothing plays.
  private anchorPos = 0;
  private anchorOut = 0;
  private anchorRate = 1;
  private pausedPos = 0;
  /** The region's natural end without repeat, as a timer: the node only
   *  falls silent there, and the player has to know it stopped. */
  private endTimer = 0;
  private suspendTimer = 0;

  private playing = false;
  private repeat = true;
  duration = 1;
  private regionStart = 0;
  private regionEnd = 1;
  private effects: AudioEffects = { tempo: 100, transpose: 0, pitch: 0 };

  constructor(private readonly onPlayingChange: (playing: boolean) => void) {}

  private rate(): number { return this.effects.tempo / 100; }
  private semitones(): number { return this.effects.transpose + this.effects.pitch / 100; }
  /** The output device's own buffer — large on Android with `playback`. */
  private deviceLag(): number { return this.audioCtx?.outputLatency || this.audioCtx?.baseLatency || 0; }

  /** The position at the node's output at context time `at`. It loops
   *  between the region's bounds, so the position wraps the same way: past
   *  regionEnd, back to regionStart. */
  private positionAt(at: number): number {
    if (!this.playing) return this.pausedPos;
    const p = this.anchorPos + Math.max(0, at - this.anchorOut) * this.anchorRate;
    if (p < this.regionEnd) return p;
    if (!this.repeat) return this.regionEnd;
    return this.regionStart + ((p - this.regionEnd) % Math.max(this.regionEnd - this.regionStart, 1e-3));
  }

  /** What is being HEARD — the playhead, and where a marker set "here" goes. */
  position(): number {
    return this.audioCtx ? this.positionAt(this.audioCtx.currentTime - this.deviceLag()) : this.pausedPos;
  }

  isPlaying(): boolean { return this.playing; }

  /** Tells the node everything, effective `lead` from now — the node's own
   *  latency, so the change is taken exactly on time rather than "caught up"
   *  with. From `from` when given (a seek), else from wherever playback will
   *  be by then. A schedule() call drops whatever was scheduled after it, the
   *  region's end included, so this is the one place that schedules, and it
   *  re-arms that end every time. */
  private sendState(from?: number): void {
    const { stretch, audioCtx } = this;
    if (!stretch || !audioCtx) return;
    const out = audioCtx.currentTime + this.lead;
    const input = from ?? this.positionAt(out);
    this.anchorPos = input;
    this.anchorOut = out;
    this.anchorRate = this.rate();
    void stretch.schedule({
      output: out,
      active: true,
      input,
      rate: this.anchorRate,
      semitones: this.semitones(),
      // Equal bounds disable the loop (library README).
      loopStart: this.repeat ? this.regionStart : 0,
      loopEnd: this.repeat ? this.regionEnd : 0,
    });
    clearTimeout(this.endTimer);
    if (!this.repeat) {
      const end = out + Math.max(0, this.regionEnd - input) / this.anchorRate;
      void stretch.schedule({ output: end, active: false });
      this.endTimer = window.setTimeout(() => this.handleEnd(), (end - audioCtx.currentTime + this.deviceLag()) * 1000);
    }
  }

  /** An inactive node still runs its DSP on silence, so the context sleeps
   *  while nothing plays — a moment after a stop, never with it, so the node
   *  has faded out first. */
  private suspendSoon(): void {
    clearTimeout(this.suspendTimer);
    this.suspendTimer = window.setTimeout(() => {
      if (!this.playing && this.audioCtx?.state === 'running') void this.audioCtx.suspend();
    }, 400);
  }

  private setPlaying(playing: boolean): void {
    if (this.playing === playing) return;
    this.playing = playing;
    this.onPlayingChange(playing);
  }

  /** Pause and stop: the node goes inactive NOW — not `lead` ahead: the
   *  library then fades out as it catches up, rather than cutting. */
  private halt(): void {
    clearTimeout(this.endTimer);
    this.setPlaying(false);
    if (this.stretch && this.audioCtx) void this.stretch.schedule({ output: this.audioCtx.currentTime, active: false });
    this.suspendSoon();
  }

  /** The region's natural end, without repeat: the node has already stopped
   *  itself (sendState scheduled it); the player catches up. */
  private handleEnd(): void {
    this.pausedPos = this.regionStart;
    this.setPlaying(false);
    this.suspendSoon();
  }

  private teardown(): void {
    clearTimeout(this.endTimer);
    clearTimeout(this.suspendTimer);
    this.stretch?.disconnect();
    this.stretch = null;
    this.setPlaying(false);
  }

  /** One channel array per channel of the file. Copied into the worklet. */
  private loadInto(node: StretchNode, b: AudioBuffer): Promise<number> {
    return node.addBuffers(Array.from({ length: b.numberOfChannels }, (_, c) => b.getChannelData(c)));
  }

  /** The context and the node — built once, and again if another player's
   *  stopCurrentAudio() closed them under this one. */
  private async ensureGraph(): Promise<void> {
    if (this.audioCtx && this.audioCtx.state !== 'closed' && this.stretch) return;
    stopCurrentAudio();
    const ctx = newPlayerContext();
    this.audioCtx = ctx;
    currentAudioCtx = ctx;
    currentDispose = () => this.teardown();
    const create = await loadStretch();
    const node = await create(ctx);
    node.connect(ctx.destination);
    this.stretch = node;
    this.lead = await node.latency();
    if (this.buffer) await this.loadInto(node, this.buffer);
  }

  /** Decodes the file and readies the node, silent until play. The waveform
   *  is the file's outline, 120 bars normalised to the loudest. */
  async load(entry: FileEntry): Promise<{ duration: number; waveform: number[] }> {
    await this.ensureGraph();
    this.buffer = await decodeAudio(entry, this.audioCtx!);
    this.duration = this.buffer.duration;
    this.regionEnd = this.duration;
    await this.loadInto(this.stretch!, this.buffer);
    // Silent until the user hits play.
    this.suspendSoon();
    return { duration: this.duration, waveform: buildWaveformData(this.buffer) };
  }

  async play(): Promise<void> {
    await this.ensureGraph();
    const { audioCtx, stretch, buffer } = this;
    if (!audioCtx || !stretch || !buffer) return;
    clearTimeout(this.suspendTimer);
    if (audioCtx.state === 'suspended') await audioCtx.resume();
    // Past the region's end there is nothing to play: from its start.
    if (this.pausedPos >= this.regionEnd) this.pausedPos = this.regionStart;
    // Playing BEFORE scheduling (sendState reads it), but told to the screen
    // only after: its first frame would otherwise read a stale anchor.
    this.playing = true;
    this.sendState(this.pausedPos);
    this.onPlayingChange(true);
  }

  pause(): void {
    if (!this.playing) return;
    this.pausedPos = this.position();
    this.halt();
  }

  stop(): void {
    this.pausedPos = this.regionStart;
    this.halt();
  }

  seek(offsetSecs: number): void {
    const pos = Math.max(0, Math.min(offsetSecs, this.duration));
    this.pausedPos = pos;
    if (this.playing) this.sendState(pos);
  }

  /** The bounds, as the screen draws them — during a drag too, so the
   *  position wraps where the handle is. The node gets them at the next
   *  `applyRegion`. */
  setRegionBounds(start: number, end: number): void {
    this.regionStart = start;
    this.regionEnd = end;
  }

  /** For a change of region or of repeat: carries on from where playback
   *  is, under the new bounds. */
  applyRegion(): void { if (this.playing) this.sendState(); }

  setRepeat(repeat: boolean): void {
    this.repeat = repeat;
    this.applyRegion();
  }

  /** The sliders: taken at once while playing, read at the next play else. */
  setEffects(effects: AudioEffects): void {
    this.effects = effects;
    if (this.playing) this.sendState();
  }
}
