import { describe, it, expect } from 'vitest';
import { FollowedTunes, rescored } from './followedTunes';
import type { Detection, DetectionEvent, WindowCandidate } from '../model';

const det = (id: string, tuneId: string, end: number | null) => ({ id, tuneId, end } as unknown as Detection);
const ev = (type: 'open' | 'update' | 'close', id: string, tuneId: string, end: number | null): DetectionEvent => ({ type, detection: det(id, tuneId, end) });
const cand = (tuneId: string, score: number): WindowCandidate => ({ tuneId, settingId: `s${tuneId}`, displayName: tuneId, dance: 'reel', meter: '4/4', score });

describe('FollowedTunes', () => {
  it('follows an open detection, and its tune one window after it closed', () => {
    const f = new FollowedTunes();
    f.update([ev('open', 'd1', '100', null)], 0);
    expect(f.tunes(1)).toEqual(['100']);
    f.update([ev('close', 'd1', '100', 30)], 1);
    expect(f.tunes(2)).toEqual(['100']);
    expect(f.tunes(3)).toEqual([]);
  });

  it('forgets a retracted detection', () => {
    const f = new FollowedTunes();
    f.update([ev('open', 'd1', '100', null)], 0);
    f.update([{ type: 'retract', id: 'd1' } as DetectionEvent], 1);
    expect(f.tunes(2)).toEqual([]);
  });

  it('follows the tune a detection is renamed to', () => {
    const f = new FollowedTunes();
    f.update([ev('open', 'd1', '100', null)], 0);
    f.update([ev('update', 'd1', '200', null)], 1);
    expect(f.tunes(2)).toEqual(['200']);
  });
});

describe('rescored', () => {
  it('averages over every opinion', () => {
    const out = rescored([cand('1', 0.6)], [new Map([['1', 0.3]]), new Map([['1', 0.9]])]);
    expect(+out[0]!.score.toFixed(3)).toBe(0.6);
  });

  it('puts each tune at the mean of its two scores, a tune the second opinion missed at its lowest', () => {
    const out = rescored([cand('1', 0.6), cand('2', 0.5), cand('3', 0.4)], [new Map([['1', 0.4], ['2', 0.7]])]);
    expect(out.map(c => [c.tuneId, +c.score.toFixed(3)])).toEqual([['2', 0.6], ['1', 0.5], ['3', 0.4]]);
  });

  it('leaves the candidates as they are without a second opinion', () => {
    const c = [cand('1', 0.6)];
    expect(rescored(c, [])).toBe(c);
    expect(rescored(c, [new Map()])).toBe(c);
  });
});
