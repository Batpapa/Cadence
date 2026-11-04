import { parseAbcBlock, meterCanSwing, NO_SWING } from '../services/abcService';
import { swingAudioParams } from '../services/jigSwing';
import { abcjsVolumeMultiplier } from '../services/playbackVolume';
import {
  playPlan, resumeInside, passOf, eventAt, isNote, touches, type PlayableSource, type TimingEvent,
} from '../services/abcTextPlayback';

// ── The score viewer's one player (2026-11-04, the user) ────────────────────
// The viewer had two: abcjs's own SynthController under the stave, which only
// existed once the stave was drawn, and one of ours under the ABC text, which
// the text face needed because of that. Each face had its own buttons, and
// the cursor was copied from one to the other when the tab changed. Showing
// both faces at once (the "both" face) made that untenable — and the user's
// verdict was that it should never have been tied to a view in the first
// place: the transport plays the TUNE, and each face only shows where it is.
//
// So this is the text face's player, out of the viewer and without a view:
// it plays a text, from a note, inside a passage, round the loop, and reports
// each note it reaches. The faces draw those notes; nothing here knows there
// is a stave or a box. It is built the way SynthController.go() builds its
// own (synth-controller.js) — a CreateSynth and a TimingCallbacks — from the
// text engraved off screen (renderAbc's "*" target: a hidden div, drawn and
// removed), since the timing of each note is only known once abcjs has laid
// the tune out. Built at each start: the text may have changed.
//
// What went with abcjs's controller is every workaround it needed: its play
// button waiting for good on a failed preparation outside a tap (Safari), its
// `isStarted` left true by a pause from outside, the queue of `setWarp`
// rebuilds that raced each other, the hidden tempo field it wrote into
// without a null check.

/** How far before a note to seek: abcjs picks the current event with a strict
 *  `milliseconds < currentTime`, and a seek goes out in seconds and comes back
 *  in milliseconds — when the round trip leaves it a hair higher, an exact
 *  seek steps past the note and selects the next one. A few milliseconds is
 *  far below the shortest note in this music (a sixteenth in a fast reel is
 *  about 80 ms). */
const SEEK_BACKOFF_MS = 10;

/** Beats per bar, as the click counts them. A compound metre is counted in
 *  dotted beats, not in its own denominator: a jig in 6/8 is TWO, not six,
 *  and clicking six would be unusable at any speed this music is played at.
 *  9/8 is three, 12/8 four; everything else counts its numerator. */
function beatsPerBar(meter: string): number {
  const m = /^(\d+)\s*\/\s*(\d+)/.exec(meter.trim());
  if (!m) return 4;
  const top = parseInt(m[1]!, 10);
  const bottom = parseInt(m[2]!, 10);
  if (!Number.isFinite(top) || top <= 0) return 4;
  if (bottom === 8 && top % 3 === 0 && top > 3) return top / 3;
  return top;
}

/** A `%%MIDI drum` pattern: one stroke per beat, the first one accented.
 *
 *  The spec is a run of `d`/`z` followed by one MIDI note per stroke and then
 *  one velocity per stroke. 76 and 77 are the two woodblocks — the pair every
 *  metronome sound in General MIDI is built from — and the first is louder so
 *  the bar has a shape to follow rather than a flat tick. */
function drumPattern(beats: number): string {
  const n = Math.max(1, Math.min(12, beats));
  const strokes = 'd'.repeat(n);
  const notes = ['76', ...Array(n - 1).fill('77')].join(' ');
  const volumes = ['95', ...Array(n - 1).fill('60')].join(' ');
  return `${strokes} ${notes} ${volumes}`;
}

export type PlayState = 'idle' | 'loading' | 'playing' | 'paused';

/** How the tune is to sound, read at every build. */
export interface PlaySettings {
  program: number | undefined;
  /** Semitones: the sound of the key the stave is transposed to. */
  transpose: number;
  metronome: boolean;
  swing: number;
  /** Of the written tempo. */
  tempoPercent: number;
}

/** A note on one of its times round the repeats: what a start and a jump
 *  name. `char` is where it starts in the source abcjs reads. */
export interface Place { char: number; pass: number }

/** A performance being played: its text and its notes in time. */
export interface PlayerRun {
  ps: PlayableSource;
  /** One event per note per time round, as abcjs's timer has them. */
  timings: TimingEvent[];
  /** The note sounding — or paused on, or sought to. */
  last: TimingEvent | null;
}

/** What the player asks of whoever owns it, and tells it. */
export interface AbcPlayerHost {
  /** The text to play, as abcjs is to read it — read at each build. */
  source: () => PlayableSource;
  settings: () => PlaySettings;
  /** The passage, as characters of the source; null for the whole tune. Read
   *  at every note: the bounds may move while it plays. */
  region: () => { from: number; to: number } | null;
  looping: () => boolean;
  onState: (state: PlayState) => void;
  /** A note reached, or sought to while paused. */
  onNote: (ev: TimingEvent, run: PlayerRun) => void;
  /** Just before the sound is prepared — inside the tap that asked, which
   *  is when a browser lets audio start. */
  beforeBuild?: () => void;
}

export interface AbcPlayer {
  state: () => PlayState;
  run: () => PlayerRun | null;
  /** Builds and plays: from `from` when it is inside the passage, else from
   *  the passage's start. */
  start: (from: Place | null) => void;
  pause: () => void;
  resume: () => void;
  /** To a note — playing on from it, or paused on it. Only inside the
   *  passage: false when it did not go. */
  jump: (to: Place) => boolean;
  /** Back to the start of the passage, playing or not, without stopping. */
  rewind: () => void;
  stop: () => void;
  /** A setting changed: the same note, the same time round, rebuilt. */
  retime: () => void;
}

interface Run extends PlayerRun {
  id: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  synth: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  timer: any;
  /** The furthest character played inside the passage — see resumeInside. */
  playedTo: number;
}

interface Resume { at: Place; playedTo: number; paused: boolean }

export function createAbcPlayer(abcjs: typeof import('abcjs'), host: AbcPlayerHost): AbcPlayer {
  let run: Run | null = null;
  /** Bumped by every start and every stop, so a preparation that comes back
   *  after either is dropped rather than started. */
  let runId = 0;
  let state: PlayState = 'idle';
  /** The place the run being prepared was asked to start from. A setting
   *  changed again before it is ready restarts the preparation from that
   *  same place, not from the cursor (the key changed press after press,
   *  2026-10-20: each press while loading sent it back to the caret). */
  let loading: { from: Place | null; resume: Resume | null } | null = null;

  const setState = (next: PlayState) => {
    state = next;
    host.onState(next);
  };

  /** The passage, read again at each use, or the whole tune without one. */
  const region = (): { from: number; to: number } => host.region() ?? { from: 0, to: Infinity };
  /** The first note of the passage in time. */
  const regionStart = (r: Run): TimingEvent | null => {
    const { from, to } = region();
    return playPlan(r.timings, from, to)?.start ?? null;
  };
  /** The event of a place, if it is inside the passage. */
  const eventOf = (r: Run, to: Place): TimingEvent | null => {
    const ev = eventAt(r.timings, to.char, to.pass) ?? playPlan(r.timings, to.char, null)?.start ?? null;
    const { from, to: end } = region();
    return ev && touches(ev, from, end) ? ev : null;
  };

  /** The run moved to a note — a hair before it. `rearm` restarts the timer's
   *  own loop, which has ended once the tune is played out. */
  const seek = (r: Run, ev: TimingEvent, rearm = false) => {
    const at = Math.max(0, ev.milliseconds - SEEK_BACKOFF_MS) / 1000;
    if (state === 'paused') {
      r.synth.seek(at, 'seconds');
      r.timer.setProgress(at, 'seconds');
      return;
    }
    // Stopped, sought, started: abcjs's own seek restarts the sound only
    // while it thinks it is running, which it may no longer think at the
    // end of the buffer.
    try { r.synth.stop(); } catch { /* not started */ }
    r.synth.seek(at, 'seconds');
    r.synth.start();
    if (rearm) { r.timer.reset(); r.timer.start(at, 'seconds'); } else r.timer.setProgress(at, 'seconds');
  };

  /** The end of the passage: round again with the loop, else stop. */
  const endRun = (r: Run, rearm: boolean) => {
    if (!host.looping()) { stop(); return; }
    r.playedTo = -1;
    const start = regionStart(r);
    if (start) seek(r, start, rearm);
    else stop();
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const onEvent = (r: Run, ev: any): 'continue' | undefined => {
    if (r.id !== runId) return undefined;
    if (!ev) {
      // Played out. "continue" keeps the timer from stopping itself over
      // the restart (abc_timing_callbacks' shouldStop).
      endRun(r, true);
      return host.looping() ? 'continue' : undefined;
    }
    const tev = ev as TimingEvent;
    const { from, to } = region();
    if (isNote(tev) && !touches(tev, from, to)) {
      const next = resumeInside(r.timings, tev.milliseconds, r.playedTo, from, to);
      if (next) seek(r, next);
      else endRun(r, false);
      return undefined;
    }
    r.playedTo = Math.max(r.playedTo, ...(tev.startCharArray ?? []));
    r.last = tev;
    host.onNote(tev, r);
    return undefined;
  };

  /** The run on its way out, silenced — not a stop: the state is left to
   *  whoever replaces it. */
  const halt = () => {
    const r = run;
    run = null;
    if (!r) return;
    try { r.timer.stop(); } catch { /* already stopped */ }
    try { r.synth.stop(); } catch { /* never started */ }
  };

  const start = (from: Place | null, resume: Resume | null = null) => {
    // One tune at a time: a run already there — paused, typically, and
    // started again from where the cursor was moved to — goes.
    halt();
    const id = ++runId;
    loading = { from, resume };
    const ps = host.source();
    const s = host.settings();
    setState('loading');
    host.beforeBuild?.();
    void (async () => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const visualObj: any = abcjs.renderAbc('*', ps.source, {})[0];
        if (!visualObj) throw new Error('no tune');
        const audioParams: Record<string, unknown> = { soundFontVolumeMultiplier: abcjsVolumeMultiplier() };
        if (s.program !== undefined) audioParams.program = s.program;
        // The stave draws the transposition as `visualTranspose`, which
        // abc_midi_sequencer subtracts back out on the way to MIDI; this
        // engraving has none, so the sound is moved here, by the same amount.
        if (s.transpose !== 0) audioParams.midiTranspose = s.transpose;
        const meter = parseAbcBlock(ps.source).meter;
        if (s.metronome) { audioParams.drum = drumPattern(beatsPerBar(meter)); audioParams.drumBars = 1; }
        // abcjs's `swing` in a reel, our own note-map pass in a jig — see
        // swingAudioParams. Both read the metre and the pickup from abcjs's
        // own parse, the one the notes are timed from.
        if (s.swing !== NO_SWING && meterCanSwing(meter)) {
          Object.assign(audioParams, swingAudioParams(s.swing, visualObj.getMeterFraction(), visualObj.getPickupLength()));
        }
        // As SynthController.go() does it, at the chosen speed.
        const millisecondsPerMeasure = visualObj.millisecondsPerMeasure() * 100 / s.tempoPercent;
        const qpm = Math.round(visualObj.getBeatsPerMeasure() / millisecondsPerMeasure * 60000);
        const synth = new abcjs.synth.CreateSynth();
        await synth.init({ visualObj, options: audioParams, millisecondsPerMeasure });
        await synth.prime();
        if (id !== runId) return;
        // eslint-disable-next-line prefer-const
        let r: Run;
        const timer = new abcjs.TimingCallbacks(visualObj, {
          qpm,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          eventCallback: (ev: any) => onEvent(r, ev),
        });
        const timings = timer.noteTimings as TimingEvent[];
        r = { id, synth, timer, ps, timings, playedTo: resume ? resume.playedTo : -1, last: null };
        const startAt = regionStart(r);
        if (!startAt) { stop(); return; }
        const place = resume?.at ?? from;
        const at = (place && eventOf(r, place)) ?? startAt;
        run = r;
        loading = null;
        // The note it starts on, shown before the first one sounds.
        r.last = at;
        const seekTo = Math.max(0, at.milliseconds - SEEK_BACKOFF_MS) / 1000;
        synth.seek(seekTo, 'seconds');
        if (resume?.paused) {
          setState('paused');
          timer.setProgress(seekTo, 'seconds');
          host.onNote(at, r);
          return;
        }
        host.onNote(at, r);
        setState('playing');
        synth.start();
        timer.start(seekTo, 'seconds');
      } catch (err) {
        if (id !== runId) return;
        console.warn('[abc] could not play the tune', err);
        stop();
      }
    })();
  };

  const pause = () => {
    if (state !== 'playing' || !run) return;
    try { run.synth.pause(); run.timer.pause(); } catch { /* ended */ }
    setState('paused');
  };

  const resume = () => {
    if (state !== 'paused' || !run) return;
    run.synth.start();
    run.timer.start();
    setState('playing');
  };

  const jump = (to: Place): boolean => {
    const r = run;
    if (!r || (state !== 'playing' && state !== 'paused')) return false;
    const ev = eventOf(r, to);
    if (!ev) return false;
    r.playedTo = -1;
    r.last = ev;
    seek(r, ev);
    // Paused, the timer's own report of a seek is not to be counted on: the
    // note is told here.
    if (state === 'paused') host.onNote(ev, r);
    return true;
  };

  const rewind = () => {
    const r = run;
    if (!r || state === 'loading') return;
    r.playedTo = -1;
    const at = regionStart(r);
    if (!at) return;
    r.last = at;
    seek(r, at);
    if (state === 'paused') host.onNote(at, r);
  };

  function stop(): void {
    runId++;
    loading = null;
    halt();
    if (state !== 'idle') setState('idle');
  }

  const retime = () => {
    if (state === 'idle') return;
    const r = run;
    if (state === 'loading' || !r) {
      // Started again, which drops the preparation under way: not stopped
      // first, which would tell the faces the music had stopped.
      start(loading?.from ?? null, loading?.resume ?? null);
      return;
    }
    const at = r.last ?? regionStart(r);
    const next: Resume = {
      at: { char: at?.startCharArray?.[0] ?? 0, pass: at ? passOf(r.timings, at) : 0 },
      playedTo: r.playedTo,
      paused: state === 'paused',
    };
    start(null, next);
  };

  return {
    state: () => state,
    run: () => run,
    start: (from) => start(from),
    pause, resume, jump, rewind, stop, retime,
  };
}
