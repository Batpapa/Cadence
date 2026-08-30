import { openDB, type IDBPDatabase } from 'idb';
import type { AppState } from '../types';

// ── Safety-net snapshots ─────────────────────────────────────────────────────
// Before ANY operation that wholesale-replaces a copy of the user's data (the
// boot fast-forward, either button of the conflict modal), the side about to
// be destroyed is stashed here. This is the floor under every sync bug, found
// or not: nothing the sync layer does can be an irreversible loss any more.
//
// Deliberately its OWN IndexedDB database, not a new store in the main one:
// adding a store there means a version bump and an upgrade transaction across
// every deployed client — this must be a pure addition with zero migration
// risk. Also best-effort by construction: a failure to snapshot must never
// block or break the sync operation itself (a user with a full quota still
// gets to sync), so every entry point swallows its errors.

const DB_NAME  = 'cadence-snapshots';
const STORE    = 'snapshots';
const KEEP_PER_USER = 5;

export type SnapshotReason = 'apply-drive' | 'conflict-keep-local' | 'conflict-use-drive';

export interface SnapshotMeta {
  key: string;
  userId: string;
  ts: number;
  reason: SnapshotReason;
  cards: number;
  reviews: number;
}

interface SnapshotRecord extends Omit<SnapshotMeta, 'key'> {
  state: AppState;
}

let _db: Promise<IDBPDatabase> | null = null;
function db(): Promise<IDBPDatabase> {
  _db ??= openDB(DB_NAME, 1, {
    upgrade(d) { d.createObjectStore(STORE); },
  });
  return _db;
}

export function countReviews(state: AppState): number {
  let n = 0;
  for (const w of Object.values(state.cardWorks ?? {})) n += w.history?.length ?? 0;
  return n;
}

/** Stash `state` as the about-to-be-lost side. Never throws — but callers
 *  should still `await` it, so the copy exists BEFORE the destruction runs. */
export async function saveSnapshot(userId: string, reason: SnapshotReason, state: AppState): Promise<void> {
  try {
    const ts = Date.now();
    const rec: SnapshotRecord = {
      userId, ts, reason,
      cards: Object.keys(state.cards ?? {}).length,
      reviews: countReviews(state),
      // structuredClone: the live appState object must not end up shared with
      // a stored record that outlives it.
      state: structuredClone(state),
    };
    const d = await db();
    await d.put(STORE, rec, `${userId}:${ts}`);
    // Prune beyond the ring size — oldest first (keys sort by ts within a user).
    const keys = (await d.getAllKeys(STORE) as string[])
      .filter(k => k.startsWith(`${userId}:`))
      .sort();
    for (const k of keys.slice(0, Math.max(0, keys.length - KEEP_PER_USER))) {
      await d.delete(STORE, k);
    }
  } catch (e) {
    console.warn('[snapshots] failed to save (continuing — snapshots are best-effort)', e);
  }
}

/** Newest first. Metadata only — the full state is fetched on demand. */
export async function listSnapshots(userId: string): Promise<SnapshotMeta[]> {
  try {
    const d = await db();
    const keys = (await d.getAllKeys(STORE) as string[]).filter(k => k.startsWith(`${userId}:`)).sort().reverse();
    const out: SnapshotMeta[] = [];
    for (const key of keys) {
      const rec = await d.get(STORE, key) as SnapshotRecord | undefined;
      if (rec) out.push({ key, userId: rec.userId, ts: rec.ts, reason: rec.reason, cards: rec.cards, reviews: rec.reviews });
    }
    return out;
  } catch {
    return [];
  }
}

export async function getSnapshotState(key: string): Promise<AppState | null> {
  try {
    const d = await db();
    const rec = await d.get(STORE, key) as SnapshotRecord | undefined;
    return rec?.state ?? null;
  } catch {
    return null;
  }
}

export async function clearSnapshotsForUser(userId: string): Promise<void> {
  try {
    const d = await db();
    const keys = (await d.getAllKeys(STORE) as string[]).filter(k => k.startsWith(`${userId}:`));
    for (const k of keys) await d.delete(STORE, k);
  } catch { /* best-effort */ }
}
