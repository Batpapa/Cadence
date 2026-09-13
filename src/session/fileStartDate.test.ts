import { describe, it, expect } from 'vitest';
import { fileStartDate } from './fileStartDate';

const NOW = Date.parse('2026-09-13T22:00:00Z');
const HOUR = 3_600_000;

describe('fileStartDate', () => {
  // A recorder writes its file when the recording stops.
  it('puts the start one duration before the modification time', () => {
    expect(fileStartDate(NOW - 2 * HOUR, 192 * 60, NOW)).toBe('2026-09-13T16:48:00.000Z');
  });

  it('says nothing without a duration', () => {
    expect(fileStartDate(NOW - HOUR, null, NOW)).toBeNull();
    expect(fileStartDate(NOW - HOUR, 0, NOW)).toBeNull();
    expect(fileStartDate(NOW - HOUR, Number.NaN, NOW)).toBeNull();
  });

  it('says nothing without a modification time, or with one in the future', () => {
    expect(fileStartDate(0, 600, NOW)).toBeNull();
    expect(fileStartDate(NOW + HOUR, 600, NOW)).toBeNull();
  });

  // What a browser reports when it does not know (File API): the current time.
  it('reads a modification time of "just now" as unknown', () => {
    expect(fileStartDate(NOW - 5_000, 600, NOW)).toBeNull();
    expect(fileStartDate(NOW - 2 * 60_000, 60, NOW)).toBe(new Date(NOW - 3 * 60_000).toISOString());
  });
});
