import { describe, it, expect } from 'vitest';
import type { Detection, DetectionAlternate } from './model';
import { manualDetection, insertionIndex, alternatePickFields, viterbiPickOf } from './model';

const tune: DetectionAlternate = {
  tuneId: '182', settingId: '400', displayName: 'the kesh',
  dance: 'jig', meter: '6/8', meanScore: 0,
};

function det(id: string, start: number, end: number | null = start + 60): Detection {
  const pick = { tuneId: '1', settingId: '1', displayName: 'cooley', dance: 'reel', meter: '4/4', meanScore: .8 };
  return {
    id, ...pick, start, end, confidence: .8, bucket: 'high',
    evidence: [], alternates: [], viterbiPick: pick,
    userConfirmed: false, liked: false, finalized: true,
  };
}

describe('manualDetection', () => {
  it('is born confirmed, finalized and marked as hand-made', () => {
    const d = manualDetection(tune, 120, 300);
    expect(d.manual).toBe(true);
    expect(d.userConfirmed).toBe(true);
    expect(d.finalized).toBe(true);
    expect([d.start, d.end]).toEqual([120, 300]);
  });

  it('carries the tune and its most popular setting', () => {
    const d = manualDetection(tune, 0, 10);
    expect(d.tuneId).toBe('182');
    expect(d.settingId).toBe('400');
    expect(d.displayName).toBe('the kesh');
  });

  // The card's badge and the timeline strip both read these, and a hand-added
  // detection has to look like a confirmed one rather than a weak result.
  it('reads as certain, and never as a match score', () => {
    const d = manualDetection(tune, 0, 10);
    expect(d.confidence).toBe(1);
    expect(d.bucket).toBe('high');
    expect(d.meanScore).toBe(0);
  });

  it('claims no observation and no rivals', () => {
    const d = manualDetection(tune, 0, 10);
    expect(d.evidence).toEqual([]);
    expect(d.alternates).toEqual([]);
  });

  it('gives every detection its own id', () => {
    expect(manualDetection(tune, 0, 10).id).not.toBe(manualDetection(tune, 0, 10).id);
  });

  // Re-pointing it at another tune keeps it hand-made: what changes is which
  // tune was played, not that a person is the one saying so.
  it('stays manual when its identity is re-picked', () => {
    const d = manualDetection(tune, 0, 10);
    const other: DetectionAlternate = { ...tune, tuneId: '9', settingId: '90', displayName: 'cooley' };
    const next = { ...d, ...alternatePickFields(d, other) };
    expect(next.manual).toBe(true);
    expect(next.tuneId).toBe('9');
    expect(next.userConfirmed).toBe(true);
  });

  it('has no decoder answer hiding behind it', () => {
    const d = manualDetection(tune, 0, 10);
    expect(viterbiPickOf(d).tuneId).toBe(tune.tuneId);
    expect(viterbiPickOf(d).meanScore).toBe(0);
  });
});

describe('insertionIndex', () => {
  const anns = [det('a', 0), det('b', 100), det('c', 400)];

  it('finds the hole between two detections', () => {
    expect(insertionIndex(anns, 250)).toBe(2);
  });

  it('puts an early tune first and a late one last', () => {
    expect(insertionIndex(anns, 0)).toBe(1);
    expect(insertionIndex(anns, 900)).toBe(3);
  });

  it('keeps a flush neighbour in front on a tie', () => {
    expect(insertionIndex(anns, 100)).toBe(2);
  });

  it('handles an empty analysis', () => {
    expect(insertionIndex([], 42)).toBe(0);
  });

  it('leaves the list sorted', () => {
    const list = [...anns];
    const added = det('new', 250);
    list.splice(insertionIndex(list, added.start), 0, added);
    expect(list.map(d => d.start)).toEqual([0, 100, 250, 400]);
  });
});
