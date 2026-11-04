import { describe, it, expect, vi } from 'vitest';
import { createAbcPlayer, type AbcPlayerHost, type PlayState } from './abcPlayer';
import type { TimingEvent } from '../services/abcTextPlayback';

// The player's own rules — where it starts, where it goes round, what a pause,
// a jump, a stop and a rebuild leave — against a stand-in for abcjs: a synth
// that records what it is told, a timer that is driven by hand. No sound and
// no engraving: both are abcjs's, and the viewer's tests are the browser.

/** A note per event, a quarter of a second apart: `char` is where it starts
 *  in the source, two characters long. */
const ev = (char: number, ms: number): TimingEvent => ({
  type: 'event', milliseconds: ms, startCharArray: [char], endCharArray: [char + 2],
});

/** `|:AB:|C` played out: A B A B C. */
const TIMINGS: TimingEvent[] = [ev(10, 0), ev(12, 250), ev(10, 500), ev(12, 750), ev(20, 1000)];

interface FakeTimer {
  noteTimings: TimingEvent[];
  callback: (e: unknown) => unknown;
  started: number[];
  stopped: boolean;
}

function fakeAbcjs() {
  const synths: { calls: string[] }[] = [];
  const timers: FakeTimer[] = [];
  const abcjs = {
    renderAbc: () => [{
      millisecondsPerMeasure: () => 1000,
      getBeatsPerMeasure: () => 2,
      getMeterFraction: () => ({ num: 2, den: 4 }),
      getPickupLength: () => 0,
    }],
    synth: {
      CreateSynth: class {
        calls: string[] = [];
        constructor() { synths.push(this); }
        async init() { this.calls.push('init'); }
        async prime() { this.calls.push('prime'); }
        seek(at: number) { this.calls.push(`seek ${at}`); }
        start() { this.calls.push('start'); }
        stop() { this.calls.push('stop'); }
        pause() { this.calls.push('pause'); }
      },
    },
    TimingCallbacks: class {
      noteTimings = TIMINGS;
      callback: (e: unknown) => unknown;
      started: number[] = [];
      stopped = false;
      constructor(_v: unknown, opts: { eventCallback: (e: unknown) => unknown }) {
        this.callback = opts.eventCallback;
        timers.push(this as unknown as FakeTimer);
      }
      start(at = 0) { this.started.push(at); }
      stop() { this.stopped = true; }
      pause() { /* held */ }
      reset() { /* back to 0 */ }
      setProgress() { /* sought */ }
    },
  };
  return { abcjs: abcjs as unknown as typeof import('abcjs'), synths, timers };
}

function setup(overrides: Partial<AbcPlayerHost> = {}) {
  const fake = fakeAbcjs();
  const states: PlayState[] = [];
  const notes: number[] = [];
  let region: { from: number; to: number } | null = null;
  let looping = true;
  const host: AbcPlayerHost = {
    source: () => ({ source: 'X:1\nK:C\n|:AB:|C', segments: [] }),
    settings: () => ({ program: undefined, transpose: 0, metronome: false, swing: 0, tempoPercent: 100 }),
    region: () => region,
    looping: () => looping,
    onState: (s) => states.push(s),
    onNote: (e) => notes.push(e.milliseconds),
    ...overrides,
  };
  const player = createAbcPlayer(fake.abcjs, host);
  return {
    ...fake, player, states, notes,
    setRegion: (r: typeof region) => { region = r; },
    setLooping: (on: boolean) => { looping = on; },
  };
}

/** Lets the preparation's promises run. */
const settle = () => new Promise(r => setTimeout(r, 0));

describe('the score player', () => {
  it('builds, then plays from the start of the tune', async () => {
    const { player, states, notes, synths, timers } = setup();
    player.start(null);
    expect(player.state()).toBe('loading');
    await settle();
    expect(states).toEqual(['loading', 'playing']);
    expect(notes).toEqual([0]);
    expect(synths[0]!.calls).toContain('start');
    expect(timers[0]!.started).toEqual([0]);
  });

  it('starts on a place inside the passage, on its time round', async () => {
    const { player, notes } = setup();
    player.start({ char: 12, pass: 1 });
    await settle();
    expect(notes).toEqual([750]);
  });

  it('starts at the passage when the place is outside it', async () => {
    const { player, notes, setRegion } = setup();
    setRegion({ from: 12, to: 14 });
    player.start({ char: 20, pass: 0 });
    await settle();
    expect(notes).toEqual([250]);
  });

  it('pauses and resumes the same run', async () => {
    const { player, states, synths } = setup();
    player.start(null);
    await settle();
    player.pause();
    player.resume();
    expect(states).toEqual(['loading', 'playing', 'paused', 'playing']);
    expect(synths).toHaveLength(1);
  });

  it('goes round to the start of the passage with the loop, and stops without', async () => {
    const looped = setup();
    looped.player.start(null);
    await settle();
    // Played out: the timer reports nothing.
    expect(looped.timers[0]!.callback(null)).toBe('continue');
    expect(looped.player.state()).toBe('playing');

    const once = setup();
    once.setLooping(false);
    once.player.start(null);
    await settle();
    once.timers[0]!.callback(null);
    expect(once.player.state()).toBe('idle');
    expect(once.states.at(-1)).toBe('idle');
  });

  it('leaves the passage at its end: back to its start with the loop', async () => {
    const { player, timers, notes, setRegion, synths } = setup();
    setRegion({ from: 10, to: 14 });
    player.start(null);
    await settle();
    timers[0]!.callback(TIMINGS[1]);
    timers[0]!.callback(TIMINGS[2]);
    timers[0]!.callback(TIMINGS[3]);
    // C is outside: sent back to A, not told as a note.
    timers[0]!.callback(TIMINGS[4]);
    expect(notes).toEqual([0, 250, 500, 750]);
    expect(synths[0]!.calls.at(-2)).toBe('seek 0');
  });

  it('jumps only inside the passage, and tells the note while paused', async () => {
    const { player, notes, setRegion } = setup();
    setRegion({ from: 10, to: 14 });
    player.start(null);
    await settle();
    player.pause();
    expect(player.jump({ char: 20, pass: 0 })).toBe(false);
    expect(player.jump({ char: 12, pass: 1 })).toBe(true);
    expect(notes.at(-1)).toBe(750);
    expect(player.run()?.last).toBe(TIMINGS[3]);
  });

  it('stops for good: a preparation still under way is dropped', async () => {
    const { player, states } = setup();
    player.start(null);
    player.stop();
    await settle();
    expect(states).toEqual(['loading', 'idle']);
    expect(player.run()).toBeNull();
  });

  it('rebuilds at the same note and time round, still paused', async () => {
    const { player, notes, synths, timers, states } = setup();
    player.start(null);
    await settle();
    timers[0]!.callback(TIMINGS[3]);
    player.pause();
    player.retime();
    await settle();
    expect(synths).toHaveLength(2);
    expect(synths[0]!.calls).toContain('stop');
    expect(notes.at(-1)).toBe(750);
    expect(player.state()).toBe('paused');
    // Never through idle: the faces must not read it as a stop.
    expect(states).not.toContain('idle');
  });

  it('a new start silences the run it replaces', async () => {
    const { player, synths } = setup();
    player.start(null);
    await settle();
    player.pause();
    player.start({ char: 20, pass: 0 });
    await settle();
    expect(synths[0]!.calls).toContain('stop');
    expect(player.run()?.last).toBe(TIMINGS[4]);
  });

  it('asks for the sound only once it has been asked to play', () => {
    const beforeBuild = vi.fn();
    const { player } = setup({ beforeBuild });
    expect(beforeBuild).not.toHaveBeenCalled();
    player.start(null);
    expect(beforeBuild).toHaveBeenCalledTimes(1);
  });
});
