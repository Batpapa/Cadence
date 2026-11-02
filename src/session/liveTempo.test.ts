import { describe, it, expect } from 'vitest';
import { TempoTracker, estimateRate, TEMPO_OPTIONS } from './liveTempo';

const FPS = 48000 / 1024;

/** Features of a tune played at `rate` quavers a second: one pitch per
 *  quaver, walking a scale, nothing else sounding but a little noise. */
function played(rate: number, seconds: number, from = 0): Float32Array {
  const frames = Math.round(seconds * FPS);
  const out = new Float32Array(frames * 48);
  for (let f = 0; f < frames; f++) {
    const quaver = Math.floor(((from + f) / FPS) * rate);
    const pitch = 12 + ((quaver * 5) % 14);
    for (let p = 0; p < 48; p++) out[f * 48 + p] = 0.01;
    out[f * 48 + pitch] = 1;
  }
  return out;
}

/** Features with no pulse: a new pitch on random frames. */
function noise(seconds: number, seed = 3): Float32Array {
  let s = seed;
  const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const frames = Math.round(seconds * FPS);
  const out = new Float32Array(frames * 48);
  let pitch = 20;
  for (let f = 0; f < frames; f++) {
    if (rnd() < 0.15) pitch = Math.floor(rnd() * 48);
    for (let p = 0; p < 48; p++) out[f * 48 + p] = 0.05 * rnd();
    out[f * 48 + pitch] = 0.3 + rnd();
  }
  return out;
}

/** Fed a second at a time, read after each, as the worker does. */
function run(tracker: TempoTracker, features: Float32Array) {
  const step = Math.round(FPS) * 48;
  const readings = [];
  for (let at = 0; at < features.length; at += step) {
    tracker.push(features.subarray(at, at + step));
    readings.push(tracker.read(tracker.frames / FPS).reading);
  }
  return readings;
}

describe('estimateRate', () => {
  it('finds the quaver rate of a reel and of a jig', () => {
    for (const rate of [7.1, 6.3, 4.4]) {
      const F = played(rate, 12);
      const tracker = new TempoTracker(FPS);
      tracker.push(F);
      expect(tracker.estimate()!.rate).toBeCloseTo(rate, 1);
    }
  });

  it('says nothing of a flat curve', () => {
    expect(estimateRate(new Float32Array(600), FPS)).toBeNull();
  });
});

describe('TempoTracker', () => {
  it('listens for its first seconds, then shows the pulse', () => {
    const readings = run(new TempoTracker(FPS), played(7, 20));
    const firstPulse = readings.findIndex(r => r.state === 'pulse');
    expect(readings.slice(0, TEMPO_OPTIONS.minSeconds - 1).every(r => r.state === 'listening')).toBe(true);
    // Four agreeing estimates are asked for, one a second.
    expect(firstPulse).toBeGreaterThanOrEqual(TEMPO_OPTIONS.minSeconds + TEMPO_OPTIONS.agree - 2);
    const last = readings[readings.length - 1]!;
    expect(last.state).toBe('pulse');
    if (last.state === 'pulse') expect(last.rate).toBeCloseTo(7, 1);
  });

  it('shows no pulse over noise', () => {
    const readings = run(new TempoTracker(FPS), noise(40));
    expect(readings.filter(r => r.state === 'pulse').length).toBe(0);
  });

  it('drops the pulse as soon as the music stops', () => {
    const tracker = new TempoTracker(FPS);
    run(tracker, played(7, 20));
    const after = run(tracker, noise(12));
    expect(after[after.length - 1]!.state).toBe('none');
  });

  it('starts listening again after a reset', () => {
    const tracker = new TempoTracker(FPS);
    run(tracker, played(7, 20));
    tracker.reset();
    expect(run(tracker, played(6, 2))[1]!.state).toBe('listening');
  });

  it('reads the same whether fed in large or small pieces', () => {
    const F = played(6.5, 15);
    const a = new TempoTracker(FPS);
    a.push(F);
    const b = new TempoTracker(FPS);
    for (let at = 0; at < F.length; at += 16 * 48) b.push(F.subarray(at, at + 16 * 48));
    expect(b.estimate()).toEqual(a.estimate());
  });
});
