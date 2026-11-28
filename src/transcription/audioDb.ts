import { openDB, type IDBPDatabase } from 'idb';

// ── The recordings transcribed, on this device ───────────────────────────────
// One row per transcription, keyed by its id: the recording it was written out
// of, whole — the passage is the record's (model.ts), so a new transcription of
// another passage needs nothing more. Never in the synced blob: the analyser's
// rule (session/db.ts), a recording being the largest thing this app stores.
//
// ONE DATABASE PER USER, named after them, as the analyser's and the
// attachments' (services/attachmentDb.ts, which says why). Version 1, and it
// stays 1: a tab still open on an older bundle blocks an upgrade, and the
// module hangs waiting for it (session/db.ts). A store added later is added
// under a NEW database name, never by an upgrade.
//
// Not on Drive yet: a recording transcribed on one device is heard on that one
// (2026-11-27 — the Drive copy is the module's next step). Nothing here deletes
// a row on its own: only deleting the transcription does, and removing the
// user from this device.

const STORE = 'audio';
const DB_VERSION = 1;

function dbName(userId: string): string {
  return `cadence-transcription-local-user-${userId}`;
}

let _db: IDBPDatabase | null = null;
let _userId: string | null = null;

/** Points this module at `userId`'s database — from the same places as
 *  initAttachmentDbForUser, closing first for the same reason (an open
 *  connection blocks deleteDatabase). */
export function initTranscriptionDbForUser(userId: string): void {
  if (_userId === userId) return;
  _userId = userId;
  _db?.close();
  _db = null;
}

async function db(): Promise<IDBPDatabase> {
  if (!_userId) throw new Error('transcription/audioDb.ts: initTranscriptionDbForUser() not called yet');
  if (_db) return _db;
  _db = await openDB(dbName(_userId), DB_VERSION, {
    upgrade(d) {
      if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE);
    },
  });
  return _db;
}

export async function putTranscriptionAudio(id: string, blob: Blob): Promise<void> {
  await (await db()).put(STORE, blob, id);
}

/** The recording as held on THIS device, or undefined (transcribed on another). */
export async function getTranscriptionAudio(id: string): Promise<Blob | undefined> {
  return (await db()).get(STORE, id);
}

export async function deleteTranscriptionAudio(id: string): Promise<void> {
  await (await db()).delete(STORE, id);
}

/** Drops the whole database when a user is removed from this device, or reset.
 *  Best-effort, as deleteLocalAttachmentData: a blocked delete must not make a
 *  reset fail once it has done the part that matters. */
export async function deleteLocalTranscriptionData(userId: string): Promise<void> {
  if (_db && _userId === userId) { _db.close(); _db = null; }
  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase(dbName(userId));
    req.onsuccess = () => resolve();
    req.onerror = () => resolve();
    req.onblocked = () => {
      console.warn(`[transcription] deleting ${dbName(userId)} was blocked by an open connection`);
      resolve();
    };
  });
}

// ── A take not transcribed yet ───────────────────────────────────────────────
// A recording made in the module (the microphone, the device's sound) exists
// nowhere else until it is transcribed: kept here as soon as it is made, under
// a key no transcription can have (ids are generateId's), so a tab closed or a
// phone that drops the page in the background loses nothing — the setup comes
// back at the next visit (the review of 2026-11-28, the user: yes). One at a
// time: a new take replaces it.

const PENDING_KEY = 'pending-take';

/** What the setup needs back (transcription/ui/state.ts SetupSource). */
export interface PendingTake { audio: Blob; label: string; source: 'mic' | 'device'; duration: number; mimeType: string; folder?: string | null }

export async function putPendingTake(take: PendingTake): Promise<void> {
  await (await db()).put(STORE, take, PENDING_KEY);
}

export async function getPendingTake(): Promise<PendingTake | undefined> {
  const v: unknown = await (await db()).get(STORE, PENDING_KEY);
  // checked: a row written by a later build may be anything
  if (!v || typeof v !== 'object' || !((v as PendingTake).audio instanceof Blob)) return undefined;
  return v as PendingTake;
}

export async function deletePendingTake(): Promise<void> {
  await (await db()).delete(STORE, PENDING_KEY);
}
