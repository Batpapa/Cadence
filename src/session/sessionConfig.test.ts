import { describe, it, expect } from 'vitest';
import { importWarnMinutes, wholeFileDecodeBytes, WHOLE_FILE_BYTES_PER_S, ANALYSIS_SAMPLE_RATE } from './sessionConfig';

// The threshold that failed in the field (2026-09-11): a single 90-minute
// constant, so an import that died at 20 minutes on a phone was never warned
// about at all. These pin the arithmetic that replaced it — the numbers, not
// the wording, are what has to keep holding.

describe('wholeFileDecodeBytes', () => {
  it('counts both copies that exist at once, not just the one we keep', () => {
    // The mono PCM at the analysis rate, PLUS the decoder's own copy of the
    // original before mixdown. Counting only the first is how the old estimate
    // came out nearly four times too optimistic.
    const kept = ANALYSIS_SAMPLE_RATE * 4;
    expect(WHOLE_FILE_BYTES_PER_S).toBeGreaterThan(kept);
    expect(wholeFileDecodeBytes(1)).toBe(WHOLE_FILE_BYTES_PER_S);
  });

  it('scales with duration and never goes negative', () => {
    expect(wholeFileDecodeBytes(60)).toBe(WHOLE_FILE_BYTES_PER_S * 60);
    expect(wholeFileDecodeBytes(0)).toBe(0);
    expect(wholeFileDecodeBytes(-10)).toBe(0);
  });

  it('predicts the failure that was reported', () => {
    // 20 minutes on a phone: the import died, and the estimate has to be over
    // the ~500 MB a phone tab gets for this to have been foreseeable.
    expect(wholeFileDecodeBytes(20 * 60)).toBeGreaterThan(500_000_000);
  });

  it('shows why a three-hour file cannot be going through this path at all', () => {
    // The same user imports 3h20 on a desktop successfully. That is 6 GB by
    // this formula — far past any renderer — so that import must be using the
    // chunked decoder, not this fallback. The number is the evidence.
    expect(wholeFileDecodeBytes(200 * 60)).toBeGreaterThan(5_000_000_000);
  });
});

describe('importWarnMinutes', () => {
  it('warns a phone long before it would have died', () => {
    const limit = importWarnMinutes(true);
    expect(limit).toBeLessThan(20);      // the duration that actually failed
    expect(limit).toBeGreaterThan(5);    // but not so low it cries wolf
  });

  it('still reproduces the desktop number the old constant hand-picked', () => {
    // The old value was 90, chosen by hand. The budget-divided-by-cost formula
    // lands on the same place, which is what makes it a derivation rather than
    // a second arbitrary number.
    expect(importWarnMinutes(false)).toBeGreaterThan(80);
    expect(importWarnMinutes(false)).toBeLessThan(100);
  });

  it('is stricter on the small device, always', () => {
    expect(importWarnMinutes(true)).toBeLessThan(importWarnMinutes(false));
  });

  it('agrees with its own cost estimate at the limit', () => {
    // Whatever the budgets are, the threshold must be the point where the
    // estimate reaches them — otherwise the message quotes two numbers that
    // contradict each other.
    for (const small of [true, false]) {
      const atLimit = wholeFileDecodeBytes(importWarnMinutes(small) * 60);
      const justUnder = wholeFileDecodeBytes((importWarnMinutes(small) - 1) * 60);
      expect(justUnder).toBeLessThan(atLimit);
    }
  });
});
