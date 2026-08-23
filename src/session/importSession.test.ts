import { describe, it, expect } from 'vitest';
import { pruneRateSamples, estimateEtaS, RATE_WINDOW_S, type RateSample } from './importSession';

// ── ETA estimation (2026-08-25) ─────────────────────────────────────────────
// Regression coverage for the bug the user reported: "j'ai l'impression
// qu'il sous-estime systématiquement" (the remaining-time estimate
// systematically undershoots). Reproduces the exact mechanism — an early
// burst of fast windows (StreamingFileSource's decode queue already has a
// few chunks buffered the instant analysis starts) permanently dragging a
// plain since-start average optimistic — and checks the trailing-window
// replacement self-corrects instead.

function sample(t: number, analyzedS: number): RateSample {
  return { t, analyzedS };
}

describe('estimateEtaS', () => {
  it('is null before the trailing window covers more than 3s of real time', () => {
    expect(estimateEtaS([sample(0, 5)], 100, 5, 2000)).toBeNull(); // only 2s span
  });

  it('is null when nothing has been covered yet (analyzedS unchanged across the window)', () => {
    expect(estimateEtaS([sample(0, 5)], 100, 5, 5000)).toBeNull(); // 5s span but 0 progress within it
  });

  it('computes a plain constant-rate ETA correctly (sanity check of the formula itself)', () => {
    // 10 audio-seconds analyzed over the last 5 real seconds => 2x realtime.
    // 90s of audio remain => 45s of wall time left at that rate.
    const samples = [sample(0, 0), sample(5000, 10)];
    expect(estimateEtaS(samples, 100, 10, 5000)).toBeCloseTo(45, 6);
  });

  it('regression: a fast early burst does NOT permanently bias the estimate once the window has moved past it', () => {
    // 20 audio-seconds of ALREADY-QUEUED PCM processed almost instantly
    // (burst), then a much slower steady state (1x realtime) — real bug
    // shape from StreamingFileSource's decode queue. A plain since-start
    // average would keep averaging in that instant burst forever, staying
    // optimistic no matter how long the slow steady state runs. The
    // trailing window must NOT: once the burst sample has fallen out of the
    // RATE_WINDOW_S window, the estimate should reflect ONLY the steady 1x
    // rate, not something faster.
    const burstAt = sample(0, 20); // 20s of audio "instantly" at t=0
    const now = (RATE_WINDOW_S + 30) * 1000; // long past the burst sample's relevance
    // Steady state since some point within the trailing window: 1 audio-second
    // per real second, for the last RATE_WINDOW_S seconds.
    const steadyState = [
      burstAt,
      sample(now - RATE_WINDOW_S * 1000, 20 + 30 - RATE_WINDOW_S), // analyzedS at window start
      sample(now, 20 + 30), // analyzedS now (30 real seconds of 1x steady state since burst)
    ];
    const pruned = pruneRateSamples(steadyState, now);
    // The burst sample must have been dropped — it's older than RATE_WINDOW_S.
    expect(pruned).not.toContainEqual(burstAt);

    const totalS = 1000;
    const analyzedS = 20 + 30;
    const eta = estimateEtaS(pruned, totalS, analyzedS, now);
    // At a true 1x rate, remaining (totalS - analyzedS) audio-seconds take
    // exactly that many real seconds — NOT inflated by the long-gone burst.
    expect(eta).toBeCloseTo(totalS - analyzedS, 6);
  });
});

describe('pruneRateSamples', () => {
  it('drops samples older than RATE_WINDOW_S but always keeps at least the most recent one', () => {
    const now = 100_000;
    const samples = [sample(0, 0), sample(now - (RATE_WINDOW_S + 5) * 1000, 1)];
    const pruned = pruneRateSamples(samples, now);
    expect(pruned).toHaveLength(1);
    expect(pruned[0]).toEqual(samples[1]);
  });

  it('keeps every sample still within the trailing window', () => {
    const now = 100_000;
    const samples = [sample(now - 5000, 1), sample(now - 1000, 2), sample(now, 3)];
    expect(pruneRateSamples(samples, now)).toEqual(samples);
  });
});
