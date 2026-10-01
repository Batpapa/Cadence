// Writes the duration into a WebM that MediaRecorder produced without one — so
// the file seeks, and players show its length — while touching only its first
// few kilobytes.
//
// Replaces fix-webm-duration (2026-10-01). That library reads the WHOLE file
// into an ArrayBuffer, rebuilds the Segment into a second one and the file into
// a third, then wraps the result in a new Blob: three to four copies of a
// recording held at once, at the one moment the phone is already under strain —
// stopping a live session, or recovering one after a crash. For three hours of
// audio that is several hundred megabytes of peak memory.
//
// What actually has to change sits at the very start: MediaRecorder writes the
// Segment with an UNKNOWN size and an Info element with no Duration. So the
// first bytes are read, a Duration is added to Info, and the result is the
// patched head followed by the rest of the ORIGINAL blob, sliced — a Blob made
// of slices of a disk-backed Blob copies nothing into memory.
//
// Inserting bytes into Info moves everything after it. Nothing in a
// MediaRecorder file points at those positions — there is no SeekHead and no
// Cues — and a file that has a SeekHead is left as it is rather than patched
// into one whose index lies. fix-webm-duration had the same blind spot (it
// never rewrote SeekHead either); this one refuses instead.

/** Enough for the EBML header, the Segment's own header, Info and Tracks, with
 *  room to spare: a MediaRecorder Info is under a hundred bytes. */
const HEAD_BYTES = 64 * 1024;

const ID_EBML = 0x1a45dfa3;
const ID_SEGMENT = 0x18538067;
const ID_INFO = 0x1549a966;
const ID_TIMECODESCALE = 0x2ad7b1;
const ID_DURATION = 0x4489;
const ID_VOID = 0xec;
const ID_CRC32 = 0xbf;

/** The duration-bearing file, or `blob` itself when there is nothing to do or
 *  the layout is not one this recognises — never a half-patched file. The
 *  audio is intact either way; only seeking and the displayed length suffer
 *  from a missing Duration. */
export async function patchWebmDuration(blob: Blob, durationMs: number): Promise<Blob> {
  if (!(durationMs > 0)) return blob;
  const head = new Uint8Array(await blob.slice(0, Math.min(blob.size, HEAD_BYTES)).arrayBuffer());
  const patched = patchHead(head, durationMs);
  if (!patched) return blob;
  return new Blob([patched.head, blob.slice(patched.consumed)], { type: blob.type });
}

interface Vint { value: number; length: number; unknown: boolean }

/** An EBML variable-length integer: the count of leading zeros in the first
 *  byte is the number of bytes that follow. As a SIZE the marker bit is
 *  dropped, and all value bits set means "unknown". As an ID it is kept. */
function readVint(b: Uint8Array, pos: number, keepMarker: boolean, maxLength: number): Vint | null {
  const first = b[pos];
  if (first === undefined || first === 0) return null;
  let length = 1;
  while (length <= 8 && !(first & (0x80 >> (length - 1)))) length++;
  if (length > maxLength || pos + length > b.length) return null;
  let value = keepMarker ? first : first & (0xff >> length);
  let allOnes = value === (0xff >> length);
  for (let i = 1; i < length; i++) {
    const byte = b[pos + i]!;
    value = value * 256 + byte;
    if (byte !== 0xff) allOnes = false;
  }
  return { value, length, unknown: !keepMarker && allOnes };
}

const readId = (b: Uint8Array, pos: number) => readVint(b, pos, true, 4);
const readSize = (b: Uint8Array, pos: number) => readVint(b, pos, false, 8);

/** `value` as a size VINT of exactly `length` bytes, or null if it does not
 *  fit (all value bits set is reserved for "unknown"). */
function encodeSize(value: number, length: number): Uint8Array | null {
  if (value >= 2 ** (7 * length) - 1) return null;
  const out = new Uint8Array(length);
  let v = value;
  for (let i = length - 1; i >= 0; i--) { out[i] = v % 256; v = Math.floor(v / 256); }
  out[0]! |= 0x80 >> (length - 1);
  return out;
}

/** Smallest encoding, never below `atLeast` — keeping a field its original
 *  width is the least surprising change to a file. */
function encodeSizeMin(value: number, atLeast: number): Uint8Array {
  for (let len = atLeast; len <= 8; len++) {
    const enc = encodeSize(value, len);
    if (enc) return enc;
  }
  throw new Error('size too large');
}

function readUint(b: Uint8Array, pos: number, length: number): number {
  let v = 0;
  for (let i = 0; i < length; i++) v = v * 256 + b[pos + i]!;
  return v;
}

function concat(parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

/** The patched head, and how many bytes of the original it replaces. Exported
 *  for the tests: this is the whole of the logic, on bytes alone. */
export function patchHead(b: Uint8Array, durationMs: number): { head: Uint8Array<ArrayBuffer>; consumed: number } | null {
  // EBML header — skipped whole.
  const ebmlId = readId(b, 0);
  if (!ebmlId || ebmlId.value !== ID_EBML) return null;
  const ebmlSize = readSize(b, ebmlId.length);
  if (!ebmlSize || ebmlSize.unknown) return null;
  const segStart = ebmlId.length + ebmlSize.length + ebmlSize.value;

  const segId = readId(b, segStart);
  if (!segId || segId.value !== ID_SEGMENT) return null;
  const segSizeAt = segStart + segId.length;
  const segSize = readSize(b, segSizeAt);
  if (!segSize) return null;
  const segDataStart = segSizeAt + segSize.length;

  // Info is the first Segment child that matters; Void and CRC-32 may precede
  // it. Anything else first — a SeekHead above all — and this is not a layout
  // it is safe to shift.
  let pos = segDataStart;
  for (;;) {
    const id = readId(b, pos);
    if (!id) return null;
    const size = readSize(b, pos + id.length);
    if (!size || size.unknown) return null;
    const dataStart = pos + id.length + size.length;
    const end = dataStart + size.value;
    if (id.value === ID_VOID || id.value === ID_CRC32) { pos = end; continue; }
    if (id.value !== ID_INFO) return null;           // SeekHead, Tracks, Cluster…
    if (end > b.length) return null;                 // Info not wholly read

    // Inside Info.
    let scale = 1_000_000;
    let durationAt = -1;
    let durationLen = 0;
    for (let p = dataStart; p < end;) {
      const cid = readId(b, p);
      if (!cid) return null;
      const csize = readSize(b, p + cid.length);
      if (!csize || csize.unknown) return null;
      const cdata = p + cid.length + csize.length;
      if (cid.value === ID_TIMECODESCALE) scale = readUint(b, cdata, csize.value) || 1_000_000;
      if (cid.value === ID_DURATION) { durationAt = cdata; durationLen = csize.value; }
      p = cdata + csize.value;
    }
    const ticks = durationMs * 1_000_000 / scale;

    if (durationAt >= 0) {
      // Present: only a zero or unreadable one is replaced, in place.
      const view = new DataView(b.buffer, b.byteOffset + durationAt, durationLen);
      const current = durationLen === 4 ? view.getFloat32(0) : durationLen === 8 ? view.getFloat64(0) : NaN;
      if (current > 0) return null;
      if (durationLen !== 4 && durationLen !== 8) return null;
      const head = b.slice(0, end);
      const out = new DataView(head.buffer, durationAt, durationLen);
      if (durationLen === 4) out.setFloat32(0, ticks); else out.setFloat64(0, ticks);
      return { head, consumed: end };
    }

    // Absent: Info gains an 8-byte float Duration.
    const duration = new Uint8Array(11);
    duration[0] = 0x44; duration[1] = 0x89; duration[2] = 0x88;   // id, size = 8
    new DataView(duration.buffer).setFloat64(3, ticks);
    const infoData = concat([b.subarray(dataStart, end), duration]);
    const infoSize = encodeSizeMin(infoData.length, size.length);
    const infoId = b.subarray(pos, pos + id.length);
    const grown = infoId.length + infoSize.length + infoData.length - (end - pos);

    // A Segment of unknown size stays unknown — which is what MediaRecorder
    // writes, and valid Matroska. A known one grows by what Info grew, in the
    // same width, or the file is left alone.
    let segSizeBytes = b.subarray(segSizeAt, segDataStart);
    if (!segSize.unknown) {
      const enc = encodeSize(segSize.value + grown, segSize.length);
      if (!enc) return null;
      segSizeBytes = enc;
    }
    const head = concat([
      b.subarray(0, segSizeAt), segSizeBytes, b.subarray(segDataStart, pos),
      infoId, infoSize, infoData,
    ]);
    return { head, consumed: end };
  }
}
