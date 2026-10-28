// ── Where the bubble goes when there is no room beside the lit element ───────
// driver.js places the bubble on a side of the lit element where it fits
// whole. When none does — a dialog that fills a phone screen, a form taller
// than half of it — it falls back to the bottom of the screen, centred, OVER
// whatever is there. On a phone that is a dialog's own buttons: the bubble sat
// on « Créer », the step waited for a press on it, and the walkthrough could
// not go on (2026-10-27, group feedback).
//
// So the place is decided from what the step needs to stay in reach: the
// lit element's controls when the step has the user act, the lit element
// itself otherwise. The bubble goes to the top or bottom of the screen, or in
// a free band between those controls, wherever it covers the least of them —
// nearest to where driver.js had put it when several are clear.
//
// Pure, and in window pixels throughout: every rect comes from
// getBoundingClientRect, and the bubble is zoomed back to 1 (engine.ts).

export interface Rect { top: number; bottom: number; left: number; right: number }

export interface Viewport {
  width: number;
  height: number;
  /** The safe area — under a phone's status bar and above its gesture bar. */
  insetTop: number;
  insetBottom: number;
}

const MARGIN = 10;

function overlap(a: Rect, b: Rect): number {
  const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
  const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  return w > 0 && h > 0 ? w * h : 0;
}

const covered = (bubble: Rect, keep: Rect[]) => keep.reduce((sum, k) => sum + overlap(bubble, k), 0);

/** Where the bubble's top should be, or null to leave driver.js's place
 *  alone — which is whenever that place covers none of `keep`, or nothing
 *  better can be found. The bubble is then centred across the screen. */
export function bubbleTop(bubble: Rect, keep: Rect[], view: Viewport): number | null {
  const here = covered(bubble, keep);
  if (here === 0) return null;
  const h = bubble.bottom - bubble.top;
  const w = bubble.right - bubble.left;
  const left = (view.width - w) / 2;
  const lo = view.insetTop + MARGIN;
  const hi = view.height - view.insetBottom - MARGIN - h;
  if (hi < lo) return null;

  // The two edges, and both sides of each control: every free band between
  // them starts or ends at one of these.
  const candidates = [lo, hi];
  for (const k of keep) candidates.push(k.bottom + MARGIN, k.top - MARGIN - h);

  let best: number | null = null;
  let bestCover = here;
  for (const raw of candidates) {
    const top = Math.max(lo, Math.min(hi, raw));
    const c = covered({ top, bottom: top + h, left, right: left + w }, keep);
    if (c < bestCover || (c === bestCover && best !== null && Math.abs(top - bubble.top) < Math.abs(best - bubble.top))) {
      best = top;
      bestCover = c;
    }
  }
  return best;
}
