import { openDB, type IDBPDatabase } from 'idb';
import type { RecordedSession, WindowResult } from './model';

// ── Session-feature IndexedDB ─────────────────────────────────────────────────
// Two databases:
//  - `cadence-sessions` (one shared instance per device): just the KV store —
//    the (large) downloaded FolkFriend/TheSession tune index. Not personal
//    data, so it's kept shared across every local user rather than
//    re-downloaded per user. Schema version deliberately frozen at 1 forever
//    (see sharedDb()'s doc) — this file used to also hold SESSIONS_STORE/
//    CHUNKS_STORE here, still present as dead weight on devices that had them.
//  - `cadence-sessions-user-{userId}` (one per local user): recorded session
//    audio/metadata + in-flight recording chunks — genuinely personal, so it
//    must never be visible across users sharing one device (2026-08-26 bug:
//    a second local user on the same device could see the first user's
//    recorded sessions, because this used to be one database for everyone).
// Works in both window and worker contexts — kvGet/kvSet run inside the
// FolkFriend worker (ffWorker.ts → indexStore.ts), everything else runs on
// the main thread (liveSession.ts, importSession.ts, recovery.ts, …).

const SHARED_DB_NAME    = 'cadence-sessions';
const SHARED_DB_VERSION = 1;
const KV_STORE = 'kv'; // tune index + metadata

const USER_DB_VERSION = 1;
const SESSIONS_STORE = 'sessions'; // RecordedSession (metadata + audio blob)
const CHUNKS_STORE   = 'chunks';   // in-flight recording chunks (crash recovery)

let _userId: string | null = null;
let _sharedDb: IDBPDatabase | null = null;
let _userDb: IDBPDatabase | null = null;

/** Must be called once the active local user is known (main.ts, alongside
 *  initDriveForUser) before anything in this module touches per-user data —
 *  everything below routes through whichever user was set here. */
export function initSessionDbForUser(userId: string): void {
  if (_userId === userId) return;
  _userId = userId;
  _userDb = null; // force the next userDb() call to open the new user's database
}

/** The schema version stays 1 forever, deliberately never bumped: this
 *  database is also opened from the FolkFriend worker thread (a separate JS
 *  context with its own copy of this module's state), and a version bump
 *  triggers a versionchange transaction that could race against the main
 *  thread's legacy-migration copy below — whichever side's upgrade transaction
 *  runs first would delete SESSIONS_STORE/CHUNKS_STORE before the other side
 *  got a chance to read them. Never touching the schema at all sidesteps
 *  that race entirely: KV_STORE is created (existence-checked, not
 *  oldVersion-gated, so this is safe however/whenever the DB first came to
 *  exist) once and never altered again, and SESSIONS_STORE/CHUNKS_STORE — on
 *  devices that still have them from before this fix — are drained of their
 *  ROWS by userDb() below via a plain readwrite transaction (no schema
 *  change), never deleted as object stores. */
async function sharedDb(): Promise<IDBPDatabase> {
  if (_sharedDb) return _sharedDb;
  _sharedDb = await openDB(SHARED_DB_NAME, SHARED_DB_VERSION, {
    upgrade(d) {
      if (!d.objectStoreNames.contains(KV_STORE)) d.createObjectStore(KV_STORE);
    },
  });
  return _sharedDb;
}

/** One-time migration off the old shared-for-everyone sessions store: the
 *  first per-user database to be opened after this fix ships claims whatever
 *  legacy rows are still sitting in the old shared `cadence-sessions`
 *  database's SESSIONS_STORE/CHUNKS_STORE (a device that predates the
 *  per-user split), copies them in, then deletes them from the shared store
 *  so a second local user's first load doesn't also claim them. A deliberate
 *  "first user to load after the fix wins" migration rather than per-session
 *  attribution, which isn't recoverable (old sessions carry no owner
 *  information at all). No-op (nothing to copy) on a device that never had
 *  the old shared schema, or that's already been through this once. */
async function migrateLegacySessions(target: IDBPDatabase): Promise<void> {
  const shared = await sharedDb();
  if (!shared.objectStoreNames.contains(SESSIONS_STORE)) return;
  const keys   = (await shared.getAllKeys(SESSIONS_STORE)) as string[];
  const values = await shared.getAll(SESSIONS_STORE);
  const chunks = shared.objectStoreNames.contains(CHUNKS_STORE) ? await shared.getAll(CHUNKS_STORE) : [];
  if (keys.length === 0 && chunks.length === 0) return;

  const targetTx = target.transaction([SESSIONS_STORE, CHUNKS_STORE], 'readwrite');
  keys.forEach((k, i) => void targetTx.objectStore(SESSIONS_STORE).put(values[i], k));
  for (const c of chunks) void targetTx.objectStore(CHUNKS_STORE).add(c);
  await targetTx.done;

  const sharedTx = shared.transaction([SESSIONS_STORE, CHUNKS_STORE], 'readwrite');
  for (const k of keys) void sharedTx.objectStore(SESSIONS_STORE).delete(k);
  await sharedTx.objectStore(CHUNKS_STORE).clear();
  await sharedTx.done;
}

async function userDb(): Promise<IDBPDatabase> {
  if (!_userId) throw new Error('session/db.ts: initSessionDbForUser() not called yet');
  if (_userDb) return _userDb;
  const d = await openDB(`cadence-sessions-user-${_userId}`, USER_DB_VERSION, {
    upgrade(db) {
      db.createObjectStore(SESSIONS_STORE);
      db.createObjectStore(CHUNKS_STORE, { autoIncrement: true });
    },
  });
  await migrateLegacySessions(d);
  _userDb = d;
  return _userDb;
}

// ── KV (tune index cache) ─────────────────────────────────────────────────────

export async function kvGet<T>(key: string): Promise<T | undefined> {
  return (await sharedDb()).get(KV_STORE, key);
}

export async function kvSet(key: string, value: unknown): Promise<void> {
  await (await sharedDb()).put(KV_STORE, value, key);
}

// ── Recorded sessions ─────────────────────────────────────────────────────────

/** Audio blob is stored separately from metadata so listing sessions stays cheap. */
export async function saveSessionMeta(session: RecordedSession): Promise<void> {
  await (await userDb()).put(SESSIONS_STORE, session, session.id);
}

export async function saveSessionAudio(sessionId: string, audio: Blob): Promise<void> {
  await (await userDb()).put(SESSIONS_STORE, audio, `${sessionId}:audio`);
}

/** Raw per-window recognition results for an in-progress LIVE recording
 *  (2026-08-15) — recovery.ts replays these through a fresh
 *  IncrementalViterbiSegmenter instead of trusting a persisted annotation
 *  snapshot, so a crash mid-session can never resurrect a short-lived,
 *  never-confirmed guess (which the live snapshot could contain at any given
 *  instant) as a "real" finalized annotation. Overwritten wholesale on every
 *  persistDraft() call, same as the audio blob and the metadata row —
 *  simplest correct thing, not bounded, per the same "recompute is cheap
 *  enough" call made throughout this feature. */
export async function saveSessionWindows(sessionId: string, windows: WindowResult[]): Promise<void> {
  await (await userDb()).put(SESSIONS_STORE, windows, `${sessionId}:windows`);
}

export async function loadSessionWindows(sessionId: string): Promise<WindowResult[] | undefined> {
  return (await userDb()).get(SESSIONS_STORE, `${sessionId}:windows`);
}

/** Dead weight once a live recording is done (normally or via recovery) —
 *  only ever needed for crash-recovery replay of a still-in-progress session. */
export async function deleteSessionWindows(sessionId: string): Promise<void> {
  await (await userDb()).delete(SESSIONS_STORE, `${sessionId}:windows`);
}

/** Sessions saved before the `source` field existed were all mic recordings. */
function migrateSession(s: RecordedSession | undefined): RecordedSession | undefined {
  if (s && s.source === undefined) s.source = 'live';
  return s;
}

export async function loadSessionMeta(sessionId: string): Promise<RecordedSession | undefined> {
  return migrateSession(await (await userDb()).get(SESSIONS_STORE, sessionId));
}

export async function loadSessionAudio(sessionId: string): Promise<Blob | undefined> {
  return (await userDb()).get(SESSIONS_STORE, `${sessionId}:audio`);
}

export async function deleteSession(sessionId: string): Promise<void> {
  const d = await userDb();
  await d.delete(SESSIONS_STORE, sessionId);
  await d.delete(SESSIONS_STORE, `${sessionId}:audio`);
  await d.delete(SESSIONS_STORE, `${sessionId}:windows`);
}

/** Storage-saving: drops the (large) audio blob, keeps metadata + annotations.
 *  Irreversible — clip attachments can no longer be extracted from this session afterward. */
export async function forgetSessionAudio(sessionId: string): Promise<void> {
  await (await userDb()).delete(SESSIONS_STORE, `${sessionId}:audio`);
}

export async function listSessions(): Promise<RecordedSession[]> {
  const d = await userDb();
  const keys = (await d.getAllKeys(SESSIONS_STORE)) as string[];
  const metaKeys = keys.filter(k => !k.endsWith(':audio'));
  const sessions = await Promise.all(metaKeys.map(k => d.get(SESSIONS_STORE, k) as Promise<RecordedSession>));
  // Undated sessions (fresh imports) sort first — they're the current work.
  return sessions.map(s => migrateSession(s)!).sort((a, b) => (b.date ?? '￿').localeCompare(a.date ?? '￿'));
}

// ── Recording chunks (crash recovery) ─────────────────────────────────────────

export async function appendChunk(recordingId: string, seq: number, blob: Blob): Promise<void> {
  await (await userDb()).add(CHUNKS_STORE, { recordingId, seq, blob });
}

export async function collectChunks(recordingId: string): Promise<Blob[]> {
  const d = await userDb();
  const all = await d.getAll(CHUNKS_STORE) as { recordingId: string; seq: number; blob: Blob }[];
  return all
    .filter(c => c.recordingId === recordingId)
    .sort((a, b) => a.seq - b.seq)
    .map(c => c.blob);
}

export async function clearChunks(recordingId: string): Promise<void> {
  const d = await userDb();
  const tx = d.transaction(CHUNKS_STORE, 'readwrite');
  let cursor = await tx.store.openCursor();
  while (cursor) {
    if ((cursor.value as { recordingId: string }).recordingId === recordingId) await cursor.delete();
    cursor = await cursor.continue();
  }
  await tx.done;
}
