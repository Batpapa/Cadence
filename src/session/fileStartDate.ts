// ── When an imported recording started ───────────────────────────────────────
// A file carries no start time a browser will give out — no creation date,
// only `File.lastModified`. For a recorder's own file that is when the
// recording was WRITTEN, which is when it stopped: start = end − duration
// (user request, 2026-09-13). It used to start dateless instead, on the ground
// that a modification time survives transfers erratically — which is still
// true: a file that went through a messaging app or a download carries the
// time it arrived. So this is a starting value shown in the date field, to be
// corrected there, never a fact.

/** How close to "now" a modification time has to be to mean nothing. The File
 *  API tells a browser that does not know a file's modification time to report
 *  the current time instead — and a recording finished less than a minute
 *  before it was imported is far rarer than a browser that does not know. */
const UNKNOWN_IF_WITHIN_MS = 60_000;

/** ISO start of a recording from its file's modification time and its duration,
 *  or null when either says nothing: no duration, no modification time, one in
 *  the future, or one that is merely "now" (see UNKNOWN_IF_WITHIN_MS). */
export function fileStartDate(lastModifiedMs: number, durationS: number | null, nowMs: number): string | null {
  if (durationS === null || !(durationS > 0)) return null;
  if (!(lastModifiedMs > 0) || lastModifiedMs > nowMs) return null;
  if (nowMs - lastModifiedMs < UNKNOWN_IF_WITHIN_MS) return null;
  return new Date(lastModifiedMs - durationS * 1000).toISOString();
}
