import { describe, it, expect } from 'vitest';
import { RecognitionAggregator, type AnnotationEvent } from './aggregator';
import { AGG_CONFIG, type AggConfig } from './aggregatorConfig';
import type { WindowResult, WindowCandidate } from '../model';

// ── Helpers ───────────────────────────────────────────────────────────────────

// Tests pin the hysteresis counters so they validate the state-machine
// mechanics regardless of production tuning in aggregatorConfig.
const TEST_CFG: AggConfig = {
  ...AGG_CONFIG,
  K_CONFIRM: 2,
  K_SWITCH: 2,
  K_EMPTY_CLOSE: 4,
  K_EMPTY_CANDIDATE_RESET: 2,
};

function mkAgg(overrides: Partial<AggConfig> = {}): RecognitionAggregator {
  return new RecognitionAggregator({ ...TEST_CFG, ...overrides });
}

const HOP = 5; // seconds between windows, mirrors the live pipeline

function cand(tuneId: string, score: number, settingId = `s${tuneId}`): WindowCandidate {
  return { tuneId, settingId, displayName: `Tune ${tuneId}`, dance: 'reel', meter: '4/4', score };
}

function win(t: number, candidates: WindowCandidate[]): WindowResult {
  return { tWindowStart: t, tWindowEnd: t + 15, empty: false, candidates };
}

function emptyWin(t: number): WindowResult {
  return { tWindowStart: t, tWindowEnd: t + 15, empty: true, candidates: [] };
}

/** Feeds a sequence of windows spaced HOP apart starting at t0; returns all events. */
function feed(agg: RecognitionAggregator, windows: ((t: number) => WindowResult)[], t0 = 0): AnnotationEvent[] {
  const events: AnnotationEvent[] = [];
  windows.forEach((mk, i) => events.push(...agg.step(mk(t0 + i * HOP))));
  return events;
}

const strongA = (t: number) => win(t, [cand('A', 0.9), cand('B', 0.6)]);
const strongB = (t: number) => win(t, [cand('B', 0.88), cand('A', 0.55)]);

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('confirmation', () => {
  it('opens an annotation after K_CONFIRM consecutive wins, start = first win', () => {
    const agg = mkAgg();
    const events = feed(agg, [strongA, strongA]);
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('open');
    expect(events[0]!.annotation.tuneId).toBe('A');
    expect(events[0]!.annotation.start).toBe(0); // retroactive to first win
    expect(events[0]!.annotation.end).toBeNull();
  });

  it('does not open on a single win', () => {
    const agg = mkAgg();
    expect(feed(agg, [strongA])).toHaveLength(0);
  });

  it('a different winner restarts candidacy', () => {
    const agg = mkAgg();
    const events = feed(agg, [strongA, strongB, strongA]);
    expect(events).toHaveLength(0); // no tune ever reached 2 consecutive wins
  });

  it('windows below SCORE_FLOOR are treated as empty', () => {
    const agg = mkAgg();
    const weak = (t: number) => win(t, [cand('A', AGG_CONFIG.SCORE_FLOOR - 0.01)]);
    expect(feed(agg, [weak, weak, weak])).toHaveLength(0);
  });
});

describe('candidate hysteresis', () => {
  it('one empty window does not reset a candidate', () => {
    const agg = mkAgg();
    const events = feed(agg, [strongA, emptyWin, strongA]);
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('open');
  });

  it('two consecutive empty windows reset the candidate', () => {
    const agg = mkAgg();
    const events = feed(agg, [strongA, emptyWin, emptyWin, strongA]);
    expect(events).toHaveLength(0); // A must re-earn K_CONFIRM wins
  });
});

describe('set segmentation (switch)', () => {
  it('closes the current tune and opens the rival after K_SWITCH rival wins', () => {
    const agg = mkAgg();
    const events = feed(agg, [strongA, strongA, strongA, strongB, strongB]);
    const close = events.filter(e => e.type === 'close');
    const opens = events.filter(e => e.type === 'open');
    expect(close).toHaveLength(1);
    expect(opens).toHaveLength(2);
    expect(close[0]!.annotation.tuneId).toBe('A');
    // Boundary: end of A === start of B === first rival win (t = 3*HOP)
    expect(close[0]!.annotation.end).toBe(3 * HOP);
    expect(opens[1]!.annotation.tuneId).toBe('B');
    expect(opens[1]!.annotation.start).toBe(3 * HOP);
  });

  it('a rival change resets the rival streak', () => {
    const agg = mkAgg();
    const strongC = (t: number) => win(t, [cand('C', 0.86), cand('A', 0.5)]);
    const events = feed(agg, [strongA, strongA, strongB, strongC, strongA]);
    expect(events.filter(e => e.type === 'close')).toHaveLength(0); // no rival reached K_SWITCH
  });

  it('a win by the confirmed tune clears the rival', () => {
    const agg = mkAgg();
    const events = feed(agg, [strongA, strongA, strongB, strongA, strongB, strongA]);
    expect(events.filter(e => e.type === 'close')).toHaveLength(0);
  });
});

describe('empty-close hysteresis', () => {
  it('closes after K_EMPTY_CLOSE empty windows, end voted past the empty start', () => {
    const agg = mkAgg();
    const events = feed(agg, [strongA, strongA, emptyWin, emptyWin, emptyWin, emptyWin]);
    const close = events.filter(e => e.type === 'close');
    expect(close).toHaveLength(1);
    // Wins [0,15]+[5,20] outvote the empty [10,25] up to t=15; beyond that the
    // empties take the majority. (Legacy bound was 10, the empty-streak start.)
    expect(close[0]!.annotation.end).toBe(3 * HOP);
  });

  it('a win resets the empty streak', () => {
    const agg = mkAgg();
    const events = feed(agg, [strongA, strongA, emptyWin, emptyWin, emptyWin, strongA, emptyWin, emptyWin, emptyWin]);
    expect(events.filter(e => e.type === 'close')).toHaveLength(0);
  });
});

describe('finalize', () => {
  it('closes the open annotation with end = t final', () => {
    const agg = mkAgg();
    feed(agg, [strongA, strongA]);
    const events = agg.finalize(120);
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('close');
    expect(events[0]!.annotation.end).toBe(120);
  });

  it('drops an unconfirmed candidate silently', () => {
    const agg = mkAgg();
    feed(agg, [strongA]);
    expect(agg.finalize(60)).toHaveLength(0);
  });

  it('is a no-op when idle', () => {
    const agg = mkAgg();
    expect(agg.finalize(60)).toHaveLength(0);
  });
});

describe('confidence', () => {
  it('clean wins with large margins score high', () => {
    const agg = mkAgg();
    const events = feed(agg, [strongA, strongA, strongA, strongA]);
    const last = events[events.length - 1]!;
    expect(last.annotation.confidence).toBeGreaterThan(AGG_CONFIG.BUCKET_HIGH);
    expect(last.annotation.bucket).toBe('high');
  });

  it('narrow margins lower the confidence', () => {
    const agg = mkAgg();
    const narrow = (t: number) => win(t, [cand('A', 0.86), cand('B', 0.85)]);
    const eventsNarrow = feed(agg, [narrow, narrow, narrow, narrow]);
    const agg2 = mkAgg();
    const eventsWide = feed(agg2, [strongA, strongA, strongA, strongA]);
    const cNarrow = eventsNarrow[eventsNarrow.length - 1]!.annotation.confidence;
    const cWide   = eventsWide[eventsWide.length - 1]!.annotation.confidence;
    expect(cNarrow).toBeLessThan(cWide);
  });

  it('updates are emitted on each confirmed win', () => {
    const agg = mkAgg();
    const events = feed(agg, [strongA, strongA, strongA, strongA]);
    expect(events.filter(e => e.type === 'update')).toHaveLength(2);
  });
});

describe('ambiguity guard (MARGIN_MIN)', () => {
  it('does not count a rival win when the elected tune is within MARGIN_MIN of top-1', () => {
    const agg = mkAgg();
    // B edges out A by less than MARGIN_MIN — should count as a win for A
    const photo = (t: number) => win(t, [cand('B', 0.87), cand('A', 0.87 - AGG_CONFIG.MARGIN_MIN + 0.01)]);
    const events = feed(agg, [strongA, strongA, photo, photo, photo]);
    expect(events.filter(e => e.type === 'close')).toHaveLength(0);
  });
});

describe('sporadic recognition (pub conditions)', () => {
  it('confirms a tune from repeated non-consecutive hits within the candidate tolerance', () => {
    // Real case (The Flogging): correct hits 25 s apart, never 2 consecutive.
    const agg = mkAgg({ K_EMPTY_CANDIDATE_RESET: 8 });
    const events = feed(agg, [strongA, emptyWin, emptyWin, emptyWin, emptyWin, strongA]);
    expect(events.filter(e => e.type === 'open')).toHaveLength(1);
    expect(events[0]!.annotation.start).toBe(0); // retroactive to the first hit
  });

  it('still drops a one-off candidate after the tolerance', () => {
    const agg = mkAgg({ K_EMPTY_CANDIDATE_RESET: 3 });
    const events = feed(agg, [strongA, emptyWin, emptyWin, emptyWin, strongA]);
    expect(events).toHaveLength(0); // reset happened before the second hit
  });
});

describe('precise end bounds (endCandidate)', () => {
  it('a switch after a lull closes the previous tune at the start of the lull', () => {
    const agg = mkAgg({ K_EMPTY_CLOSE: 10 });
    // A confirmed, then 3 empty windows (lull), then B takes over.
    const events = feed(agg, [strongA, strongA, emptyWin, emptyWin, emptyWin, strongB, strongB]);
    const close = events.filter(e => e.type === 'close');
    expect(close).toHaveLength(1);
    expect(close[0]!.annotation.end).toBe(3 * HOP);  // voted end, still well before B's first win
    const opens = events.filter(e => e.type === 'open');
    expect(opens[1]!.annotation.start).toBe(5 * HOP); // B still starts at its first win
  });

  it('finalize after trailing empties closes near the start of the trail', () => {
    const agg = mkAgg({ K_EMPTY_CLOSE: 10 });
    feed(agg, [strongA, strongA, emptyWin, emptyWin, emptyWin]);
    const events = agg.finalize(300);
    expect(events[0]!.annotation.end).toBe(3 * HOP); // voted end — not 300
  });
});


describe('end vote (overlap majority)', () => {
  it('one junk tail window cannot truncate the annotation (banjo solo clip)', () => {
    // Real case: Cliffs of Moher played 0–35 s, last window [20,35] scored
    // below floor. Windows [10,25]+[15,30] outvote it up to t=30.
    const agg = mkAgg();
    feed(agg, [strongA, strongA, strongA, strongA, emptyWin]);
    const events = agg.finalize(35);
    expect(events).toHaveLength(1);
    expect(events[0]!.annotation.end).toBe(30);
  });

  it('never regresses below the legacy bound on sparse recognition', () => {
    // Pub-style: two early wins, then a long empty run before the close.
    const agg = mkAgg({ K_EMPTY_CLOSE: 4 });
    const events = feed(agg, [strongA, strongA, emptyWin, emptyWin, emptyWin, emptyWin]);
    const close = events.filter(e => e.type === 'close');
    expect(close[0]!.annotation.end).toBeGreaterThanOrEqual(2 * HOP);
    expect(close[0]!.annotation.end).toBeLessThanOrEqual(4 * HOP); // bounded by win coverage
  });

  it('a switch close never overlaps the successor annotation', () => {
    const agg = mkAgg();
    const events = feed(agg, [strongA, strongA, strongA, strongB, strongB]);
    const close = events.filter(e => e.type === 'close');
    const opens = events.filter(e => e.type === 'open');
    expect(close[0]!.annotation.end).toBeLessThanOrEqual(opens[1]!.annotation.start);
  });

  it('tune winning until the very end finalizes at t final', () => {
    const agg = mkAgg();
    feed(agg, [strongA, strongA, strongA]);
    const events = agg.finalize(25);
    expect(events[0]!.annotation.end).toBe(25);
  });
});

describe('alternates', () => {
  it('collects runner-up tunes with mean scores, excluding the elected tune', () => {
    const agg = mkAgg();
    const events = feed(agg, [strongA, strongA, strongA]);
    const last = events[events.length - 1]!;
    expect(last.annotation.alternates.length).toBeGreaterThan(0);
    expect(last.annotation.alternates[0]!.tuneId).toBe('B');
    expect(last.annotation.alternates.some(a => a.tuneId === 'A')).toBe(false);
  });
});
