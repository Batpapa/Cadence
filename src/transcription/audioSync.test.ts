// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { addTranscription, deleteTranscriptions } from './actions';
import { initTranscriptionDbForUser, getTranscriptionAudio } from './audioDb';
import { transcriptionAudio } from './audioSync';
import type { TranscriptionModuleData, TranscriptionRecord } from './model';

// The Transcription module's recordings on Drive (2026-11-28): the analyser's
// code (session/companionAudio.ts, whose rules its own tests pin), with this
// module's records, file names and lists. What is checked here is that wiring:
// a new transcription's recording goes up under its own name, as the module's
// choice says, its failures are remembered apart from the analyser's, and a
// deletion takes its Drive copy to the trash.

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
    objectStoreNames: { contains: () => true },
    close: () => {},
  };
  return { openDB: () => Promise.resolve(db) };
});

const drive = vi.hoisted(() => ({
  outcomes: [] as Array<'ok' | 'network'>,
  uploads: [] as string[],
  trashed: [] as string[],
}));
vi.mock('../services/driveService', () => ({
  isDriveConnected: () => true,
  hasDriveToken: () => true,
  uploadCompanionFile: (name: string) => {
    drive.uploads.push(name);
    const outcome = drive.outcomes.shift() ?? 'ok';
    if (outcome === 'network') return Promise.reject(new Error('Failed to fetch'));
    return Promise.resolve(`file-${drive.uploads.length}`);
  },
  trashCompanionFile: (id: string) => { drive.trashed.push(id); return Promise.resolve(true); },
  registerDrivePendingWork: () => {},
}));

const store = vi.hoisted(() => ({ state: { id: 'u1', modules: {} } as { id: string; modules: Record<string, unknown> } }));
vi.mock('../store', () => ({
  appState: { get value() { return store.state; } },
  mutate: (fn: (s: typeof store.state) => void) => { fn(store.state); return Promise.resolve(); },
}));
vi.mock('../services/storageService', async () => {
  const { signal } = await import('@preact/signals');
  return {
    FULL_RATIO: 0.8,
    storageUsage: signal<number | null>(null),
    storageQuota: signal<number | null>(null),
    refreshStorageEstimate: () => Promise.resolve(),
  };
});
vi.stubGlobal('IDBKeyRange', { bound: () => null });

const mod = () => store.state.modules['transcription'] as TranscriptionModuleData | undefined;
/** Lets every pending promise chain run to its end — dynamic imports
 *  included, which take more than a turn. */
const settle = () => new Promise(r => setTimeout(r, 50));

const record = (): Omit<TranscriptionRecord, 'id'> => ({
  name: 'Slip', createdAt: Date.parse('2026-11-28T00:00:00Z'), source: 'mic', duration: 12,
  mimeType: 'audio/webm', from: 0, to: 12, settings: {}, draft: 'X: 1\nT: Slip\nK: G\nGAB|',
});

beforeEach(() => {
  stores.clear();
  localStorage.clear();
  store.state = { id: 'u1', modules: {} };
  Object.assign(drive, { outcomes: [], uploads: [], trashed: [] });
  initTranscriptionDbForUser('u1');
  transcriptionAudio.setUploadOnWifiOnly(false);
});

describe("a transcription's recording on Drive", () => {
  it('goes up once the transcription is stored, under a name of its own', async () => {
    const id = await addTranscription(record(), new Blob(['x'], { type: 'audio/webm' }));
    await settle();
    expect(drive.uploads).toEqual([`cadence-transcription-${id}.webm`]);
    expect(mod()?.syncedAudio?.[id]).toEqual({ fileId: 'file-1', mimeType: 'audio/webm', bytes: 1 });
    // the analyser's slice never touched
    expect(store.state.modules['tune-analyser']).toBeUndefined();
  });

  it('stays on the device when the module says manual', async () => {
    store.state.modules['transcription'] = { transcriptions: {}, syncAudioByDefault: false };
    const id = await addTranscription(record(), new Blob(['x'], { type: 'audio/webm' }));
    await settle();
    expect(drive.uploads).toEqual([]);
    expect(mod()?.syncedAudio).toBeUndefined();
    expect(await getTranscriptionAudio(id)).toBeDefined();
  });

  it('remembers a failed copy in its own list, apart from the analyser', async () => {
    drive.outcomes = ['network'];
    const id = await addTranscription(record(), new Blob(['x'], { type: 'audio/webm' }));
    await settle();
    expect(transcriptionAudio.autoUploadState.value[id]).toBe('waiting');
    expect(JSON.parse(localStorage.getItem('cadence_transcription_audio_uploads_wanted:u1') ?? '[]')).toEqual([id]);
    expect(localStorage.getItem('cadence_audio_uploads_wanted:u1')).toBeNull();
  });

  it('goes to the Drive trash with the transcription, its records forgotten', async () => {
    const id = await addTranscription(record(), new Blob(['x'], { type: 'audio/webm' }));
    await settle();
    await deleteTranscriptions([id]);
    expect(drive.trashed).toEqual(['file-1']);
    expect(mod()?.transcriptions[id]).toBeUndefined();
    expect(mod()?.syncedAudio).toBeUndefined();
    expect(await getTranscriptionAudio(id)).toBeUndefined();
  });

  it('is freed from this device only once Drive has it', async () => {
    drive.outcomes = ['network'];
    const kept = await addTranscription(record(), new Blob(['x'], { type: 'audio/webm' }));
    await settle();
    const copied = await addTranscription(record(), new Blob(['yy'], { type: 'audio/webm' }));
    await settle();
    expect((await transcriptionAudio.freeable()).ids).toEqual([copied]);
    await transcriptionAudio.freeSynced();
    expect(await getTranscriptionAudio(copied)).toBeUndefined();
    expect(await getTranscriptionAudio(kept)).toBeDefined();
    // and it is now on Drive only, to be brought back
    expect((await transcriptionAudio.driveOnly()).map(r => r.id)).toEqual([copied]);
  });
});
