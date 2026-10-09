// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  initSessionDbForUser, saveSessionAudio, deleteSession, autoUploadState, initAudioUploadRetry,
  uploadSessionAudio, setUploadOnWifiOnly,
} from './db';
import type { TuneAnalyserModuleData } from './model';

// The device's network, one object for the whole file: the app wires its
// listener to it once, as a browser's own never changes.
const net = vi.hoisted(() => {
  const target = new EventTarget() as EventTarget & { type: string };
  target.type = 'wifi';
  Object.defineProperty(navigator, 'connection', { configurable: true, value: target });
  return target;
});

// The automatic copy of a recording to Drive, and what happens when it fails
// (2026-10-09): a user found three recordings that had never been copied,
// because a network error was logged once and forgotten.

// The local database as plain Maps — the rule under test is which uploads are
// remembered and retried, not IndexedDB.
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

const drive = vi.hoisted(() => ({
  connected: true,
  /** What the next uploads do, in order; past the end they succeed. */
  outcomes: [] as Array<'ok' | 'network' | 'auth'>,
  uploads: 0,
  pending: null as null | { pending: () => boolean; resume: () => void },
  /** Held open until released, to start a second upload during the first. */
  gate: null as null | Promise<void>,
}));
vi.mock('../services/driveService', () => ({
  isDriveConnected: () => drive.connected,
  hasDriveToken: () => true,
  uploadCompanionFile: async () => {
    drive.uploads++;
    if (drive.gate) await drive.gate;
    const outcome = drive.outcomes.shift() ?? 'ok';
    if (outcome === 'network') throw new Error('Failed to fetch');
    if (outcome === 'auth') throw new Error('needs_auth');
    return `file-${drive.uploads}`;
  },
  trashCompanionFile: () => Promise.resolve(true),
  registerDrivePendingWork: (w: { pending: () => boolean; resume: () => void }) => { drive.pending = w; },
}));

const store = vi.hoisted(() => ({ state: { id: 'u1', modules: {} } as { id: string; modules: Record<string, unknown> } }));
vi.mock('../store', () => ({
  appState: { get value() { return store.state; } },
  mutate: (fn: (s: typeof store.state) => void) => { fn(store.state); return Promise.resolve(); },
}));
vi.mock('../services/storageService', () => ({ refreshStorageEstimate: () => Promise.resolve() }));
vi.mock('./liveBackup', () => ({ settleLiveBackup: () => Promise.resolve() }));

const mod = () => store.state.modules['tune-analyser'] as TuneAnalyserModuleData;
const audio = () => new Blob(['x'], { type: 'audio/webm' });
/** Lets every pending promise chain run to its end — dynamic imports included,
 *  which take more than a turn. */
const settle = () => new Promise(r => setTimeout(r, 50));

vi.stubGlobal('IDBKeyRange', { bound: () => null });

/** A finalized session, as the library holds it. */
function addSession(id: string): void {
  mod().sessions[id] = { id, name: id, date: '2026-10-10T00:00:00Z', duration: 1, mimeType: 'audio/webm', source: 'live', annotations: [] };
}

beforeEach(async () => {
  stores.clear();
  localStorage.clear();
  store.state = { id: 'u1', modules: { 'tune-analyser': { sessions: {} } } };
  Object.assign(drive, { connected: true, outcomes: [], uploads: 0, gate: null });
  net.type = 'wifi';
  await initSessionDbForUser('u1');
  setUploadOnWifiOnly(false);
});

describe('the automatic upload after a recording', () => {
  it('is crossed off once it goes through', async () => {
    addSession('s1');
    await saveSessionAudio('s1', audio());
    await settle();
    expect(mod().syncedAudio?.s1?.fileId).toBe('file-1');
    expect(autoUploadState.value.s1).toBeUndefined();
    expect(localStorage.getItem('cadence_audio_uploads_wanted:u1')).toBeNull();
  });

  it('is remembered when it fails, and shown as waiting', async () => {
    addSession('s1');
    drive.outcomes = ['network'];
    await saveSessionAudio('s1', audio());
    await settle();
    expect(mod().syncedAudio?.s1).toBeUndefined();
    expect(autoUploadState.value.s1).toBe('waiting');
    expect(JSON.parse(localStorage.getItem('cadence_audio_uploads_wanted:u1')!)).toEqual(['s1']);
  });

  it('is not queued at all without Drive: that is the backlog, sent only on request', async () => {
    addSession('s1');
    drive.connected = false;
    await saveSessionAudio('s1', audio());
    await settle();
    expect(drive.uploads).toBe(0);
    expect(localStorage.getItem('cadence_audio_uploads_wanted:u1')).toBeNull();
  });

  it('is not queued when the user switched the option off', async () => {
    addSession('s1');
    mod().syncAudioByDefault = false;
    await saveSessionAudio('s1', audio());
    await settle();
    expect(drive.uploads).toBe(0);
    expect(localStorage.getItem('cadence_audio_uploads_wanted:u1')).toBeNull();
  });
});

describe('retrying', () => {
  it('sends what failed when the network comes back', async () => {
    addSession('s1');
    drive.outcomes = ['network'];
    // Wired first, as in the app (finishBoot comes before any recording).
    // The other way round, vitest hands the retry the REAL driveService: its
    // mock of a dynamically imported module loses a race with the import the
    // wiring makes. Measured 2026-10-09; the app has only the one module.
    initAudioUploadRetry();
    await settle();
    await saveSessionAudio('s1', audio());
    await settle();
    window.dispatchEvent(new Event('online'));
    await settle(); await settle();
    expect(mod().syncedAudio?.s1).toBeDefined();
    expect(autoUploadState.value.s1).toBeUndefined();
  });

  it('survives a restart: the list is on disk, not in memory', async () => {
    addSession('s1');
    // As a previous run would have left it — killed mid-upload.
    localStorage.setItem('cadence_audio_uploads_wanted:u1', JSON.stringify(['s1']));
    stores.set('audio', new Map([['s1', audio()]]));
    initAudioUploadRetry();
    expect(autoUploadState.value.s1).toBe('waiting');
    window.dispatchEvent(new Event('online'));
    await settle(); await settle();
    expect(mod().syncedAudio?.s1).toBeDefined();
  });

  it('waits for a token when that is what was missing, then sends', async () => {
    addSession('s1');
    drive.outcomes = ['auth'];
    await saveSessionAudio('s1', audio());
    await settle();
    initAudioUploadRetry();
    await settle();
    expect(drive.pending?.pending()).toBe(true);
    drive.pending!.resume();
    await settle(); await settle();
    expect(mod().syncedAudio?.s1).toBeDefined();
    expect(drive.pending?.pending()).toBe(false);
  });

  it('leaves alone a recording whose analysis is not saved yet', async () => {
    // liveSession.stop writes the audio before the analysis.
    localStorage.setItem('cadence_audio_uploads_wanted:u1', JSON.stringify(['s1']));
    stores.set('audio', new Map([['s1', audio()]]));
    initAudioUploadRetry();
    window.dispatchEvent(new Event('online'));
    await settle(); await settle();
    expect(drive.uploads).toBe(0);
    expect(autoUploadState.value.s1).toBe('waiting');
  });

  it('forgets a session that was deleted', async () => {
    addSession('s1');
    drive.outcomes = ['network'];
    await saveSessionAudio('s1', audio());
    await settle();
    await deleteSession('s1');
    expect(autoUploadState.value.s1).toBeUndefined();
    expect(localStorage.getItem('cadence_audio_uploads_wanted:u1')).toBeNull();
  });
});

describe('two askers at once', () => {
  it('share one upload instead of putting two copies on Drive', async () => {
    addSession('s1');
    stores.set('audio', new Map([['s1', audio()]]));
    let release!: () => void;
    drive.gate = new Promise<void>(r => { release = r; });
    const a = uploadSessionAudio('s1', false);
    const b = uploadSessionAudio('s1', true);
    await settle();
    release();
    await Promise.all([a, b]);
    expect(drive.uploads).toBe(1);
  });
});

describe('Wi-Fi only', () => {
  it('holds the copy on a mobile connection, and sends it once on Wi-Fi', async () => {
    addSession('s1');
    initAudioUploadRetry();
    await settle();
    setUploadOnWifiOnly(true);
    net.type = 'cellular';
    await saveSessionAudio('s1', audio());
    await settle();
    expect(drive.uploads).toBe(0);
    expect(autoUploadState.value.s1).toBe('wifi');
    net.type = 'wifi';
    net.dispatchEvent(new Event('change'));
    await settle(); await settle();
    expect(drive.uploads).toBe(1);
    expect(mod().syncedAudio?.s1).toBeDefined();
  });

  it('sends at once on any network when told "always" — the default', async () => {
    addSession('s1');
    net.type = 'cellular';
    await saveSessionAudio('s1', audio());
    await settle();
    expect(drive.uploads).toBe(1);
  });
});
