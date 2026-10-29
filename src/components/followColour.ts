import { MATCH_GOOD, MATCH_USABLE } from '../session/scoreFollow';

// ── The colour of an alignment's quality ─────────────────────────────────────
// One continuous scale for how well a score holds on a recording — the
// Play-along toggle's colour for the whole, the waveform's bar by bar
// (2026-10-29, the user: a gradient rather than three steps). Red up to a
// little below MATCH_USABLE, amber halfway to MATCH_GOOD, green from it on;
// mixed in between, in the theme's own three colours.

const RED_UNTIL = MATCH_USABLE - 0.1;
const AMBER_AT = (MATCH_USABLE + MATCH_GOOD) / 2;

/** Steps the scale is drawn in: finer would be invisible, and each step is a
 *  string a frame compares. */
const STEPS = 50;

/** `share` (0–1, the share of notes on the score) as a CSS colour. */
export function qualityColour(share: number): string {
  const s = Math.round(Math.min(1, Math.max(0, share)) * STEPS) / STEPS;
  if (s <= RED_UNTIL) return 'var(--color-danger)';
  if (s >= MATCH_GOOD) return 'var(--color-success)';
  const [from, to, p] = s < AMBER_AT
    ? ['var(--color-danger)', 'var(--color-warn)', (s - RED_UNTIL) / (AMBER_AT - RED_UNTIL)]
    : ['var(--color-warn)', 'var(--color-success)', (s - AMBER_AT) / (MATCH_GOOD - AMBER_AT)];
  return `color-mix(in oklab, ${to} ${Math.round(p * 100)}%, ${from})`;
}

/** `colour` at `alpha` (0–1), over whatever is behind it. */
export function faded(colour: string, alpha: number): string {
  return `color-mix(in srgb, ${colour} ${Math.round(alpha * 100)}%, transparent)`;
}
