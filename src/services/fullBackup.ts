import type { AppState } from '../types';
import { toDateStr } from '../utils';
import { downloadCadenceFile } from './fileTransfer';
import { buildZipBlob, readZipBlob, isZipBlob, audioExtension, ZIP32_MAX_BYTES, type ZipBlobEntry } from './zip';
import { loadSessionAudio, saveSessionAudio } from '../session/db';
import { analyserModuleOf } from '../session/model';
import { externalAttachmentBlobs, externalAttachmentBytes, type ExportGate } from './attachmentStore';

// ── Backups (.cdb, .cdbf) ────────────────────────────────────────────────────
// Two choices of one format. The .cdbf (full backup) carries the recordings,
// which live in a separate per-user database — the one thing that exists in a
// single copy, and the one thing "export all your data" did not export until a
// user lost every recording on their phone on 2026-09-09. The .cdb leaves them
// out: it is small and quick, what someone wants when moving a library rather
// than archiving a year of sessions.
//
// Both are a zip (zip.ts, STORE): `data.cdb` (the state, JSON), then
// `attachments/<external id>` and, in a .cdbf, `audio/<session id>.<ext>`.
// Embedding bytes as base64 costs 33% and, worse, has to exist as ONE
// JavaScript string, which throws outright somewhere past half a gigabyte.
// Since 2026-11-15 the archive is a Blob of the stored Blobs, read in pieces
// for the CRC and never held whole; until then it was assembled in memory and
// capped at 1.5 GB, and a .cdb was JSON with its attachments in base64.
//
// LEGACY READ — a .cdb in JSON is still read (parseBackup), with no deadline:
// a backup is a file kept for the long term, and reading an old one is the
// whole point of it (decided 2026-11-26, over the removal planned on
// 2026-11-15 for 2027-01-15). The recovery screen (main.ts, ?mode=recovery)
// still writes one, too.

export const BACKUP_DATA_ENTRY = 'data.cdb';
const AUDIO_DIR = 'audio/';
// Attachments kept out of the blob travel the same way the recordings do: as
// entries beside the state, not as base64 inside it. Measured on the library
// that prompted the externalisation: those ten files are 21.18 MB of bytes and
// would be 28.24 MB of base64, so 7.06 MB saved — and, which matters more,
// `data.cdb` stays a 6.3 MB string instead of a 34.5 MB one. Attachments are
// the category most likely to grow.
const ATTACH_DIR = 'attachments/';

/** The zip format's own ceiling (ZIP32), less room for its headers. Memory is
 *  no longer the limit: nothing is held whole. */
export const MAX_FULL_BACKUP_BYTES = ZIP32_MAX_BYTES - 64 * 1024 * 1024;

export class BackupTooLarge extends Error {
  constructor(public readonly bytes: number) { super('backup_too_large'); }
}

function sessionsOf(user: AppState): Record<string, { mimeType?: string }> {
  const mod = analyserModuleOf(user);
  return (mod?.sessions ?? {}) as Record<string, { mimeType?: string }>;
}

/** What a full backup would weigh, so the button can say so before it is
 *  pressed and the refusal above can happen before anything is read. */
export async function fullBackupSize(user: AppState): Promise<{ audioBytes: number; attachmentBytes: number; count: number }> {
  let audioBytes = 0, count = 0;
  for (const id of Object.keys(sessionsOf(user))) {
    const blob = await loadSessionAudio(id);
    if (!blob) continue;
    audioBytes += blob.size;
    count++;
  }
  // Read from the state rather than from the local database: the figure must
  // be what the archive will hold, and that includes attachments another
  // device uploaded which this one will fetch on the way out.
  return { audioBytes, attachmentBytes: externalAttachmentBytes(user), count };
}

/** The archive of `user`'s state, its attachments and, `withAudio`, its
 *  recordings. Null if the gate refused an export missing some attachments. */
export async function buildBackup(user: AppState, gate: ExportGate, withAudio: boolean): Promise<Blob | null> {
  const { blobs, missing } = await externalAttachmentBlobs(Object.values(user.cards ?? {}));
  if (missing.length > 0 && !(await gate(missing))) return null;

  // The state written into the archive KEEPS `external`: the bytes are in the
  // archive too, beside it, so there is nothing to put back inline. What it
  // must not keep is `driveFileId` — that names a file in the Drive of
  // whoever made the backup, which a restore may well not be. Dropping it
  // leaves the attachment in the upload backlog, so the restoring device
  // sends its own copy up and every other device of theirs can reach it.
  //
  // The cost, paid knowingly: restoring onto the SAME Drive re-uploads what
  // is already there and leaves the old copies as orphans. A restore is a
  // once-in-a-library event, and the alternative — a pointer that silently
  // resolves to nothing on every other device — is the failure this whole
  // chantier exists to avoid.
  //
  // Only for the ones actually archived. An attachment whose bytes could not
  // be fetched (and which the gate let through) keeps its `driveFileId`: it
  // is the one chance left of ever seeing that file again.
  const state = structuredClone(user);
  for (const card of Object.values(state.cards ?? {})) {
    for (const att of card.content?.attachments ?? []) {
      if (att.type === 'file' && att.external && blobs.has(att.external.id)) delete att.external.driveFileId;
    }
  }

  const { id: _id, ...data } = state;
  const json = JSON.stringify(data);

  const entries: ZipBlobEntry[] = [{ name: BACKUP_DATA_ENTRY, data: json }];
  let total = json.length;

  for (const [extId, blob] of blobs) {
    total += blob.size;
    if (total > MAX_FULL_BACKUP_BYTES) throw new BackupTooLarge(total);
    // Named by external id, and by nothing else: the id is what the state
    // points at, the attachment's own name is neither unique nor safe as a
    // path, and the mime type is read back from the state — the same
    // reasoning the audio entries below spell out.
    entries.push({ name: ATTACH_DIR + extId, data: blob });
  }

  if (withAudio) {
    for (const [id, meta] of Object.entries(sessionsOf(user))) {
      const blob = await loadSessionAudio(id);
      if (!blob) continue;   // recorded on another device, or freed here
      total += blob.size;
      if (total > MAX_FULL_BACKUP_BYTES) throw new BackupTooLarge(total);
      // Named by session id, not by the session's title: the id is what the
      // metadata points at, and two sessions may legitimately share a name.
      entries.push({ name: `${AUDIO_DIR}${id}.${audioExtension(blob.type || meta.mimeType)}`, data: blob });
    }
  }

  return buildZipBlob(entries);
}

export async function exportFullBackup(user: AppState, gate: ExportGate): Promise<void> {
  const zip = await buildBackup(user, gate, true);
  if (zip) downloadCadenceFile(zip, `cadence-backup-${toDateStr(new Date())}.cdbf`);
}

export interface FullBackup {
  /** The same object a .cdb has always given, so the caller applies it
   *  through the one existing path rather than a second one. */
  raw: Record<string, unknown>;
  /** Session id → its recording, read when asked for. Restored only AFTER the
   *  state is applied, one at a time. */
  audio: Map<string, () => Promise<Blob>>;
  /** External id → an attachment's bytes, for the same reason and at the same
   *  moment: the state has to name them before they are worth writing. */
  attachments: Map<string, Blob>;
}

/** A .cdb or a .cdbf, whichever it is: an archive, or (LEGACY READ) a .cdb
 *  in JSON. */
export async function parseBackup(file: File): Promise<FullBackup> {
  const name = file.name.toLowerCase();
  if (!name.endsWith('.cdb') && !name.endsWith('.cdbf')) throw new Error('Expected a .cdb or .cdbf file');
  if (!(await isZipBlob(file))) {
    if (!name.endsWith('.cdb')) throw new Error('not_a_zip');
    return { raw: parseJsonBackup(await file.text()), audio: new Map(), attachments: new Map() };
  }

  const entries = await readZipBlob(file);
  const dataEntry = entries.find(e => e.name === BACKUP_DATA_ENTRY);
  if (!dataEntry) throw new Error('backup_missing_data');

  let raw: unknown;
  try { raw = JSON.parse(await dataEntry.text()); }
  catch { throw new Error('Invalid file'); }
  // As loose as the archive's reader has always been: only ever written by
  // buildBackup, unlike a JSON .cdb, which people have edited by hand.
  if (!isRecord(raw)) throw new Error('Invalid file');

  const sessions = sessionsOf(raw as unknown as AppState);
  const audio = new Map<string, () => Promise<Blob>>();
  const attachments = new Map<string, Blob>();
  for (const e of entries) {
    if (e.name.startsWith(ATTACH_DIR)) {
      // Stored untyped: the attachment's declared mimeType is the one the app
      // agreed on (the container sniffing of 2026-09-18), and attachmentBlob
      // re-wraps whatever it finds with it — so guessing one here would only
      // give the guess a chance to be wrong. A copy, not a slice of the
      // archive: it goes into IndexedDB (zip.ts).
      attachments.set(e.name.slice(ATTACH_DIR.length), await e.copy());
      continue;
    }
    if (!e.name.startsWith(AUDIO_DIR)) continue;
    const id = e.name.slice(AUDIO_DIR.length).replace(/\.[^.]+$/, '');
    // The recorded mime type comes from the metadata, not from the extension:
    // the extension is a lossy rendering of it, and <audio> is fussier than
    // the file system about the difference.
    audio.set(id, () => e.copy(sessions[id]?.mimeType || 'audio/webm'));
  }
  return { raw, audio, attachments };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isValidBackup(data: unknown): data is Record<string, unknown> {
  if (!isRecord(data)) return false;
  // Cards and profiles directly (id may be absent — stripped on export). The
  // multi-user AppState of before 2026-06-01 is no longer converted (gone
  // 2026-11-26, its users known and long migrated): one from before profiles
  // is "not a backup" here, a later one is refused by its version
  // (migration.ts's OLDEST_SCHEMA).
  return isRecord(data['cards']) && isRecord(data['profiles']);
}

/** LEGACY READ — a .cdb as it was written until 2026-11-15. */
function parseJsonBackup(text: string): Record<string, unknown> {
  let data: unknown;
  try { data = JSON.parse(text); } catch { throw new Error('Invalid file'); }
  if (!isValidBackup(data)) throw new Error('File is not a valid Cadence backup');
  return data;
}

/** Writes the recordings back, once the state that references them is in place.
 *
 *  `sync: false` explicitly. Copying to Drive now defaults to on, and a restore
 *  would otherwise push every recording back up — spending someone's bandwidth
 *  and quota on files that, if they came from a full backup, they already have.
 *  Failures are counted rather than thrown: the state is already restored, and
 *  losing one recording must not read as losing the import. */
export async function restoreFullBackupAudio(audio: Map<string, () => Promise<Blob>>): Promise<{ ok: number; failed: number }> {
  let ok = 0, failed = 0;
  for (const [id, read] of audio) {
    try { await saveSessionAudio(id, await read(), false); ok++; }
    catch (e) { console.warn('[backup] could not restore the audio of ' + id, e); failed++; }
  }
  return { ok, failed };
}
