import { openDB, type IDBPDatabase } from 'idb';
import type { User } from './types';

const DB_NAME    = 'cadence';
const DB_VERSION = 2;
const USER_STORE = 'user';
const LEGACY_STORE   = 'state';
const LEGACY_KEY     = 'cadence-state';
const LS_LAST_USER   = 'cadence_last_user_id';

let _db: IDBPDatabase;

export async function initDb(): Promise<void> {
  _db = await openDB(DB_NAME, DB_VERSION, {
    upgrade(db, oldVersion) {
      // LEGACY_STORE ('state') is only present on v1 databases — never create it on fresh installs.
      if (oldVersion < 2) db.createObjectStore(USER_STORE);
    },
  });
}

export async function loadUser(id: string): Promise<User | undefined> {
  return _db.get(USER_STORE, id);
}

export async function saveUser(user: User): Promise<void> {
  await _db.put(USER_STORE, user, user.id);
}

export async function getAllUserIds(): Promise<string[]> {
  return _db.getAllKeys(USER_STORE) as Promise<string[]>;
}

/** Read from the legacy single-key store for one-time migration. */
export async function loadLegacyState(): Promise<Record<string, unknown> | undefined> {
  try {
    return await _db.get(LEGACY_STORE, LEGACY_KEY);
  } catch {
    return undefined;
  }
}

export async function deleteUser(id: string): Promise<void> {
  await _db.delete(USER_STORE, id);
}

/** Drop the legacy store entirely after migration. Closes and reopens the DB. */
export async function dropLegacyStore(): Promise<void> {
  const nextVersion = _db.version + 1;
  _db.close();
  _db = await openDB(DB_NAME, nextVersion, {
    upgrade(db) {
      if (db.objectStoreNames.contains(LEGACY_STORE)) {
        db.deleteObjectStore(LEGACY_STORE);
      }
    },
  });
}

export function getLastUserId(): string | null {
  return localStorage.getItem(LS_LAST_USER);
}

export function setLastUserId(id: string): void {
  localStorage.setItem(LS_LAST_USER, id);
}

export function clearLastUserId(): void {
  localStorage.removeItem(LS_LAST_USER);
}

export async function loadAllUsers(): Promise<import('./types').User[]> {
  const ids = await getAllUserIds();
  const users = await Promise.all(ids.map(id => loadUser(id)));
  return users.filter((u): u is import('./types').User => u !== undefined);
}
