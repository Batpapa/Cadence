import { signal } from '@preact/signals';

// ── Keep the recordings (2026-11-04) ─────────────────────────────────────────
// Off, an analysis keeps its detections and nothing of its sound: a live
// recording still writes its chunks while it runs — they are what the bounds
// are put on the passes from — and they go at the stop, or at the recovery
// after a crash; an import stores nothing of the file. No Drive backup of a recording that will not be kept.
// Recordings already kept are not touched, and a re-analysis keeps the one it
// re-runs: it is no new recording.
//
// Per DEVICE, in localStorage (the user's call): a phone short of room and a
// computer that keeps everything are not the same choice.
//
// Absent = YES. Both values are written, and it is read only through
// `keepRecordings` — the same discipline as SYNC_AUDIO_BY_DEFAULT: a "no"
// stored as an absence would read back as a yes.

const KEY = 'cadence_keep_recordings';

export const KEEP_RECORDINGS_BY_DEFAULT = true;

function read(): boolean {
  try {
    const v = localStorage.getItem(KEY);
    return v === null ? KEEP_RECORDINGS_BY_DEFAULT : v === '1';
  } catch {
    return KEEP_RECORDINGS_BY_DEFAULT;
  }
}

/** Whether a recording made or imported from now on keeps its audio. A signal,
 *  so the settings and the live screen redraw when it is turned. */
export const keepRecordings = signal(read());

export function setKeepRecordings(on: boolean): void {
  keepRecordings.value = on;
  try { localStorage.setItem(KEY, on ? '1' : '0'); } catch { /* private mode: it lasts as long as the page */ }
}
