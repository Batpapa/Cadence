import { describe, it, expect } from 'vitest';
import type { Detection, DetectionAlternate, DetectionEvent } from './model';
import { DetectionTracker, provisionalEnd } from './detectionState';

const KESH: DetectionAlternate = { tuneId: '1', settingId: '1', displayName: 'the kesh', dance: 'jig', meter: '6/8', meanScore: .8 };
const MORRISON: DetectionAlternate = { tuneId: '99', settingId: '99', displayName: 'morrison’s', dance: 'jig', meter: '6/8', meanScore: .4 };
const BUTTERFLY: DetectionAlternate = { tuneId: '5', settingId: '5', displayName: 'the butterfly', dance: 'slip jig', meter: '9/8', meanScore: .6 };

/** A decoder detection: closed and finalized unless told otherwise. An open
 *  one (`end: null`) is given evidence up to `heardTo`. */
function det(id: string, over: Partial<Detection> & { heardTo?: number } = {}, tune: DetectionAlternate = KESH): Detection {
  const { heardTo, ...rest } = over;
  const start = rest.start ?? 10;
  return {
    id, tuneId: tune.tuneId, settingId: tune.settingId, displayName: tune.displayName,
    dance: tune.dance, meter: tune.meter,
    start, end: 60, confidence: .8, bucket: 'high', meanScore: tune.meanScore,
    evidence: heardTo !== undefined ? [{ t: heardTo - 5, tEnd: heardTo, score: .8, margin: 0 }] : [],
    alternates: [], viterbiPick: tune,
    userConfirmed: false, liked: false, finalized: true,
    ...rest,
  };
}
const open = (d: Detection): DetectionEvent => ({ type: 'open', detection: d });
const update = (d: Detection): DetectionEvent => ({ type: 'update', detection: d });
const retract = (id: string): DetectionEvent => ({ type: 'retract', id });
const ids = (t: DetectionTracker) => t.list().map(d => d.id);

describe('DetectionTracker — the decoder alone', () => {
  it('opens, updates and closes', () => {
    const t = new DetectionTracker();
    t.apply([open(det('a'))]);
    expect(t.get('a')?.end).toBe(60);
    t.apply([{ type: 'close', detection: det('a', { end: 75 }) }]);
    expect(t.get('a')?.end).toBe(75);
  });

  it('retracts a guess nobody vouched for', () => {
    const t = new DetectionTracker();
    t.apply([open(det('a')), open(det('b', { start: 70, end: 90 })), retract('a')]);
    expect(ids(t)).toEqual(['b']);
  });

  it('carries the like marker and hand-named variants across an update', () => {
    const t = new DetectionTracker();
    t.apply([open(det('a'))]);
    t.toggleLike('a');
    t.addManualAlternate('a', MORRISON);
    t.apply([update(det('a', { end: 80 }))]);
    expect(t.get('a')?.liked).toBe(true);
    expect(t.get('a')?.manualAlternates).toEqual([MORRISON]);
  });

  it('sorts by start', () => {
    const t = new DetectionTracker();
    t.apply([open(det('b', { start: 70, end: 90 })), open(det('a'))]);
    expect(ids(t)).toEqual(['a', 'b']);
  });
});

describe('DetectionTracker — confirming while it plays (2026-10-10)', () => {
  it('confirms an open detection: same id, the user’s tune, the decoder’s timing', () => {
    const t = new DetectionTracker();
    t.apply([open(det('a', { end: null, finalized: false, heardTo: 30 }))]);
    t.confirm('a', MORRISON);
    expect(t.get('a')).toMatchObject({ tuneId: '99', userConfirmed: true, end: null });
    t.apply([update(det('a', { end: null, finalized: false, heardTo: 50, confidence: .5 }))]);
    expect(t.get('a')).toMatchObject({ tuneId: '99', userConfirmed: true, confidence: .5 });
    expect(provisionalEnd(t.get('a')!)).toBe(50);
  });

  it('follows the stretch when the decoder hands it to another tune', () => {
    const t = new DetectionTracker();
    t.apply([open(det('a', { end: null, finalized: false, heardTo: 30 }))]);
    t.confirm('a', KESH);
    // The decoder now calls that stretch The Butterfly, under a new id.
    t.apply([retract('a'), open(det('c', { end: null, finalized: false, heardTo: 40 }, BUTTERFLY))]);
    expect(ids(t)).toEqual(['a']);
    expect(t.get('a')).toMatchObject({ tuneId: '1', userConfirmed: true });
    // …and back to the Kesh, under yet another id: still one detection.
    t.apply([retract('c'), open(det('a2', { end: null, finalized: false, heardTo: 55 }))]);
    expect(ids(t)).toEqual(['a']);
    t.apply([{ type: 'close', detection: det('a2', { end: 70 }) }]);
    expect(t.get('a')).toMatchObject({ end: 70, finalized: true, userConfirmed: true });
  });

  it('keeps a stretch the decoder abandons, as last seen, until the end settles it', () => {
    const t = new DetectionTracker();
    t.apply([open(det('a', { end: null, finalized: false, heardTo: 40 }))]);
    t.confirm('a', KESH);
    t.apply([retract('a')]);
    expect(t.get('a')).toMatchObject({ start: 10, end: 40, finalized: false, userConfirmed: true });
    t.finish([]);
    expect(t.get('a')?.finalized).toBe(true);
  });

  it('can be absorbed into a merge, and the merge is confirmed', () => {
    const t = new DetectionTracker();
    t.apply([open(det('a', { start: 10, end: 40, finalized: false })), open(det('b', { start: 40, end: 80, finalized: false }, BUTTERFLY))]);
    t.confirm('a', KESH);
    t.apply([retract('a'), retract('b'), open(det('m', { start: 10, end: 80, finalized: false }, BUTTERFLY))]);
    expect(ids(t)).toEqual(['a']);
    expect(t.get('a')).toMatchObject({ start: 10, end: 80, tuneId: '1', userConfirmed: true });
  });

  it('keeps only the latest of two confirmations on one detection', () => {
    const t = new DetectionTracker();
    t.apply([open(det('a', { start: 10, end: 40, finalized: false })), open(det('b', { start: 40, end: 80, finalized: false }, BUTTERFLY))]);
    t.confirm('a', KESH);
    t.confirm('b', MORRISON);
    t.apply([retract('a'), retract('b'), open(det('m', { start: 10, end: 80, finalized: false }))]);
    // Both ranges land on the merge; b was confirmed last.
    expect(ids(t)).toEqual(['b']);
    expect(t.get('b')?.tuneId).toBe('99');
    const dom = t.dominated();
    expect(dom).toHaveLength(1);
    expect(dom[0]!.loser).toMatchObject({ id: 'a', tuneId: '1' });
    expect(dom[0]!.winner.id).toBe('b');
  });

  it('a re-confirmation is the latest word', () => {
    const t = new DetectionTracker();
    t.apply([open(det('a', { start: 10, end: 40, finalized: false })), open(det('b', { start: 40, end: 80, finalized: false }))]);
    t.confirm('a', KESH);
    t.confirm('b', MORRISON);
    t.confirm('a', BUTTERFLY);
    t.apply([retract('a'), retract('b'), open(det('m', { start: 10, end: 80, finalized: false }))]);
    expect(ids(t)).toEqual(['a']);
    expect(t.get('a')?.tuneId).toBe('5');
  });

  it('holds its range: the detection covering most of it wins, not the one that kept its id', () => {
    const t = new DetectionTracker();
    t.apply([open(det('a', { start: 0, end: null, finalized: false, heardTo: 10 }))]);
    t.confirm('a', KESH);
    // The decoder moves its own 'a' to 8 s on, and gives 0–8 to the tune before.
    t.apply([
      update(det('a', { start: 8, end: 70, finalized: false })),
      open(det('p', { start: -50, end: 8, finalized: false }, BUTTERFLY)),
    ]);
    expect(t.get('a')).toMatchObject({ start: -50, end: 8, tuneId: '1', userConfirmed: true });
    // The decoder's own 'a' still shows — under another id, never a duplicate.
    const others = t.list().filter(d => d.id !== 'a');
    expect(others).toHaveLength(1);
    expect(others[0]).toMatchObject({ start: 8, userConfirmed: false });
    expect(others[0]!.id).not.toBe('a');
  });

  it('un-confirming hands the detection back to the decoder, with its marks', () => {
    const t = new DetectionTracker();
    t.apply([open(det('a', { end: null, finalized: false, heardTo: 30 }))]);
    t.confirm('a', MORRISON);
    t.toggleLike('a');
    t.apply([retract('a'), open(det('c', { end: null, finalized: false, heardTo: 40 }, BUTTERFLY))]);
    t.confirm('a', null);
    expect(ids(t)).toEqual(['c']);
    expect(t.get('c')).toMatchObject({ tuneId: '5', userConfirmed: false, liked: true });
  });

  it('keeps the like marker on a confirmed detection whatever the decoder does', () => {
    const t = new DetectionTracker();
    t.apply([open(det('a', { end: null, finalized: false, heardTo: 30 }))]);
    t.confirm('a', KESH);
    t.toggleLike('a');
    t.apply([retract('a'), open(det('c', { end: null, finalized: false, heardTo: 40 }, BUTTERFLY))]);
    expect(t.get('a')?.liked).toBe(true);
  });

  it('removing the hand-named tune it is confirmed as hands it back', () => {
    const t = new DetectionTracker();
    t.apply([open(det('a'))]);
    t.addManualAlternate('a', MORRISON);
    t.confirm('a', MORRISON);
    t.removeManualAlternate('a', '99');
    expect(t.get('a')).toMatchObject({ tuneId: '1', userConfirmed: false, manualAlternates: undefined });
  });

  it('puts a draft’s confirmations back on a replay', () => {
    const t = new DetectionTracker();
    t.apply([open(det('a', { end: null, finalized: false, heardTo: 30 }))]);
    t.confirm('a', MORRISON);
    const saved = t.snapshot();

    // The replay makes its own ids.
    const replay = new DetectionTracker();
    replay.restore(saved);
    replay.apply([open(det('x1', { end: 65, finalized: false }))]);
    replay.finish([{ type: 'close', detection: det('x1', { end: 65 }) }]);
    expect(replay.list()).toHaveLength(1);
    expect(replay.get('a')).toMatchObject({ tuneId: '99', end: 65, finalized: true, userConfirmed: true });
  });
});

describe('DetectionTracker.takeSettled', () => {
  it('reports a detection once when it finalizes, and again if its end moves', () => {
    const t = new DetectionTracker();
    t.apply([open(det('a', { end: null, finalized: false, heardTo: 30 }))]);
    expect(t.takeSettled()).toEqual([]);
    t.apply([{ type: 'close', detection: det('a', { end: 62 }) }]);
    expect(t.takeSettled().map(d => d.end)).toEqual([62]);
    expect(t.takeSettled()).toEqual([]);
    t.apply([update(det('a', { end: 64 }))]);
    expect(t.takeSettled().map(d => d.end)).toEqual([64]);
  });
});
