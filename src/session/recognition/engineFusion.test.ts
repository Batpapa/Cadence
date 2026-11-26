import { describe, it, expect } from 'vitest';
import { fuseCandidates } from './engineFusion';
import type { WindowCandidate } from '../model';

const cand = (tuneId: string, score: number, extra: Partial<WindowCandidate> = {}): WindowCandidate =>
  ({ tuneId, settingId: `s${tuneId}`, displayName: tuneId, dance: 'reel', meter: '4/4', score, ...extra });

describe('fuseCandidates', () => {
  it('scores a tune heard by both transcriptions at the mean of its scores', () => {
    const out = fuseCandidates([cand('1', 0.8), cand('2', 0.5)], [cand('1', 0.6), cand('2', 0.7)]);
    expect(out.map(c => [c.tuneId, +c.score.toFixed(3)])).toEqual([['1', 0.7], ['2', 0.6]]);
  });

  it('counts a tune missing from a list at that list\'s last score', () => {
    const out = fuseCandidates([cand('1', 0.8), cand('2', 0.4)], [cand('3', 0.9), cand('1', 0.6)]);
    // 1: (0.8 + 0.6) / 2; 3: (0.4 + 0.9) / 2; 2: (0.4 + 0.6) / 2
    expect(out.map(c => [c.tuneId, +c.score.toFixed(3)])).toEqual([['1', 0.7], ['3', 0.65], ['2', 0.5]]);
  });

  it('keeps the setting, key and pitch of the transcription that heard the tune best', () => {
    const out = fuseCandidates([cand('1', 0.5, { settingId: 'a', transpose: 2, pitch: 2.1 })], [cand('1', 0.7, { settingId: 'b', pitch: -0.1 })]);
    expect(out[0]).toMatchObject({ settingId: 'b', pitch: -0.1, score: 0.6 });
    expect(out[0]!.transpose).toBeUndefined();
  });

  it('leaves the other list as it is when one transcription heard nothing', () => {
    const a = [cand('1', 0.8), cand('2', 0.5)];
    expect(fuseCandidates(a, [])).toEqual(a);
    expect(fuseCandidates([], a)).toEqual(a);
  });

  it('keeps at most the top ten', () => {
    const a = Array.from({ length: 10 }, (_, i) => cand(`a${i}`, 0.9 - i * 0.01));
    const b = Array.from({ length: 10 }, (_, i) => cand(`b${i}`, 0.9 - i * 0.01));
    expect(fuseCandidates(a, b)).toHaveLength(10);
  });
});
