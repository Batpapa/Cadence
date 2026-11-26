// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { userKey, userKeyPrefix, userKeys, forgetUserKeys } from './userLocalKeys';

// ── Every localStorage key is either one user's or the device's ──────────────
// A per-user key built anywhere but userLocalKeys.ts is one that removing the
// user would leave behind — what happened to seven of them until 2026-11-26.
// So every `cadence_…` key written in the source is either in that registry,
// or named here as the device's own. A new key fails this test until it is put
// on one side or the other.

/** One per device, whoever is open: never removed with a user. */
const DEVICE_KEYS = new Set([
  'cadence_abc_split', 'cadence_access_token', 'cadence_token_expires_at', 'cadence_token_owner',
  'cadence_device_id', 'cadence_last_user_id', 'cadence_user_order', 'cadence_welcome_lang',
  'cadence_lastLanguage', 'cadence_theme', 'cadence_zoom', 'cadence_dev_mode',
  'cadence_sidebar_collapsed', 'cadence_sidebar_width', 'cadence_pinned_module',
  'cadence_install_offer_seen', 'cadence_play_offer_seen', 'cadence_playback_volume',
  'cadence_analysis_view', 'cadence_analysis_study', 'cadence_analysis_tempo',
  'cadence_keep_recordings', 'cadence_play_along_offset_ms',
  // Keyed by a recording's or a page's own id (UUIDs), not by a user.
  'cadence_live_backup_discarded', 'cadence_recovery_attempt:', 'cadence_finder_runs:',
  'cadence_standalone_analyser_left',
]);

const SRC = path.dirname(fileURLToPath(import.meta.url));

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(p, out);
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(p);
  }
  return out;
}

/** `cadence_…` in a string, on a line of code (comments name keys in prose). */
const KEY_LITERAL = /['"`](cadence_[A-Za-z0-9_:.-]*)/g;
const COMMENT_LINE = /^\s*(\/\/|\*|\/\*)/;

describe('localStorage keys', () => {
  it('are each one user\'s (userLocalKeys.ts) or the device\'s (DEVICE_KEYS)', () => {
    const registry = path.join(SRC, 'userLocalKeys.ts');
    const unclassified: string[] = [];
    for (const file of sourceFiles(SRC)) {
      if (file === registry) continue;
      readFileSync(file, 'utf8').split(/\r?\n/).forEach((line, i) => {
        if (COMMENT_LINE.test(line)) return;
        for (const m of line.matchAll(KEY_LITERAL)) {
          if (!DEVICE_KEYS.has(m[1]!)) unclassified.push(`${path.relative(SRC, file)}:${i + 1} ${m[1]}`);
        }
      });
    }
    expect(unclassified).toEqual([]);
  });

  it('per user: no prefix is another\'s start, so a scan by prefix finds one key only', () => {
    const prefixes = userKeys().map(userKeyPrefix);
    expect(new Set(prefixes).size).toBe(prefixes.length);
    for (const a of prefixes) for (const b of prefixes) if (a !== b) expect(b.startsWith(a)).toBe(false);
  });

  it('per user: no device key falls under one of their prefixes', () => {
    for (const p of userKeys().map(userKeyPrefix)) for (const d of DEVICE_KEYS) expect(d.startsWith(p)).toBe(false);
  });
});

describe('forgetUserKeys', () => {
  beforeEach(() => localStorage.clear());

  it('removes every key of that user, and only of that user', () => {
    for (const k of userKeys()) { localStorage.setItem(userKey(k, 'u1'), 'x'); localStorage.setItem(userKey(k, 'u2'), 'y'); }
    localStorage.setItem('cadence_theme', 'dark');
    forgetUserKeys('u1');
    for (const k of userKeys()) {
      expect(localStorage.getItem(userKey(k, 'u1'))).toBeNull();
      expect(localStorage.getItem(userKey(k, 'u2'))).toBe('y');
    }
    expect(localStorage.getItem('cadence_theme')).toBe('dark');
  });

  it('removes one group alone when asked — the Drive bookkeeping, say', () => {
    for (const k of userKeys()) localStorage.setItem(userKey(k, 'u1'), 'x');
    forgetUserKeys('u1', 'drive');
    for (const k of userKeys('drive')) expect(localStorage.getItem(userKey(k, 'u1'))).toBeNull();
    for (const k of userKeys('app')) expect(localStorage.getItem(userKey(k, 'u1'))).toBe('x');
  });

  it('keeps the names every device already has on disk', () => {
    expect(userKey('driveFileId', 'u1')).toBe('cadence_drive_file_id_u1');
    expect(userKey('driveFolderId', 'u1')).toBe('cadence_drive_folder_id_u1');
    expect(userKey('driveEditSeq', 'u1')).toBe('cadence_edit_seq_u1');
    expect(userKey('lastRoute', 'u1')).toBe('cadence_last_route:u1');
    expect(userKey('audioFreed', 'u1')).toBe('cadence_audio_freed:u1');
  });
});
