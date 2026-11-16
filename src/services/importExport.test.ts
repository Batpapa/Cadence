import { describe, expect, it, vi } from 'vitest';
import { cardPackageBlob, parseCardPackage } from './importExport';
import { readZipBlob } from './zip';
import type { Attachment, Card } from '../types';

// ── The gate an export cannot get past ──────────────────────────────────────
// A .cdc is a zip since 2026-11-15: the cards, and beside them the bytes of
// every attachment that lives outside the blob. What is pinned down: the
// cards given are never touched, a file that could not be fetched stops the
// export rather than travelling as an empty one, and the bytes come back
// inline on import, where the receiver's own rule decides where they go.

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

async function cardsJson(pkg: Blob): Promise<{ cards: Card[] }> {
  const items = await readZipBlob(pkg);
  return JSON.parse(await items.find(i => i.name === 'cards.json')!.text());
}

describe('cardPackageBlob', () => {
  it('carries the bytes beside the cards, without touching the cards it was given', async () => {
    held.set('e1', new Blob([new Uint8Array([1, 2, 3])]));
    const cards = [card([externalised('e1', 'd1')])];

    const pkg = await cardPackageBlob(cards, never);
    const items = await readZipBlob(pkg!);
    expect(items.map(i => i.name)).toEqual(['cards.json', 'attachments/e1']);
    expect(Array.from(new Uint8Array(await (await items[1]!.copy()).arrayBuffer()))).toEqual([1, 2, 3]);
    // The reference stays; the exporter's Drive file id does not travel.
    expect((await cardsJson(pkg!)).cards[0]!.content.attachments[0])
      .toEqual({ type: 'file', name: 'reel.mp3', mimeType: 'audio/mpeg', data: '', external: { id: 'e1', bytes: 3 } });

    // The running state keeps its empty `data` and its Drive id.
    expect(cards[0]!.content.attachments[0]).toEqual(externalised('e1', 'd1'));
  });

  it('produces nothing at all when the gate refuses', async () => {
    const cards = [card([externalised('e2')])];
    expect(await cardPackageBlob(cards, never)).toBe(null);
  });

  it('hands the gate what is missing, named and explained', async () => {
    const gate = vi.fn().mockResolvedValue(true);
    const cards = [card([externalised('e3')])];

    const pkg = await cardPackageBlob(cards, gate);
    expect(gate).toHaveBeenCalledWith([{ card: 'Cooley', name: 'reel.mp3', reason: 'not-uploaded' }]);
    // Accepted, so the package exists — with that attachment as it stands,
    // which is the honest rendering of "these bytes are somewhere else".
    expect((await cardsJson(pkg!)).cards[0]!.content.attachments[0]).toEqual(externalised('e3'));
  });

  it('never asks when there is nothing to ask about', async () => {
    const gate = vi.fn().mockResolvedValue(true);
    const pkg = await cardPackageBlob([card([{ type: 'file', name: 'x.abc', mimeType: 'text/plain', data: 'QUJD' } as Attachment])], gate);
    expect(gate).not.toHaveBeenCalled();
    expect(((await cardsJson(pkg!)).cards[0]!.content.attachments[0] as { data: string }).data).toBe('QUJD');
  });
});

describe('parseCardPackage', () => {
  it('puts archived bytes back inline, for the import to place by its own rule', async () => {
    held.set('e4', new Blob([new Uint8Array([1, 2, 3])]));
    const pkg = await cardPackageBlob([card([externalised('e4', 'd4')])], never);
    const [imported] = await parseCardPackage(new File([pkg!], 'x.cdc'));
    const att = imported!.content.attachments[0] as Attachment & { external?: unknown; data: string };
    expect(att.data).toBe('AQID');
    expect(att.external).toBeUndefined();
  });

  it('still reads a JSON package — exported before, or written by hand', async () => {
    const json = JSON.stringify({ schemaVersion: 9, cards: [card([{ type: 'file', name: 'x.abc', mimeType: 'text/plain', data: 'QUJD' } as Attachment])] });
    const [imported] = await parseCardPackage(new File([json], 'old.cdc'));
    expect(imported!.name).toBe('Cooley');
    expect((imported!.content.attachments[0] as { data: string }).data).toBe('QUJD');
  });
});
