import { useEffect, useRef } from 'preact/hooks';
import type { RefObject } from 'preact';
import { anyOverlayOpen } from './overlayStack';
import { isAppleTouchDevice, touchDragActive } from '../utils';
import { devMode } from '../services/devMode';

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

/** For developer mode only while it is tried in the Android app (2026-11-19):
 *  the first version was too awkward to use, and the rework — measured in
 *  Chrome on a phone — has not been tried there yet. true gives it to
 *  everyone. */
const DRAWER_SWIPE_FOR_EVERYONE = false;

/** Opening by a swipe on an iPhone or iPad: off, as MUI's SwipeableDrawer has
 *  it by default (disableSwipeToOpen = iOS) — Safari takes the left edge for
 *  its own Back there. Closing by a swipe stays. true opens there too. */
const SWIPE_TO_OPEN_ON_IOS = false;

/** How far from the left edge an opening swipe may start, in the touch's
 *  pixels. Measured on the Android 17 emulator, gesture navigation
 *  (2026-11-18): a swipe starting 23 px in is the system's Back (the app went
 *  to the background), one starting 36 px in reaches the page. With 40 px,
 *  that left a strip about 16 px wide — under a thumb's width — so 64. */
const EDGE_PX = 64;
/** Movement before the swipe is read as one direction or the other — MUI's
 *  SwipeableDrawer (UNCERTAINTY_THRESHOLD) reads it at 3 px too: decided
 *  later, the browser may have started its own scroll first (10 px lost a
 *  third of the swipes on a Galaxy A22, 2026-11-19). */
const DECIDE_PX = 3;
/** How much more horizontal than vertical a swipe must be to be the drawer's. */
const HORIZONTAL_RATIO = 1.5;
/** A release this fast (px/ms) finishes the move, however short. The speed
 *  of the last moves, smoothed as MUI does — not the average since the
 *  touch began, which a slow start then a flick never reached. */
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
    if (!el) return;
    const swipeOpens = SWIPE_TO_OPEN_ON_IOS || !isAppleTouchDevice();
    let state: 'idle' | 'pending' | 'dragging' = 'idle';
    let opening = false;
    let x0 = 0, y0 = 0, width = 1, dx = 0;
    /** Smoothed speed (px/ms), from the previous move's place and time. */
    let speed = 0, lastX = 0, lastT = 0;
    /** Whether touchDragActive is this swipe's own doing. */
    let carrying = false;

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
      if (carrying) { carrying = false; touchDragActive.value = false; }
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
      // Read at each touch: developer mode switched on takes effect at once.
      if (!(DRAWER_SWIPE_FOR_EVERYONE || devMode.value)) return;
      if (!on || e.touches.length !== 1 || anyOverlayOpen() || touchDragActive.value) return;
      const touch = e.touches[0]!;
      opening = !isOpen;
      if (opening && !swipeOpens) return;
      if (opening && touch.clientX - el.getBoundingClientRect().left > EDGE_PX) return;
      if (startsInSomethingElse(e.target, opening)) return;
      width = panel.current?.getBoundingClientRect().width || 1;
      x0 = lastX = touch.clientX; y0 = touch.clientY; lastT = e.timeStamp; dx = 0; speed = 0;
      state = 'pending';
    };

    const onMove = (e: TouchEvent) => {
      if (state === 'idle') return;
      const touch = e.touches[0];
      // Not cancelable: the browser has taken the touch (its scroll, or
      // Chrome's own Back swipe) — following it too is what made the drawer
      // let go halfway and the page move under it (phone, 2026-11-19).
      if (!touch || (touchDragActive.value && !carrying) || !e.cancelable) { if (state === 'dragging') release(); state = 'idle'; return; }
      dx = touch.clientX - x0;
      const dy = touch.clientY - y0;
      if (state === 'pending') {
        // Held off until the swipe is read: the browser starts its own scroll
        // on the first move left to it, and every later one is then out of
        // reach. Measured on a Galaxy A22 in Chrome: a third of the swipes
        // came under DECIDE_PX on their first move, and were lost that way.
        if (Math.max(Math.abs(dx), Math.abs(dy)) < DECIDE_PX) { e.preventDefault(); return; }
        const sideways = Math.abs(dx) > Math.abs(dy) * HORIZONTAL_RATIO;
        const rightWay = opening ? dx > 0 : dx < 0;
        if (!sideways || !rightWay) { state = 'idle'; return; }
        state = 'dragging';
        // The finger carries the drawer: the Android app's pull-to-refresh
        // stands aside (native/appShell.ts), and a long press under it stays
        // a swipe (utils.ts's touch drag). Without it, a slow swipe drifting
        // down took the native layout's slop: it claimed the touch, the page
        // got a cancel, and the drawer sprang back open — in the app only,
        // never in Chrome (2026-11-19).
        carrying = true;
        touchDragActive.value = true;
      }
      // The page must not scroll under a drawer being pulled.
      e.preventDefault();
      if (e.timeStamp > lastT) {
        speed = speed * 0.4 + (touch.clientX - lastX) / (e.timeStamp - lastT) * 0.6;
        lastX = touch.clientX; lastT = e.timeStamp;
      }
      paint();
    };

    const onEnd = () => {
      if (state !== 'dragging') { state = 'idle'; return; }
      state = 'idle';
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
