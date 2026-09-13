import type { IAudioMetadata } from 'music-metadata';

// ── When a recording started, read from inside the file ───────────────────────
// A file's modification time is lost the moment it is sent anywhere; some
// formats carry the recording's own time inside them, and that survives a
// transfer. Read with music-metadata (2026-09-13, user decision) rather than a
// hand-written parser per format — loaded on demand, since only a file import
// needs it.
//
// Measured on every real recording on the dev machine (2026-09-13) before
// writing any of this:
//   - M4A/MP4 from phones: `mvhd` creation time is present, and it is the END
//     of the recording, in UTC. Two Samsung files named after their start time
//     land on it to the minute once the duration is taken off, and Android's
//     MPEG4Writer writes that box when the recording stops. Every long session
//     tried lands on the day in its file name. Treated the same whatever made
//     the file (user decision; iPhone not verified).
//   - Broadcast Wave (Zoom, Tascam…): OriginationDate/Time in `bext` is the
//     START, in the recorder's local time with no zone.
//   - MP3, WebM, and phone WAVs: nothing. ID3's year is an ALBUM's year and is
//     never a recording date, hence no date without a time is ever used.
//
// Cost on those files: at most 3.4 MB read out of 240 MB, under 80 ms.

/** What a parse offers about when the recording happened. */
export interface RecordingDateClues {
  /** MP4 `mvhd` creation time — music-metadata sets this from nothing else. */
  mp4CreationTime?: Date;
  /** Broadcast Wave `bext` origination date ("yyyy-mm-dd", any separator). */
  bextDate?: string;
  /** Broadcast Wave `bext` origination time ("hh:mm:ss", any separator). */
  bextTime?: string;
  /** A date tag (ID3 TDRC, ©day, Vorbis DATE, RIFF ICRD…) as written. */
  tagDate?: string;
}

/** Before this, a date is a zeroed field (MP4 writes 1904) or a clock that was
 *  never set — not a session anyone would be importing. */
const EARLIEST_MS = Date.UTC(1990, 0, 1);

/** The recording's start as ISO, from the first clue that holds up — or null.
 *  In order of how much each has been seen to mean: the MP4 header, then
 *  Broadcast Wave's origination stamp, then a date tag that carries a time. A
 *  date in the future, or before 1990, is no clue at all. */
export function recordingStartFrom(clues: RecordingDateClues, durationS: number | null, nowMs: number): string | null {
  const plausible = (ms: number) => Number.isFinite(ms) && ms >= EARLIEST_MS && ms <= nowMs;

  const end = clues.mp4CreationTime?.getTime();
  if (end !== undefined && durationS !== null && durationS > 0 && plausible(end)) {
    const start = end - durationS * 1000;
    if (plausible(start)) return new Date(start).toISOString();
  }

  const bext = localDateTime(clues.bextDate, clues.bextTime);
  if (bext !== null && plausible(bext)) return new Date(bext).toISOString();

  const tag = tagDateTime(clues.tagDate);
  if (tag !== null && plausible(tag)) return new Date(tag).toISOString();

  return null;
}

/** Broadcast Wave's two fixed-width fields, read as local time — the recorder's
 *  clock has no zone, and the device importing it is the best guess of one.
 *  The spec allows any separator. */
function localDateTime(date: string | undefined, time: string | undefined): number | null {
  const d = /^(\d{4})\D(\d{2})\D(\d{2})$/.exec(date?.trim() ?? '');
  const t = /^(\d{2})\D(\d{2})\D(\d{2})$/.exec(time?.trim() ?? '');
  if (!d || !t) return null;
  const [y, mo, da, h, mi, s] = [d[1], d[2], d[3], t[1], t[2], t[3]].map(Number) as [number, number, number, number, number, number];
  const at = new Date(y, mo - 1, da, h, mi, s);
  // The constructor rolls "13th month" over into the next year rather than
  // failing — a field it had to repair was not a real date.
  if (at.getFullYear() !== y || at.getMonth() !== mo - 1 || at.getDate() !== da || at.getHours() !== h || at.getMinutes() !== mi) return null;
  return at.getTime();
}

/** A date tag, only when it names a moment: a bare date, and above all a bare
 *  year, says when an album came out far more often than when a session was
 *  recorded. With a zone it is taken as written; without one, as local time. */
function tagDateTime(value: string | undefined): number | null {
  const v = value?.trim() ?? '';
  if (!/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(v)) return null;
  const ms = Date.parse(v.replace(' ', 'T'));
  return Number.isNaN(ms) ? null : ms;
}

/** The clues a music-metadata parse holds. */
export function cluesOf(md: IAudioMetadata): RecordingDateClues {
  const bext = (id: string) => {
    const value = md.native?.exif?.find(tag => tag.id === id)?.value;
    return typeof value === 'string' ? value : undefined;
  };
  return {
    mp4CreationTime: md.format.creationTime,
    bextDate: bext('bext.originationDate'),
    bextTime: bext('bext.originationTime'),
    tagDate: md.common.date,
  };
}

/** When the recording in `file` started, if the file itself says — null when it
 *  does not, and on any failure at all: this only ever improves a starting
 *  value, so it must never be the reason an import breaks (offline, the parser
 *  chunk itself may not load). `durationS` is the one already measured; the
 *  MP4 header's own is used when there is none. */
export async function readRecordingStart(file: Blob, durationS: number | null): Promise<string | null> {
  try {
    const { parseBlob } = await import('music-metadata');
    const md = await parseBlob(file, { duration: false, skipCovers: true });
    return recordingStartFrom(cluesOf(md), durationS ?? md.format.duration ?? null, Date.now());
  } catch {
    return null;
  }
}
