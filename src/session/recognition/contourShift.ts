// ── Contour transposition ─────────────────────────────────────────────────────
// FolkFriend contour strings encode one char per note, mapped linearly over
// MIDI 48–95 (CONTOUR_TO_QUERY_CHAR in vendor ff_config.rs). The index query
// matches in absolute pitch space with no transposition invariance, so
// transposing a contour = shifting each char through this table.

const CONTOUR_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUV';

/** Transpose a contour by `semitones`. Notes leaving the supported MIDI range
 *  (and any unexpected characters) are dropped rather than clamped — a few
 *  missing notes cost less to the alignment than false ones. */
export function shiftContour(contour: string, semitones: number): string {
  let out = '';
  for (const ch of contour) {
    const idx = CONTOUR_CHARS.indexOf(ch);
    if (idx === -1) continue;
    const shifted = idx + semitones;
    if (shifted >= 0 && shifted < CONTOUR_CHARS.length) out += CONTOUR_CHARS[shifted];
  }
  return out;
}
