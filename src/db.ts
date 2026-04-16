import { openDB, type IDBPDatabase } from 'idb';
import type { AppState } from './types';

const DB_NAME = 'cadence';
const DB_VERSION = 1;
const STORE = 'state';
const STATE_KEY = 'cadence-state';

let _db: IDBPDatabase;

export async function initDb(): Promise<void> {
  _db = await openDB(DB_NAME, DB_VERSION, {
    upgrade(db) {
      db.createObjectStore(STORE);
    },
  });
}

export async function loadState(): Promise<AppState | undefined> {
  return _db.get(STORE, STATE_KEY);
}

export async function saveState(state: AppState): Promise<void> {
  await _db.put(STORE, state, STATE_KEY);
}
