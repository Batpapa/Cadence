import { signal } from '@preact/signals';

// ── Experimental recognition (hidden) ────────────────────────────────────────
// (2026-11-26, the user: to be tried by two testers, hidden like the
// transcription.) File imports transcribe every window with cadence-transcriptor's
// note decoder instead of FolkFriend's, in the regime the hidden transcription
// writes ABC in (ffWorker.ts's analyzeWithTranscriptor; the measurements are in
// transcriptor.ts, recognitionContour). Live recording keeps FolkFriend: a window
// costs about twice as much.
//
// Switched on and off by five taps on the FolkFriend line of "About Cadence";
// the version line then says so, the only sign it is on. Per DEVICE, in
// localStorage, like the developer mode: a trial on this browser, not a setting
// that follows the user through Drive.

const LS_KEY = 'cadence_experimental_recognition';

function read(): boolean {
  try {
    return localStorage.getItem(LS_KEY) === '1';
  } catch {
    return false;
  }
}

export const experimentalRecognition = signal<boolean>(read());

export function toggleExperimentalRecognition(): void {
  const on = !experimentalRecognition.value;
  experimentalRecognition.value = on;
  try {
    // Absent rather than stored off, like the other device prefs.
    if (on) localStorage.setItem(LS_KEY, '1');
    else localStorage.removeItem(LS_KEY);
  } catch { /* private mode: it lasts as long as the page */ }
}
