import { useEffect, useRef } from 'preact/hooks';
import type { RefObject } from 'preact';
import { anyOverlayOpen } from './overlayStack';
import { touchDragActive } from '../utils';

// ── The drawer under a finger (2026-11-18) ───────────────────────────────────
// Where the side panel is a drawer (the narrow layout), it opens with a swipe
// to the right from the left edge, and closes with one to the left — on the
// drawer or on the shade beside it — as in most phone apps (asked by the group,
// 11-11). It follows the finger; let go past a third of its width, or with a
// flick, and it finishes the move, else it goes back.
//
// What it must leave alone:
//  • a mostly vertical swipe: that is the page scrolling;
//  • an open dialog or menu (overlayStack), and a long-press drag in progress
//    (touchDragActive) — that finger belongs to them;
//  • a field, a slider, and anything that scrolls sideways and still can —
//    a swipe there is theirs.
// The very edge belongs to the system on Android with gesture navigation (its
// Back) and to Safari's tab history on iOS: a touch starting there never
// reaches the page, or is cancelled once the system claims it — hence a zone
// wider than the system's, and a cancel that puts the drawer back.

/** Off for now (2026-11-19): too awkward to use as it stands, to be reworked.
 *  Everything else stays wired; true turns the gesture back on. */
const DRAWER_SWIPE_ENABLED = false;

/** How far from the left edge an opening swipe may start, in the touch's
 *  pixels. Measured on the Android 17 emulator, gesture navigation
 *  (2026-11-18): a swipe starting 23 px in is the system's Back (the app went
 *  to the background), one starting 36 px in reaches the page. With 40 px,
 *  that left a strip about 16 px wide — under a thumb's width — so 64. */
const EDGE_PX = 64;
/** Movement before the swipe is read as one direction or the other. */
const DECIDE_PX = 10;
/** How much more horizontal than vertical a swipe must be to be the drawer's. */
const HORIZONTAL_RATIO = 1.5;
/** A release this fast (px/ms) finishes the move, however short. */
const FLICK_SPEED = 0.4;

function startsInSomethingElse(target: EventTarget | null, opening: boolean): boolean {
  for (let el = target instanceof Element ? target : null; el; el = el.parentElement) {
    if (el.matches('input, textarea, select, [contenteditable=""], [contenteditable="true"]')) return true;
    if (el instanceof HTMLElement && el.scrollWidth > el.clientWidth) {
      const ox = getComputedStyle(el).overflowX;
      if (ox === 'auto' || ox === 'scroll') {
        // A rightward swipe scrolls it back towards its start, a leftward one
        // towards its end: theirs while there is room that way.
        if (opening ? el.scrollLeft > 0 : el.scrollLeft + el.clientWidth < el.scrollWidth - 1) return true;
      }
    }
  }
  return false;
}

export function useDrawerSwipe({ enabled, open, area, panel, shade, onOpen, onClose }: {
  /** The narrow layout, where the panel is a drawer. */
  enabled: boolean;
  open: boolean;
  /** Where the swipes are heard: the drawer, its shade and the page. */
  area: RefObject<HTMLElement>;
  panel: RefObject<HTMLElement>;
  /** The shade over the page while the drawer is open, faded with it. */
  shade: RefObject<HTMLElement>;
  onOpen: () => void;
  onClose: () => void;
}): void {
  // Read by the listeners, which are attached once.
  const live = useRef({ enabled, open, onOpen, onClose });
  live.current = { enabled, open, onOpen, onClose };

  useEffect(() => {
    const el = area.current;
    if (!DRAWER_SWIPE_ENABLED || !el) return;
    let state: 'idle' | 'pending' | 'dragging' = 'idle';
    let opening = false;
    let x0 = 0, y0 = 0, t0 = 0, width = 1, dx = 0;

    /** Where the drawer stands, 0 = put away, 1 = open. */
    const progress = () => Math.min(1, Math.max(0, opening ? dx / width : 1 + dx / width));

    const paint = () => {
      const p = progress();
      const pane = panel.current;
      if (pane) {
        pane.style.transition = 'none';
        // A percentage of its own width: the app's zoom stays out of it.
        pane.style.transform = `translateX(${(p - 1) * 100}%)`;
      }
      const sh = shade.current;
      if (sh) { sh.style.transition = 'none'; sh.style.opacity = String(p); }
    };

    /** Back to the classes: the inline position goes, and the drawer's own
     *  transition carries it from where the finger left it. */
    const release = () => {
      for (const node of [panel.current, shade.current]) {
        if (!node) continue;
        node.style.removeProperty('transition');
        node.style.removeProperty('transform');
        node.style.removeProperty('opacity');
      }
    };

    const onStart = (e: TouchEvent) => {
      state = 'idle';
      const { enabled: on, open: isOpen } = live.current;
      if (!on || e.touches.length !== 1 || anyOverlayOpen() || touchDragActive.value) return;
      const touch = e.touches[0]!;
      opening = !isOpen;
      if (opening && touch.clientX - el.getBoundingClientRect().left > EDGE_PX) return;
      if (startsInSomethingElse(e.target, opening)) return;
      width = panel.current?.getBoundingClientRect().width || 1;
      x0 = touch.clientX; y0 = touch.clientY; t0 = e.timeStamp; dx = 0;
      state = 'pending';
    };

    const onMove = (e: TouchEvent) => {
      if (state === 'idle') return;
      const touch = e.touches[0];
      if (!touch || touchDragActive.value) { if (state === 'dragging') release(); state = 'idle'; return; }
      dx = touch.clientX - x0;
      const dy = touch.clientY - y0;
      if (state === 'pending') {
        if (Math.max(Math.abs(dx), Math.abs(dy)) < DECIDE_PX) return;
        const sideways = Math.abs(dx) > Math.abs(dy) * HORIZONTAL_RATIO;
        const rightWay = opening ? dx > 0 : dx < 0;
        if (!sideways || !rightWay) { state = 'idle'; return; }
        state = 'dragging';
      }
      // The page must not scroll under a drawer being pulled.
      if (e.cancelable) e.preventDefault();
      paint();
    };

    const onEnd = (e: TouchEvent) => {
      if (state !== 'dragging') { state = 'idle'; return; }
      state = 'idle';
      const speed = dx / Math.max(1, e.timeStamp - t0);
      const p = progress();
      release();
      if (opening && (p > 1 / 3 || speed > FLICK_SPEED)) live.current.onOpen();
      else if (!opening && (p < 2 / 3 || speed < -FLICK_SPEED)) live.current.onClose();
    };

    // The system took the touch (Android's Back from the edge) or the browser
    // did: the drawer goes back to where it was.
    const onCancel = () => {
      if (state === 'dragging') release();
      state = 'idle';
    };

    el.addEventListener('touchstart', onStart, { passive: true });
    // Not passive: once the swipe is the drawer's, the page must not scroll.
    el.addEventListener('touchmove', onMove, { passive: false });
    el.addEventListener('touchend', onEnd);
    el.addEventListener('touchcancel', onCancel);
    return () => {
      el.removeEventListener('touchstart', onStart);
      el.removeEventListener('touchmove', onMove);
      el.removeEventListener('touchend', onEnd);
      el.removeEventListener('touchcancel', onCancel);
    };
  }, [area, panel, shade]);
}
