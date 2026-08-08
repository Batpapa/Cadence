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
    onTouchEnd: (e: TouchEvent) => {
      clear();
      // Suppress the synthetic click / native follow-up a touch release
      // would otherwise fire, once a long-press has already acted on it.
      if (refs.fired.current) e.preventDefault();
    },
  };
}

export function useLongPress(onLongPress: (clientX: number, clientY: number) => void, opts?: LongPressOptions) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  const fired = useRef(false);
  return { ...createLongPressHandlers({ timer, start, fired }, onLongPress, opts), firedRef: fired };
}
