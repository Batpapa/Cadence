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
  const phone = { model: 'V2023', platform: 'Android', platformVersion: '14', renderer: 'ANGLE (Mali-G57)', cores: 8 };
  const laptop = { model: '', platform: 'Windows', platformVersion: '19', renderer: 'ANGLE (NVIDIA, RTX 4070 Laptop GPU)', cores: 20 };

  it('recognises this very browser by its id', () => {
    expect(matchDevice({ deviceId: 'a', deviceModel: '', device: laptop }, 'a', laptop)).toBe('same');
  });

  it('recognises a phone by its model once the id is gone', () => {
    expect(matchDevice({ deviceId: 'a', deviceModel: 'V2023', device: phone }, 'b', phone)).toBe('likely');
  });

  it('recognises a wiped desktop by its GPU, platform and cores', () => {
    // The case measured on 2026-09-17: same laptop, local data cleared, a new
    // device id and no phone model — it used to read as someone else's.
    expect(matchDevice({ deviceId: 'a', deviceModel: '', device: laptop }, 'b', laptop)).toBe('likely');
  });

  it('does not take one machine for another', () => {
    const other = { ...laptop, renderer: 'ANGLE (Intel, UHD Graphics 620)' };
    expect(matchDevice({ deviceId: 'a', deviceModel: '', device: laptop }, 'b', other)).toBe('other');
    expect(matchDevice({ deviceId: 'a', deviceModel: '', device: laptop }, 'b', { ...laptop, cores: 8 })).toBe('other');
    expect(matchDevice({ deviceId: 'a', deviceModel: '', device: laptop }, 'b', { ...laptop, platform: 'Linux' })).toBe('other');
  });

  it('says nothing when the browser says nothing', () => {
    const blind = { model: '', platform: '', platformVersion: '', renderer: '', cores: 0 };
    expect(matchDevice({ deviceId: 'a', deviceModel: '', device: blind }, 'b', blind)).toBe('other');
  });

  it('still reads a backup written before signatures existed', () => {
    expect(matchDevice({ deviceId: 'a', deviceModel: 'V2023' }, 'b', phone)).toBe('likely');
    expect(matchDevice({ deviceId: 'a', deviceModel: '' }, 'b', laptop)).toBe('other');
  });
});

describe('decideBackup', () => {
  const base: BackupSituation = {
    match: 'same', discarded: false, recordingHere: false, localDraft: false,
    finalized: false, audioSynced: false, audioHere: false, syncByDefault: true,
  };

  it('offers a lost recording on the device that made it, and only there', () => {
    expect(decideBackup(base)).toBe('offer');
    expect(decideBackup({ ...base, match: 'likely' })).toBe('offer');
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
    expect(decideBackup({ ...noSound, match: 'likely' })).toBe('keep');
    expect(decideBackup({ ...noSound, match: 'other' })).toBe('keep');
  });
});
