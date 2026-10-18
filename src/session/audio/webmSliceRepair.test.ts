import { describe, expect, it } from 'vitest';
import { patchHead } from './webmDuration';
import { findDoubledHead, repairDoubledWebm } from './webmSliceRepair';

// A WebM as MediaRecorder writes one (same shape as webmDuration.test.ts):
// EBML header, Segment of unknown size, Info without Duration, Tracks, clusters.
const bytes = (...xs: number[]) => Uint8Array.from(xs);
const str = (s: string) => Array.from(new TextEncoder().encode(s));
function el(id: number[], data: number[] | Uint8Array): Uint8Array {
  const d = Array.from(data);
  return bytes(...id, 0x80 | d.length, ...d);
}
function cat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}
const UNKNOWN = [0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff];
function recorderFile(info?: Uint8Array): Uint8Array {
  const ebml = el([0x1a, 0x45, 0xdf, 0xa3], [...el([0x42, 0x82], str('webm')), ...el([0x42, 0x87], [4])]);
  const inf = info ?? el([0x15, 0x49, 0xa9, 0x66], [...el([0x2a, 0xd7, 0xb1], [0x0f, 0x42, 0x40]), ...el([0x4d, 0x80], str('Safari'))]);
  const tracks = el([0x16, 0x54, 0xae, 0x6b], el([0xae], [...el([0xd7], [1]), ...el([0x86], str('A_OPUS'))]));
  const cluster = (n: number) => cat(bytes(0x1f, 0x43, 0xb6, 0x75, ...UNKNOWN), el([0xe7], [n]),
    el([0xa3], Array.from({ length: 100 }, (_, i) => (i * 7 + n) & 0xff)));
  return cat(ebml, bytes(0x18, 0x53, 0x80, 0x67, ...UNKNOWN), inf, tracks, cluster(0), cluster(1));
}

/** What the old patch stored, as WebKit read it back: the patched head, then
 *  the whole original, its own head included. And what it should have been. */
function damaged(file: Uint8Array, durationMs: number) {
  const p = patchHead(file, durationMs)!;
  return { bad: cat(p.head, file), good: cat(p.head, file.subarray(p.consumed)) };
}

describe('repairDoubledWebm', () => {
  it('rebuilds a recording whose head was followed by the whole original', async () => {
    const { bad, good } = damaged(recorderFile(), 44_123);
    const out = await repairDoubledWebm(new Blob([bad as BlobPart], { type: 'audio/webm;codecs=opus' }));
    expect(out).not.toBeNull();
    expect(out!.type).toBe('audio/webm;codecs=opus');
    expect(new Uint8Array(await out!.arrayBuffer())).toEqual(good);
  });

  // The Duration value is masked out of the comparison, so whatever its bytes,
  // they must not decide the verdict.
  it('recognises it whatever duration was written', async () => {
    for (const ms of [1, 999, 44_000, 60_000, 3_600_000, 10_800_000, 1_234_567.89]) {
      const { bad, good } = damaged(recorderFile(), ms);
      const out = await repairDoubledWebm(new Blob([bad as BlobPart]));
      expect(new Uint8Array(await out!.arrayBuffer())).toEqual(good);
    }
  });

  it('does so when the Duration was filled in place, too', async () => {
    const info = el([0x15, 0x49, 0xa9, 0x66], [...el([0x2a, 0xd7, 0xb1], [0x0f, 0x42, 0x40]), ...el([0x44, 0x89], [0, 0, 0, 0, 0, 0, 0, 0])]);
    const { bad, good } = damaged(recorderFile(info), 5_000);
    const out = await repairDoubledWebm(new Blob([bad as BlobPart]));
    expect(new Uint8Array(await out!.arrayBuffer())).toEqual(good);
  });

  it('leaves alone a sound recording, patched or not', async () => {
    const file = recorderFile();
    expect(await repairDoubledWebm(new Blob([file as BlobPart]))).toBeNull();
    expect(await repairDoubledWebm(new Blob([damaged(file, 3_000).good as BlobPart]))).toBeNull();
  });

  it('leaves alone what is not one of these', async () => {
    expect(await repairDoubledWebm(new Blob([bytes(0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0)]))).toBeNull();
    // Two WebM files end to end: the second head is not the first one patched.
    const file = recorderFile();
    expect(await repairDoubledWebm(new Blob([cat(file, file) as BlobPart]))).toBeNull();
    // An EBML magic inside the head that is not where an original starts.
    expect(findDoubledHead(cat(patchHead(file, 1_000)!.head, bytes(0x1a, 0x45, 0xdf, 0xa3, 0, 0)))).toBeNull();
  });
});
