import { openDB, type IDBPDatabase } from 'idb';
import type { AppState } from './types';

const DB_VERSION  = 1;
const STORE       = 'state';
const STATE_KEY   = 'cadence-state';
const LEGACY_DB   = 'cadence'; // pre-workspace single database

let _db: IDBPDatabase;

async function openNamed(name: string): Promise<IDBPDatabase> {
  return openDB(name, DB_VERSION, {
    upgrade(db) { db.createObjectStore(STORE); },
  });
}

export async function initDb(workspaceId: string): Promise<void> {
  _db = await openNamed(`cadence-${workspaceId}`);
}

export async function loadState(): Promise<AppState | undefined> {
  return _db.get(STORE, STATE_KEY);
}

export async function saveState(state: AppState): Promise<void> {
  await _db.put(STORE, state, STATE_KEY);
}

/** Read from the legacy single-workspace DB for one-time migration. */
export async function loadLegacyState(): Promise<AppState | undefined> {
  try {
    const db    = await openNamed(LEGACY_DB);
    const state = await db.get(STORE, STATE_KEY) as AppState | undefined;
    db.close();
    return state;
  } catch {
    return undefined;
  }
}
