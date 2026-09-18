import { describe, it, expect } from 'vitest';
import { monoFromS24Bytes, wavHeader } from './streamingFileSource';

// 24-bit PCM is the one width the browser's own decoder cannot be handed (it
// crashes the tab — see the comment above monoFromS24Bytes), so this
// conversion is ours, and these are the cases that would go wrong silently:
// sign extension, byte order, and the mixdown.

/** `value` as three little-endian bytes, the way a file carries it. */
const s24 = (value: number): number[] => [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff];

const bytes = (...samples: number[]): Uint8Array => new Uint8Array(samples.flatMap(s24));

describe('24-bit PCM to mono floats', () => {
  it('reads little-endian, not the other way round', () => {
    // 0x000001 is the smallest positive step, and would be 0x010000 reversed.
    const out = monoFromS24Bytes(bytes(1), 1);
    expect(out[0]).toBeCloseTo(1 / 8388608, 12);
  });

  it('sign-extends: the top bit is a sign, not a huge number', () => {
    expect(monoFromS24Bytes(bytes(-1), 1)[0]).toBeCloseTo(-1 / 8388608, 12);
    expect(monoFromS24Bytes(bytes(-8388608), 1)[0]).toBe(-1);          // 0x800000
    expect(monoFromS24Bytes(bytes(8388607), 1)[0]).toBeCloseTo(1, 6);  // 0x7fffff
    expect(monoFromS24Bytes(bytes(0), 1)[0]).toBe(0);
  });

  it('averages the channels of an interleaved frame', () => {
    // One stereo frame: +full left, −full right → silence once mixed.
    expect(monoFromS24Bytes(bytes(8388607, -8388608), 2)[0]).toBeCloseTo(0, 6);
    // Two frames, both channels equal — the mixdown must not halve them.
    const out = monoFromS24Bytes(bytes(4194304, 4194304, -4194304, -4194304), 2);
    expect(out).toHaveLength(2);
    expect(out[0]).toBeCloseTo(0.5, 6);
    expect(out[1]).toBeCloseTo(-0.5, 6);
  });

  it('never reads past the end of a truncated packet', () => {
    // 7 bytes is two whole mono frames and a byte of a third.
    const out = monoFromS24Bytes(new Uint8Array(7), 1);
    expect(out).toHaveLength(2);
    expect(monoFromS24Bytes(new Uint8Array(0), 2)).toHaveLength(0);
  });

  it('treats a channel count of zero as mono rather than dividing by it', () => {
    expect(monoFromS24Bytes(bytes(8388607), 0)[0]).toBeCloseTo(1, 6);
  });
});

// The header written in front of an AVI's raw packets. Every field is
// little-endian and every one of them is a way to make a file no player opens.
describe('the WAV header', () => {
  const read = (h: Uint8Array) => {
    const v = new DataView(h.buffer, h.byteOffset, h.byteLength);
    const ascii = (at: number, len: number) => String.fromCharCode(...h.slice(at, at + len));
    return {
      riff: ascii(0, 4), riffSize: v.getUint32(4, true), wave: ascii(8, 4),
      fmt: ascii(12, 4), fmtSize: v.getUint32(16, true), tag: v.getUint16(20, true),
      channels: v.getUint16(22, true), rate: v.getUint32(24, true),
      byteRate: v.getUint32(28, true), blockAlign: v.getUint16(32, true),
      bits: v.getUint16(34, true), data: ascii(36, 4), dataSize: v.getUint32(40, true),
    };
  };

  it('describes 16-bit stereo the way a player expects', () => {
    const h = read(wavHeader(11_112_000, 44100, 2, 16, false));
    expect(h).toMatchObject({
      riff: 'RIFF', wave: 'WAVE', fmt: 'fmt ', fmtSize: 16, data: 'data',
      tag: 1, channels: 2, rate: 44100, bits: 16,
      blockAlign: 4,          // 2 channels x 2 bytes
      byteRate: 176400,       // 44100 x 4
      dataSize: 11_112_000,
      riffSize: 11_112_036,   // everything after the first 8 bytes
    });
  });

  it('is 44 bytes, whatever it describes', () => {
    expect(wavHeader(0, 48000, 1, 24, false)).toHaveLength(44);
  });

  it('marks floating-point samples with the other format tag', () => {
    expect(read(wavHeader(100, 48000, 2, 32, true)).tag).toBe(3);
    expect(read(wavHeader(100, 48000, 2, 32, false)).tag).toBe(1);
  });

  it('keeps block align and byte rate in step with odd widths', () => {
    const h = read(wavHeader(0, 48000, 2, 24, false));
    expect(h.blockAlign).toBe(6);
    expect(h.byteRate).toBe(288000);
  });
});
