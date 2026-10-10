import { describe, expect, it } from 'vitest';
import { fetchRemotePassage, type RangeReader } from './remotePassage';
import { openAudioInput } from './clipExtract';

// Synthetic recordings in the three shapes the module reaches by parts — built
// here, since the real ones are personal and far too large for the repo. They
// were measured on real files too (see the module's header); these keep the
// mechanics honest: the passage is the one asked for, and it costs few ROUND
// TRIPS — on Drive each one waits over a second before its first byte, which
// is what made the first version slow (2026-10-10).

/** A reader over `file` that counts what it is asked for. */
function counted(file: Uint8Array) {
  const stats = { requests: 0, bytes: 0 };
  const read: RangeReader = async (s, e) => {
    stats.requests++;
    stats.bytes += e - s;
    return file.slice(s, e);
  };
  return { read, stats };
}

async function durationOf(blob: Blob): Promise<number> {
  const { input } = await openAudioInput(blob);
  try { return await input.computeDuration(); } finally { input.dispose(); }
}

function cat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

// ── WAV ──────────────────────────────────────────────────────────────────────

function wav(seconds: number, rate = 8000): Uint8Array {
  const data = seconds * rate * 2;
  const out = new Uint8Array(44 + data);
  const v = new DataView(out.buffer);
  const tag = (at: number, s: string) => { for (let i = 0; i < 4; i++) out[at + i] = s.charCodeAt(i); };
  tag(0, 'RIFF'); v.setUint32(4, 36 + data, true); tag(8, 'WAVE');
  tag(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  tag(36, 'data'); v.setUint32(40, data, true);
  return out;
}

// ── MP3: MPEG-1 layer III, 128 kbps, 44.1 kHz, silent frames ─────────────────

function mp3(seconds: number, opts: { xing?: boolean } = {}): Uint8Array {
  const frames = Math.round(seconds * 44100 / 1152);
  const exact = 144_000 * 128 / 44100;              // 417.96 bytes a frame
  const parts: Uint8Array[] = [];
  for (let i = 0; i < frames; i++) {
    // Padded whenever it keeps the running total on the exact rate, as an
    // encoder does.
    const pad = Math.floor((i + 1) * exact) - Math.floor(i * exact) - 417;
    const f = new Uint8Array(417 + pad);
    f[0] = 0xff; f[1] = 0xfb; f[2] = 0x90 | (pad << 1); f[3] = 0xc4;
    if (i === 0 && opts.xing) f.set([0x58, 0x69, 0x6e, 0x67], 36);   // "Xing"
    parts.push(f);
  }
  return cat(parts);
}

// ── WebM as MediaRecorder writes it ──────────────────────────────────────────
// Segment and clusters of UNKNOWN size, no Cues, a cluster every 5 s, Opus in
// 20 ms packets — and a pause: the timeline jumps `gap` seconds at `gapAt`,
// with no packet in between, which is what breaks a straight-line estimate.

const UNKNOWN = [0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff];
function size(n: number): number[] {
  if (n < 0x7f) return [0x80 | n];
  if (n < 0x3fff) return [0x40 | (n >> 8), n & 0xff];
  return [0x10, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}
function el(id: number[], data: number[] | Uint8Array): Uint8Array {
  const d = Array.from(data);
  return Uint8Array.from([...id, ...size(d.length), ...d]);
}
const uint = (n: number) => { const out: number[] = []; do { out.unshift(n & 0xff); n = Math.floor(n / 256); } while (n > 0); return out; };
const str = (s: string) => Array.from(new TextEncoder().encode(s));

function webm(seconds: number, gapAt: number, gap: number): Uint8Array {
  const opusHead = [...str('OpusHead'), 1, 1, 0x38, 0x01, 0x80, 0xbb, 0, 0, 0, 0, 0];
  const header = cat([
    el([0x1a, 0x45, 0xdf, 0xa3], [
      ...el([0x42, 0x86], [1]), ...el([0x42, 0xf7], [1]), ...el([0x42, 0xf2], [4]), ...el([0x42, 0xf3], [8]),
      ...el([0x42, 0x82], str('webm')), ...el([0x42, 0x87], [4]), ...el([0x42, 0x85], [2]),
    ]),
    Uint8Array.from([0x18, 0x53, 0x80, 0x67, ...UNKNOWN]),
    el([0x15, 0x49, 0xa9, 0x66], [...el([0x2a, 0xd7, 0xb1], uint(1_000_000)), ...el([0x4d, 0x80], str('test'))]),
    el([0x16, 0x54, 0xae, 0x6b], el([0xae], [
      ...el([0xd7], [1]), ...el([0x73, 0xc5], [1]), ...el([0x83], [2]),
      ...el([0x86], str('A_OPUS')), ...el([0x63, 0xa2], opusHead),
      ...el([0xe1], [...el([0xb5], [0x47, 0x3b, 0x80, 0x00]), ...el([0x9f], [1])]),
    ])),
  ]);
  const clusters: Uint8Array[] = [];
  for (let c = 0; c * 5 < seconds; c++) {
    const recorded = c * 5;
    const ms = (recorded >= gapAt ? recorded + gap : recorded) * 1000;
    const blocks: Uint8Array[] = [];
    for (let k = 0; k < 250 && recorded + k * 0.02 < seconds; k++) {
      // Track 1, relative timecode, keyframe; an Opus TOC for 20 ms CELT, then noise.
      const rel = k * 20;
      blocks.push(el([0xa3], [0x81, rel >> 8, rel & 0xff, 0x80, 0xf8, ...Array.from({ length: 160 }, (_, i) => (i * 37 + k) & 0xff)]));
    }
    clusters.push(Uint8Array.from([0x1f, 0x43, 0xb6, 0x75, ...UNKNOWN]), el([0xe7], uint(ms)), ...blocks);
  }
  return cat([header, ...clusters]);
}

describe('fetchRemotePassage', () => {
  it('cuts a WAV passage from the data chunk', async () => {
    const file = wav(120);
    const { read, stats } = counted(file);
    const clip = await fetchRemotePassage(read, { bytes: file.length, duration: 120 }, 50, 60);
    expect(clip?.extension).toBe('wav');
    expect(await durationOf(clip!.blob)).toBeCloseTo(10, 1);
    // Its header, then the passage in one piece.
    expect(stats.requests).toBe(2);
  });

  it('cuts a constant-bitrate MP3 passage by arithmetic, from a frame boundary', async () => {
    const file = mp3(120);
    const { read, stats } = counted(file);
    const clip = await fetchRemotePassage(read, { bytes: file.length, duration: 120 }, 70.3, 90.3, 'mp3-test');
    expect(clip?.extension).toBe('mp3');
    expect(Math.abs(await durationOf(clip!.blob) - 20)).toBeLessThan(0.1);
    expect(stats.requests).toBe(2);
    // The next passage of the same recording: its header is known already.
    const again = await fetchRemotePassage(read, { bytes: file.length, duration: 120 }, 10, 20, 'mp3-test');
    expect(Math.abs(await durationOf(again!.blob) - 10)).toBeLessThan(0.1);
    expect(stats.requests).toBe(3);
  });

  it('declines a variable-bitrate MP3 — the caller downloads it whole', async () => {
    const file = mp3(30, { xing: true });
    expect(await fetchRemotePassage(counted(file).read, { bytes: file.length, duration: 30 }, 10, 20)).toBeNull();
  });

  it('reaches a WebM passage by its cluster timecodes, a pause notwithstanding', async () => {
    // 600 s recorded, with 60 s of nothing after 300: the timeline runs to 660.
    const file = webm(600, 300, 60);
    const { read, stats } = counted(file);
    let before = 0;
    for (const [from, to] of [[100, 130], [420, 450], [600, 630], [200, 230]] as const) {
      const clip = await fetchRemotePassage(read, { bytes: file.length, duration: 600 }, from, to, 'webm-test');
      expect(clip?.extension).toBe('webm');
      // The whole passage, its last cluster included (an unknown-size cluster
      // at the end of a file is otherwise dropped).
      expect(Math.abs(await durationOf(clip!.blob) - 30)).toBeLessThan(0.2);
      // The first passage reads the header and the end of the file as well;
      // after that, a window around the passage — and a search only when the
      // pause has thrown the estimate off.
      expect(stats.requests - before).toBeLessThanOrEqual(before === 0 ? 4 : 3);
      before = stats.requests;
    }
    // Four passages, and still never the whole file.
    expect(stats.bytes).toBeLessThan(file.length);
  });

  it('does not read what it does not recognise', async () => {
    const file = new Uint8Array(4096).fill(7);
    const { read, stats } = counted(file);
    expect(await fetchRemotePassage(read, { bytes: file.length, duration: 10 }, 1, 2)).toBeNull();
    expect(stats.requests).toBe(1);
  });
});
