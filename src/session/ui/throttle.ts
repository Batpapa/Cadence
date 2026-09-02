import { useEffect, useMemo, useRef } from 'preact/hooks';

// ── Coalescing a high-frequency callback down to a render budget ─────────────
// File import analyses faster than real time, and got faster again when the
// analysis window shrank to 10s (2026-09-02): the worker emits a window roughly
// every 60ms on a desktop, and both `onProgress` and `onAnnotations` fire on
// each one — so the import screen was re-rendering a dozen-plus times a second
// to move a progress bar a fraction of a pixel.
//
// Only the UI feed is throttled. The session orchestrators keep receiving and
// applying every single event exactly as before: their annotation map, their
// window array and their IndexedDB writes are untouched. Nothing about the
// RESULT changes, only how often the screen is asked to redraw it.
//
// Deliberately not requestAnimationFrame: rAF is ~60fps (the opposite of the
// problem) and stops firing entirely in a background tab, which is exactly
// where a long import is likely to be left running.
//
// NOT applied to the live screen, on purpose: live analysis is paced by the
// hop, so it emits one window every 5s — throttling there would only add up to
// 250ms of latency to a feed that is already 20x slower than the budget. Its
// chrono and VU meter, the only genuinely fast-moving things on that screen,
// already bypass rendering entirely by writing to the DOM through refs.

/** Renders per second for the analysis feeds. Fast enough that a progress bar
 *  and an appearing detection still feel immediate, slow enough that the cost
 *  is negligible whatever the machine. */
export const ANALYSIS_UI_FPS = 4;

export interface Throttled<A extends unknown[]> {
  /** Same signature as the wrapped function. */
  call: (...args: A) => void;
  /** Drops any pending trailing call. Safe to call more than once. */
  cancel: () => void;
}

/** Leading + trailing throttle.
 *
 *  The leading edge fires immediately, so the first update of a burst is never
 *  delayed. The trailing edge ALWAYS fires with the most recent arguments,
 *  which is what makes this safe for state feeds: whatever the timing, the last
 *  value a caller supplied does reach the callback, so the screen can never be
 *  left showing an intermediate state. Intermediate values within a window are
 *  dropped, never queued — the point is to skip them, and each one here is a
 *  complete snapshot rather than a delta.
 *
 *  Pure and framework-free so it can be unit tested with a fake clock; see
 *  `useThrottled` below for the hook that owns the cleanup. */
export function createThrottle<A extends unknown[]>(
  fn: (...args: A) => void,
  minIntervalMs: number,
  now: () => number = Date.now,
): Throttled<A> {
  let lastRun = -Infinity;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: A | null = null;

  const run = (args: A) => {
    lastRun = now();
    fn(...args);
  };

  return {
    call(...args: A) {
      const wait = minIntervalMs - (now() - lastRun);
      if (wait <= 0 && timer === null) { run(args); return; }
      // Inside the window: keep only the freshest arguments and make sure a
      // trailing call is scheduled for when the window closes.
      pending = args;
      if (timer !== null) return;
      timer = setTimeout(() => {
        timer = null;
        const next = pending;
        pending = null;
        if (next) run(next);
      }, Math.max(0, wait));
    },
    cancel() {
      if (timer !== null) { clearTimeout(timer); timer = null; }
      pending = null;
    },
  };
}

/** Hook wrapper: one throttle for the component's lifetime, pending call
 *  dropped on unmount (nobody is watching the screen any more, and firing a
 *  state setter into a torn-down tree buys nothing).
 *
 *  `fn` is read through a ref, so the throttle survives re-renders while still
 *  calling the latest closure — a fresh throttle per render would reset the
 *  window on every update and let everything through. */
export function useThrottled<A extends unknown[]>(fn: (...args: A) => void, fps = ANALYSIS_UI_FPS): (...args: A) => void {
  const ref = useRef(fn);
  ref.current = fn;
  const throttled = useMemo(
    () => createThrottle<A>((...args) => ref.current(...args), 1000 / fps),
    [fps],
  );
  useEffect(() => () => throttled.cancel(), [throttled]);
  return throttled.call;
}
