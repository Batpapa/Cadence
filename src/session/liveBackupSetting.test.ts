import { describe, it, expect } from 'vitest';
import { autoLiveBackupEnabled, AUTO_LIVE_BACKUP_BY_DEFAULT } from './db';

// The automatic backup follows the same "absent means yes" discipline as the
// audio copy — and the same hazard: read as a bare truthiness check, an
// untouched install would read as OFF, which is the opposite of the intent, and
// a deliberate "no" would be indistinguishable from never having chosen.

describe('autoLiveBackupEnabled', () => {
  it('is on for an install that never touched it', () => {
    expect(AUTO_LIVE_BACKUP_BY_DEFAULT).toBe(true);
    expect(autoLiveBackupEnabled({})).toBe(true);
    expect(autoLiveBackupEnabled({ modules: {} })).toBe(true);
    expect(autoLiveBackupEnabled({ modules: { 'tune-analyser': { sessions: {} } } })).toBe(true);
  });

  it('honours a stored no, which is why both values are written', () => {
    expect(autoLiveBackupEnabled({ modules: { 'tune-analyser': { sessions: {}, autoLiveBackup: false } } })).toBe(false);
    expect(autoLiveBackupEnabled({ modules: { 'tune-analyser': { sessions: {}, autoLiveBackup: true } } })).toBe(true);
  });
});
