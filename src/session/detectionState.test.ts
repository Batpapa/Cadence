import { describe, it, expect } from 'vitest';
import type { Detection } from './model';
import { applyDetectionEvents } from './detectionState';

function det(id: string, over: Partial<Detection> = {}): Detection {
  const pick = { tuneId: '1', settingId: '1', displayName: 'the kesh', dance: 'jig', meter: '6/8', meanScore: .8 };
  return {
    id, ...pick, start: 10, end: 60, confidence: .8, bucket: 'high',
    evidence: [], alternates: [], viterbiPick: pick,
    userConfirmed: false, liked: false, finalized: true,
    ...over,
  };
}
const map = (...ds: Detection[]) => new Map(ds.map(d => [d.id, d]));

describe('applyDetectionEvents', () => {
  it('opens and updates', () => {
    const anns = map();
    applyDetectionEvents(anns, [{ type: 'open', detection: det('a') }]);
    expect(anns.get('a')?.end).toBe(60);
    applyDetectionEvents(anns, [{ type: 'close', detection: det('a', { end: 75 }) }]);
    expect(anns.get('a')?.end).toBe(75);
  });

  it('retracts a guess nobody vouched for', () => {
    const anns = map(det('a'));
    applyDetectionEvents(anns, [{ type: 'retract', id: 'a' }]);
    expect(anns.has('a')).toBe(false);
  });

  it('never retracts one the user confirmed', () => {
    const anns = map(det('a', { userConfirmed: true }));
    applyDetectionEvents(anns, [{ type: 'retract', id: 'a' }]);
    expect(anns.has('a')).toBe(true);
  });

  it('keeps the user’s tune on a confirmed detection, and takes the new timing', () => {
    const anns = map(det('a', { userConfirmed: true, displayName: 'morrison’s', tuneId: '99' }));
    applyDetectionEvents(anns, [{ type: 'update', detection: det('a', { end: 90, confidence: .5 }) }]);
    const a = anns.get('a')!;
    expect(a.displayName).toBe('morrison’s');
    expect(a.tuneId).toBe('99');
    expect(a.end).toBe(90);
    expect(a.confidence).toBe(.5);
    expect(a.userConfirmed).toBe(true);
  });

  it('carries the like marker and hand-named variants across an update', () => {
    const manual = [{ tuneId: '7', settingId: '7', displayName: 'x', dance: 'reel', meter: '4/4', meanScore: 0 }];
    const anns = map(det('a', { liked: true, manualAlternates: manual }));
    applyDetectionEvents(anns, [{ type: 'update', detection: det('a', { end: 80 }) }]);
    expect(anns.get('a')?.liked).toBe(true);
    expect(anns.get('a')?.manualAlternates).toEqual(manual);
  });

  it('carries them onto a detection that was never seen before as defaults', () => {
    const anns = map();
    applyDetectionEvents(anns, [{ type: 'open', detection: det('a') }]);
    expect(anns.get('a')?.liked).toBe(false);
    expect(anns.get('a')?.manualAlternates).toBeUndefined();
  });

  it('applies a whole batch in order', () => {
    const anns = map();
    applyDetectionEvents(anns, [
      { type: 'open', detection: det('a') },
      { type: 'open', detection: det('b') },
      { type: 'retract', id: 'a' },
    ]);
    expect([...anns.keys()]).toEqual(['b']);
  });
});
