// ── #17 background-recording diagnostics ─────────────────────────────────────
// Buffers visibility/AudioContext/wake-lock events with a wall-clock timestamp
// during a live session, so a phone test doesn't need a tethered devtools
// session to observe what actually happens when the screen locks — download
// the log from the summary screen afterwards instead.

export interface BgLogEntry { t: number; event: string }

export const bgLog: BgLogEntry[] = [];

export function logBg(event: string): void {
  bgLog.push({ t: Date.now(), event });
}

export function resetBgLog(): void {
  bgLog.length = 0;
}
