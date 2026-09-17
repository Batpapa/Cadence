import { describe, it, expect } from 'vitest';
import {
  planAudioParts, audioPartName, windowsPartName, parseBackupFileName, parseBackupMeta,
  selectAudioParts, mergeWindowParts, matchDevice, decideBackup,
  type BackupSituation,
} from './liveBackupPlan';
import type { WindowResult } from './model';

const win = (t: number): WindowResult => ({ tWindowStart: t, tWindowEnd: t + 10, empty: true, candidates: [] });

describe('planAudioParts', () => {
  it('cuts at the size limit and keeps seq order', () => {
    const chunks = [0, 1, 2, 3, 4].map(seq => ({ seq, size: 40 }));
    const parts = planAudioParts(chunks, 100);
    expect(parts.map(p => [p.first, p.last])).toEqual([[0, 1], [2, 3], [4, 4]]);
  });

  it('gives an oversized chunk a part of its own rather than dropping it', () => {
    const parts = planAudioParts([{ seq: 7, size: 500 }, { seq: 8, size: 10 }], 100);
    expect(parts.map(p => [p.first, p.last])).toEqual([[7, 7], [8, 8]]);
  });

  it('keeps gaps in the numbering (a chunk refused for want of space)', () => {
    const parts = planAudioParts([{ seq: 3, size: 1 }, { seq: 5, size: 1 }], 100);
    expect(parts).toHaveLength(1);
    expect([parts[0]!.first, parts[0]!.last]).toEqual([3, 5]);
  });

  it('plans nothing when there is nothing new', () => {
    expect(planAudioParts([], 100)).toEqual([]);
  });
});

describe('file names', () => {
  it('round-trips audio and windows parts, and sorts as numbers', () => {
    expect(parseBackupFileName(audioPartName(12, 340, 'webm'))).toEqual({ kind: 'audio', first: 12, last: 340 });
    expect(parseBackupFileName(windowsPartName(0, 9))).toEqual({ kind: 'windows', first: 0, last: 9 });
    expect([audioPartName(100, 120, 'webm'), audioPartName(9, 99, 'webm')].sort()[0]).toBe(audioPartName(9, 99, 'webm'));
  });

  it('recognises meta.json and ignores anything else', () => {
    expect(parseBackupFileName('meta.json')).toEqual({ kind: 'meta' });
    expect(parseBackupFileName('notes.txt')).toBeNull();
    expect(parseBackupFileName('audio-00000009-00000003.webm')).toBeNull();
  });
});

describe('parseBackupMeta', () => {
  it('rejects what is not a backup meta', () => {
    expect(parseBackupMeta(null)).toBeNull();
    expect(parseBackupMeta({ schema: 2, sessionId: 'a', deviceId: 'd' })).toBeNull();
    expect(parseBackupMeta({ schema: 1, deviceId: 'd' })).toBeNull();
  });

  it('fills what an older or damaged meta lacks', () => {
    const m = parseBackupMeta({ schema: 1, sessionId: 's', deviceId: 'd' })!;
    expect(m.deviceModel).toBe('');
    expect(m.durationS).toBe(0);
    expect(m.source).toBe('live');
  });
});

describe('selectAudioParts', () => {
  it('keeps the longest of parts resent from the same start (lost confirmation)', () => {
    const chosen = selectAudioParts([
      { first: 0, last: 10 },
      { first: 11, last: 20 },   // uploaded, answer lost…
      { first: 11, last: 30 },   // …so the next press resent from 11
      { first: 31, last: 40 },
    ]);
    expect(chosen.map(p => [p.first, p.last])).toEqual([[0, 10], [11, 30], [31, 40]]);
  });

  it('never plays a stretch twice when an overlap cannot be spliced', () => {
    const chosen = selectAudioParts([{ first: 0, last: 10 }, { first: 5, last: 15 }, { first: 16, last: 20 }]);
    expect(chosen.map(p => [p.first, p.last])).toEqual([[0, 10], [16, 20]]);
  });

  it('orders parts listed in any order', () => {
    const chosen = selectAudioParts([{ first: 20, last: 29 }, { first: 0, last: 9 }, { first: 10, last: 19 }]);
    expect(chosen.map(p => p.first)).toEqual([0, 10, 20]);
  });
});

describe('mergeWindowParts', () => {
  it('rebuilds windows by index, overlaps included', () => {
    const merged = mergeWindowParts([
      { first: 2, windows: [win(20), win(30)] },
      { first: 0, windows: [win(0), win(10), win(20)] },
    ]);
    expect(merged.map(w => w.tWindowStart)).toEqual([0, 10, 20, 30]);
  });
});

describe('matchDevice', () => {
  it('same id wins, then a non-empty model, never an empty one', () => {
    expect(matchDevice({ deviceId: 'a', deviceModel: 'V2023' }, 'a', '')).toBe('same');
    expect(matchDevice({ deviceId: 'a', deviceModel: 'V2023' }, 'b', 'V2023')).toBe('model');
    // Desktops and non-Chromium browsers report no model: two of them must not
    // pass for the same device.
    expect(matchDevice({ deviceId: 'a', deviceModel: '' }, 'b', '')).toBe('other');
    expect(matchDevice({ deviceId: 'a', deviceModel: 'V2023' }, 'b', 'Pixel 7')).toBe('other');
  });
});

describe('decideBackup', () => {
  const base: BackupSituation = {
    match: 'same', discarded: false, recordingHere: false, localDraft: false,
    finalized: false, audioSynced: false, audioHere: false, syncByDefault: true,
  };

  it('offers a lost recording on the device that made it, and only there', () => {
    expect(decideBackup(base)).toBe('offer');
    expect(decideBackup({ ...base, match: 'model' })).toBe('offer');
    expect(decideBackup({ ...base, match: 'other' })).toBe('keep');
    expect(decideBackup({ ...base, match: null })).toBe('keep');
  });

  it('leaves alone a recording still running here or owned by local recovery', () => {
    expect(decideBackup({ ...base, recordingHere: true })).toBe('keep');
    expect(decideBackup({ ...base, localDraft: true })).toBe('keep');
  });

  it('deletes what the user threw away, whoever asks', () => {
    expect(decideBackup({ ...base, discarded: true, match: 'other' })).toBe('delete');
  });

  it('deletes once the finished recording is safe, and not before', () => {
    const done = { ...base, finalized: true };
    expect(decideBackup({ ...done, audioSynced: true, match: 'other' })).toBe('delete');
    expect(decideBackup({ ...done, audioHere: true, syncByDefault: true })).toBe('keep');
    expect(decideBackup({ ...done, audioHere: true, syncByDefault: false })).toBe('delete');
  });

  it('never deletes the only sound of a finished recording on another device', () => {
    const noSound = { ...base, finalized: true };
    expect(decideBackup({ ...noSound, match: 'same' })).toBe('delete');
    expect(decideBackup({ ...noSound, match: 'model' })).toBe('keep');
    expect(decideBackup({ ...noSound, match: 'other' })).toBe('keep');
  });
});
