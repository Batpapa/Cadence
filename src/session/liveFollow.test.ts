import { describe, it, expect } from 'vitest';
import { LiveFollower, LiveCursor, type LiveEstimate, type LiveFollowOptions } from './liveFollow';
import { contourToMidi, FOLLOW_FPS } from './scoreFollow';

const tune = contourToMidi('ooqxxvxxqxxxvxAxvtsovoxovosovoAvsoqxxvxxqxxxvxACEFHECzAxvsoqsoqq');
const N = tune.length;

/** A played sequence: quaver indices, a null being a quaver's worth of
 *  silence. Each quaver lights its pitch (plus some spread) over a little
 *  noise, as scoreFollow.test.ts's performances do. */
function perform(played: Array<number | null>, { quaverS = 0.14, lead = 2, drift = 0.08 } = {}, sounds: Array<number | null> = played) {
  const notes: Array<{ t: number; index: number | null }> = [];
  let t = lead;
  played.forEach((index, n) => {
    notes.push({ t, index });
    t += quaverS * (1 + drift * Math.sin((2 * Math.PI * n) / played.length));
  });
  const end = t;
  const frames = Math.ceil((end + lead) * FOLLOW_FPS);
  const f = new Float32Array(frames * 48);
  let seed = 3;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let fr = 0; fr < frames; fr++) for (let p = 0; p < 48; p++) f[fr * 48 + p] = 0.02 * rnd();
  notes.forEach((nt, k) => {
    if (nt.index === null) return;
    const a = Math.floor(nt.t * FOLLOW_FPS);
    const b = Math.floor((k + 1 < notes.length ? notes[k + 1]!.t : end) * FOLLOW_FPS);
    const p = tune[sounds[k] ?? nt.index]! - 48;
    for (let fr = a; fr < b; fr++) {
      f[fr * 48 + p] = 1;
      if (p + 1 < 48) f[fr * 48 + p + 1] = 0.2;
      if (p > 0) f[fr * 48 + p - 1] = 0.2;
    }
  });
  /** The true position at `t` s: quaver and fraction, null in silence. */
  const truth = (at: number): number | null => {
    let k = -1;
    for (let j = 0; j < notes.length; j++) { if (notes[j]!.t <= at) k = j; else break; }
    if (k < 0 || at >= end || notes[k]!.index === null) return null;
    const next = k + 1 < notes.length ? notes[k + 1]!.t : end;
    return notes[k]!.index! + (at - notes[k]!.t) / (next - notes[k]!.t);
  };
  return { f, frames, truth, end };
}

const passes = (n: number, from = 0) => Array.from({ length: n * N }, (_, k) => (from + k) % N);
const gap = (q: number, n: number) => {
  const d = Math.abs(q - n) % N;
  return Math.min(d, N - d);
};

function run(f: Float32Array, frames: number, options: Partial<LiveFollowOptions> = {}): LiveEstimate[] {
  const lf = new LiveFollower(tune, options);
  const out: LiveEstimate[] = [];
  for (let fr = 0; fr < frames; fr++) out.push(lf.push(f.subarray(fr * 48, (fr + 1) * 48)));
  return out;
}

describe('live score following', () => {
  it('follows a drifting performance, a few frames back, on the right quaver', () => {
    const { f, frames, truth } = perform(passes(2));
    const est = run(f, frames);
    let checked = 0, right = 0;
    for (const e of est) {
      // Past the first seconds of the tune: those are the acquisition.
      if (e.at < 5 || e.quaver === null) continue;
      const tq = truth(e.at);
      if (tq === null) continue;
      checked++;
      if (gap(e.quaver, tq) < 0.6) right++;
    }
    expect(checked).toBeGreaterThan(500);
    expect(right / checked).toBeGreaterThan(0.95);
    // The tempo it reads: 1 / 0.14 s ≈ 7.1 quavers a second, give or take
    // the drift.
    const rates = est.filter(e => e.quaver !== null && e.at > 5).map(e => e.rate);
    const mid = rates.sort((a, b) => a - b)[Math.floor(rates.length / 2)]!;
    expect(mid).toBeGreaterThan(6.3);
    expect(mid).toBeLessThan(8);
  });

  it('shows nothing before the tune, and is lost once it stops', () => {
    const { f, frames, end } = perform(passes(1), { lead: 3 });
    const est = run(f, frames);
    expect(est.slice(0, Math.floor(2.5 * FOLLOW_FPS)).every(e => e.state === 'search')).toBe(true);
    expect(est.some(e => e.state === 'follow')).toBe(true);
    expect(est[est.length - 1]!.state).toBe('lost');
    // Not long after the last note — and this noise, a quarter of the
    // music's energy spread over every pitch, is no room falling silent: it
    // is loud enough to be read, and scores outside barely better than in.
    const lostAt = est.findIndex((e, k) => k > end * FOLLOW_FPS && e.state === 'lost');
    expect(lostAt / FOLLOW_FPS - end).toBeLessThan(3);
  });

  it('finds the tune again after a pause, started elsewhere', () => {
    // Half a pass, two seconds of silence, then the second half from bar 5.
    const silence = Array.from({ length: 14 }, () => null);
    const { f, frames, truth } = perform([...passes(1).slice(0, 32), ...silence, ...passes(1, 32), ...passes(1)], { drift: 0 });
    const est = run(f, frames);
    const restart = 2 + 46 * 0.14;
    // Back on the right quaver within three seconds, and staying there for
    // the pass begun at bar 5. Not the pass after it: going back to bar 1,
    // whose first fourteen quavers are bar 5's, cannot be told from going on
    // until the two part ways — nor is it, by anyone listening.
    const after = est.filter(e => e.at > restart + 3 && e.at < restart + N * 0.14 && e.quaver !== null && truth(e.at) !== null);
    expect(after.length).toBeGreaterThan(200);
    const right = after.filter(e => gap(e.quaver!, truth(e.at)!) < 0.6).length;
    expect(right / after.length).toBeGreaterThan(0.95);
  });

  it('goes on through a bar played otherwise rather than jumping', () => {
    // The first take from the app (2026-11-01): a bar varied, the cursor
    // jumped to where those notes are written. Here bar 3 of the second pass
    // sounds, note for note, as bar 7 is written — the hardest variation:
    // a whole bar of evidence for elsewhere. The place stays bar 3, then
    // bar 4, all but a tenth of a second or so.
    const played = passes(2);
    const sounds = played.map((q, k) => (k >= N + 16 && k < N + 24 ? q + 32 : q));
    const { f, frames, truth } = perform(played, {}, sounds);
    const from = 2 + (N + 16) * 0.14, to = from + 3;
    const off = (opts: Partial<LiveFollowOptions>) => run(f, frames, opts)
      .filter(e => e.at > from && e.at < to && e.quaver !== null && truth(e.at) !== null)
      .filter(e => gap(e.quaver!, truth(e.at)!) > 2).length;
    expect(off({})).toBeLessThan(8);
    // Where it used to jump, for most of a second: leaving the tune and
    // coming back in cost 19, and nothing kept the part being played.
    expect(off({ exitPenalty: 4, wrongPenalty: Infinity, quietPenalty: 0, jumpMargin: 0, jumpFrames: 0 })).toBeGreaterThan(30);
  });
});

describe('live cursor', () => {
  const at = (q: number, t: number, rate = 7): LiveEstimate => ({ state: 'follow', quaver: q, at: t, rate, bpm: 210, match: 1 });

  it('runs on at the tempo between estimates, carried to the moment drawn', () => {
    const c = new LiveCursor(N);
    c.update(at(10, 1));
    // Drawn 0.2 s after the moment of the estimate: 1.4 quavers further.
    expect(c.position(1.2)).toBeCloseTo(11.4);
    expect(c.position(1.3)).toBeCloseTo(12.1);
  });

  it('makes up a small gap without stepping back, and jumps for a large one', () => {
    const c = new LiveCursor(N);
    c.update(at(10, 1));
    let p = c.position(1)!;
    // The music turns out to be half a quaver behind: the cursor slows
    // down, never goes back.
    c.update(at(9.5, 1.1));
    for (let t = 1.0; t < 1.6; t += 1 / 60) {
      const q = c.position(t)!;
      expect(q).toBeGreaterThanOrEqual(p - 1e-9);
      p = q;
    }
    // Caught up by then.
    expect(Math.abs(p - (9.5 + 7 * (1.6 - 1.1)))).toBeLessThan(0.3);
    // Far off: the musician may be elsewhere — or the follower torn. The
    // cursor runs on where it is until that has held for confirmSeconds.
    c.update(at(40, 1.7));
    expect(Math.abs(c.position(1.7)! - 40)).toBeGreaterThan(10);
    c.update(at(42.1, 2.0));
    expect(Math.abs(c.position(2.0)! - 42.1)).toBeGreaterThan(10);
    expect(c.position(2.11)).toBeCloseTo(42.1 + 7 * 0.11);
  });

  it('wraps round the end of the pass, goes after a while without a position, and at once when lost', () => {
    const c = new LiveCursor(N);
    c.update(at(N - 0.5, 1));
    expect(c.position(1.2)).toBeCloseTo(0.9);
    c.update({ ...at(0, 1.3), quaver: null });
    expect(c.position(1.8)).not.toBeNull();
    expect(c.position(2.5)).toBeNull();
    c.update(at(5, 3));
    expect(c.position(3)).toBeCloseTo(5);
    c.update({ ...at(5, 3.1), state: 'lost', quaver: null });
    expect(c.position(3.1)).toBeNull();
  });
});
