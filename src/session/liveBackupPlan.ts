import type { Analysis, WindowResult } from './model';

// ── Live backup: the decisions, without the I/O (2026-09-17) ────────────────────
// A live recording can be copied to Drive while it runs (liveBackup.ts does the
// transfers). Everything here is pure, so the rules that decide what is sent,
// what is put back together and what is thrown away can be tested without a
// browser, a database or a Google account.
//
// Why this exists: a user lost the whole local store of the app three times on
// the same phone, with persistent storage granted, and the cause was never
// found. The one copy that survives that is the one not on the device.
//
// On Drive, one folder per recording: `cadence-data-ext/live-backups/<id>/`
//   meta.json                       who, what, which device — rewritten each time
//   audio-<firstSeq>-<lastSeq>.<ext> recorder chunks, concatenated, in seq order
//   windows-<first>-<last>.json     analysis windows by index
// A press sends only what no earlier press has, so a part never repeats one
// that was CONFIRMED sent. It can repeat one whose confirmation got lost —
// uploaded, but the response never arrived — which is what the selection
// below is built to absorb.

/** One part at most this size, bar a single chunk bigger on its own. A long
 *  backlog then goes as several requests, and a dropped connection costs one
 *  part rather than the whole hour. */
export const BACKUP_PART_MAX_BYTES = 4 * 1024 * 1024;

export const BACKUP_META_NAME = 'meta.json';

const SEQ_DIGITS = 8;
const pad = (n: number) => String(n).padStart(SEQ_DIGITS, '0');

export interface LiveBackupMeta {
  schema: 1;
  sessionId: string;
  name: string;
  /** Recording start, ISO. */
  date: string;
  mimeType: string;
  source: Analysis['source'];
  /** Elapsed recording time at the last backup, pauses excluded. */
  durationS: number;
  /** Who recorded it. The device id lives in localStorage, which is exactly
   *  what gets wiped in the case this exists for — hence the model beside it
   *  (see matchDevice). */
  deviceId: string;
  deviceModel: string;
  updatedAt: number;
}

export function parseBackupMeta(raw: unknown): LiveBackupMeta | null {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as Partial<LiveBackupMeta>;
  if (m.schema !== 1 || typeof m.sessionId !== 'string' || typeof m.deviceId !== 'string') return null;
  return {
    schema: 1,
    sessionId: m.sessionId,
    name: typeof m.name === 'string' ? m.name : '',
    date: typeof m.date === 'string' ? m.date : new Date(0).toISOString(),
    mimeType: typeof m.mimeType === 'string' ? m.mimeType : 'audio/webm',
    source: m.source === 'device' ? 'device' : 'live',
    durationS: typeof m.durationS === 'number' && Number.isFinite(m.durationS) ? m.durationS : 0,
    deviceId: m.deviceId,
    deviceModel: typeof m.deviceModel === 'string' ? m.deviceModel : '',
    updatedAt: typeof m.updatedAt === 'number' ? m.updatedAt : 0,
  };
}

// ── Names ────────────────────────────────────────────────────────────────────

export function audioPartName(first: number, last: number, ext: string): string {
  return `audio-${pad(first)}-${pad(last)}.${ext}`;
}

export function windowsPartName(first: number, last: number): string {
  return `windows-${pad(first)}-${pad(last)}.json`;
}

export type BackupFileKind = { kind: 'audio' | 'windows'; first: number; last: number } | { kind: 'meta' };

export function parseBackupFileName(name: string): BackupFileKind | null {
  if (name === BACKUP_META_NAME) return { kind: 'meta' };
  const m = /^(audio|windows)-(\d+)-(\d+)\./.exec(name);
  if (!m) return null;
  const first = Number(m[2]), last = Number(m[3]);
  if (last < first) return null;
  return { kind: m[1] as 'audio' | 'windows', first, last };
}

// ── Sending ──────────────────────────────────────────────────────────────────

/** Groups chunks, already in seq order, into parts of at most `maxBytes`. */
export function planAudioParts<T extends { seq: number; size: number }>(
  chunks: T[], maxBytes = BACKUP_PART_MAX_BYTES,
): Array<{ first: number; last: number; chunks: T[] }> {
  const parts: Array<{ first: number; last: number; chunks: T[] }> = [];
  let current: T[] = [];
  let bytes = 0;
  for (const c of chunks) {
    if (current.length > 0 && bytes + c.size > maxBytes) {
      parts.push({ first: current[0]!.seq, last: current[current.length - 1]!.seq, chunks: current });
      current = [];
      bytes = 0;
    }
    current.push(c);
    bytes += c.size;
  }
  if (current.length > 0) parts.push({ first: current[0]!.seq, last: current[current.length - 1]!.seq, chunks: current });
  return parts;
}

// ── Putting it back together ─────────────────────────────────────────────────

/** The audio parts to concatenate, in order, without playing any stretch twice.
 *
 *  A part is resent when its upload landed but the answer never came back, and
 *  the resend starts where the lost one did — so duplicates share a FIRST seq,
 *  and the longest of them wins. A part overlapping what is already covered
 *  without sharing that start cannot be produced by the sender; it is skipped
 *  rather than spliced, since parts are opaque bytes and cannot be cut. */
export function selectAudioParts<T extends { first: number; last: number }>(parts: T[]): T[] {
  const sorted = [...parts].sort((a, b) => a.first - b.first || b.last - a.last);
  const chosen: T[] = [];
  let coveredLast = -1;
  for (const p of sorted) {
    if (p.first <= coveredLast) continue;
    chosen.push(p);
    coveredLast = p.last;
  }
  return chosen;
}

/** Windows by index, from any number of possibly overlapping parts. Unlike
 *  audio these are separable, so an overlap is simply the same window twice. */
export function mergeWindowParts(parts: Array<{ first: number; windows: WindowResult[] }>): WindowResult[] {
  const byIndex = new Map<number, WindowResult>();
  for (const p of parts) p.windows.forEach((w, i) => byIndex.set(p.first + i, w));
  return [...byIndex.keys()].sort((a, b) => a - b).map(i => byIndex.get(i)!);
}

// ── Whose it is ──────────────────────────────────────────────────────────────

/** Recovery is offered only on the device that recorded (decided 2026-09-17):
 *  a laptop on the same Drive must not ask about a phone's recording that may
 *  still be running.
 *
 *  'same'  — same device id: this very browser.
 *  'model' — different id, same non-empty phone model: almost certainly the
 *            same phone after its local data was wiped, which renews the id.
 *            Chromium reports a model on Android and an empty one on desktop;
 *            Safari and Firefox report none, and fall back to the id alone.
 *  'other' — anything else. */
export type DeviceMatch = 'same' | 'model' | 'other';

export function matchDevice(meta: Pick<LiveBackupMeta, 'deviceId' | 'deviceModel'>, deviceId: string, deviceModel: string): DeviceMatch {
  if (meta.deviceId === deviceId) return 'same';
  if (meta.deviceModel && meta.deviceModel === deviceModel) return 'model';
  return 'other';
}

// ── What to do with a backup found on Drive ──────────────────────────────────

export interface BackupSituation {
  /** Null when meta.json is missing or unreadable (a first press that failed
   *  midway). Such a folder is left alone: nothing says whose it is. */
  match: DeviceMatch | null;
  /** The user threw this recording away here (cancelled it, or abandoned its
   *  recovery) and the Drive copy could not be deleted at the time. */
  discarded: boolean;
  /** Being recorded in this tab right now. */
  recordingHere: boolean;
  /** A local draft exists: local recovery owns it, and decides first. */
  localDraft: boolean;
  /** The analysis is finished and in the synced state. */
  finalized: boolean;
  /** Its audio has its own copy on Drive. */
  audioSynced: boolean;
  /** Its audio is on this device. */
  audioHere: boolean;
  /** New recordings are copied to Drive when saved. */
  syncByDefault: boolean;
}

export type BackupDecision = 'delete' | 'offer' | 'keep';

/** Never deletes the last copy of a recording's sound: a backup goes only once
 *  the audio is safe elsewhere, or once the user has chosen where it lives.
 *  There is no age-based purge — the same objection as for orphan companion
 *  files: a device that has not come back yet may be the one that needs it. */
export function decideBackup(s: BackupSituation): BackupDecision {
  if (s.discarded) return 'delete';
  if (s.recordingHere || s.localDraft) return 'keep';
  if (s.finalized) {
    if (s.audioSynced) return 'delete';
    // Kept on this device with copying off: that is where the user wants it.
    // With copying on, the upload has not landed yet — wait for it.
    if (s.audioHere) return s.syncByDefault ? 'keep' : 'delete';
    // Finished, no sound here or on Drive. On the recording device that means
    // the user forgot the audio on purpose. Anywhere else it is not ours to judge.
    return s.match === 'same' ? 'delete' : 'keep';
  }
  if (s.match === 'same' || s.match === 'model') return 'offer';
  return 'keep';
}
