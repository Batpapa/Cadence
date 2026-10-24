import { signal } from '@preact/signals';

// ── Developer mode ───────────────────────────────────────────────────────────
// What only the person debugging Cadence needs: today, the raw dump of a
// recognition's windows under an analysis. It used to be shown to everyone
// after an import, and a first-time user from TheSession (2026-10-23) clicked
// it looking for the list of tunes, and got a JSON file they could not read.
//
// Switched on and off by seven taps on the version line of "About Cadence" —
// the Android convention for its own developer options, and a gesture nobody
// makes by accident. Like the way into the recovery screen, it is meant to be
// talked through, not found.
//
// Per DEVICE, in localStorage: it is the browser being debugged that wants it,
// not every device of that user through Drive.

const LS_KEY = 'cadence_dev_mode';

function read(): boolean {
  try {
    return localStorage.getItem(LS_KEY) === '1';
  } catch {
    return false;
  }
}

export const devMode = signal<boolean>(read());

export function toggleDevMode(): void {
  const on = !devMode.value;
  devMode.value = on;
  try {
    // Absent rather than stored off, like the other device prefs.
    if (on) localStorage.setItem(LS_KEY, '1');
    else localStorage.removeItem(LS_KEY);
  } catch { /* private mode: it lasts as long as the page */ }
}
