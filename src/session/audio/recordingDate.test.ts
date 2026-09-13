import { describe, it, expect } from 'vitest';
import { parseBuffer } from 'music-metadata';
import { recordingStartFrom, cluesOf } from './recordingDate';

const NOW = Date.parse('2026-09-13T22:00:00Z');

describe('recordingStartFrom', () => {
  // The Mayflower session: its header says 21:34:13 UTC, 11 542 s long.
  it('takes the duration off an MP4 header, which marks the end', () => {
    const start = recordingStartFrom({ mp4CreationTime: new Date('2026-06-10T21:34:13Z') }, 11542, NOW);
    expect(start).toBe('2026-06-10T18:21:51.000Z');
  });

  it('ignores a zeroed MP4 header, and one without a duration', () => {
    expect(recordingStartFrom({ mp4CreationTime: new Date('1904-01-01T00:00:00Z') }, 600, NOW)).toBeNull();
    expect(recordingStartFrom({ mp4CreationTime: new Date('2026-06-10T21:34:13Z') }, null, NOW)).toBeNull();
  });

  it('ignores a date in the future', () => {
    expect(recordingStartFrom({ mp4CreationTime: new Date('2027-01-01T00:00:00Z') }, 600, NOW)).toBeNull();
  });

  // Broadcast Wave stamps the start, in the recorder's local time.
  it('reads a Broadcast Wave origination stamp as local time', () => {
    const start = recordingStartFrom({ bextDate: '2026:06:10', bextTime: '20-22-05' }, 600, NOW);
    expect(start).toBe(new Date(2026, 5, 10, 20, 22, 5).toISOString());
  });

  it('refuses an origination stamp the calendar had to repair', () => {
    expect(recordingStartFrom({ bextDate: '2026-13-10', bextTime: '20:22:05' }, 600, NOW)).toBeNull();
  });

  // A year or a bare date is an album's, far more often than a session's.
  it('uses a date tag only when it names a moment', () => {
    expect(recordingStartFrom({ tagDate: '2020' }, 600, NOW)).toBeNull();
    expect(recordingStartFrom({ tagDate: '2026-06-10' }, 600, NOW)).toBeNull();
    expect(recordingStartFrom({ tagDate: '2026-06-10T20:22:05Z' }, 600, NOW)).toBe('2026-06-10T20:22:05.000Z');
    expect(recordingStartFrom({ tagDate: '2026-06-10 20:22' }, 600, NOW)).toBe(new Date(2026, 5, 10, 20, 22).toISOString());
  });

  it('prefers the MP4 header, then Broadcast Wave, then a tag', () => {
    const clues = {
      mp4CreationTime: new Date('2026-06-10T21:00:00Z'),
      bextDate: '2025-01-01', bextTime: '10:00:00',
      tagDate: '2024-01-01T10:00:00Z',
    };
    expect(recordingStartFrom(clues, 3600, NOW)).toBe('2026-06-10T20:00:00.000Z');
    expect(recordingStartFrom({ ...clues, mp4CreationTime: undefined }, 3600, NOW)).toBe(new Date(2025, 0, 1, 10).toISOString());
  });
});

describe('cluesOf', () => {
  // A Broadcast Wave file as a field recorder writes it, through the real parser.
  it('finds the origination stamp in a Broadcast Wave file', async () => {
    const ascii = (s: string, len: number) => { const b = Buffer.alloc(len); b.write(s, 'ascii'); return b; };
    const chunk = (id: string, body: Buffer) => {
      const head = Buffer.alloc(8); head.write(id, 0, 'ascii'); head.writeUInt32LE(body.length, 4);
      return Buffer.concat([head, body, body.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)]);
    };
    const fmt = Buffer.alloc(16);
    fmt.writeUInt16LE(1, 0); fmt.writeUInt16LE(1, 2); fmt.writeUInt32LE(8000, 4);
    fmt.writeUInt32LE(16000, 8); fmt.writeUInt16LE(2, 12); fmt.writeUInt16LE(16, 14);
    const bext = Buffer.concat([
      ascii('', 256), ascii('ZOOM H6', 32), ascii('', 32),
      ascii('2026-06-10', 10), ascii('20:22:05', 8),
      Buffer.alloc(8), Buffer.from([1, 0]), Buffer.alloc(64), Buffer.alloc(10), Buffer.alloc(180),
    ]);
    const wav = chunk('RIFF', Buffer.concat([ascii('WAVE', 4), chunk('fmt ', fmt), chunk('bext', bext), chunk('data', Buffer.alloc(16000))]));

    const clues = cluesOf(await parseBuffer(new Uint8Array(wav), { mimeType: 'audio/wav' }));
    expect(clues.bextDate).toBe('2026-06-10');
    expect(clues.bextTime).toBe('20:22:05');
    expect(recordingStartFrom(clues, 1, NOW)).toBe(new Date(2026, 5, 10, 20, 22, 5).toISOString());
  });
});
