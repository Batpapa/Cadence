import { describe, it, expect } from 'vitest';
import { buildZip, audioExtension } from './zip';

const u8 = (...b: number[]) => new Uint8Array(b);
const rd16 = (a: Uint8Array, o: number) => a[o]! | (a[o + 1]! << 8);
const rd32 = (a: Uint8Array, o: number) => (a[o]! | (a[o + 1]! << 8) | (a[o + 2]! << 16)) + a[o + 3]! * 0x1000000;

describe('buildZip', () => {
  it('produces a well-formed STORE archive whose payloads round-trip', () => {
    const files = [
      { name: 'one.webm', data: u8(1, 2, 3, 4, 5) },
      { name: 'sous/deux.mp3', data: u8(0xde, 0xad, 0xbe, 0xef) },
    ];
    const zip = buildZip(files, new Date(2026, 7, 31, 12, 0, 0));

    // Magic + EOCD bookkeeping.
    expect(rd32(zip, 0)).toBe(0x04034b50);
    const eocd = zip.length - 22;
    expect(rd32(zip, eocd)).toBe(0x06054b50);
    expect(rd16(zip, eocd + 10)).toBe(2);                      // entry count
    const cdOffset = rd32(zip, eocd + 16);
    expect(rd32(zip, cdOffset)).toBe(0x02014b50);

    // Walk local headers and extract each payload back, byte-identical.
    let pos = 0;
    for (const f of files) {
      expect(rd32(zip, pos)).toBe(0x04034b50);
      expect(rd16(zip, pos + 8)).toBe(0);                      // STORE
      const size = rd32(zip, pos + 22);
      const nameLen = rd16(zip, pos + 26);
      expect(size).toBe(f.data.length);
      expect(new TextDecoder().decode(zip.slice(pos + 30, pos + 30 + nameLen))).toBe(f.name);
      expect([...zip.slice(pos + 30 + nameLen, pos + 30 + nameLen + size)]).toEqual([...f.data]);
      pos += 30 + nameLen + size;
    }
    expect(pos).toBe(cdOffset);                                // no gaps, no overlap
  });

  it('a known CRC32 lands in the header (the field unzip tools verify)', () => {
    // CRC32 of "123456789" is the classic check value 0xCBF43926.
    const zip = buildZip([{ name: 'x', data: new TextEncoder().encode('123456789') }]);
    expect(rd32(zip, 14) >>> 0).toBe(0xcbf43926);
  });

  it('empty archive is still valid (EOCD only)', () => {
    const zip = buildZip([]);
    expect(zip.length).toBe(22);
    expect(rd32(zip, 0)).toBe(0x06054b50);
  });
});

describe('audioExtension', () => {
  it('maps common mimes, ignores codec suffixes, falls back to bin', () => {
    expect(audioExtension('audio/webm;codecs=opus')).toBe('webm');
    expect(audioExtension('audio/mpeg')).toBe('mp3');
    expect(audioExtension('audio/mp4')).toBe('m4a');
    expect(audioExtension(undefined)).toBe('bin');
    expect(audioExtension('application/x-whatever')).toBe('bin');
  });
});
