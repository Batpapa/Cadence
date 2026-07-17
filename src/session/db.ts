import { openDB, type IDBPDatabase } from 'idb';
import type { RecordedSession } from './model';

// ── Session-feature IndexedDB ─────────────────────────────────────────────────
// Separate database from the main Cadence user DB: holds the (large) FolkFriend
// tune index, recorded session audio, and crash-recovery recording chunks.
// Works in both window and worker contexts.

const DB_NAME = 'cadence-sessions';
const DB_VERSION = 1;
const KV_STORE = 'kv';           // tune index + metadata
const SESSIONS_STORE = 'sessions'; // RecordedSession (metadata + audio blob)
const CHUNKS_STORE = 'chunks';     // in-flight recording chunks (crash recovery)

let _db: IDBPDatabase | null = null;

async function db(): Promise<IDBPDatabase> {
  if (_db) return _db;
  _db = await openDB(DB_NAME, DB_VERSION, {
    upgrade(d) {
      d.createObjectStore(KV_STORE);
      d.createObjectStore(SESSIONS_STORE);
      d.createObjectStore(CHUNKS_STORE, { autoIncrement: true });
    },
  });
  return _db;
}

// ── KV (tune index cache) ─────────────────────────────────────────────────────

export async function kvGet<T>(key: string): Promise<T | undefined> {
  return (await db()).get(KV_STORE, key);
}

export async function kvSet(key: string, value: unknown): Promise<void> {
  await (await db()).put(KV_STORE, value, key);
}

// ── Recorded sessions ─────────────────────────────────────────────────────────

/** Audio blob is stored separately from metadata so listing sessions stays cheap. */
export async function saveSessionMeta(session: RecordedSession): Promise<void> {
  await (await db()).put(SESSIONS_STORE, session, session.id);
}

export async function saveSessionAudio(sessionId: string, audio: Blob): Promise<void> {
  await (await db()).put(SESSIONS_STORE, audio, `${sessionId}:audio`);
}

/** Sessions saved before the `source` field existed were all mic recordings. */
function migrateSession(s: RecordedSession | undefined): RecordedSession | undefined {
  if (s && s.source === undefined) s.source = 'live';
  return s;
}

export async function loadSessionMeta(sessionId: string): Promise<RecordedSession | undefined> {
  return migrateSession(await (await db()).get(SESSIONS_STORE, sessionId));
}

export async function loadSessionAudio(sessionId: string): Promise<Blob | undefined> {
  return (await db()).get(SESSIONS_STORE, `${sessionId}:audio`);
}

export async function deleteSession(sessionId: string): Promise<void> {
  const d = await db();
  await d.delete(SESSIONS_STORE, sessionId);
  await d.delete(SESSIONS_STORE, `${sessionId}:audio`);
}

export async function listSessions(): Promise<RecordedSession[]> {
  const d = await db();
  const keys = (await d.getAllKeys(SESSIONS_STORE)) as string[];
  const metaKeys = keys.filter(k => !k.endsWith(':audio'));
  const sessions = await Promise.all(metaKeys.map(k => d.get(SESSIONS_STORE, k) as Promise<RecordedSession>));
  // Undated sessions (fresh imports) sort first — they're the current work.
  return sessions.map(s => migrateSession(s)!).sort((a, b) => (b.date ?? '￿').localeCompare(a.date ?? '￿'));
}

// ── Recording chunks (crash recovery) ─────────────────────────────────────────

export async function appendChunk(recordingId: string, seq: number, blob: Blob): Promise<void> {
  await (await db()).add(CHUNKS_STORE, { recordingId, seq, blob });
}

export async function collectChunks(recordingId: string): Promise<Blob[]> {
  const d = await db();
  const all = await d.getAll(CHUNKS_STORE) as { recordingId: string; seq: number; blob: Blob }[];
  return all
    .filter(c => c.recordingId === recordingId)
    .sort((a, b) => a.seq - b.seq)
    .map(c => c.blob);
}

export async function clearChunks(recordingId: string): Promise<void> {
  const d = await db();
  const tx = d.transaction(CHUNKS_STORE, 'readwrite');
  let cursor = await tx.store.openCursor();
  while (cursor) {
    if ((cursor.value as { recordingId: string }).recordingId === recordingId) await cursor.delete();
    cursor = await cursor.continue();
  }
  await tx.done;
}
