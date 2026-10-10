import { openAudioSource, copySlice, type ExtractedClip } from './clipExtract';

// ── A passage of a recording that is only on Drive ───────────────────────────
// Lot 5 #13 (2026-10-10): hearing one detection of an analysis whose recording
// is not on this device used to mean downloading all of it — 50 to 250 MB for
// an evening. Drive serves byte ranges (alt=media + Range: 206, CORS allowed),
// so only the passage is fetched, then cut out without re-encoding by the same
// copy a clip uses (clipExtract.ts's copySlice) into a small file of its own.
//
// What it costs is ROUND TRIPS, not bytes: Drive takes 1 to 1.6 s to send the
// first byte of any range, then a quarter of a megabyte in 20 ms (measured
// 2026-10-10). The first version read the passage the way mediabunny asks for
// it, a block at a time — nine requests one after the other, 13 s for 75 s of
// an MP3. So wherever the bytes of the passage can be known beforehand, they
// are fetched in ONE request, with a margin; and what was learnt about a
// recording (its first bytes, where its clusters are) is kept for the next
// passage of it.
//
// How a byte range is found for a time depends on the container, and so does
// whether one can be found at all:
//
//  • MP3 at a constant bitrate (imports): time × bitrate is the byte. A
//    variable bitrate has no such arithmetic.
//  • WAV: the same arithmetic, on the data chunk.
//  • WebM from MediaRecorder (live recordings on Android and Chrome): no Cues,
//    clusters of UNKNOWN size, so mediabunny alone would read everything from
//    the start. But each cluster (~5 s) carries its absolute timecode: one
//    window estimated from the clusters already known usually holds the whole
//    passage; when it does not — a pause in the recording bends the timeline,
//    one was off by 391 s — the clusters are searched for by interpolation.
//    Then the header followed by just those clusters is handed to mediabunny
//    as a file of its own.
//  • MP4 / M4A (imports, iPhone recordings): mediabunny reads the sample table
//    and jumps by itself; its reads are grouped into blocks that grow while
//    they run on, and the opened file is kept so the table is read once.
//
// Anything else returns null and the caller downloads the whole recording, as
// before (user's call: the fallback, with its confirmation in the manual mode).
//
// Never computeDuration: on a remote file it reads all of it. The analysis
// knows the duration.

/** Bytes [start, end) of the recording. */
export type RangeReader = (start: number, end: number) => Promise<Uint8Array>;

export interface RemoteRecording {
  bytes: number;
  /** Seconds, as the analysis has it. */
  duration: number;
}

/** What mediabunny is handed: a file that may be made of pieces of the real
 *  one, and where its time 0 falls in the recording's. */
interface Plan {
  size: number;
  read: RangeReader;
  /** Recording time of the plan's own time 0 — 0 when it keeps the recording's
   *  timestamps, the passage's start when it only holds the passage. */
  offset: number;
}

/** The first bytes, which say what the file is. A whole block: an MP4 reader
 *  starts from it, and 256 KB arrive as fast as 64 once Drive answers. */
const HEAD_BYTES = 256 * 1024;

/** What is remembered of a recording between passages, by key. */
interface Known {
  head: Uint8Array;
  /** WebM: the clusters seen so far, by position. */
  clusters?: Map<number, Cluster>;
}
const known = new Map<string, Known>();
const KNOWN_KEPT = 4;

function remember(key: string | undefined, entry: Known): Known {
  if (key === undefined) return entry;
  known.delete(key);
  known.set(key, entry);
  while (known.size > KNOWN_KEPT) known.delete(known.keys().next().value!);
  return entry;
}

type Opened = Awaited<ReturnType<typeof openAudioSource>>;

/** MP4 recordings kept open between passages, by key: its sample table — 4 to
 *  7 MB for an evening — is then read once, not once per passage played. The
 *  most recent last; two is enough for a list of passes. */
const openMp4 = new Map<string, Promise<Opened>>();
const MP4_KEPT = 2;

function plannedSource(plan: Plan) {
  return openAudioSource(m => new m.StreamSource({
    getSize: () => plan.size,
    read: (s, e) => plan.read(s, e),
    // Exact reads: the plans below hold their bytes already, and the MP4 one
    // groups its own (blockReader). mediabunny's "network" profile doubles
    // what it reads ahead, up to 8 MB.
    prefetchProfile: 'none',
  }));
}

/** The passage [start, end] of a recording read through `read` — a small file
 *  in the recording's own container, playable from its beginning. Null when
 *  this container gives no way to find a time without reading what precedes
 *  it. Throws when reading fails.
 *
 *  `key` names the recording (its Drive file id): what is learnt about it is
 *  kept for its next passage.
 *
 *  The end is not clamped to `rec.duration`: the analysis counts recording
 *  time, and a file's timeline can run past it. Past the last packet, the cut
 *  simply stops. */
export async function fetchRemotePassage(
  read: RangeReader,
  rec: RemoteRecording,
  start: number,
  end: number,
  key?: string,
): Promise<ExtractedClip | null> {
  const from = Math.max(0, start);
  if (end <= from) return null;
  const kept = key !== undefined ? openMp4.get(key) : undefined;
  if (kept) {
    openMp4.delete(key!);
    openMp4.set(key!, kept);
    const { mb, input } = await kept;
    return copySlice(mb, input, from, end);
  }
  const info = remember(key, (key !== undefined ? known.get(key) : undefined)
    ?? { head: await read(0, Math.min(rec.bytes, HEAD_BYTES)) });
  const head = info.head;
  if (isMp4(head)) return mp4Passage(read, rec, head, from, end, key);
  const plan = isEbml(head) ? await webmPlan(read, rec, info, from, end)
    : isWav(head) ? await wavPlan(read, head, from, end)
    : isMp3(head) ? await mp3Plan(read, rec, head, from, end)
    : null;
  if (!plan) return null;
  const { mb, input } = await plannedSource(plan);
  try {
    return await copySlice(mb, input, Math.max(0, from - plan.offset), end - plan.offset);
  } finally {
    input.dispose();
  }
}

// ── Recognising the container from its first bytes ──────────────────────────

const isEbml = (b: Uint8Array) => b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3;
const ascii = (b: Uint8Array, at: number, n: number) => String.fromCharCode(...b.subarray(at, at + n));
const isMp4 = (b: Uint8Array) => ascii(b, 4, 4) === 'ftyp';
const isWav = (b: Uint8Array) => ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WAVE';
const isMp3 = (b: Uint8Array) => ascii(b, 0, 3) === 'ID3' || (b[0] === 0xff && (b[1]! & 0xe0) === 0xe0);

/** A file held in memory: `prefix`, then `body`, then `suffix`. */
function inMemory(prefix: Uint8Array, body: Uint8Array, suffix: Uint8Array, offset: number): Plan {
  const file = new Uint8Array(prefix.length + body.length + suffix.length);
  file.set(prefix, 0);
  file.set(body, prefix.length);
  file.set(suffix, prefix.length + body.length);
  return { size: file.length, read: async (s, e) => file.slice(s, e), offset };
}

const NONE = new Uint8Array(0);

// ── MP4 ──────────────────────────────────────────────────────────────────────

async function mp4Passage(
  read: RangeReader, rec: RemoteRecording, head: Uint8Array, from: number, end: number, key: string | undefined,
) {
  const opened = plannedSource({ size: rec.bytes, read: blockReader(read, rec.bytes, head), offset: 0 });
  if (key === undefined) {
    const { mb, input } = await opened;
    try { return await copySlice(mb, input, from, end); } finally { input.dispose(); }
  }
  openMp4.set(key, opened);
  while (openMp4.size > MP4_KEPT) {
    const [oldest, evicted] = openMp4.entries().next().value!;
    openMp4.delete(oldest);
    void evicted.then(o => o.input.dispose(), () => {});
  }
  try {
    const { mb, input } = await opened;
    return await copySlice(mb, input, from, end);
  } catch (e) {
    // A recording that failed once is not kept: the next try starts afresh.
    if (openMp4.get(key) === opened) openMp4.delete(key);
    void opened.then(o => o.input.dispose(), () => {});
    throw e;
  }
}

const BLOCK_BYTES = 256 * 1024;
const FIRST_RUN_BLOCKS = 4;
const MAX_RUN_BLOCKS = 16;
const BLOCKS_KEPT = 48;

/** Reads in aligned blocks, keeping the recent ones: mediabunny reads an MP4
 *  passage a packet — a few hundred bytes — at a time, and each read must not
 *  be a request to Drive. What is missing of [s, e) is fetched in ONE request
 *  of at least a megabyte, and while the misses run on from each other — a
 *  passage or a sample table read in order — each request is twice as long as
 *  the last, up to 4 MB. `head`, the file's first bytes already read, is its
 *  first block. */
function blockReader(read: RangeReader, size: number, head: Uint8Array): RangeReader {
  const blocks = new Map<number, Uint8Array>();
  if (head.length >= Math.min(size, BLOCK_BYTES)) blocks.set(0, head.subarray(0, BLOCK_BYTES));
  let lastMissEnd = -1;
  let run = FIRST_RUN_BLOCKS;
  return async (s, e) => {
    const first = Math.floor(s / BLOCK_BYTES), last = Math.floor((e - 1) / BLOCK_BYTES);
    let missFrom = -1, missTo = -1;
    for (let b = first; b <= last; b++) {
      if (blocks.has(b)) continue;
      if (missFrom === -1) missFrom = b;
      missTo = b;
    }
    if (missFrom !== -1) {
      run = missFrom === lastMissEnd ? Math.min(MAX_RUN_BLOCKS, run * 2) : FIRST_RUN_BLOCKS;
      const lastBlock = Math.ceil(size / BLOCK_BYTES) - 1;
      const to = Math.min(lastBlock, Math.max(missTo, missFrom + run - 1));
      const got = await read(missFrom * BLOCK_BYTES, Math.min(size, (to + 1) * BLOCK_BYTES));
      for (let b = missFrom; b <= to; b++) {
        const at = (b - missFrom) * BLOCK_BYTES;
        blocks.set(b, got.subarray(at, Math.min(got.length, at + BLOCK_BYTES)));
      }
      lastMissEnd = to + 1;
    }
    const out = new Uint8Array(e - s);
    for (let b = first; b <= last; b++) {
      const block = blocks.get(b)!;
      // Most recently used last, for the eviction below.
      blocks.delete(b);
      blocks.set(b, block);
      const bs = b * BLOCK_BYTES;
      const from = Math.max(s, bs), to = Math.min(e, bs + block.length);
      out.set(block.subarray(from - bs, to - bs), from - s);
    }
    while (blocks.size > Math.max(BLOCKS_KEPT, last - first + 1)) blocks.delete(blocks.keys().next().value!);
    return out;
  };
}

// ── WebM / Matroska ──────────────────────────────────────────────────────────

interface Cluster {
  pos: number;
  ms: number;
  /** Where the next cluster starts, once known — what proves this one is the
   *  last to start at or before a time. */
  next?: number;
}

/** Every cluster in `buf` (which starts at file offset `base`): its ID, a size,
 *  then its Timecode as first child and a block right after — the block is
 *  what tells a real cluster from the same four bytes inside Opus data. */
function clustersIn(buf: Uint8Array, base: number): Cluster[] {
  const out: Cluster[] = [];
  for (let i = 0; i + 16 < buf.length; i++) {
    if (buf[i] !== 0x1f || buf[i + 1] !== 0x43 || buf[i + 2] !== 0xb6 || buf[i + 3] !== 0x75) continue;
    const first = buf[i + 4]!;
    let len = 1;
    for (let mask = 0x80; len <= 8 && !(first & mask); mask >>= 1) len++;
    if (len > 8) continue;
    const tcAt = i + 4 + len;
    if (buf[tcAt] !== 0xe7) continue;
    const tcLen = buf[tcAt + 1]! & 0x7f;
    if (tcLen < 1 || tcLen > 8 || tcAt + 2 + tcLen >= buf.length) continue;
    let ms = 0;
    for (let k = 0; k < tcLen; k++) ms = ms * 256 + buf[tcAt + 2 + k]!;
    // SimpleBlock, BlockGroup, Position or PrevSize.
    const after = buf[tcAt + 2 + tcLen];
    if (after !== 0xa3 && after !== 0xa0 && after !== 0xa7 && after !== 0xab) continue;
    out.push({ pos: base + i, ms });
  }
  for (let k = 0; k + 1 < out.length; k++) out[k]!.next = out[k + 1]!.pos;
  return out;
}

/** Adds what a read of [from, to) found. Timecodes only grow with the
 *  position, so anything that contradicts the clusters on either side is
 *  taken for Opus data that happens to look like one and left out. */
function learn(clusters: Map<number, Cluster>, found: Cluster[], from: number, to: number, size: number): void {
  const sorted = [...clusters.values()].sort((a, b) => a.pos - b.pos);
  const fits = (c: Cluster) => {
    const before = sorted.filter(x => x.pos < c.pos).pop();
    const after = sorted.find(x => x.pos > c.pos);
    return (!before || before.ms <= c.ms) && (!after || c.ms <= after.ms);
  };
  const kept = found.filter(c => clusters.has(c.pos) || fits(c)).map(c => ({ pos: c.pos, ms: c.ms } as Cluster));
  // Consecutive in the read, so each is followed by the next one kept.
  for (let k = 0; k + 1 < kept.length; k++) kept[k]!.next = kept[k + 1]!.pos;
  // The read covered everything up to `to`: the last cluster in it is followed
  // by the first one known at or past `to`, or by the end of the file.
  if (kept.length > 0) {
    const after = sorted.find(x => x.pos >= to);
    if (to >= size) kept[kept.length - 1]!.next = size;
    else if (after && after.pos === to) kept[kept.length - 1]!.next = to;
  }
  // A window starting on a known cluster and holding no other: nothing lies
  // between it and the next one.
  const at = clusters.get(from);
  if (at && kept.every(c => c.pos === from)) {
    const after = sorted.find(x => x.pos >= to);
    if (after?.pos === to) at.next = to;
  }
  for (const c of kept) {
    const k = clusters.get(c.pos);
    if (!k) clusters.set(c.pos, { ...c });
    else if (c.next !== undefined && k.next === undefined) k.next = c.next;
  }
}

/** Where `ms` should be, by interpolation between the clusters known on
 *  either side of it. */
function estimate(clusters: Map<number, Cluster>, ms: number, size: number): number {
  const sorted = [...clusters.values()].sort((a, b) => a.pos - b.pos);
  const hiIdx = sorted.findIndex(c => c.ms > ms);
  const lo = sorted[hiIdx === -1 ? sorted.length - 1 : Math.max(0, hiIdx - 1)]!;
  const first = sorted[0]!, last = sorted[sorted.length - 1]!;
  if (hiIdx === -1 || hiIdx === 0) {
    // Outside what is known: the recording's average rate.
    const rate = last.ms > first.ms ? (last.pos - first.pos) / (last.ms - first.ms) : 0;
    return Math.max(first.pos, Math.min(size, Math.round(lo.pos + (ms - lo.ms) * rate)));
  }
  const hi = sorted[hiIdx]!;
  return Math.round(lo.pos + (ms - lo.ms) / (hi.ms - lo.ms) * (hi.pos - lo.pos));
}

const EMPTY_CUES = new Uint8Array([0x1c, 0x53, 0xbb, 0x6b, 0x80]);
const TAIL_BYTES = 256 * 1024;
/** Each side of the estimated passage: about 16 s of a live recording. */
const WINDOW_SLACK = 256 * 1024;
const PROBE_BYTES = 128 * 1024;
const MAX_PROBES = 16;

async function webmPlan(read: RangeReader, rec: RemoteRecording, info: Known, from: number, to: number): Promise<Plan | null> {
  const first = clustersIn(info.head, 0)[0];
  if (!first) return null;
  let clusters = info.clusters;
  if (!clusters) {
    // The end of the file gives the last clusters, so every search is bracketed
    // by real timecodes — the analysis's duration counts recording time, and a
    // webm's timeline can run past it.
    clusters = new Map([[first.pos, first]]);
    const tailFrom = Math.max(first.pos, rec.bytes - TAIL_BYTES);
    learn(clusters, clustersIn(await read(tailFrom, rec.bytes), tailFrom), tailFrom, rec.bytes, rec.bytes);
    info.clusters = clusters;
  }

  // One window meant to hold the whole passage: in the usual case, the only
  // request this passage needs.
  const winFrom = Math.max(first.pos, estimate(clusters, from * 1000, rec.bytes) - WINDOW_SLACK);
  const winTo = Math.min(rec.bytes, estimate(clusters, to * 1000, rec.bytes) + WINDOW_SLACK);
  let window: { from: number; bytes: Uint8Array } | null = null;
  if (winTo > winFrom) {
    window = { from: winFrom, bytes: await read(winFrom, winTo) };
    learn(clusters, clustersIn(window.bytes, winFrom), winFrom, winTo, rec.bytes);
  }

  // Already bracketed by what the window found, these read nothing.
  const startCluster = await locate(read, clusters, from * 1000, rec.bytes);
  const endCluster = await locate(read, clusters, to * 1000, rec.bytes);
  if (!startCluster || !endCluster) return null;
  const bodyFrom = startCluster.pos, bodyTo = endCluster.next ?? rec.bytes;
  const body = window && bodyFrom >= window.from && bodyTo <= window.from + window.bytes.length
    ? window.bytes.subarray(bodyFrom - window.from, bodyTo - window.from)
    : await read(bodyFrom, bodyTo);
  // Closed by an empty Cues: a cluster of unknown size only ends where the
  // next top-level element begins, and without one mediabunny drops the last
  // cluster — up to 5 s off the end of the passage.
  return inMemory(info.head.slice(0, first.pos), body, EMPTY_CUES, 0);
}

/** The cluster holding `ms` — the last one starting at or before it — by
 *  interpolation between the clusters already seen, which only works because
 *  a timecode never goes back. Null when it cannot be pinned down. */
async function locate(read: RangeReader, clusters: Map<number, Cluster>, ms: number, size: number): Promise<Cluster | null> {
  let probe = PROBE_BYTES;
  for (let n = 0; n < MAX_PROBES; n++) {
    const sorted = [...clusters.values()].sort((a, b) => a.pos - b.pos);
    const hiIdx = sorted.findIndex(c => c.ms > ms);
    if (hiIdx === 0) return sorted[0]!;                    // before the first cluster
    const lo = sorted[hiIdx === -1 ? sorted.length - 1 : hiIdx - 1]!;
    if (hiIdx === -1 && lo.next === size) return lo;     // in the last cluster
    const hi = hiIdx === -1 ? { pos: size, ms: Infinity } : sorted[hiIdx]!;
    if (lo.next === hi.pos) return lo;

    // Close in time: read on from the cluster itself until its successor
    // shows. Far: aim where the timecodes say it should be.
    const est = hi.ms === Infinity || hi.ms - lo.ms <= 15_000
      ? lo.pos
      : Math.floor(lo.pos + (ms - lo.ms) / (hi.ms - lo.ms) * (hi.pos - lo.pos) - probe / 2);
    const winFrom = Math.max(lo.pos, est);
    const winTo = Math.min(hi.pos, winFrom + probe);
    const before = clusters.size, nextKnown = lo.next;
    learn(clusters, clustersIn(await read(winFrom, winTo), winFrom), winFrom, winTo, size);
    // Clusters larger than the window: widen rather than read the same bytes.
    if (clusters.size === before && lo.next === nextKnown) probe *= 2;
  }
  return null;
}

// ── MP3, constant bitrate only ───────────────────────────────────────────────

const MP3_KBPS_V1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const MP3_KBPS_V2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
const MP3_RATES: Record<number, number[]> = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };

/** Length of the layer III frame whose header starts at `i`, or 0 when there
 *  is none there. */
function mp3FrameLength(b: Uint8Array, i: number): number {
  if (b[i] !== 0xff || (b[i + 1]! & 0xe0) !== 0xe0 || ((b[i + 1]! >> 1) & 3) !== 1) return 0;
  const version = (b[i + 1]! >> 3) & 3;
  const kbps = (version === 3 ? MP3_KBPS_V1 : MP3_KBPS_V2)[b[i + 2]! >> 4];
  const rate = MP3_RATES[version]?.[(b[i + 2]! >> 2) & 3];
  if (!kbps || !rate) return 0;
  return Math.floor((version === 3 ? 144_000 : 72_000) * kbps / rate) + ((b[i + 2]! >> 1) & 1);
}

/** The first frame in `buf` — two headers in a row, the length of the first
 *  apart, so that a stray 0xFF in the audio data is not taken for one. */
function firstMp3Frame(buf: Uint8Array): number | null {
  for (let i = 0; i + 4 < buf.length; i++) {
    const len = mp3FrameLength(buf, i);
    if (len > 0 && i + len + 4 <= buf.length && mp3FrameLength(buf, i + len) > 0) return i;
  }
  return null;
}

async function mp3Plan(read: RangeReader, rec: RemoteRecording, head: Uint8Array, from: number, to: number): Promise<Plan | null> {
  let audioStart = 0;
  if (ascii(head, 0, 3) === 'ID3') {
    audioStart = 10 + ((head[6]! & 0x7f) << 21 | (head[7]! & 0x7f) << 14 | (head[8]! & 0x7f) << 7 | (head[9]! & 0x7f));
    if (head[5]! & 0x10) audioStart += 10;              // footer
  }
  if (audioStart + 4 > head.length) return null;
  const h1 = head[audioStart + 1]!, h2 = head[audioStart + 2]!;
  if (head[audioStart] !== 0xff || (h1 & 0xe0) !== 0xe0 || ((h1 >> 1) & 3) !== 1) return null;   // not layer III
  const kbps = ((h1 >> 3) & 3) === 3 ? MP3_KBPS_V1[h2 >> 4] : MP3_KBPS_V2[h2 >> 4];
  if (!kbps) return null;
  // A Xing or VBRI header means a variable bitrate. LAME writes "Info" in the
  // same place for a constant one.
  const firstFrame = ascii(head, audioStart, Math.min(256, head.length - audioStart));
  if (firstFrame.includes('Xing') || firstFrame.includes('VBRI')) return null;
  const byteRate = kbps * 125;
  // And the size must agree with it: a variable bitrate without a header, or
  // a duration that is not this file's, both show here.
  const expected = audioStart + rec.duration * byteRate;
  if (Math.abs(expected - rec.bytes) > rec.bytes * 0.03) return null;
  // The whole passage in one request; it starts on a frame boundary — a file
  // starting mid-frame is not recognised as an MP3 at all.
  const a = Math.min(rec.bytes, audioStart + Math.floor(from * byteRate));
  const b = Math.min(rec.bytes, audioStart + Math.ceil((to + 1) * byteRate));
  if (b <= a) return null;
  const bytes = await read(a, b);
  const at = firstMp3Frame(bytes);
  if (at === null) return null;
  return inMemory(NONE, bytes.subarray(at), NONE, (a + at - audioStart) / byteRate);
}

// ── WAV ──────────────────────────────────────────────────────────────────────

async function wavPlan(read: RangeReader, head: Uint8Array, from: number, to: number): Promise<Plan | null> {
  const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
  let byteRate = 0, blockAlign = 0, dataStart = -1, dataSize = 0;
  for (let p = 12; p + 8 <= head.length;) {
    const id = ascii(head, p, 4), size = view.getUint32(p + 4, true);
    if (id === 'fmt ' && p + 16 <= head.length) { byteRate = view.getUint32(p + 16, true); blockAlign = view.getUint16(p + 20, true); }
    if (id === 'data') { dataStart = p + 8; dataSize = size; break; }
    p += 8 + size + (size & 1);
  }
  if (dataStart < 0 || !byteRate || !blockAlign) return null;
  const at = (t: number) => dataStart + Math.min(dataSize, Math.floor(t * byteRate / blockAlign) * blockAlign);
  const a = at(from), b = at(to);
  if (b <= a) return null;
  // The header as it is, its two sizes made to describe just the passage.
  const prefix = head.slice(0, dataStart);
  const pv = new DataView(prefix.buffer);
  pv.setUint32(4, prefix.length - 8 + (b - a), true);
  pv.setUint32(dataStart - 4, b - a, true);
  return inMemory(prefix, await read(a, b), NONE, (a - dataStart) / byteRate);
}
