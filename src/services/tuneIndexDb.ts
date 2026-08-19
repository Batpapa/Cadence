import { openDB, type IDBPDatabase } from 'idb';

// ── TheSession tune-name index IndexedDB ──────────────────────────────────────
// Separate database from the main Cadence user DB, the sessions DB, and the
// trending DB — holds a compact, tune-level (deduped from per-setting rows)
// index synced from adactio/TheSession-data's json/tunes.json, used to search
// by name locally instead of hitting TheSession's own (much lower quality)
// /tunes/search API. Single KV store, same minimal shape as the other
// feature-specific DBs (trending/db.ts, session/db.ts).

const DB_NAME = 'cadence-tune-name-index';
const DB_VERSION = 1;
const KV_STORE = 'kv';
const DB_KEY = 'tuneNameIndex';

export interface LocalTune {
  id: number;
  name: string;
  type: string;
  meter: string;
  mode: string;
}

export interface TuneNameIndexDb {
  /** Latest known commit SHA for json/tunes.json — staleness check compares
   *  against this (see tuneNameIndexService.ts). Null until the first sync. */
  commitSha: string | null;
  tunes: LocalTune[];
}

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

export function emptyTuneNameIndexDb(): TuneNameIndexDb {
  return { commitSha: null, tunes: [] };
}

export async function loadTuneNameIndexDb(): Promise<TuneNameIndexDb> {
  const stored = await (await db()).get(KV_STORE, DB_KEY) as TuneNameIndexDb | undefined;
  return stored ?? emptyTuneNameIndexDb();
}

export async function saveTuneNameIndexDb(value: TuneNameIndexDb): Promise<void> {
  await (await db()).put(KV_STORE, value, DB_KEY);
}
