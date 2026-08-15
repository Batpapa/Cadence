import { describe, it, expect } from 'vitest';
import { buildTemporalTimeline } from './temporalObservationBuilder';
import { DETECTION_TEMPORAL_CONFIG } from './detectionTemporalConfig';
import type { WindowResult, WindowCandidate } from '../model';

const HOP = 5;

function cand(tuneId: string, score: number): WindowCandidate {
  return { tuneId, settingId: `s${tuneId}`, displayName: `Tune ${tuneId}`, dance: 'reel', meter: '4/4', score };
}

function win(i: number, candidates: WindowCandidate[]): WindowResult {
  const t = i * HOP;
  return { tWindowStart: t, tWindowEnd: t + 15, empty: candidates.length === 0, candidates };
}

describe('buildTemporalTimeline', () => {
  it('zero-fills a tuneId absent from a window rather than skipping it', () => {
    const windows = [win(0, [cand('A', 0.9)]), win(1, []), win(2, [cand('A', 0.8)])];
    const t = buildTemporalTimeline(windows, DETECTION_TEMPORAL_CONFIG);
    expect(t.observations.get('A')).toEqual([0.9, 0, 0.8]);
  });

  it('keeps a tune whose best score is only reached in a later window', () => {
    const windows = [win(0, [cand('A', 0.1)]), win(1, [cand('A', 0.15)]), win(2, [cand('A', 0.9)])];
    const t = buildTemporalTimeline(windows, DETECTION_TEMPORAL_CONFIG);
    expect(t.tuneIds).toContain('A');
    expect(t.observations.get('A')).toEqual([0.1, 0.15, 0.9]);
  });

  it('drops a tune whose best-ever score never clears minCandidateProbability', () => {
    const windows = [win(0, [cand('A', 0.05)]), win(1, [cand('A', 0.1)])];
    const t = buildTemporalTimeline(windows, DETECTION_TEMPORAL_CONFIG);
    expect(t.tuneIds).not.toContain('A');
    expect(t.observations.has('A')).toBe(false);
  });

  it('records the 1-based rank per window, null where absent', () => {
    const windows = [win(0, [cand('A', 0.9), cand('B', 0.8)]), win(1, [cand('B', 0.7)])];
    const t = buildTemporalTimeline(windows, DETECTION_TEMPORAL_CONFIG);
    expect(t.ranks.get('A')).toEqual([1, null]);
    expect(t.ranks.get('B')).toEqual([2, 1]);
  });
});
