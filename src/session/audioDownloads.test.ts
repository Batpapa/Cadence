// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  initSessionDbForUser, forgetSessionAudio, fetchSyncedAudio, driveOnlyAudio, freedAudioIds,
  audioArrivals, loadSessionAudio,
} from './db';
import {
  runAutoDownloads, setAudioDownloadMode, setDownloadOnWifiOnly, autoDownloadStatus, downloadAllAudio,
} from './audioDownloads';
import { onUnmeteredNetwork } from './network';
import type { TuneAnalyserModuleData } from './model';

// Bringing recordings that are on Drive onto this device (2026-10-09): which
// ones the automatic mode takes, and when it holds back.

const stores = vi.hoisted(() => new Map<string, Map<string, unknown>>());
vi.mock('idb', () => {
  const store = (name: string) => {
    if (!stores.has(name)) stores.set(name, new Map());
    return stores.get(name)!;
  };
  const db = {
    get: (s: string, k: string) => Promise.resolve(store(s).get(k)),
    getAllKeys: (s: string) => Promise.resolve([...store(s).keys()]),
    put: (s: string, v: unknown, k: string) => { store(s).set(k, v); return Promise.resolve(); },
    delete: (s: string, k: string) => { store(s).delete(k); return Promise.resolve(); },
    transaction: () => ({ store: { delete: () => Promise.resolve() }, done: Promise.resolve() }),
    close: () => {},
  };
  return { openDB: () => Promise.resolve(db) };
});

const drive = vi.hoisted(() => ({ downloads: [] as string[], fail: false }));
vi.mock('../services/driveService', () => ({
  isDriveConnected: () => true,
  hasDriveToken: () => true,
  registerDrivePendingWork: () => {},
  downloadCompanionFile: (fileId: string, _i: boolean, onProgress?: (l: number, t: number | null) => void) => {
    drive.downloads.push(fileId);
    if (drive.fail) return Promise.reject(new Error('Failed to fetch'));
    onProgress?.(1, 2);
    return Promise.resolve(new Blob(['abc'], { type: 'audio/webm' }));
  },
}));

const store = vi.hoisted(() => ({ state: { id: 'u1', modules: {} } as { id: string; modules: Record<string, unknown> } }));
vi.mock('../store', () => ({
  appState: { get value() { return store.state; } },
  mutate: (fn: (s: typeof store.state) => void) => { fn(store.state); return Promise.resolve(); },
}));
const storage = vi.hoisted(() => ({ usage: 0, quota: 1000 }));
vi.mock('../services/storageService', async () => {
  const { signal } = await import('@preact/signals');
  const storageUsage = signal<number | null>(null), storageQuota = signal<number | null>(null);
  return {
    FULL_RATIO: 0.8,
    storageUsage, storageQuota,
    refreshStorageEstimate: () => { storageUsage.value = storage.usage; storageQuota.value = storage.quota; return Promise.resolve(); },
  };
});
vi.stubGlobal('IDBKeyRange', { bound: () => null });

const mod = () => store.state.modules['tune-analyser'] as TuneAnalyserModuleData;

/** An analysis whose recording is on Drive, and optionally here too. */
function addSynced(id: string, date: string, bytes = 100, here = false): void {
  mod().sessions[id] = { id, name: id, date, duration: 1, mimeType: 'audio/webm', source: 'live', annotations: [] };
  mod().syncedAudio ??= {};
  mod().syncedAudio![id] = { fileId: 'file-' + id, mimeType: 'audio/webm', bytes };
  if (here) {
    if (!stores.has('audio')) stores.set('audio', new Map());
    stores.get('audio')!.set(id, new Blob(['x']));
  }
}

function setConnection(type: string | undefined): void {
  Object.defineProperty(navigator, 'connection', { configurable: true, value: type === undefined ? undefined : Object.assign(new EventTarget(), { type }) });
}

beforeEach(async () => {
  stores.clear();
  localStorage.clear();
  store.state = { id: 'u1', modules: { 'tune-analyser': { sessions: {} } } };
  Object.assign(drive, { downloads: [], fail: false });
  Object.assign(storage, { usage: 0, quota: 1000 });
  setConnection(undefined);
  await initSessionDbForUser('u1');
  setDownloadOnWifiOnly(true);
  setAudioDownloadMode('manual');
  audioArrivals.value = new Set();
});

describe('what is only on Drive', () => {
  it('lists the recordings not here, newest first', async () => {
    addSynced('old', '2026-01-01T00:00:00Z');
    addSynced('new', '2026-10-01T00:00:00Z');
    addSynced('here', '2026-05-01T00:00:00Z', 100, true);
    expect((await driveOnlyAudio()).map(r => r.id)).toEqual(['new', 'old']);
  });
});

describe('freed on purpose', () => {
  it('is remembered when the audio of a recording on Drive is forgotten', async () => {
    addSynced('s1', '2026-10-01T00:00:00Z', 100, true);
    await forgetSessionAudio('s1');
    expect(freedAudioIds().has('s1')).toBe(true);
  });

  it('is not, when there was no Drive copy: that audio is simply gone', async () => {
    mod().sessions.s1 = { id: 's1', name: 's1', date: '2026-10-01T00:00:00Z', duration: 1, mimeType: 'audio/webm', source: 'live', annotations: [] };
    stores.set('audio', new Map([['s1', new Blob(['x'])]]));
    await forgetSessionAudio('s1');
    expect(freedAudioIds().has('s1')).toBe(false);
  });

  it('is forgotten once the recording is downloaded again', async () => {
    addSynced('s1', '2026-10-01T00:00:00Z', 100, true);
    await forgetSessionAudio('s1');
    await fetchSyncedAudio('s1');
    expect(freedAudioIds().has('s1')).toBe(false);
    expect(await loadSessionAudio('s1')).toBeDefined();
    expect(audioArrivals.value.has('s1')).toBe(true);
  });
});

describe('the automatic mode', () => {
  it('does nothing unless chosen', async () => {
    addSynced('s1', '2026-10-01T00:00:00Z');
    await runAutoDownloads();
    expect(drive.downloads).toEqual([]);
  });

  it('brings everything here, newest first, freed ones excepted', async () => {
    addSynced('old', '2026-01-01T00:00:00Z');
    addSynced('new', '2026-10-01T00:00:00Z');
    addSynced('freed', '2026-06-01T00:00:00Z', 100, true);
    await forgetSessionAudio('freed');
    setAudioDownloadMode('auto');
    await vi.waitFor(() => expect(autoDownloadStatus.value?.remaining).toBe(0));
    expect(drive.downloads).toEqual(['file-new', 'file-old']);
    expect(autoDownloadStatus.value).toMatchObject({ remaining: 0, blocked: null, freed: 1 });
  });

  it('waits for Wi-Fi on a mobile connection, unless allowed', async () => {
    addSynced('s1', '2026-10-01T00:00:00Z');
    setConnection('cellular');
    setAudioDownloadMode('auto');
    await vi.waitFor(() => expect(autoDownloadStatus.value?.blocked).toBe('wifi'));
    expect(drive.downloads).toEqual([]);
    setDownloadOnWifiOnly(false);
    await vi.waitFor(() => expect(drive.downloads).toEqual(['file-s1']));
  });

  it('stops before the storage fills up', async () => {
    addSynced('s1', '2026-10-01T00:00:00Z', 300);
    Object.assign(storage, { usage: 600, quota: 1000 });   // 600 + 300 ≥ 80 %
    setAudioDownloadMode('auto');
    await vi.waitFor(() => expect(autoDownloadStatus.value?.blocked).toBe('space'));
    expect(drive.downloads).toEqual([]);
  });

  it('says so when a download fails, and leaves the rest for later', async () => {
    addSynced('a', '2026-10-01T00:00:00Z');
    addSynced('b', '2026-09-01T00:00:00Z');
    drive.fail = true;
    setAudioDownloadMode('auto');
    await vi.waitFor(() => expect(autoDownloadStatus.value?.blocked).toBe('failed'));
    expect(drive.downloads).toEqual(['file-a']);
  });
});

describe('download everything', () => {
  it('takes the freed ones too: it is a request', async () => {
    addSynced('s1', '2026-10-01T00:00:00Z', 100, true);
    addSynced('s2', '2026-09-01T00:00:00Z');
    await forgetSessionAudio('s1');
    const r = await downloadAllAudio();
    expect(r).toEqual({ ok: 2, failed: 0, stoppedForSpace: false });
    expect(freedAudioIds().size).toBe(0);
  });
});

describe('what counts as Wi-Fi', () => {
  it('trusts a browser that does not say, and nothing else it names', () => {
    setConnection(undefined); expect(onUnmeteredNetwork()).toBe(true);
    setConnection('wifi'); expect(onUnmeteredNetwork()).toBe(true);
    setConnection('ethernet'); expect(onUnmeteredNetwork()).toBe(true);
    setConnection('cellular'); expect(onUnmeteredNetwork()).toBe(false);
    setConnection('unknown'); expect(onUnmeteredNetwork()).toBe(false);
  });
});
