import { patchHead } from './webmDuration';

// ── Recordings damaged by WebKit's sliced-Blob bug — TEMPORARY ────────────────
// TO REMOVE on 2026-11-15 (decided 2026-10-18): by then every damaged recording
// still on a device has been opened, and so repaired, or never will be.
// Remove this file, its test, and in db.ts everything marked "webmSliceRepair":
// the repair in loadSessionAudio, `drivesToRepair` and repairDriveCopy.
//
// A repaired recording that is on Drive has its Drive copy put right too
// (db.ts's repairDriveCopy, 2026-10-19): that copy was sent from the damaged
// bytes, or is what another device downloaded them from, and would otherwise
// stay broken for good.
//
// Until the fix of 2026-10-18 (webmDuration.ts), a WebM recording was stored as
// its patched head followed by a SLICE of the original, and WebKit stores a
// slice without its start offset. Read back, such a recording is the patched
// head followed by the WHOLE original, its own head included: nothing plays it,
// and its Drive upload fails, or sent those very bytes. They are all there,
// though, so the recording can be rebuilt: the head, then the original past
// what the head replaced. Measured in Playwright WebKit (ios-lab/
// idb-repair-probe.mjs): the original follows the head byte for byte, and the
// rebuilt file is the one that should have been stored.
//
// Only a file that proves it is one of these is touched. The original found
// after the head must give back, patched again, exactly that head — every byte
// but those of the Duration value, which depends on a duration not known here.
// Anything else is left as it is.

const ID_EBML = [0x1a, 0x45, 0xdf, 0xa3];
/** Head and original head together are a few hundred bytes (a MediaRecorder
 *  Info is under a hundred): this is room to spare, read for every recording
 *  opened — some screens open one per session at once. */
export const PROBE_BYTES = 16 * 1024;

const MASK_DURATIONS = [Math.PI * 1e3, -Math.E * 1e5, Math.SQRT2 * 1e-20, Math.LN2 * 1e20];

const isEbmlAt =(b: Uint8Array, i: number) => ID_EBML.every((x, k) => b[i + k] === x);

/** Where the original starts, and how many of its bytes the head replaced —
 *  or null when `b` (the file's first bytes) is not a damaged recording. */
export function findDoubledHead(b: Uint8Array): { origAt: number; consumed: number } | null {
  if (!isEbmlAt(b, 0)) return null;
  for (let at = 4; at + 4 <= b.length; at++) {
    if (!isEbmlAt(b, at)) continue;
    const orig = b.subarray(at);
    // Patched with durations whose floats share no byte (sign, exponent and a
    // full mantissa all differ): the bytes where the heads differ are the
    // Duration value, and every other byte must be the head found.
    const heads = MASK_DURATIONS.map(d => patchHead(orig, d));
    const p = heads[0];
    if (!p || heads.some(h => !h || h.head.length !== at)) continue;
    let same = true;
    for (let i = 0; i < at && same; i++) {
      if (heads.some(h => h!.head[i] !== p.head[i])) continue;
      if (b[i] !== p.head[i]) same = false;
    }
    if (same) return { origAt: at, consumed: p.consumed };
  }
  return null;
}

/** The rebuilt recording, or null when `blob` is not a damaged one — the
 *  common case, which costs a read of its first bytes. The result is made of
 *  bytes, not slices, so it can be stored back. */
export async function repairDoubledWebm(blob: Blob): Promise<Blob | null> {
  // Only recordings were patched, and always as WebM: an imported MP3 or M4A
  // is not even read.
  if (blob.size < 8 || (blob.type && !blob.type.includes('webm'))) return null;
  const first = new Uint8Array(await blob.slice(0, PROBE_BYTES).arrayBuffer());
  if (!findDoubledHead(first)) return null;
  // Found again in the whole, which is what gets rebuilt.
  const all = new Uint8Array(await blob.arrayBuffer());
  const found = findDoubledHead(all.subarray(0, PROBE_BYTES));
  if (!found) return null;
  return new Blob([all.subarray(0, found.origAt), all.subarray(found.origAt + found.consumed)], { type: blob.type });
}
