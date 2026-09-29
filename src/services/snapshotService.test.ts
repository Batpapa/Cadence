import { describe, expect, it } from 'vitest';
import { expiredSnapshotKeys } from './snapshotService';

// ── How long a snapshot lives ───────────────────────────────────────────────
// A month, asked for on 2026-09-29 for the space. Everything below is a reason
// NOT to delete one: another user's, an unreadable date, a date in the future.

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 8, 29);
const key = (userId: string, daysAgo: number) => `${userId}:${NOW - daysAgo * DAY}`;

describe('which snapshots have expired', () => {
  it('expires what is older than thirty days, and only that', () => {
    const keys = [key('u1', 31), key('u1', 29), key('u1', 0)];
    expect(expiredSnapshotKeys(keys, 'u1', NOW)).toEqual([key('u1', 31)]);
  });

  it('keeps one exactly thirty days old', () => {
    expect(expiredSnapshotKeys([key('u1', 30)], 'u1', NOW)).toEqual([]);
  });

  it('never touches another user\'s', () => {
    // Nor one whose id merely starts the same way.
    const keys = [key('u2', 90), key('u10', 90), key('u1', 90)];
    expect(expiredSnapshotKeys(keys, 'u1', NOW)).toEqual([key('u1', 90)]);
  });

  it('keeps a snapshot whose date cannot be read', () => {
    expect(expiredSnapshotKeys(['u1:', 'u1:abc'], 'u1', NOW)).toEqual([]);
  });

  it('keeps one dated in the future, as after a clock put back', () => {
    expect(expiredSnapshotKeys([key('u1', -40)], 'u1', NOW)).toEqual([]);
  });
});
