import { describe, it, expect } from 'vitest';
import type { Detection } from './model';
import type { TempoReading } from './liveTempo';
import {
  approxTempo, currentPoint, detectionAt, DetectionTempoCache, inBeats, insideCurve, insideTempo, sessionCurve, smoothedTempo, summariseInside, withTempo,
} from './tempoSummary';
import { NoveltyStore } from './liveTempo';

const det = (id: string, start: number, end: number | null, meter: string, dance = meter === '6/8' ? 'jig' : 'reel'): Detection =>
  ({ id, tuneId: id, settingId: id, displayName: id, dance, meter, start, end } as unknown as Detection);

const pulses = (from: number, to: number, rate: (t: number) => number): TempoReading[] => {
  const out: TempoReading[] = [];
  for (let t = from; t <= to; t++) out.push({ t, state: 'pulse', rate: rate(t) });
  return out;
};

describe('detectionAt', () => {
  it('takes the newest of overlapping detections, and an open one', () => {
    const a = det('a', 0, 100, '4/4'), b = det('b', 90, null, '6/8');
    expect(detectionAt([a, b], 50)).toBe(a);
    expect(detectionAt([a, b], 95)).toBe(b);
    expect(detectionAt([a, b], 500)).toBe(b);
    expect(detectionAt([a], 150)).toBeNull();
  });
});

describe('inBeats', () => {
  it("counts in the dance's beat, in quavers without a tune", () => {
    expect(inBeats(7, det('r', 0, null, '4/4'))).toEqual({ value: 105, unit: 'minim', quaversPerMinute: 420 });
    expect(inBeats(7, det('p', 0, null, '2/4', 'polka')).unit).toBe('crotchet');
    expect(inBeats(6.3, det('j', 0, null, '6/8')).unit).toBe('dottedCrotchet');
    expect(inBeats(6.3, det('j', 0, null, '6/8')).value).toBeCloseTo(126, 6);
    expect(inBeats(7, null)).toEqual({ value: 420, unit: 'quaver', quaversPerMinute: 420 });
  });
});

describe('smoothedTempo', () => {
  it('takes a lone slip off, and draws across a missed reading or two', () => {
    const readings: TempoReading[] = [
      ...pulses(0, 20, t => (t === 15 ? 10.5 : 7)),
      { t: 21, state: 'none' },
      { t: 22, state: 'none' },
      ...pulses(23, 40, () => 7),
    ];
    const points = smoothedTempo(readings);
    expect(points).toHaveLength(39);
    expect(points.every(p => p.rate === 7 && p.run === 0)).toBe(true);
  });

  it('breaks at a long silence, and where listening starts again', () => {
    const points = smoothedTempo([
      ...pulses(0, 20, () => 7),
      ...pulses(40, 60, () => 5),
      { t: 61, state: 'listening' },
      ...pulses(62, 70, () => 6),
    ]);
    expect(points.find(p => p.t === 20)).toEqual({ t: 20, rate: 7, run: 0 });
    expect(points.find(p => p.t === 40)).toEqual({ t: 40, rate: 5, run: 1 });
    expect(points.find(p => p.t === 62)).toEqual({ t: 62, rate: 6, run: 2 });
  });
});

describe('currentPoint', () => {
  it('holds the last tempo a few seconds, then lets it go', () => {
    const base = pulses(0, 20, () => 7);
    const none = (from: number, to: number): TempoReading[] => pulses(from, to, () => 0).map(r => ({ t: r.t, state: 'none' as const }));
    expect(currentPoint([...base, ...none(21, 25)])?.rate).toBe(7);
    expect(currentPoint([...base, ...none(21, 40)])).toBeNull();
    expect(currentPoint([...base, { t: 21, state: 'listening' }])).toBeNull();
  });
});

const FPS = 48000 / 1024;

/** The novelty of tunes played one after the other, each at its quaver rate
 *  (per second, possibly moving): a spike at every quaver. */
function played(...tunes: Array<{ seconds: number; rate: (t: number) => number }>): NoveltyStore {
  const store = new NoveltyStore(FPS);
  let at = 0;
  for (const tune of tunes) {
    const n = Math.round(tune.seconds * FPS);
    const values = new Float32Array(n);
    let phase = 0;
    for (let f = 0; f < n; f++) {
      const before = phase;
      phase += tune.rate(f / FPS) / FPS;
      values[f] = Math.floor(phase) > Math.floor(before) ? 1 : 0.05;
    }
    store.write(at, values);
    at += n;
  }
  return store;
}

describe("a detection's own tempo", () => {
  it('never hears the tune before it, and gives a short tune a "~" tempo', () => {
    // A reel at 9 quavers a second, then one at 7 from 20 s.
    const store = played({ seconds: 20, rate: () => 9 }, { seconds: 60, rate: () => 7 });
    const it = insideTempo(det('b', 20, 80, '4/4'), store)!;
    expect(it.rate).toBeCloseTo(7, 1);
    expect(it.approx).toBe(false);
    // Its first seconds share the window [20, 32]: no point hears the 9.
    expect(it.points.every(p => Math.abs(p.rate - 7) < 0.2)).toBe(true);
    expect(new Set(it.points.filter(p => p.t < 32).map(p => p.from))).toEqual(new Set([20]));
    const short = insideTempo(det('s', 20, 28, '4/4'), store)!;
    expect(short.rate).toBeCloseTo(7, 1);
    expect(short.approx).toBe(true);
    expect(approxTempo(det('s', 20, 28, '4/4'))).toBe(true);
  });

  it("gives each tune its tempo in its beat, and how it moved", () => {
    const store = played({ seconds: 120, rate: t => 7 * (1 + 0.04 * (t / 120)) }, { seconds: 80, rate: () => 6 });
    const reel = det('reel', 0, 120, '4/4'), jig = det('jig', 120, null, '6/8');
    const cache = new DetectionTempoCache();
    const r = cache.get(reel, store)!, j = cache.get(jig, store)!;
    expect(inBeats(r.rate, reel).unit).toBe('minim');
    expect(r.change!).toBeGreaterThan(0.02);
    expect(inBeats(j.rate, jig).unit).toBe('dottedCrotchet');
    expect(inBeats(j.rate, jig).value).toBeCloseTo(120, 0);
  });

  it('is saved on each closed detection, never on one added by hand', () => {
    const store = played({ seconds: 110, rate: () => 7 });
    const heard = det('heard', 0, 100, '4/4'), short = det('short', 100, 108, '4/4'), open = det('open', 100, null, '4/4');
    const manual = { ...det('manual', 0, 100, '4/4'), manual: true } as Detection;
    const [a, b, c, d] = withTempo([heard, short, manual, open], store);
    expect(a!.quaverRate).toBeCloseTo(7, 1);
    expect(b!.quaverRate).toBeCloseTo(7, 1);
    expect(c).toBe(manual);
    expect(d).toBe(open);
  });

  it("draws a detection's curve without the tracker's slips", () => {
    const it = { rate: 7, approx: false, weak: false, change: null, points: [
      { t: 0, from: 0, span: 12, rate: 7, strength: 0.1 },
      { t: 1, from: 0, span: 12, rate: 10.5, strength: 0.02 },
      { t: 13, from: 1, span: 12, rate: 7.1, strength: 0.1 },
    ] };
    expect(insideCurve(it).map(p => p.t)).toEqual([0, 13]);
  });

  it("says how it moved from the windows its tempo counts, not from its slips", () => {
    // Jerry Daly's (2026-11-02): its first windows weak and half again too fast.
    const window = (from: number, rate: number, strength: number) => ({ t: from + 12, from, span: 12, rate, strength });
    const points = [
      ...Array.from({ length: 20 }, (_, i) => window(i, 10.5, 0.01)),
      ...Array.from({ length: 40 }, (_, i) => window(20 + i, 7, 0.07)),
    ];
    const it = summariseInside(points)!;
    expect(it.rate).toBe(7);
    expect(it.change).toBe(0);
    expect(it.weak).toBe(false);
    expect(insideCurve(it).every(p => !p.approx)).toBe(true);
  });

  it('marks a tempo read from weak windows only with a "~"', () => {
    // Old Joe's (2026-11-02): a tempo on its card, no window with a clear pulse.
    const points = Array.from({ length: 20 }, (_, i) => ({ t: i + 12, from: i, span: 12, rate: 6.65, strength: 0.03 }));
    const it = summariseInside(points)!;
    expect(it.rate).toBe(6.65);
    expect(it.weak).toBe(true);
    expect(insideCurve(it).every(p => p.approx)).toBe(true);
  });
});

describe("the session's curve", () => {
  it("draws each tune's own curve, and the readings only where they hear none", () => {
    // A reel at 9 quavers a second, a polka at 4.85 from 60 s to 100 s, then
    // music no tune was recognised in, at 7.4.
    const store = played({ seconds: 60, rate: () => 9 }, { seconds: 40, rate: () => 4.85 }, { seconds: 60, rate: () => 7.4 });
    const reel = det('reel', 0, 60, '4/4'), polka = det('polka', 60, 100, '2/4', 'polka');
    // The readings hear 12 s back: the reel until 72, the polka until 112.
    const readings = [...pulses(12, 72, () => 9), ...pulses(73, 111, () => 4.85), ...pulses(112, 160, () => 7.4)];
    const cache = new DetectionTempoCache();
    const curve = sessionCurve(readings, [reel, polka], d => cache.get(d, store));
    const at = (from: number, to: number) => curve.filter(p => p.t >= from && p.t <= to);
    expect(at(0, 59).every(p => Math.abs(p.rate - 9) < 0.2)).toBe(true);
    expect(at(60, 100).length).toBeGreaterThan(30);
    expect(at(60, 100).every(p => Math.abs(p.rate - 4.85) < 0.2)).toBe(true);
    expect(at(101, 111)).toEqual([]);
    expect(at(112, 160).every(p => p.rate === 7.4)).toBe(true);
    expect(new Set(curve.map(p => p.run)).size).toBe(3);
  });

  it("gives the tempo now in a tune its readings find no pulse in", () => {
    // Old Joe's, 2026-11-02: no reading strong enough, its card at 133.
    const store = played({ seconds: 28, rate: () => 6.65 });
    const tune = det('joe', 0, null, '6/8');
    const readings: TempoReading[] = Array.from({ length: 28 }, (_, i) => ({ t: i + 1, state: i < 8 ? 'listening' as const : 'none' as const }));
    expect(currentPoint(readings)).toBeNull();
    const now = currentPoint(readings, sessionCurve(readings, [tune], d => new DetectionTempoCache().get(d, store)));
    expect(now!.rate).toBeCloseTo(6.65, 1);
  });
});
