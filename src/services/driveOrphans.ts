import type { AppState } from '../types';
import { TUNE_ANALYSER_MODULE_KEY, type TuneAnalyserModuleData } from '../session/model';
import {
  isDriveConnected, hasDriveToken, manualSync, readDriveFile, findCompanionPath,
  listCompanionChildren, trashCompanionFile, driveBlobSize, type DriveChild,
} from './driveService';
import { snapshotStates } from './snapshotService';

/** Google's own name for a folder — the one thing a listing must never treat
 *  as a file. */
const FOLDER_MIME = 'application/vnd.google-apps.folder';

// ── Companion files nothing points at any more ──────────────────────────────
// Files outlive the things that referenced them, in ways that are nobody's
// fault: a card deleted while offline on a device that never came back, an
// attachment brought home into the blob (its Drive copy is deliberately left
// alone — this app has exactly one trigger for deleting one), a library
// restored onto the same Drive, which re-uploads everything it carries.
//
// Listing a folder and deleting whatever is unreferenced is a genuinely
// dangerous idea: it destroys the file another device wrote a minute ago and
// whose blob has not come down yet. Three conditions, all of them required,
// make it safe:
//
//   1. Judge against the SERVER blob, never the local copy — and push first,
//      so nothing this device just created can look unreferenced. That removes
//      "the other device pushed and we have not read it".
//   2. Ignore anything younger than 30 days. That covers the window where a
//      file is uploaded but its blob not yet pushed (30 s debounce,
//      MAX_PENDING_MS 5 min) with four orders of magnitude to spare.
//   3. Trash, never delete, and only on an explicit gesture with the count and
//      the size in view. A sweep can be wrong; a trashed file comes back with
//      one click, a deleted one never does.
//
// A fourth, added 2026-09-29: a file one of this device's snapshots still
// names is not an orphan, whatever the server blob says. Restoring the
// snapshot would hand it back, and the snapshot has no other copy of it.
//
// And it looks only where it understands what it sees: the attachments folder,
// whose every file is an attachment, and recordings in the companion root,
// which carry their session id in their name. The live-recording backups live
// in a folder of their own with their own lifecycle and are never touched.

const ATTACHMENTS_DIR = 'attachments';
const MIN_AGE_DAYS = 30;
/** `cadence-session-<id>.<ext>`, as session/db.ts writes it. Anything else in
 *  the companion root is something this sweep does not understand, and what it
 *  does not understand it leaves alone. */
const SESSION_AUDIO = /^cadence-session-.+\.[^.]+$/;

export interface DriveOrphan {
  id: string;
  name: string;
  bytes: number;
  kind: 'attachment' | 'recording';
}

export class OrphanScanUnavailable extends Error {
  constructor(public readonly reason: 'not-connected' | 'unreadable' | 'snapshots') { super('orphan_scan:' + reason); }
}

function bytesOf(child: DriveChild): number {
  const n = Number(child.size);
  return Number.isFinite(n) ? n : 0;
}

function oldEnough(child: DriveChild, now: number): boolean {
  // No createdTime at all: treated as too young. An unknown age is not a
  // licence to delete.
  if (!child.createdTime) return false;
  const created = Date.parse(child.createdTime);
  if (!Number.isFinite(created)) return false;
  return now - created > MIN_AGE_DAYS * 24 * 60 * 60 * 1000;
}

/** Every Drive file id the SERVER state points at, by kind. */
function referenced(state: AppState): { attachments: Set<string>; recordings: Set<string> } {
  const attachments = new Set<string>();
  for (const card of Object.values(state.cards ?? {})) {
    for (const att of card.content?.attachments ?? []) {
      if (att.type === 'file' && att.external?.driveFileId) attachments.add(att.external.driveFileId);
    }
  }
  const recordings = new Set<string>();
  const mod = state.modules?.[TUNE_ANALYSER_MODULE_KEY] as TuneAnalyserModuleData | undefined;
  for (const entry of Object.values(mod?.syncedAudio ?? {})) {
    if (entry?.fileId) recordings.add(entry.fileId);
  }
  return { attachments, recordings };
}

/** Pushes what is pending, re-reads the server blob, and reports what is left
 *  over. Changes nothing.
 *
 *  `tooYoung` counts the files nothing points at that the age rule spared. It
 *  is reported rather than swallowed because otherwise the honest answer
 *  ("nothing to delete") and the surprising one ("I can see it right there")
 *  look identical — and the rule that makes this safe stays invisible until
 *  someone assumes it is broken. `inSnapshots` likewise, for the files only a
 *  snapshot of `userId`'s still names. */
export async function findDriveOrphans(userId: string): Promise<{
  orphans: DriveOrphan[]; bytes: number; tooYoung: number; inSnapshots: number;
}> {
  if (!isDriveConnected()) throw new OrphanScanUnavailable('not-connected');

  // Condition 1, first half: anything this device is holding goes up before
  // anything is judged unreferenced. A failure here is not fatal — the read
  // below is what decides — but it is the cheap way to avoid the obvious
  // false positive.
  await manualSync().catch(e => console.warn('[orphans] could not push before scanning', e));

  const read = await readDriveFile(true);
  // Condition 1, second half. An unreadable or empty blob means every file
  // looks unreferenced, which is the worst possible moment to start deleting.
  if (read.status !== 'ok') throw new OrphanScanUnavailable('unreadable');
  const refs = referenced(read.data);

  // Condition 4, and fatal when it fails for the same reason as the blob: a
  // snapshot that could not be read makes its files look unreferenced. Read
  // after the push, which can itself resolve a conflict and so take one.
  const held = { attachments: new Set<string>(), recordings: new Set<string>() };
  try {
    for (const state of await snapshotStates(userId)) {
      const r = referenced(state);
      for (const id of r.attachments) held.attachments.add(id);
      for (const id of r.recordings) held.recordings.add(id);
    }
  } catch (e) {
    console.warn('[orphans] could not read the snapshots', e);
    throw new OrphanScanUnavailable('snapshots');
  }

  const now = Date.now();
  const orphans: DriveOrphan[] = [];
  let tooYoung = 0;
  let inSnapshots = 0;

  const consider = (child: DriveChild, kind: DriveOrphan['kind'], referenced: boolean) => {
    if (referenced) return;
    if ((kind === 'attachment' ? held.attachments : held.recordings).has(child.id)) { inSnapshots++; return; }
    if (!oldEnough(child, now)) { tooYoung++; return; }
    orphans.push({ id: child.id, name: child.name, bytes: bytesOf(child), kind });
  };

  const attachmentsFolder = await findCompanionPath([ATTACHMENTS_DIR], true);
  if (attachmentsFolder) {
    for (const child of await listCompanionChildren(attachmentsFolder, true)) {
      if (child.mimeType === FOLDER_MIME) continue;
      consider(child, 'attachment', refs.attachments.has(child.id));
    }
  }

  const root = await findCompanionPath([], true);
  if (root) {
    for (const child of await listCompanionChildren(root, true)) {
      if (!SESSION_AUDIO.test(child.name)) continue;
      consider(child, 'recording', refs.recordings.has(child.id));
    }
  }

  return { orphans, bytes: orphans.reduce((n, o) => n + o.bytes, 0), tooYoung, inSnapshots };
}

// ── What all of it weighs, up there ─────────────────────────────────────────

/** Drive's side of the storage panel, post by post.
 *
 *  Measured on the FOLDERS, not on the library: orphans are counted, because
 *  the figure is there to explain where space went and space nothing points at
 *  is exactly the space someone cannot otherwise account for. The orphan
 *  button beside it is then the way to act on the difference.
 *
 *  Null means "could not look" — no connection, no token, a failed request —
 *  and is shown as such rather than as zero. Never interactive. */
export async function driveStorageUsage(): Promise<{
  data: number | null; attachments: number | null; recordings: number | null;
}> {
  const nothing = { data: null, attachments: null, recordings: null };
  if (!isDriveConnected() || !hasDriveToken()) return nothing;

  const data = await driveBlobSize();
  const sum = async (folder: string | null, keep: (c: DriveChild) => boolean) => {
    if (!folder) return 0;   // the folder does not exist yet: nothing there, and that is a fact
    let bytes = 0;
    for (const child of await listCompanionChildren(folder, false)) {
      if (child.mimeType === FOLDER_MIME || !keep(child)) continue;
      bytes += bytesOf(child);
    }
    return bytes;
  };

  try {
    const attachments = await sum(await findCompanionPath([ATTACHMENTS_DIR], false), () => true);
    const recordings = await sum(await findCompanionPath([], false), c => SESSION_AUDIO.test(c.name));
    return { data, attachments, recordings };
  } catch (e) {
    console.warn('[drive] could not measure the companion folders', e);
    return { data, attachments: null, recordings: null };
  }
}

/** Moves them to the user's Drive trash. Counted, not thrown: one file that
 *  will not move must not abandon the rest. */
export async function trashDriveOrphans(
  orphans: DriveOrphan[],
): Promise<{ count: number; bytes: number; failed: number }> {
  let count = 0, bytes = 0, failed = 0;
  for (const o of orphans) {
    if (await trashCompanionFile(o.id, false)) { count++; bytes += o.bytes; }
    else failed++;
  }
  return { count, bytes, failed };
}
