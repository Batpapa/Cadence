// ── This device's localStorage that belongs to ONE local user ────────────────
// Every such key, by its prefix: the key is the prefix followed by the user's
// id. One place, so that removing a user removes all of it — until 2026-11-26
// each module built its own keys and the removal named them by hand, which had
// already left a user's Drive folder id, last route, library sort and the
// analyser's audio settings and lists behind on every device that removed one.
//
// The prefixes are what every device already has on disk: never renamed (a
// renamed key reads as absent). A key that is not per user — one per device —
// does not belong here; userLocalKeys.test.ts makes every `cadence_…` key in
// the source one or the other.

/** `group`: what the key is about. 'drive' is the sync bookkeeping, which a
 *  failed Drive recovery also drops on its own (clearDriveStateForUser). */
const KEYS = {
  driveFileId:        { prefix: 'cadence_drive_file_id_',        group: 'drive' },
  driveConnected:     { prefix: 'cadence_drive_connected_',      group: 'drive' },
  driveLocalTs:       { prefix: 'cadence_local_modified_',       group: 'drive' },
  driveSyncedTs:      { prefix: 'cadence_drive_synced_ts_',      group: 'drive' },
  driveHint:          { prefix: 'cadence_drive_hint_',           group: 'drive' },
  driveOwner:         { prefix: 'cadence_drive_owner_',          group: 'drive' },
  driveFailed:        { prefix: 'cadence_drive_sync_failed_',    group: 'drive' },
  driveSyncedVersion: { prefix: 'cadence_drive_synced_version_', group: 'drive' },
  driveEditSeq:       { prefix: 'cadence_edit_seq_',             group: 'drive' },
  driveSyncedSeq:     { prefix: 'cadence_synced_seq_',           group: 'drive' },
  driveInflight:      { prefix: 'cadence_drive_inflight_',       group: 'drive' },
  driveFolderId:      { prefix: 'cadence_drive_folder_id_',      group: 'drive' },
  lastRoute:             { prefix: 'cadence_last_route:',               group: 'app' },
  librarySort:           { prefix: 'cadence_library_sort:',             group: 'app' },
  audioUploadWifiOnly:   { prefix: 'cadence_audio_upload_wifi_only:',   group: 'app' },
  audioUploadsWanted:    { prefix: 'cadence_audio_uploads_wanted:',     group: 'app' },
  audioFreed:            { prefix: 'cadence_audio_freed:',              group: 'app' },
  audioDownloadMode:     { prefix: 'cadence_audio_download_mode:',      group: 'app' },
  audioDownloadWifiOnly: { prefix: 'cadence_audio_download_wifi_only:', group: 'app' },
} as const satisfies Record<string, { prefix: string; group: 'drive' | 'app' }>;

export type UserKey = keyof typeof KEYS;

/** The localStorage key of `key` for the user `uid`. */
export function userKey(key: UserKey, uid: string): string {
  return KEYS[key].prefix + uid;
}

/** The prefix alone — for a scan over every local user's value of one key. */
export function userKeyPrefix(key: UserKey): string {
  return KEYS[key].prefix;
}

/** Every key, or every key of one group. */
export function userKeys(group?: 'drive' | 'app'): UserKey[] {
  return (Object.keys(KEYS) as UserKey[]).filter(k => !group || KEYS[k].group === group);
}

/** Removes `uid`'s keys — all of them, or one group's. */
export function forgetUserKeys(uid: string, group?: 'drive' | 'app'): void {
  for (const k of userKeys(group)) {
    try { localStorage.removeItem(userKey(k, uid)); } catch { /* storage refused: nothing to remove either */ }
  }
}
