import { openDB, type IDBPDatabase } from 'idb';
import type { User } from './types';

const DB_NAME    = 'cadence';
const DB_VERSION = 3;
const USER_STORE   = 'user';
const LEGACY_STORE = 'state';
const LEGACY_KEY   = 'cadence-state';
const LS_LAST_USER  = 'cadence_last_user_id';
const LS_USER_ORDER = 'cadence_user_order';

let _db: IDBPDatabase;

export async function initDb(): Promise<void> {
  _db = await openDB(DB_NAME, DB_VERSION, {
    upgrade(db, oldVersion) {
      if (oldVersion < 2) db.createObjectStore(USER_STORE);
      // v2→v3: drop empty legacy store if still present (migration already cleared its data)
      if (oldVersion === 2 && db.objectStoreNames.contains(LEGACY_STORE)) {
        db.deleteObjectStore(LEGACY_STORE);
      }
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

/** Clear the legacy data entry after migration (store is dropped on next upgrade). */
export async function deleteLegacyState(): Promise<void> {
  try {
    await _db.delete(LEGACY_STORE, LEGACY_KEY);
  } catch { /* ignore */ }
}

export async function deleteUser(id: string): Promise<void> {
  await _db.delete(USER_STORE, id);
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

function readUserOrder(): string[] {
  try { return JSON.parse(localStorage.getItem(LS_USER_ORDER) ?? '[]') as string[]; } catch { return []; }
}

/** Move userId to front of the usage-order list. */
export function touchUserOrder(id: string): void {
  const order = readUserOrder().filter(x => x !== id);
  order.unshift(id);
  localStorage.setItem(LS_USER_ORDER, JSON.stringify(order));
}

/** Remove userId from the usage-order list (on delete). */
export function removeUserFromOrder(id: string): void {
  const order = readUserOrder().filter(x => x !== id);
  localStorage.setItem(LS_USER_ORDER, JSON.stringify(order));
}

export async function loadAllUsers(): Promise<User[]> {
  const ids = await getAllUserIds();
  const users = (await Promise.all(ids.map(id => loadUser(id)))).filter((u): u is User => u !== undefined);
  const order = readUserOrder();
  return users.sort((a, b) => {
    const ai = order.indexOf(a.id);
    const bi = order.indexOf(b.id);
    if (ai === -1 && bi === -1) return 0;
    if (ai === -1) return 1;
    if (bi === -1) return -1;
    return ai - bi;
  });
}
