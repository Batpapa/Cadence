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
// Copied to Drive as the analyser's are (audioSync.ts, since 2026-11-28),
// which is what makes them heard on the user's other devices. Nothing here
// deletes a row on its own: deleting the transcription does, freeing its
// recording from this device once Drive has a copy, and removing the user
// from this device.

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

/** The transcriptions whose recording this device holds — the keys only,
 *  never the blobs; the take waiting to be transcribed is none of them. */
export async function transcriptionAudioKeys(): Promise<string[]> {
  const keys = await (await db()).getAllKeys(STORE) as string[];
  return keys.filter(k => k !== PENDING_KEY);
}

/** The user this module's database is open for. */
export function transcriptionDbUserId(): string | null {
  return _userId;
}

/** How much recording a user's database holds — for the storage panel and the
 *  warnings before a user is removed, as localSessionAudioStats does for the
 *  analyser's, and under the same rule: null when it cannot be told cheaply
 *  and safely (no database, an unreadable one, no `indexedDB.databases`),
 *  never an empty database created to find out. A take not transcribed yet
 *  counts: it is a recording only this device has. */
export async function localTranscriptionAudioStats(userId: string): Promise<{ count: number; bytes: number } | null> {
  const name = dbName(userId);
  if (!indexedDB.databases) return null;
  try {
    const all = await indexedDB.databases();
    if (!all.some(d => d.name === name)) return null;
    const raw = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(name);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error('indexeddb_blocked'));
    });
    try {
      if (!raw.objectStoreNames.contains(STORE)) return null;
      const values = await new Promise<unknown[]>((resolve, reject) => {
        const req = raw.transaction(STORE, 'readonly').objectStore(STORE).getAll();
        req.onsuccess = () => resolve(req.result as unknown[]);
        req.onerror = () => reject(req.error);
      });
      let count = 0, bytes = 0;
      for (const v of values) {
        const blob = v instanceof Blob ? v : (v as PendingTake | null)?.audio;
        if (blob instanceof Blob && blob.size > 0) { count++; bytes += blob.size; }
      }
      return count > 0 ? { count, bytes } : null;
    } finally {
      raw.close();
    }
  } catch {
    return null;
  }
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
