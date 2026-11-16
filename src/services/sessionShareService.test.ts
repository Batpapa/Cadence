import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Analysis } from '../session/model';

// The .cds package (a zip since 2026-11-15): written as a Blob of Blobs, read
// back from a file, audio byte for byte — and the older JSON files, audio in
// base64, still read until 2027-05-15.

const { saved, downloads } = vi.hoisted(() => ({
  saved: { meta: [] as Analysis[], audio: [] as Array<{ id: string; blob: Blob }> },
  downloads: [] as Array<{ content: BlobPart; name: string }>,
}));

vi.mock('../session/db', () => ({
  saveSessionMeta: async (s: Analysis) => { saved.meta.push(s); },
  saveSessionAudio: async (id: string, blob: Blob) => { saved.audio.push({ id, blob }); },
}));
vi.mock('./shareService', () => ({ uploadShare: async () => ({ key: 'X', secondsRemaining: 600 }), downloadShareBlob: async () => new Blob() }));
vi.mock('../session/keepRecordings', () => ({ keepRecordings: { peek: () => true } }));
// One card version the sender can read (cardIndex.ts ids); anything else, none.
vi.mock('../session/recognition/indexStore', () => ({
  getSettingAbcMeta: async (id: string) => (id === 'card:g:h' ? { abc: 'X:1\nT:Mine\nK:D\nDEFG|', meter: '4/4', mode: 'Dmajor', dance: '', tune_id: 'card:g' } : null),
}));
vi.mock('../utils', async (importOriginal) => ({
  ...await importOriginal<typeof import('../utils')>(),
  downloadCadenceFile: (content: BlobPart, name: string) => { downloads.push({ content, name }); },
}));

const { exportSessionFile, importSessionFile, packageSize } = await import('./sessionShareService');

const session = {
  id: 'original-id',
  name: 'Mardi au pub',
  date: '2026-11-11T20:00:00.000Z',
  duration: 12_600,
  mimeType: 'audio/webm;codecs=opus',
  source: 'live',
  annotations: [],
} as unknown as Analysis;

/** The exported file, as the user would pick it again. */
async function exported(audio: Blob | null): Promise<File> {
  downloads.length = 0;
  await exportSessionFile(session, audio);
  const { content, name } = downloads[0]!;
  return new File([content], name);
}

describe('session package', () => {
  beforeEach(() => {
    saved.meta.length = 0;
    saved.audio.length = 0;
  });

  it('carries the audio raw, and gives it back byte for byte', async () => {
    // More than one copy piece, and not a multiple of it.
    const bytes = new Uint8Array(8 * 1024 * 1024 + 12_345).map((_, i) => (i * 13) % 251);
    const file = await exported(new Blob([bytes], { type: 'audio/webm' }));

    // No base64: the package is the audio plus a small header.
    expect(file.size).toBeLessThan(bytes.length + 2_000);
    // Announced from the session's mime type, made with the audio's own: the
    // two differ by the type's length in the JSON, and nothing else.
    expect(file.size).toBe(packageSize(session, bytes.length) - session.mimeType.length + 'audio/webm'.length);

    const imported = await importSessionFile(file, true);
    expect(imported.id).not.toBe('original-id');
    expect(imported.name).toBe('Mardi au pub');
    expect(saved.audio).toHaveLength(1);
    const back = saved.audio[0]!.blob;
    expect(back.type).toBe('audio/webm');
    // Compared by hand: toEqual walks 8 MB element by element for many seconds.
    const got = new Uint8Array(await back.arrayBuffer());
    expect(got.length).toBe(bytes.length);
    expect(got.findIndex((b, i) => b !== bytes[i])).toBe(-1);
  });

  it('leaves the audio out when the box is unticked', async () => {
    const file = await exported(new Blob([new Uint8Array(1000)], { type: 'audio/webm' }));
    await importSessionFile(file, false);
    expect(saved.meta).toHaveLength(1);
    expect(saved.audio).toHaveLength(0);
  });

  it('works without audio', async () => {
    const file = await exported(null);
    expect(file.size).toBe(packageSize(session, null));
    const imported = await importSessionFile(file, true);
    expect(imported.duration).toBe(12_600);
    expect(saved.audio).toHaveLength(0);
  });

  it('still reads a JSON file, audio in base64 (LEGACY READ, until 2027-05-15)', async () => {
    const { id: _id, ...rest } = session;
    const legacy = JSON.stringify({ schemaVersion: 1, session: rest, audioBase64: btoa('\x01\x02\x03'), audioMimeType: 'audio/mp4' });
    await importSessionFile(new File([legacy], 'old.cds'), true);
    expect(saved.meta[0]!.name).toBe('Mardi au pub');
    expect(Array.from(new Uint8Array(await saved.audio[0]!.blob.arrayBuffer()))).toEqual([1, 2, 3]);
    expect(saved.audio[0]!.blob.type).toBe('audio/mp4');
  });

  // The receiver has not got the sender's cards: the versions recognised from
  // them travel with the analysis (Analysis.cardVersions, 2026-11-16).
  it('carries the ABC of the card versions its detections name, and leaves the original alone', async () => {
    const pick = { tuneId: 'card:g', settingId: 'card:g:h', displayName: 'mine', dance: '', meter: '4/4', meanScore: 0.9 };
    const withCard = {
      ...session,
      annotations: [{ ...pick, id: 'd', viterbiPick: pick, alternates: [{ ...pick, tuneId: '7', settingId: '77' }], evidence: [] }],
    } as unknown as Analysis;
    downloads.length = 0;
    await exportSessionFile(withCard, null);
    const { content, name } = downloads[0]!;
    const imported = await importSessionFile(new File([content], name), false);
    expect(imported.cardVersions).toEqual({ 'card:g:h': 'X:1\nT:Mine\nK:D\nDEFG|' });
    expect(withCard.cardVersions).toBeUndefined();
  });

  it('is a zip any tool can open: analysis.json and the audio beside it', async () => {
    const file = await exported(new Blob([new Uint8Array(1000)], { type: 'audio/webm' }));
    const { readZipBlob } = await import('./zip');
    expect((await readZipBlob(file)).map(i => i.name)).toEqual(['analysis.json', 'audio.webm']);
  });
});
