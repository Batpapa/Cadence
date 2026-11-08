// ── Pitch-class contours for display ──────────────────────────────────────────
// FolkFriend contour strings encode one char per note, mapped linearly over
// MIDI 48–95 (CONTOUR_TO_QUERY_CHAR in vendor ff_config.rs). The recognition
// engine returns pitch classes (see ffWorker.ts): one of the first twelve
// symbols per note, 'a' = C, 'b' = C#, … 'l' = B, with no octave. The
// manual transpositions this file held went with the engine they served
// (2026-11-07): the engine now looks in every key itself.

const CONTOUR_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUV';

/** A pitch-class contour placed where a fiddle or a whistle reads it, D4 up to
 *  C#5 (MIDI 62-73), for display only (contour_to_abc): left as is, the twelve
 *  symbols would sit in the octave below middle C. */
export function pitchClassesForDisplay(contour: string): string {
  let out = '';
  for (const ch of contour) {
    const idx = CONTOUR_CHARS.indexOf(ch);
    if (idx === -1 || idx >= 12) continue;
    const midi = 62 + ((idx - 2 + 12) % 12); // MIDI 48 + idx is the class; D = 2
    out += CONTOUR_CHARS[midi - 48];
  }
  return out;
}
