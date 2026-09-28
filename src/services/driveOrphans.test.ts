import { describe, expect, it, beforeEach, vi } from 'vitest';
import { findDriveOrphans, OrphanScanUnavailable } from './driveOrphans';
import { TUNE_ANALYSER_MODULE_KEY } from '../session/model';
import type { AppState } from '../types';
import type { DriveChild } from './driveService';

// ── The conditions that make a Drive sweep safe at all ──────────────────────
// This is the one piece of the attachment work that DELETES someone's files.
// Everything below tests a reason not to: an unreadable blob, a file too young
// to judge, a file whose age is unknown, a name this code does not understand.

const drive = vi.hoisted(() => ({
  connected: true,
  read: null as unknown,
  children: new Map<string, DriveChild[]>(),
  pushed: 0,
  trashed: [] as string[],
}));

vi.mock('./driveService', () => ({
  isDriveConnected: () => drive.connected,
  manualSync: () => { drive.pushed++; return Promise.resolve(); },
  readDriveFile: () => Promise.resolve(drive.read),
  findCompanionPath: (path: string[]) => Promise.resolve(path.length === 0 ? 'root' : path.join('/')),
  listCompanionChildren: (id: string) => Promise.resolve(drive.children.get(id) ?? []),
  trashCompanionFile: (id: string) => { drive.trashed.push(id); return Promise.resolve(true); },
}));

const DAY = 24 * 60 * 60 * 1000;
const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();

const child = (over: Partial<DriveChild> & { id: string }): DriveChild => ({
  name: over.id, mimeType: 'application/octet-stream', size: '100', createdTime: ago(90), ...over,
});

/** A server state referencing nothing at all. */
const emptyServerState = () => ({
  status: 'ok',
  version: '1',
  data: { cards: {}, modules: {} } as unknown as AppState,
});

beforeEach(() => {
  drive.connected = true;
  drive.read = emptyServerState();
  drive.children = new Map();
  drive.pushed = 0;
  drive.trashed = [];
});

describe('before it dares look', () => {
  it('pushes whatever is pending first', async () => {
    await findDriveOrphans();
    // Otherwise a file this very device uploaded a minute ago, whose blob has
    // not gone up yet, reads as referenced by nobody.
    expect(drive.pushed).toBe(1);
  });

  it('refuses when the library cannot be read back from Drive', async () => {
    drive.read = { status: 'empty', version: '1' };
    drive.children.set('attachments', [child({ id: 'a1' })]);
    // An empty blob makes EVERY file look unreferenced. Reporting an orphan
    // here would be reporting the whole library.
    await expect(findDriveOrphans()).rejects.toBeInstanceOf(OrphanScanUnavailable);
  });

  it('refuses when Drive is not connected', async () => {
    drive.connected = false;
    await expect(findDriveOrphans()).rejects.toBeInstanceOf(OrphanScanUnavailable);
  });
});

describe('what it will not touch', () => {
  it('leaves recent files alone, however unreferenced', async () => {
    drive.children.set('attachments', [
      child({ id: 'yesterday', createdTime: ago(1) }),
      child({ id: 'lastWeek', createdTime: ago(7) }),
      child({ id: 'old', createdTime: ago(40) }),
    ]);
    const { orphans } = await findDriveOrphans();
    // The window to protect is minutes wide (30 s debounce, 5 min ceiling);
    // thirty days is that with room to spare.
    expect(orphans.map(o => o.id)).toEqual(['old']);
  });

  it('treats an unknown age as too young', async () => {
    drive.children.set('attachments', [child({ id: 'noDate', createdTime: undefined })]);
    expect((await findDriveOrphans()).orphans).toEqual([]);
  });

  it('ignores anything in the root it does not recognise', async () => {
    drive.children.set('root', [
      child({ id: 'backups', name: 'backups', mimeType: 'application/vnd.google-apps.folder' }),
      child({ id: 'stranger', name: 'someone-elses-file.txt' }),
      child({ id: 'rec', name: 'cadence-session-abc.webm' }),
    ]);
    const { orphans } = await findDriveOrphans();
    // The live-recording backups have their own lifecycle, and a file this
    // code cannot name is a file it has no business judging.
    expect(orphans.map(o => o.id)).toEqual(['rec']);
  });

  it('leaves folders in the attachments directory alone', async () => {
    drive.children.set('attachments', [
      child({ id: 'sub', mimeType: 'application/vnd.google-apps.folder' }),
      child({ id: 'a1' }),
    ]);
    expect((await findDriveOrphans()).orphans.map(o => o.id)).toEqual(['a1']);
  });
});

describe('what the server state protects', () => {
  it('spares an attachment some card still points at', async () => {
    drive.read = {
      status: 'ok',
      version: '1',
      data: {
        cards: { c1: { content: { attachments: [
          { type: 'file', name: 'x', data: '', mimeType: 'audio/mpeg', external: { id: 'e1', bytes: 1, driveFileId: 'kept' } },
        ] } } },
        modules: {},
      } as unknown as AppState,
    };
    drive.children.set('attachments', [child({ id: 'kept' }), child({ id: 'dropped' })]);
    expect((await findDriveOrphans()).orphans.map(o => o.id)).toEqual(['dropped']);
  });

  it('spares a recording some analysis still points at', async () => {
    drive.read = {
      status: 'ok',
      version: '1',
      data: {
        cards: {},
        modules: { [TUNE_ANALYSER_MODULE_KEY]: { syncedAudio: { s1: { fileId: 'kept', mimeType: 'audio/webm', bytes: 10 } } } },
      } as unknown as AppState,
    };
    drive.children.set('root', [
      child({ id: 'kept', name: 'cadence-session-s1.webm' }),
      child({ id: 'dropped', name: 'cadence-session-s2.webm' }),
    ]);
    expect((await findDriveOrphans()).orphans.map(o => o.id)).toEqual(['dropped']);
  });

  it('totals what would be freed', async () => {
    drive.children.set('attachments', [child({ id: 'a', size: '1000' }), child({ id: 'b', size: '2500' })]);
    const { orphans, bytes } = await findDriveOrphans();
    expect(orphans.length).toBe(2);
    expect(bytes).toBe(3500);
  });
});

describe('what it says about what it spared', () => {
  it('counts the unreferenced files the age rule protected', async () => {
    drive.children.set('attachments', [
      child({ id: 'old', createdTime: ago(40) }),
      child({ id: 'fresh', createdTime: ago(2) }),
      child({ id: 'alsoFresh', createdTime: ago(0) }),
    ]);
    const { orphans, tooYoung } = await findDriveOrphans();
    // Otherwise "nothing to delete" and "I can see it right there" look the
    // same, and the rule that makes this safe reads as a broken search.
    expect(orphans.map(o => o.id)).toEqual(['old']);
    expect(tooYoung).toBe(2);
  });

  it('counts nothing when every file is referenced', async () => {
    drive.read = {
      status: 'ok',
      version: '1',
      data: {
        cards: { c1: { content: { attachments: [
          { type: 'file', name: 'x', data: '', mimeType: 'audio/mpeg', external: { id: 'e1', bytes: 1, driveFileId: 'kept' } },
        ] } } },
        modules: {},
      } as unknown as AppState,
    };
    drive.children.set('attachments', [child({ id: 'kept', createdTime: ago(1) })]);
    const { orphans, tooYoung } = await findDriveOrphans();
    expect(orphans).toEqual([]);
    expect(tooYoung).toBe(0);
  });
});
