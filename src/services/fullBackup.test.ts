import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AppState, Attachment } from '../types';

// Backups (2026-11-15): one archive format for both choices — the .cdb leaves
// the recordings out, the .cdbf carries them — built without holding them,
// read back entry by entry. And a .cdb in JSON, as it was written before,
// still restores.

const { audio, attachments } = vi.hoisted(() => ({
  audio: new Map<string, Blob>(),
  attachments: new Map<string, Blob>(),
}));

vi.mock('../session/db', () => ({
  loadSessionAudio: async (id: string) => audio.get(id),
  saveSessionAudio: async () => {},
}));
vi.mock('./attachmentStore', () => ({
  externalAttachmentBlobs: async () => ({ blobs: new Map(attachments), missing: [] }),
  externalAttachmentBytes: () => 0,
}));

const { buildBackup, parseBackup, BACKUP_DATA_ENTRY } = await import('./fullBackup');
const { readZipBlob } = await import('./zip');

const user = {
  id: 'local-id',
  cards: {
    c1: { id: 'c1', name: 'Cooley', content: { notes: '', attachments: [
      { type: 'file', name: 'reel.mp3', mimeType: 'audio/mpeg', data: '', external: { id: 'e1', bytes: 3, driveFileId: 'd1' } } as Attachment,
    ] } },
  },
  profiles: { p1: { id: 'p1' } },
  modules: { 'tune-analyser': { sessions: { s1: { id: 's1', mimeType: 'audio/webm' } } } },
} as unknown as AppState;

const pass = async () => true;

describe('backups', () => {
  beforeEach(() => {
    audio.clear();
    attachments.clear();
    audio.set('s1', new Blob([new Uint8Array([9, 8, 7, 6])], { type: 'audio/webm' }));
    attachments.set('e1', new Blob([new Uint8Array([1, 2, 3])]));
  });

  it('a .cdb holds the state and the attachments, not the recordings', async () => {
    const zip = await buildBackup(user, pass, false);
    expect((await readZipBlob(zip!)).map(i => i.name)).toEqual([BACKUP_DATA_ENTRY, 'attachments/e1']);
  });

  it('a .cdbf adds the recordings, and both come back as they went', async () => {
    const zip = await buildBackup(user, pass, true);
    const parsed = await parseBackup(new File([zip!], 'b.cdbf'));

    // The device-local id is not carried; the exporter's Drive id neither.
    expect(parsed.raw['id']).toBeUndefined();
    const att = (parsed.raw['cards'] as AppState['cards'])['c1']!.content.attachments[0] as Attachment & { external: Record<string, unknown> };
    expect(att.external).toEqual({ id: 'e1', bytes: 3 });

    expect(Array.from(new Uint8Array(await parsed.attachments.get('e1')!.arrayBuffer()))).toEqual([1, 2, 3]);
    const sound = await parsed.audio.get('s1')!();
    expect(sound.type).toBe('audio/webm');
    expect(Array.from(new Uint8Array(await sound.arrayBuffer()))).toEqual([9, 8, 7, 6]);

    // The state given is never touched.
    expect((user.cards['c1']!.content.attachments[0] as Attachment & { external: { driveFileId?: string } }).external.driveFileId).toBe('d1');
  });

  it('a .cdb read back has no recordings to restore', async () => {
    const zip = await buildBackup(user, pass, false);
    const parsed = await parseBackup(new File([zip!], 'b.cdb'));
    expect(parsed.audio.size).toBe(0);
    expect(parsed.attachments.size).toBe(1);
  });

  it('nothing is built when the gate refuses missing attachments', async () => {
    const store = await import('./attachmentStore');
    vi.spyOn(store, 'externalAttachmentBlobs').mockResolvedValueOnce({ blobs: new Map(), missing: [{ card: 'Cooley', name: 'reel.mp3', reason: 'not-uploaded' }] } as never);
    expect(await buildBackup(user, async () => false, false)).toBe(null);
  });

  it('still restores a .cdb in JSON (LEGACY READ)', async () => {
    const { id: _id, ...data } = user;
    const parsed = await parseBackup(new File([JSON.stringify(data)], 'old.cdb'));
    expect(Object.keys(parsed.raw['cards'] as object)).toEqual(['c1']);
    expect(parsed.audio.size).toBe(0);
    expect(parsed.attachments.size).toBe(0);
  });

  it('refuses a JSON file that is not a backup, and a .cdbf that is not an archive', async () => {
    await expect(parseBackup(new File(['{"hello":1}'], 'x.cdb'))).rejects.toThrow('not a valid Cadence backup');
    await expect(parseBackup(new File(['{}'], 'x.cdbf'))).rejects.toThrow('not_a_zip');
  });
});
