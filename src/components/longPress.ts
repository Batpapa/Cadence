import { useRef } from 'preact/hooks';

// ── Long-press gesture detection ─────────────────────────────────────────────
// Shared touch-timer primitive: fires `onLongPress` once a touch holds still
// for `ms` without moving past `moveTolerance` px. `createLongPressHandlers`
// is a plain function (calls no hooks itself) so it can be invoked once per
// row inside a list's `.map()` — a real hook can't be, since the Rules of
// Hooks forbid calling hooks a variable number of times. `useLongPress` is a
// thin hook wrapper around it for the common single-trigger-element case
// (e.g. useContextMenu). Same gesture, different things done with it per
// caller — not a full "long-press menu" component, just the raw detection.

const DEFAULT_MS = 550;
const DEFAULT_MOVE_TOLERANCE = 10;

export interface LongPressRefs {
  timer: { current: ReturnType<typeof setTimeout> | null };
  start: { current: { x: number; y: number } | null };
  fired: { current: boolean };
}

export interface LongPressOptions {
  ms?: number;
  moveTolerance?: number;
}

export function createLongPressHandlers(
  refs: LongPressRefs,
  onLongPress: (clientX: number, clientY: number) => void,
  opts: LongPressOptions = {},
) {
  const ms = opts.ms ?? DEFAULT_MS;
  const moveTolerance = opts.moveTolerance ?? DEFAULT_MOVE_TOLERANCE;

  const clear = () => { if (refs.timer.current) { clearTimeout(refs.timer.current); refs.timer.current = null; } };

  return {
    // Marks the element for styles.css: on iOS, a long press is also the
    // system's own gesture — it selects the word under the finger, or opens a
    // link's preview — and it came first, the app's menu opening behind it.
    'data-long-press': '',
    onTouchStart: (e: TouchEvent) => {
      refs.fired.current = false;
      const touch = e.touches[0];
      if (!touch) return;
      refs.start.current = { x: touch.clientX, y: touch.clientY };
      const { clientX, clientY } = touch;
      refs.timer.current = setTimeout(() => { refs.fired.current = true; onLongPress(clientX, clientY); }, ms);
    },
    onTouchMove: (e: TouchEvent) => {
      const touch = e.touches[0];
      if (!touch || !refs.start.current) return;
      const dx = touch.clientX - refs.start.current.x;
      const dy = touch.clientY - refs.start.current.y;
      if (Math.hypot(dx, dy) > moveTolerance) clear();
    },
    // The system taking the touch over (a scroll, the edge-swipe back): the
    // timer would otherwise still fire, under a finger long gone.
    onTouchCancel: clear,
    onTouchEnd: (e: TouchEvent) => {
      clear();
      // Suppress the synthetic click / native follow-up a touch release
      // would otherwise fire, once a long-press has already acted on it.
      if (refs.fired.current) e.preventDefault();
    },
  };
}

/** The same gesture on an element built by hand (no Preact), with the right
 *  click as its mouse form: `onPress` once per gesture, whichever way the
 *  browser reports it. A touch held reports itself twice on Android — a
 *  `contextmenu` as well as the hold this times — and only as the hold on
 *  iOS, which has no contextmenu for it: the two are one gesture, done once,
 *  the second ignored until the next touch. (The score viewer's audio sync
 *  told them apart by 800 ms between the two until 2026-11-26.) `enabled` is
 *  read at each press. Returns whether a click is the release of a hold that
 *  has done its work, which the caller then ignores — true once. */
export function bindLongPress(el: HTMLElement, onPress: () => void, enabled: () => boolean = () => true): () => boolean {
  let timer = 0;
  /** The last press was a touch, not the mouse. */
  let touch = false;
  /** That touch's gesture has done its work. */
  let fired = false;
  /** Its release is still to come as a click. */
  let swallowClick = false;
  const fire = (): void => {
    window.clearTimeout(timer);
    if (fired) return;
    fired = true;
    onPress();
  };
  // Its own callout and text selection kept off the element (iOS).
  el.style.setProperty('-webkit-touch-callout', 'none');
  el.style.userSelect = 'none';
  el.addEventListener('pointerdown', (e) => {
    window.clearTimeout(timer);
    touch = e.pointerType !== 'mouse';
    fired = false;
    swallowClick = false;
    if (!touch || !enabled()) return;
    timer = window.setTimeout(() => { swallowClick = true; fire(); }, DEFAULT_MS);
  });
  for (const end of ['pointerup', 'pointercancel', 'pointerleave'] as const) {
    el.addEventListener(end, () => window.clearTimeout(timer));
  }
  el.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (!enabled()) return;
    if (touch) fire();
    else onPress();
  });
  return () => {
    const swallow = swallowClick;
    swallowClick = false;
    return swallow;
  };
}

export function useLongPress(onLongPress: (clientX: number, clientY: number) => void, opts?: LongPressOptions) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  const fired = useRef(false);
  return { ...createLongPressHandlers({ timer, start, fired }, onLongPress, opts), firedRef: fired };
}
