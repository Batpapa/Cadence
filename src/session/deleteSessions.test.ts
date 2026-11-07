// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { initSessionDbForUser, deleteSessions } from './db';
import { detectionReviewId } from './reviewLink';
import type { TuneAnalyserModuleData } from './model';

// Deleting a folder of analyses (2026-11-06): it used to be one write of the
// whole library per analysis, each one copying every other analysis. Now one
// write takes them all, and the leftovers — local audio, Drive copies — are
// handed back, for the caller to clear in view (2026-11-07).

const stores = vi.hoisted(() => new Map<string, Map<string, unknown>>());
vi.mock('idb', () => {
  const store = (name: string) => {
    if (!stores.has(name)) stores.set(name, new Map());
    return stores.get(name)!;
  };
  const db = {
    get: (s: string, k: string) => Promise.resolve(store(s).get(k)),
    put: (s: string, v: unknown, k: string) => { store(s).set(k, v); return Promise.resolve(); },
    delete: (s: string, k: string) => { store(s).delete(k); return Promise.resolve(); },
    transaction: () => ({ store: { delete: () => Promise.resolve() }, done: Promise.resolve() }),
    close: () => {},
  };
  return { openDB: () => Promise.resolve(db) };
});

const trashed = vi.hoisted(() => [] as string[]);
vi.mock('../services/driveService', () => ({
  isDriveConnected: () => true,
  hasDriveToken: () => true,
  trashCompanionFile: (id: string) => { trashed.push(id); return Promise.resolve(true); },
  registerDrivePendingWork: () => {},
}));

const store = vi.hoisted(() => ({
  state: { id: 'u1', modules: {} } as { id: string; modules: Record<string, unknown>; cardWorks?: Record<string, unknown> },
  writes: 0,
}));
vi.mock('../store', () => ({
  appState: { get value() { return store.state; } },
  mutate: (fn: (s: typeof store.state) => void) => { store.writes++; fn(store.state); return Promise.resolve(); },
}));
vi.mock('../services/storageService', () => ({ refreshStorageEstimate: () => Promise.resolve() }));
vi.mock('./liveBackup', () => ({ settleLiveBackup: () => Promise.resolve() }));

vi.stubGlobal('IDBKeyRange', { bound: () => null });

const mod = () => store.state.modules['tune-analyser'] as TuneAnalyserModuleData;
function addSession(id: string, fileId?: string): void {
  mod().sessions[id] = { id, name: id, date: '2026-10-10T00:00:00Z', duration: 1, mimeType: 'audio/webm', source: 'live', annotations: [] };
  if (fileId) (mod().syncedAudio ??= {})[id] = { fileId, size: 1 } as never;
  stores.get('audio')?.set(id, new Blob(['x']));
}

beforeEach(async () => {
  stores.clear();
  stores.set('audio', new Map());
  trashed.length = 0;
  localStorage.clear();
  store.state = { id: 'u1', modules: { 'tune-analyser': { sessions: {} } } };
  await initSessionDbForUser('u1');
  store.writes = 0;
});

describe('deleteSessions', () => {
  it('takes every analysis out of the library in one write', async () => {
    addSession('s1', 'f1');
    addSession('s2');
    addSession('s3', 'f3');
    addSession('keep', 'fk');
    const leftovers = await deleteSessions(['s1', 's2', 's3']);
    expect(store.writes).toBe(1);
    expect(Object.keys(mod().sessions)).toEqual(['keep']);
    expect(Object.keys(mod().syncedAudio ?? {})).toEqual(['keep']);
    // Nothing cleared yet: that is the caller's, in view.
    expect(trashed).toEqual([]);
    expect(leftovers.map(l => l.sessionId)).toEqual(['s1', 's2', 's3']);
    for (const l of leftovers) await l.clear();
    expect(store.writes).toBe(1);
  });

  it('then clears their recordings here and trashes their Drive copies', async () => {
    addSession('s1', 'f1');
    addSession('s2');
    addSession('keep', 'fk');
    for (const l of await deleteSessions(['s1', 's2'])) await l.clear();
    expect(trashed).toEqual(['f1']);
    expect([...stores.get('audio')!.keys()]).toEqual(['keep']);
  });

  it('keeps the ratings, dropping only their origin', async () => {
    addSession('s1');
    addSession('keep');
    store.state.cardWorks = {
      c1: { history: [
        { ts: 1, rating: 'good', id: detectionReviewId('s1', 'd1') },
        { ts: 2, rating: 'hard', id: detectionReviewId('keep', 'd2') },
      ] },
    };
    await deleteSessions(['s1']);
    const history = (store.state.cardWorks!.c1 as { history: { id?: string; rating: string }[] }).history;
    expect(history.map(e => e.rating)).toEqual(['good', 'hard']);
    expect(history[0]!.id).toBeUndefined();
    expect(history[1]!.id).toBe(detectionReviewId('keep', 'd2'));
  });
});
