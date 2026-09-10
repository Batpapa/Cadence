import type { Analysis, Detection } from '../model';

// ── Searching the session library ────────────────────────────────────────────
// A leaf on purpose: the rule below is the only part of the search with a
// decision in it, and keeping it out of SessionLibrary.tsx is what lets it be
// tested at all — that component reaches the store, which reaches the Drive
// client, which reads localStorage the moment it is imported.

/** Whether searching covers the detected tunes, not just session names.
 *
 *  Off by default, and per device rather than per user: it changes what a
 *  keystroke costs — with it on, every session's whole detection list is
 *  scanned — and it is the kind of switch someone leaves as they found it.
 *  localStorage, so it survives a reload without travelling to other devices
 *  in the synced blob. */
const SEARCH_TUNES_KEY = 'cadence_sessions_search_tunes';

export function readSearchTunes(): boolean {
  try { return localStorage.getItem(SEARCH_TUNES_KEY) === '1'; } catch { return false; }
}

export function writeSearchTunes(on: boolean): void {
  // Both values written, never a delete: absence keeps meaning "off", and a
  // stored '0' says the user has been here and said no.
  try { localStorage.setItem(SEARCH_TUNES_KEY, on ? '1' : '0'); } catch { /* private mode */ }
}

/** The detections of one session matching `q`, in the order they were played.
 *
 *  One entry per DETECTION, not per tune: the same reel recognised twice in an
 *  evening is two moments in the recording and two different places to land,
 *  exactly as the card view's "Detected in" panel already treats them.
 *
 *  Matches a tune's displayed name by substring, or its TheSession id exactly
 *  — bare ("1197") and as a card stores it ("thesession:1197"), so a number
 *  copied from either place finds the same sessions. No fuzziness anywhere: a
 *  hit nobody can explain is worse than a miss they can retype.
 *
 *  `q` is expected already trimmed and lowercased, as the search box hands it
 *  over — done once per keystroke rather than once per detection. */
export function matchingDetections(session: Analysis, q: string): Detection[] {
  if (!q) return [];
  return session.annotations
    .filter(ann =>
      ann.displayName.toLowerCase().includes(q)
      || ann.tuneId.toLowerCase() === q
      || `thesession:${ann.tuneId}`.toLowerCase() === q)
    .sort((a, b) => a.start - b.start);
}
