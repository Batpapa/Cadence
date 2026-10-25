import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { Analysis, Detection } from '../session/model';
import { readZip } from './zip';

// ── The clips zip ────────────────────────────────────────────────────────────
// The cutting itself is clipExtract's (mediabunny, real audio): stood in for
// here by a fake that writes down what it was asked for. What this file holds
// to is what the export adds around it — the order, the numbering, names a
// file system accepts, and nothing downloaded when one clip fails.

const cuts: { start: number; end: number }[] = [];
let failAt = -1;
vi.mock('../session/audio/clipExtract', () => ({
  extractClip: async (_audio: Blob, start: number, end: number) => {
    if (cuts.length === failAt) throw new Error('clip_cannot_copy: x');
    cuts.push({ start, end });
    return { blob: new Blob([`clip ${start}-${end}`], { type: 'audio/webm' }), extension: 'webm' };
  },
}));

const downloads: { blob: Blob; name: string }[] = [];
vi.mock('../utils', async (orig) => ({
  ...(await orig<typeof import('../utils')>()),
  downloadBlob: (blob: Blob, name: string) => { downloads.push({ blob, name }); },
}));

const { exportAnalysisClipsZip, clipEntryName } = await import('./analysisExport');

function det(over: Partial<Detection>): Detection {
  return { id: 'd', displayName: 'tune', dance: 'reel', meter: '4/4', start: 0, end: 10, ...over } as unknown as Detection;
}

function analysis(dets: Detection[]): Analysis {
  return { id: 'a', name: 'Session 22:14', date: null, duration: 600, mimeType: 'audio/webm', source: 'live', status: 'done', annotations: dets } as unknown as Analysis;
}

beforeEach(() => { cuts.length = 0; downloads.length = 0; failAt = -1; });

describe('exportAnalysisClipsZip', () => {
  it('cuts every detection in playing order, numbered, with file-safe names', async () => {
    const session = analysis([
      det({ id: 'b', displayName: 'second', start: 200, end: 300 }),
      det({ id: 'a', displayName: 'first', start: 10, end: 100 }),
      det({ id: 'c', displayName: 'open', start: 500, end: null }),
    ]);
    const progress: [number, number][] = [];
    await exportAnalysisClipsZip(session, new Blob(['audio']), d => d.displayName === 'second' ? 'Cooley\'s / The Wise: Maid' : d.displayName,
      (done, total) => progress.push([done, total]));

    // An open detection runs to the recording's end, as in the other exports.
    expect(cuts).toEqual([{ start: 10, end: 100 }, { start: 200, end: 300 }, { start: 500, end: 600 }]);
    expect(progress).toEqual([[0, 3], [1, 3], [2, 3], [3, 3]]);

    expect(downloads).toHaveLength(1);
    expect(downloads[0]!.name).toBe('Session_22_14-clips.zip');
    const entries = readZip(new Uint8Array(await downloads[0]!.blob.arrayBuffer()));
    // "{index} - {tune}" only — no slash (a folder in a zip), no colon
    // (Windows refuses to extract one).
    expect(entries.map(e => e.name)).toEqual([
      '1 - first.webm',
      '2 - Cooley\'s - The Wise- Maid.webm',
      '3 - open.webm',
    ]);
    expect(new TextDecoder().decode(entries[1]!.data)).toBe('clip 200-300');
  });

  it('downloads nothing when one clip cannot be cut', async () => {
    failAt = 1;
    const session = analysis([det({ start: 0, end: 10 }), det({ start: 20, end: 30 }), det({ start: 40, end: 50 })]);
    await expect(exportAnalysisClipsZip(session, new Blob(['audio']))).rejects.toThrow('clip_cannot_copy');
    expect(downloads).toHaveLength(0);
  });
});

describe('clipEntryName', () => {
  it('pads the index to the count, so a sort by name keeps the playing order', () => {
    expect(clipEntryName(0, 12, 'The Kesh', 'm4a')).toBe('01 - The Kesh.m4a');
    expect(clipEntryName(11, 12, 'The Kesh', 'm4a')).toBe('12 - The Kesh.m4a');
  });
});
