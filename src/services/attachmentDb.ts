import { openDB, type IDBPDatabase } from 'idb';

// ── Where an externalised attachment's bytes live on this device ─────────────
// An attachment above the size threshold is not carried in the synced user blob
// any more (see attachmentStore.ts for the rule and the reasons). Its bytes sit
// here, one row per attachment, keyed by the id the attachment carries in
// `external.id` — an identity of its own precisely because an attachment has
// none otherwise: it is found by its index in a list, and that index moves when
// a list is reordered or a sibling is removed.
//
// ONE DATABASE PER USER, named after them, exactly like the analyser's local
// database next door. Not a shared one keyed by user: the shared shape is what
// leaked one user's recordings into another's library on 2026-08-26, and a
// database that belongs to nobody in particular is a database nobody deletes.
//
// This is a CACHE ONLY in the sense that a copy exists on Drive once it has
// been uploaded — never before. Until `external.driveFileId` is set, these
// bytes exist nowhere else in the world, which is why nothing here deletes a
// row on its own and why "free up space" (settings) refuses to touch a row
// whose Drive copy is not proven.

const STORE = 'blobs';
/** Drive files whose attachment is gone, waiting for a chance to be deleted.
 *
 *  A journal is needed here and nowhere else in this app's Drive work. An
 *  upload that has not happened is deducible from the state — bytes present,
 *  `driveFileId` absent — so the backlog needs no record. A DELETION is the
 *  opposite: once the attachment is gone from the state, nothing left says
 *  that a file out there should die. Hence this.
 *
 *  In the user's own database and not a shared one, deliberately: removing a
 *  user from this device does not delete their Drive files either (see
 *  deleteLocalAttachmentData), so losing their pending deletions along with
 *  their data is the same rule, not an oversight. */
const GRAVEYARD = 'graveyard';
const DB_VERSION = 2;

function dbName(userId: string): string {
  return `cadence-attachments-local-user-${userId}`;
}

let _db: IDBPDatabase | null = null;
let _userId: string | null = null;

/** Point this module at `userId`'s database. Called from the same places as
 *  `initSessionDbForUser`, and for the same reason it closes first: an open
 *  connection makes `deleteDatabase` fire `onblocked` instead of deleting, so a
 *  reference merely dropped leaves the previous user's data undeletable for the
 *  life of the tab (the 2026-09-08 bug, next door). */
export function initAttachmentDbForUser(userId: string): void {
  if (_userId === userId) return;
  _userId = userId;
  _db?.close();
  _db = null;
}

async function db(): Promise<IDBPDatabase> {
  if (!_userId) throw new Error('attachmentDb.ts: initAttachmentDbForUser() not called yet');
  if (_db) return _db;
  _db = await openDB(dbName(_userId), DB_VERSION, {
    // Existence-checked rather than gated on oldVersion: this database is
    // young, and a store that is simply created when missing behaves the same
    // however the base came to exist.
    upgrade(d) {
      if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE);
      if (!d.objectStoreNames.contains(GRAVEYARD)) d.createObjectStore(GRAVEYARD);
    },
  });
  return _db;
}

export async function putAttachmentBlob(id: string, blob: Blob): Promise<void> {
  await (await db()).put(STORE, blob, id);
}

/** The bytes as held on THIS device, or undefined when they are not here —
 *  added on another device, or freed. Never reaches for the network: going to
 *  Drive is attachmentStore's decision, not this module's. */
export async function getAttachmentBlob(id: string): Promise<Blob | undefined> {
  return (await db()).get(STORE, id);
}

export async function deleteAttachmentBlob(id: string): Promise<void> {
  await (await db()).delete(STORE, id);
}

/** Every id this device holds bytes for. Read by the sweep that drops the ones
 *  nothing points at any more. */
export async function heldAttachmentIds(): Promise<string[]> {
  return (await (await db()).getAllKeys(STORE)) as string[];
}

/** What this device actually holds, measured on the STORE and not on the
 *  state: orphans included, because a figure meant to explain where space went
 *  has to count the space nothing points at as well — that is precisely the
 *  space someone cannot otherwise find. */
export async function localAttachmentBytes(): Promise<{ count: number; bytes: number }> {
  const blobs = await (await db()).getAll(STORE) as Blob[];
  let bytes = 0;
  for (const b of blobs) if (b instanceof Blob) bytes += b.size;
  return { count: blobs.length, bytes };
}

/** Every attachment this device holds for `userId`, read WITHOUT going through
 *  the module's own connection.
 *
 *  For the recovery screen, which runs when the app could not start: it must
 *  not point this module at a user, must not trigger a version upgrade (the
 *  very thing that can be stuck), and must work for a user who is not the one
 *  loaded. Opened at whatever version is on disk, exactly as
 *  `localSessionAudioStats` does next door, and null when there is no such
 *  database — which is the common case, not a failure. */
export async function rawAttachmentBlobs(userId: string): Promise<Map<string, Blob> | null> {
  const name = dbName(userId);
  try {
    if (indexedDB.databases) {
      const all = await indexedDB.databases();
      if (!all.some(d => d.name === name)) return null;
    }
    const raw = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(name);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error('indexeddb_blocked'));
    });
    try {
      if (!raw.objectStoreNames.contains(STORE)) return null;
      return await new Promise<Map<string, Blob>>((resolve, reject) => {
        const out = new Map<string, Blob>();
        const cursor = raw.transaction(STORE, 'readonly').objectStore(STORE).openCursor();
        cursor.onsuccess = () => {
          const c = cursor.result;
          if (!c) { resolve(out); return; }
          if (c.value instanceof Blob) out.set(String(c.key), c.value);
          c.continue();
        };
        cursor.onerror = () => reject(cursor.error);
      });
    } finally {
      raw.close();
    }
  } catch {
    return null;
  }
}

/** A Drive file to delete when Drive is next reachable. Keyed by file id, so
 *  condemning the same file twice is one row. */
export async function condemnDriveFile(driveFileId: string, attachmentId: string): Promise<void> {
  await (await db()).put(GRAVEYARD, { driveFileId, attachmentId, at: Date.now() }, driveFileId);
}

export interface Condemned { driveFileId: string; attachmentId: string; at: number }

export async function condemnedFiles(): Promise<Condemned[]> {
  return (await (await db()).getAll(GRAVEYARD)) as Condemned[];
}

export async function forgetCondemned(driveFileId: string): Promise<void> {
  await (await db()).delete(GRAVEYARD, driveFileId);
}

/** Drops the whole database when a user is removed from this device, or reset.
 *
 *  Best-effort, and deliberately: a blocked delete must not make a reset fail
 *  once it has done the part that matters. Same reasoning as
 *  `deleteLocalSessionData`, whose shape this follows.
 *
 *  Note what this does NOT do: it does not delete the Drive copies. Neither a
 *  reset nor removing a user touches the companion files today (verified
 *  2026-09-23 — `deleteLocalSessionData` is local-only and says so), and
 *  attachments follow the same rule rather than inventing an asymmetry. */
export async function deleteLocalAttachmentData(userId: string): Promise<void> {
  if (_db && _userId === userId) { _db.close(); _db = null; }
  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase(dbName(userId));
    req.onsuccess = () => resolve();
    req.onerror = () => resolve();
    req.onblocked = () => {
      console.warn(`[attachments] deleting ${dbName(userId)} was blocked by an open connection`);
      resolve();
    };
  });
}
