import { describe, expect, it, vi } from 'vitest';
import { cardPackageText } from './importExport';
import type { Attachment, Card } from '../types';

// ── The gate an export cannot get past ──────────────────────────────────────
// A .cdc is JSON and nothing else, so an attachment whose bytes live outside
// the blob has to come back into it here. What is pinned down: it comes back
// on a COPY, and a file that could not be fetched stops the export rather than
// travelling as an empty one.

const held = vi.hoisted(() => new Map<string, Blob>());
vi.mock('./attachmentDb', () => ({
  getAttachmentBlob: (id: string) => Promise.resolve(held.get(id) ?? null),
  putAttachmentBlob: (id: string, blob: Blob) => { held.set(id, blob); return Promise.resolve(); },
  deleteAttachmentBlob: () => Promise.resolve(),
  heldAttachmentIds: () => Promise.resolve([...held.keys()]),
  condemnDriveFile: () => Promise.resolve(),
  condemnedFiles: () => Promise.resolve([]),
  forgetCondemned: () => Promise.resolve(),
}));

const externalised = (id: string, driveFileId?: string): Attachment =>
  ({ type: 'file', name: 'reel.mp3', mimeType: 'audio/mpeg', data: '',
    external: driveFileId ? { id, bytes: 3, driveFileId } : { id, bytes: 3 } }) as Attachment;

const card = (attachments: Attachment[]): Card =>
  ({ id: 'c1', guid: 'g1', name: 'Cooley', defaultImportance: 1, tags: [],
    content: { notes: '', attachments } }) as unknown as Card;

const never = () => Promise.resolve(false);

describe('cardPackageText', () => {
  it('inlines the bytes without touching the cards it was given', async () => {
    held.set('e1', new Blob([new Uint8Array([1, 2, 3])]));
    const cards = [card([externalised('e1', 'd1')])];

    const text = await cardPackageText(cards, never);
    expect(JSON.parse(text!).cards[0].content.attachments[0])
      .toEqual({ type: 'file', name: 'reel.mp3', mimeType: 'audio/mpeg', data: 'AQID' });

    // The running state keeps its empty `data`. Filling it there would put
    // back the very megabytes the externalisation took out — on every clone
    // and every sync, for as long as the tab lives.
    expect(cards[0]!.content.attachments[0]).toEqual(externalised('e1', 'd1'));
  });

  it('produces nothing at all when the gate refuses', async () => {
    const cards = [card([externalised('e2')])];
    expect(await cardPackageText(cards, never)).toBe(null);
  });

  it('hands the gate what is missing, named and explained', async () => {
    const gate = vi.fn().mockResolvedValue(true);
    const cards = [card([externalised('e3')])];

    const text = await cardPackageText(cards, gate);
    expect(gate).toHaveBeenCalledWith([{ card: 'Cooley', name: 'reel.mp3', reason: 'not-uploaded' }]);
    // Accepted, so the package exists — with that attachment as it stands,
    // which is the honest rendering of "these bytes are somewhere else".
    expect(JSON.parse(text!).cards[0].content.attachments[0].data).toBe('');
  });

  it('never asks when there is nothing to ask about', async () => {
    const gate = vi.fn().mockResolvedValue(true);
    const text = await cardPackageText([card([{ type: 'file', name: 'x.abc', mimeType: 'text/plain', data: 'QUJD' }])], gate);
    expect(gate).not.toHaveBeenCalled();
    expect(JSON.parse(text!).cards[0].content.attachments[0].data).toBe('QUJD');
  });
});
