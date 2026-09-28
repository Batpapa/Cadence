import type { AppState } from '../types';
import { toDateStr, downloadBlob } from '../utils';
import { buildZip, readZip, audioExtension, type ZipEntry } from './zip';
import { loadSessionAudio, saveSessionAudio } from '../session/db';
import { TUNE_ANALYSER_MODULE_KEY, type TuneAnalyserModuleData } from '../session/model';
import { externalAttachmentBlobs, externalAttachmentBytes, type ExportGate } from './attachmentStore';

// ── Full backup (.cdbf) ──────────────────────────────────────────────────────
// The ordinary .cdb is JSON: tunes, decks, reviews, and the analyses with their
// detections. It has never carried the recordings, which live in a separate
// per-user database — so the one thing that exists in a single copy was the one
// thing "export all your data" did not export. A user lost every recording on
// their phone on 2026-09-09 and a fresh backup would not have helped.
//
// A zip rather than a bigger JSON. Embedding audio as base64 costs 33% and,
// worse, has to exist as ONE JavaScript string, which throws outright somewhere
// past half a gigabyte — the share format (.cds) does embed base64 and is
// capped at 70 MB for precisely that reason. Zip entries are bytes, and
// buildZip stores without compressing because the payload is already Opus.
//
// The .cdb is unchanged and still produced: it is small, instant, and it is
// what someone wants when they are moving a library rather than archiving a
// year of sessions. This is the other choice, not a replacement.

const DATA_ENTRY = 'data.cdb';
const AUDIO_DIR = 'audio/';
// Attachments kept out of the blob travel the same way the recordings do: as
// entries beside the state, not as base64 inside it — the same argument this
// file's header already makes about the audio, and for the same two reasons.
// Measured on the library that prompted the externalisation: those ten files
// are 21.18 MB of bytes and would be 28.24 MB of base64, so 7.06 MB saved —
// and, which matters more, `data.cdb` stays a 6.3 MB string instead of a
// 34.5 MB one. Attachments are the category most likely to grow.
const ATTACH_DIR = 'attachments/';

/** The archive is assembled whole in memory — buildZip returns one Uint8Array,
 *  and there is no streaming zip that works on iOS Safari. Past this, the tab
 *  dies rather than producing a file, so it is refused in words instead. */
export const MAX_FULL_BACKUP_BYTES = 1_500 * 1024 * 1024;

export class BackupTooLarge extends Error {
  constructor(public readonly bytes: number) { super('backup_too_large'); }
}

function sessionsOf(user: AppState): Record<string, { mimeType?: string }> {
  const mod = user.modules?.[TUNE_ANALYSER_MODULE_KEY] as TuneAnalyserModuleData | undefined;
  return (mod?.sessions ?? {}) as Record<string, { mimeType?: string }>;
}

/** What a full backup would weigh, so the button can say so before it is
 *  pressed and the refusal above can happen before any memory is spent. */
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

export async function exportFullBackup(user: AppState, gate: ExportGate): Promise<void> {
  const { blobs, missing } = await externalAttachmentBlobs(Object.values(user.cards ?? {}));
  if (missing.length > 0 && !(await gate(missing))) return;

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

  const entries: ZipEntry[] = [{ name: DATA_ENTRY, data: new TextEncoder().encode(json) }];
  let total = json.length;

  for (const [extId, blob] of blobs) {
    total += blob.size;
    if (total > MAX_FULL_BACKUP_BYTES) throw new BackupTooLarge(total);
    // Named by external id, and by nothing else: the id is what the state
    // points at, the attachment's own name is neither unique nor safe as a
    // path, and the mime type is read back from the state — the same
    // reasoning the audio entries below spell out.
    entries.push({ name: ATTACH_DIR + extId, data: new Uint8Array(await blob.arrayBuffer()) });
  }

  for (const [id, meta] of Object.entries(sessionsOf(user))) {
    const blob = await loadSessionAudio(id);
    if (!blob) continue;   // recorded on another device, or freed here
    total += blob.size;
    if (total > MAX_FULL_BACKUP_BYTES) throw new BackupTooLarge(total);
    // Named by session id, not by the session's title: the id is what the
    // metadata points at, and two sessions may legitimately share a name.
    entries.push({
      name: `${AUDIO_DIR}${id}.${audioExtension(blob.type || meta.mimeType)}`,
      data: new Uint8Array(await blob.arrayBuffer()),
    });
  }

  const zip = buildZip(entries);
  downloadBlob(new Blob([zip], { type: 'application/zip' }), `cadence-backup-${toDateStr(new Date())}.cdbf`);
}

export interface FullBackup {
  /** The same object `parseImport` returns for a .cdb, so the caller applies it
   *  through the one existing path rather than a second one. */
  raw: Record<string, unknown>;
  /** Session id → recording. Restored only AFTER the state is applied. */
  audio: Map<string, Blob>;
  /** External id → an attachment's bytes, for the same reason and at the same
   *  moment: the state has to name them before they are worth writing. */
  attachments: Map<string, Blob>;
}

export async function parseFullBackup(file: File): Promise<FullBackup> {
  const entries = readZip(new Uint8Array(await file.arrayBuffer()));
  const dataEntry = entries.find(e => e.name === DATA_ENTRY);
  if (!dataEntry) throw new Error('backup_missing_data');

  let raw: unknown;
  try { raw = JSON.parse(new TextDecoder().decode(dataEntry.data)); }
  catch { throw new Error('Invalid file'); }
  if (typeof raw !== 'object' || raw === null) throw new Error('Invalid file');

  const sessions = sessionsOf(raw as AppState);
  const audio = new Map<string, Blob>();
  const attachments = new Map<string, Blob>();
  for (const e of entries) {
    if (e.name.startsWith(ATTACH_DIR)) {
      // Stored untyped: the attachment's declared mimeType is the one the app
      // agreed on (the container sniffing of 2026-09-18), and attachmentBlob
      // re-wraps whatever it finds with it — so guessing one here would only
      // give the guess a chance to be wrong.
      attachments.set(e.name.slice(ATTACH_DIR.length), new Blob([new Uint8Array(e.data)]));
      continue;
    }
    if (!e.name.startsWith(AUDIO_DIR)) continue;
    const id = e.name.slice(AUDIO_DIR.length).replace(/\.[^.]+$/, '');
    // The recorded mime type comes from the metadata, not from the extension:
    // the extension is a lossy rendering of it, and <audio> is fussier than
    // the file system about the difference.
    audio.set(id, new Blob([new Uint8Array(e.data)], { type: sessions[id]?.mimeType || 'audio/webm' }));
  }
  return { raw: raw as Record<string, unknown>, audio, attachments };
}

/** Writes the recordings back, once the state that references them is in place.
 *
 *  `sync: false` explicitly. Copying to Drive now defaults to on, and a restore
 *  would otherwise push every recording back up — spending someone's bandwidth
 *  and quota on files that, if they came from a full backup, they already have.
 *  Failures are counted rather than thrown: the state is already restored, and
 *  losing one recording must not read as losing the import. */
export async function restoreFullBackupAudio(audio: Map<string, Blob>): Promise<{ ok: number; failed: number }> {
  let ok = 0, failed = 0;
  for (const [id, blob] of audio) {
    try { await saveSessionAudio(id, blob, false); ok++; }
    catch (e) { console.warn('[backup] could not restore the audio of ' + id, e); failed++; }
  }
  return { ok, failed };
}
