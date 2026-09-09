import type { AppState } from '../types';
import { toDateStr, downloadBlob } from '../utils';
import { buildZip, readZip, audioExtension, type ZipEntry } from './zip';
import { loadSessionAudio, saveSessionAudio } from '../session/db';
import { TUNE_ANALYSER_MODULE_KEY, type TuneAnalyserModuleData } from '../session/model';

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
export async function fullBackupSize(user: AppState): Promise<{ audioBytes: number; count: number }> {
  let audioBytes = 0, count = 0;
  for (const id of Object.keys(sessionsOf(user))) {
    const blob = await loadSessionAudio(id);
    if (!blob) continue;
    audioBytes += blob.size;
    count++;
  }
  return { audioBytes, count };
}

export async function exportFullBackup(user: AppState): Promise<void> {
  const { id: _id, ...data } = user;
  const json = JSON.stringify(data);

  const entries: ZipEntry[] = [{ name: DATA_ENTRY, data: new TextEncoder().encode(json) }];
  let total = json.length;

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
  for (const e of entries) {
    if (!e.name.startsWith(AUDIO_DIR)) continue;
    const id = e.name.slice(AUDIO_DIR.length).replace(/\.[^.]+$/, '');
    // The recorded mime type comes from the metadata, not from the extension:
    // the extension is a lossy rendering of it, and <audio> is fussier than
    // the file system about the difference.
    audio.set(id, new Blob([new Uint8Array(e.data)], { type: sessions[id]?.mimeType || 'audio/webm' }));
  }
  return { raw: raw as Record<string, unknown>, audio };
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
