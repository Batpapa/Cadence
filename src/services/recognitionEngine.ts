import { signal } from '@preact/signals';
import type { RecognitionEngineId } from '../session/recognition/windowEngine';

// ── Which decoder hears the recognition's windows (hidden switch) ─────────────
// (2026-11-26) transcriptor/'s note decoder by default, everywhere — imports,
// live, the TheSession widget (session/recognition/transcriptorEngine.ts, and
// windowEngine.ts for the two engines). FolkFriend's own decoder, which
// recognised until then, stays one switch away to compare with
// (folkfriendEngine.ts) — the user: "garde sous la main la capacité de comparer".
//
// Switched on and off by five taps on the FolkFriend line of "About Cadence";
// the version line then says so, the only sign it is on. Per DEVICE, in
// localStorage, like the developer mode: a comparison on this browser, not a
// setting that follows the user through Drive.

const LS_KEY = 'cadence_folkfriend_decoder';
/** The earlier switch (2026-11-26, a few hours): it asked for the transcriptor,
 *  which is now the default — dropped when met. */
const OLD_KEY = 'cadence_experimental_recognition';

function read(): boolean {
  try {
    localStorage.removeItem(OLD_KEY);
    return localStorage.getItem(LS_KEY) === '1';
  } catch {
    return false;
  }
}

/** FolkFriend's decoder asked for, to compare with. */
export const folkfriendDecoder = signal<boolean>(read());

export function toggleFolkFriendDecoder(): void {
  const on = !folkfriendDecoder.value;
  folkfriendDecoder.value = on;
  try {
    // Absent rather than stored off, like the other device prefs.
    if (on) localStorage.setItem(LS_KEY, '1');
    else localStorage.removeItem(LS_KEY);
  } catch { /* private mode: it lasts as long as the page */ }
}

/** The engine a recognition starts with on this device. */
export function recognitionEngine(): RecognitionEngineId {
  return folkfriendDecoder.value ? 'folkfriend' : 'transcriptor';
}
