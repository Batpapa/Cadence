import { openDB, type IDBPDatabase } from 'idb';

// ── IrishTuneInfo⇒TheSession mapping IndexedDB ───────────────────────────────
// Separate database from the main Cadence user DB, the sessions DB, and the
// trending DB — holds the id mapping synced from TheSession's "Irishtune.info"
// collection (https://thesession.org/tunes/collections/4). Single KV store,
// same minimal shape as trending/db.ts's own kv store.

const DB_NAME = 'cadence-iti-mapping';
const DB_VERSION = 1;
const KV_STORE = 'kv';
const DB_KEY = 'mappingDb';

export interface ItiMappingEntry {
  sessionId: number;
  name: string;
}

export interface ItiMappingDb {
  /** Last-seen `total` field from the collection's page 1 — cheap change
   *  detector: unchanged means the mapping is still up to date. */
  total: number;
  /** IrishTuneInfo numeric tune id → its TheSession equivalent. */
  byItiId: Record<number, ItiMappingEntry>;
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

export function emptyItiMappingDb(): ItiMappingDb {
  return { total: 0, byItiId: {} };
}

export async function loadItiMappingDb(): Promise<ItiMappingDb> {
  const stored = await (await db()).get(KV_STORE, DB_KEY) as ItiMappingDb | undefined;
  return stored ?? emptyItiMappingDb();
}

export async function saveItiMappingDb(value: ItiMappingDb): Promise<void> {
  await (await db()).put(KV_STORE, value, DB_KEY);
}
