// ── Minimal ZIP writer (STORE only, no compression) ─────────────────────────
// Exists for the recovery screen's "download all session audio" button: the
// entries are already-compressed audio (webm/opus, mp3…), so deflate would buy
// nothing, and a ~80-line STORE writer beats shipping a zip library in the
// main bundle (recovery lives in main.ts, so it would weigh on every boot).
// Pure Uint8Array in/out — unit-testable in node, Blob handling stays with the
// caller.

export interface ZipEntry {
  /** Path inside the archive; UTF-8 (flag bit 11 is set for every entry). */
  name: string;
  data: Uint8Array;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** One more piece into a running CRC: start from 0xffffffff, finish with `^ 0xffffffff`. */
function crcUpdate(c: number, data: Uint8Array): number {
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]!) & 0xff]! ^ (c >>> 8);
  return c;
}

function crc32(data: Uint8Array): number {
  return (crcUpdate(0xffffffff, data) ^ 0xffffffff) >>> 0;
}

/** MS-DOS date/time pair, as the ZIP format wants it. */
function dosDateTime(d: Date): { time: number; date: number } {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

export function buildZip(entries: ZipEntry[], now: Date = new Date()): Uint8Array<ArrayBuffer> {
  const enc = new TextEncoder();
  const { time, date } = dosDateTime(now);
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = enc.encode(entry.name);
    const crc = crc32(entry.data);

    const local = new Uint8Array(30 + name.length + entry.data.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);       // local file header signature
    lv.setUint16(4, 20, true);               // version needed
    lv.setUint16(6, 0x0800, true);           // flags: UTF-8 names
    lv.setUint16(8, 0, true);                // method: STORE
    lv.setUint16(10, time, true);
    lv.setUint16(12, date, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, entry.data.length, true);  // compressed size (= raw: STORE)
    lv.setUint32(22, entry.data.length, true);  // uncompressed size
    lv.setUint16(26, name.length, true);
    lv.setUint16(28, 0, true);               // extra length
    local.set(name, 30);
    local.set(entry.data, 30 + name.length);
    locals.push(local);

    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);       // central directory signature
    cv.setUint16(4, 20, true);               // version made by
    cv.setUint16(6, 20, true);               // version needed
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, time, true);
    cv.setUint16(14, date, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, entry.data.length, true);
    cv.setUint32(24, entry.data.length, true);
    cv.setUint16(28, name.length, true);
    // extra/comment/disk/attrs all zero (30..41)
    cv.setUint32(42, offset, true);          // local header offset
    central.set(name, 46);
    centrals.push(central);

    offset += local.length;
  }

  const cdSize = centrals.reduce((n, c) => n + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);         // end of central directory
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);            // central directory offset

  const total = offset + cdSize + eocd.length;
  const out = new Uint8Array(total);
  let pos = 0;
  for (const part of [...locals, ...centrals, eocd]) { out.set(part, pos); pos += part.length; }
  return out;
}

/** "audio/webm;codecs=opus" → "webm" — extension for an audio blob's mime. */
// ── Reader ───────────────────────────────────────────────────────────────────
// Added 2026-09-10 for the full backup (.cdbf), which is a zip so that the
// audio travels as files rather than as base64 inside the JSON: base64 costs
// 33% and, worse, has to exist as ONE JavaScript string, which throws outright
// past roughly half a gigabyte. The share format (.cds) does embed base64 and
// is capped at 70 MB for exactly that reason.
//
// Reads the central directory rather than scanning for local headers: it is
// the only authoritative list of what an archive contains, and a local header
// may legitimately defer its sizes to a data descriptor it does not carry.
//
// STORE only. This reads back what buildZip wrote, and buildZip never
// compresses because the payload is already-compressed audio. Anything
// deflated is refused by name rather than silently skipped — a backup that
// quietly restores nine files out of ten is worse than one that fails.

export interface ZipReadEntry { name: string; data: Uint8Array }

const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;

export function readZip(buf: Uint8Array): ZipReadEntry[] {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const dec = new TextDecoder();

  // The end-of-central-directory record sits last, but a trailing comment may
  // follow it, so it is searched for backwards over the 64 KB it can hide in.
  let eocd = -1;
  const from = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= from; i--) {
    if (view.getUint32(i, true) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not_a_zip');

  const count = view.getUint16(eocd + 10, true);
  let pos = view.getUint32(eocd + 16, true);

  const out: ZipReadEntry[] = [];
  for (let i = 0; i < count; i++) {
    if (view.getUint32(pos, true) !== CENTRAL_SIG) throw new Error('zip_central_corrupt');
    const method = view.getUint16(pos + 10, true);
    const size = view.getUint32(pos + 24, true);
    const nameLen = view.getUint16(pos + 28, true);
    const extraLen = view.getUint16(pos + 30, true);
    const commentLen = view.getUint16(pos + 32, true);
    const localOff = view.getUint32(pos + 42, true);
    const name = dec.decode(buf.subarray(pos + 46, pos + 46 + nameLen));
    if (method !== 0) throw new Error('zip_compressed_unsupported:' + name);

    // The local header repeats the name and carries its own extra field, whose
    // length routinely differs from the central one — so the data offset has
    // to be computed from the LOCAL header, never from the central copy.
    const lNameLen = view.getUint16(localOff + 26, true);
    const lExtraLen = view.getUint16(localOff + 28, true);
    const start = localOff + 30 + lNameLen + lExtraLen;
    out.push({ name, data: buf.subarray(start, start + size) });

    pos += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

// ── Blob writer and reader (2026-11-15) ──────────────────────────────────────
// The same STORE archive, never held whole. The writer reads each entry once,
// in pieces, for its CRC, and hands back a Blob OF the entries' Blobs — a
// 3-hour recording is pointed at, not copied. The reader takes the central
// directory from the end of the file and gives entries that are read only
// when asked for. Cadence's own files are all made this way: .cds, .cdc, .cdb,
// .cdbf. buildZip/readZip above remain for the small, in-memory archives
// (clips, the recovery screen).
//
// ZIP32: no entry, and no archive, past 4 GiB. Nothing Cadence writes comes
// near it except a full backup, which says so before it starts.

export const ZIP32_MAX_BYTES = 0xffffffff;
/** Read in pieces this large: for the CRC, and when an entry is copied out. */
const PIECE_BYTES = 8 * 1024 * 1024;
const LOCAL_SIG = 0x04034b50;

export interface ZipBlobEntry {
  name: string;
  data: Blob | Uint8Array<ArrayBuffer> | string;
}

/** The size the archive of these entries will have — known before any of it
 *  is read (the share window weighs a package against the server's room). */
export function zipSize(entries: Array<{ name: string; bytes: number }>): number {
  const enc = new TextEncoder();
  let total = 22;
  for (const e of entries) total += 30 + 46 + 2 * enc.encode(e.name).length + e.bytes;
  return total;
}

async function crc32Blob(blob: Blob): Promise<number> {
  let c = 0xffffffff;
  for (let at = 0; at < blob.size; at += PIECE_BYTES) {
    c = crcUpdate(c, new Uint8Array(await blob.slice(at, at + PIECE_BYTES).arrayBuffer()));
  }
  return (c ^ 0xffffffff) >>> 0;
}

export async function buildZipBlob(entries: ZipBlobEntry[], now: Date = new Date()): Promise<Blob> {
  const enc = new TextEncoder();
  const { time, date } = dosDateTime(now);
  const parts: BlobPart[] = [];
  const centrals: Uint8Array<ArrayBuffer>[] = [];
  let offset = 0;
  if (entries.length > 0xffff) throw new Error('zip_too_many_entries');

  for (const entry of entries) {
    const data = typeof entry.data === 'string' ? enc.encode(entry.data) : entry.data;
    const size = data instanceof Blob ? data.size : data.length;
    const crc = data instanceof Blob ? await crc32Blob(data) : crc32(data);
    const name = enc.encode(entry.name);
    if (offset + 30 + name.length + size > ZIP32_MAX_BYTES) throw new Error('zip_too_large');

    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, LOCAL_SIG, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x0800, true);
    lv.setUint16(8, 0, true);
    lv.setUint16(10, time, true);
    lv.setUint16(12, date, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, size, true);
    lv.setUint32(22, size, true);
    lv.setUint16(26, name.length, true);
    lv.setUint16(28, 0, true);
    local.set(name, 30);
    parts.push(local, data);

    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, CENTRAL_SIG, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, time, true);
    cv.setUint16(14, date, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, size, true);
    cv.setUint32(24, size, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    central.set(name, 46);
    centrals.push(central);

    offset += local.length + size;
  }

  const cdSize = centrals.reduce((n, c) => n + c.length, 0);
  if (offset + cdSize + 22 > ZIP32_MAX_BYTES) throw new Error('zip_too_large');
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, EOCD_SIG, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);
  return new Blob([...parts, ...centrals, eocd], { type: 'application/octet-stream' });
}

/** One entry of an archive read by readZipBlob — nothing of it read yet. */
export interface ZipBlobItem {
  name: string;
  size: number;
  text(): Promise<string>;
  /** The entry's bytes as a Blob of their OWN, copied in pieces. Never a slice
   *  of the archive: WebKit stores a sliced Blob in IndexedDB without its
   *  offset (the bytes come back from the start of the source — 2026-10-18),
   *  and what is read out of an archive mostly goes there. */
  copy(type?: string): Promise<Blob>;
}

/** Whether a file is one of these archives (rather than an older JSON one). */
export async function isZipBlob(blob: Blob): Promise<boolean> {
  if (blob.size < 4) return false;
  return new DataView(await blob.slice(0, 4).arrayBuffer()).getUint32(0, true) === LOCAL_SIG;
}

export async function readZipBlob(blob: Blob): Promise<ZipBlobItem[]> {
  const tailFrom = Math.max(0, blob.size - 22 - 0xffff);
  const tail = new Uint8Array(await blob.slice(tailFrom).arrayBuffer());
  const tv = new DataView(tail.buffer);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tv.getUint32(i, true) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not_a_zip');

  const count = tv.getUint16(eocd + 10, true);
  const cdSize = tv.getUint32(eocd + 12, true);
  const cdOffset = tv.getUint32(eocd + 16, true);
  const cd = new Uint8Array(await blob.slice(cdOffset, cdOffset + cdSize).arrayBuffer());
  const view = new DataView(cd.buffer);
  const dec = new TextDecoder();

  const out: ZipBlobItem[] = [];
  let pos = 0;
  for (let i = 0; i < count; i++) {
    if (pos + 46 > cd.length || view.getUint32(pos, true) !== CENTRAL_SIG) throw new Error('zip_central_corrupt');
    const method = view.getUint16(pos + 10, true);
    const size = view.getUint32(pos + 24, true);
    const nameLen = view.getUint16(pos + 28, true);
    const extraLen = view.getUint16(pos + 30, true);
    const commentLen = view.getUint16(pos + 32, true);
    const localOff = view.getUint32(pos + 42, true);
    const name = dec.decode(cd.subarray(pos + 46, pos + 46 + nameLen));
    if (method !== 0) throw new Error('zip_compressed_unsupported:' + name);
    pos += 46 + nameLen + extraLen + commentLen;

    // Same rule as readZip: the data starts after the LOCAL header's own name
    // and extra field, read only when the entry is.
    const start = async () => {
      const lv = new DataView(await blob.slice(localOff, localOff + 30).arrayBuffer());
      if (lv.byteLength < 30 || lv.getUint32(0, true) !== LOCAL_SIG) throw new Error('zip_local_corrupt:' + name);
      const begin = localOff + 30 + lv.getUint16(26, true) + lv.getUint16(28, true);
      if (begin + size > blob.size) throw new Error('zip_truncated:' + name);
      return begin;
    };
    out.push({
      name,
      size,
      text: async () => { const at = await start(); return blob.slice(at, at + size).text(); },
      copy: async (type?: string) => {
        const at = await start();
        const pieces: Uint8Array<ArrayBuffer>[] = [];
        for (let p = at; p < at + size; p += PIECE_BYTES) {
          pieces.push(new Uint8Array(await blob.slice(p, Math.min(p + PIECE_BYTES, at + size)).arrayBuffer()));
        }
        return new Blob(pieces, type ? { type } : {});
      },
    });
  }
  return out;
}

export function audioExtension(mime: string | undefined): string {
  const base = (mime ?? '').split(';')[0]!.trim().toLowerCase();
  const map: Record<string, string> = {
    'audio/webm': 'webm', 'video/webm': 'webm',
    'audio/ogg': 'ogg', 'application/ogg': 'ogg',
    'audio/mpeg': 'mp3', 'audio/mp3': 'mp3',
    'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/aac': 'aac',
    'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/flac': 'flac',
  };
  return map[base] ?? 'bin';
}
