import { openDB, type IDBPDatabase } from 'idb';

// ── Trending-feature IndexedDB ────────────────────────────────────────────────
// Separate database from the main Cadence user DB and from the sessions DB
// (session/db.ts) — holds the compact TheSession popularity history synced
// from adactio/TheSession-data. Single KV store, same minimal shape as
// session/db.ts's own kv store.

const DB_NAME = 'cadence-trending';
const DB_VERSION = 1;
const KV_STORE = 'kv';

export interface PopularityDb {
  /** Commit timestamps (ISO), oldest first — one per weekly snapshot applied so far. */
  snapshots: string[];
  /** tuneId → one tunebooks count (or null if absent that week) per entry in `snapshots`, same length/order. */
  tunes: Record<string, (number | null)[]>;
  /** tuneId → most recently seen name. */
  names: Record<string, string>;
}

const DB_KEY = 'popularityDb';

let _db: IDBPDatabase | null = null;

async function db(): Promise<IDBPDatabase> {
  if (_db) return _db;
  _db = await openDB(DB_NAME, DB_VERSION, {
    upgrade(d) {
      d.createObjectStore(KV_STORE);
    },
  });
  return _db;
}

export function emptyPopularityDb(): PopularityDb {
  return { snapshots: [], tunes: {}, names: {} };
}

export async function loadPopularityDb(): Promise<PopularityDb> {
  const stored = await (await db()).get(KV_STORE, DB_KEY) as PopularityDb | undefined;
  return stored ?? emptyPopularityDb();
}

export async function savePopularityDb(value: PopularityDb): Promise<void> {
  await (await db()).put(KV_STORE, value, DB_KEY);
}
