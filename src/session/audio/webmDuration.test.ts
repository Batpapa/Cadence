import { describe, expect, it } from 'vitest';
import fixWebmDuration from 'fix-webm-duration';
import { patchHead, patchWebmDuration } from './webmDuration';

// Node's Blob has arrayBuffer() (jsdom's does not); the old library, kept here
// as the oracle, only needs a FileReader to read one.
class NodeFileReader {
  result: ArrayBuffer | null = null;
  onloadend: (() => void) | null = null;
  readAsArrayBuffer(blob: Blob): void {
    void blob.arrayBuffer().then(r => { this.result = r; this.onloadend?.(); });
  }
}
(globalThis as unknown as { FileReader: unknown }).FileReader ??= NodeFileReader;

// A WebM laid out as MediaRecorder writes one: EBML header, a Segment of
// UNKNOWN size, an Info with TimecodeScale and the app names but no Duration,
// Tracks, then clusters of unknown size. The clusters carry junk payload — the
// patch must never read or move them, only carry them over.

const bytes = (...xs: number[]) => Uint8Array.from(xs);
const str = (s: string) => Array.from(new TextEncoder().encode(s));
function el(id: number[], data: number[] | Uint8Array): Uint8Array {
  const d = Array.from(data);
  if (d.length > 126) throw new Error('test helper: 1-byte sizes only');
  return bytes(...id, 0x80 | d.length, ...d);
}
function cat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}
const UNKNOWN = [0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff];

function recorderFile(opts: { info?: Uint8Array; segmentSize?: number[]; beforeInfo?: Uint8Array } = {}): Uint8Array {
  const ebml = el([0x1a, 0x45, 0xdf, 0xa3], [
    ...el([0x42, 0x82], str('webm')), ...el([0x42, 0x87], [4]), ...el([0x42, 0x85], [2]),
  ]);
  const info = opts.info ?? el([0x15, 0x49, 0xa9, 0x66], [
    ...el([0x2a, 0xd7, 0xb1], [0x0f, 0x42, 0x40]),        // TimecodeScale 1 000 000
    ...el([0x4d, 0x80], str('Chrome')), ...el([0x57, 0x41], str('Chrome')),
  ]);
  const tracks = el([0x16, 0x54, 0xae, 0x6b], el([0xae], [...el([0xd7], [1]), ...el([0x86], str('A_OPUS'))]));
  const cluster = (n: number) => cat(bytes(0x1f, 0x43, 0xb6, 0x75, ...UNKNOWN), el([0xe7], [n]),
    el([0xa3], Array.from({ length: 100 }, (_, i) => (i * 7 + n) & 0xff)));
  const segHead = bytes(0x18, 0x53, 0x80, 0x67, ...(opts.segmentSize ?? UNKNOWN));
  return cat(ebml, segHead, opts.beforeInfo ?? new Uint8Array(), info, tracks, cluster(0), cluster(1), cluster(2));
}

/** The Duration value written, in ticks, or null — read the dumb way. */
function durationIn(b: Uint8Array): number | null {
  for (let i = 0; i + 11 <= b.length; i++) {
    if (b[i] === 0x44 && b[i + 1] === 0x89 && b[i + 2] === 0x88) return new DataView(b.buffer, b.byteOffset + i + 3, 8).getFloat64(0);
  }
  return null;
}

describe('patchHead', () => {
  it('adds a Duration to a MediaRecorder file, and leaves everything after Info untouched', () => {
    const file = recorderFile();
    const out = patchHead(file, 12_345)!;
    expect(out).not.toBeNull();
    const result = cat(out.head, file.subarray(out.consumed));
    expect(durationIn(result)).toBe(12_345);                   // ms, at a 1 ms TimecodeScale
    expect(result.length).toBe(file.length + 11);
    // The clusters are the same bytes, at the end.
    expect(Array.from(result.subarray(result.length - 300))).toEqual(Array.from(file.subarray(file.length - 300)));
    // The Segment keeps its unknown size.
    expect(Array.from(result.subarray(result.indexOf(0x18) + 4, result.indexOf(0x18) + 12))).toEqual(UNKNOWN);
  });

  it('agrees with fix-webm-duration on the value written', async () => {
    const file = recorderFile();
    const theirs = new Uint8Array(await (await fixWebmDuration(new Blob([file as BlobPart]), 98_765, { logger: false })).arrayBuffer());
    const out = patchHead(file, 98_765)!;
    expect(durationIn(cat(out.head, file.subarray(out.consumed)))).toBe(durationIn(theirs));
  });

  it('converts to the file\'s own TimecodeScale', () => {
    const info = el([0x15, 0x49, 0xa9, 0x66], [...el([0x2a, 0xd7, 0xb1], [0x0f, 0x42, 0x40].map((_, i) => [0x00, 0x03, 0xe8][i]!))]); // 1000 ns
    const out = patchHead(recorderFile({ info }), 2_000)!;
    expect(durationIn(out.head)).toBe(2_000_000);
  });

  it('grows a KNOWN Segment size by what Info grew', () => {
    const file = recorderFile({ segmentSize: [0x10, 0x00, 0x10, 0x00] });   // 4-byte size 0x1000
    const out = patchHead(file, 1_000)!;
    const at = out.head.indexOf(0x18) + 4;
    expect(Array.from(out.head.subarray(at, at + 4))).toEqual([0x10, 0x00, 0x10, 0x0b]);
  });

  it('fills a zero Duration in place', () => {
    const zero = [0x44, 0x89, 0x88, 0, 0, 0, 0, 0, 0, 0, 0];
    const info = el([0x15, 0x49, 0xa9, 0x66], [...el([0x2a, 0xd7, 0xb1], [0x0f, 0x42, 0x40]), ...zero]);
    const file = recorderFile({ info });
    const out = patchHead(file, 5_000)!;
    expect(out.head.length).toBe(out.consumed);
    expect(durationIn(out.head)).toBe(5_000);
  });

  it('leaves alone a file that already knows its length', () => {
    const d = new Uint8Array(11); d.set([0x44, 0x89, 0x88]); new DataView(d.buffer).setFloat64(3, 42);
    const info = el([0x15, 0x49, 0xa9, 0x66], [...el([0x2a, 0xd7, 0xb1], [0x0f, 0x42, 0x40]), ...d]);
    expect(patchHead(recorderFile({ info }), 5_000)).toBeNull();
  });

  it('refuses a file with a SeekHead, whose positions the insertion would falsify', () => {
    const seekHead = el([0x11, 0x4d, 0x9b, 0x74], el([0x4d, 0xbb], [...el([0x53, 0xab], [0x15, 0x49, 0xa9, 0x66]), ...el([0x53, 0xac], [0])]));
    expect(patchHead(recorderFile({ beforeInfo: seekHead }), 5_000)).toBeNull();
  });

  it('steps over a Void before Info', () => {
    const out = patchHead(recorderFile({ beforeInfo: el([0xec], [0, 0, 0, 0]) }), 3_000);
    expect(out && durationIn(out.head)).toBe(3_000);
  });

  it('refuses what is not WebM', () => {
    expect(patchHead(bytes(0x49, 0x44, 0x33, 0x04, 0, 0, 0, 0), 1_000)).toBeNull();
    expect(patchHead(new Uint8Array(), 1_000)).toBeNull();
  });
});

describe('patchWebmDuration', () => {
  it('returns the same bytes plus the Duration, through Blob slices', async () => {
    const file = recorderFile();
    const out = await patchWebmDuration(new Blob([file as BlobPart], { type: 'audio/webm;codecs=opus' }), 7_000);
    expect(out.type).toBe('audio/webm;codecs=opus');
    const b = new Uint8Array(await out.arrayBuffer());
    expect(durationIn(b)).toBe(7_000);
    expect(b.length).toBe(file.length + 11);
  });

  it('hands back the original blob when there is nothing it can do', async () => {
    const blob = new Blob([bytes(1, 2, 3)]);
    expect(await patchWebmDuration(blob, 7_000)).toBe(blob);
    expect(await patchWebmDuration(new Blob([recorderFile() as BlobPart]), 0)).toBeInstanceOf(Blob);
  });
});
