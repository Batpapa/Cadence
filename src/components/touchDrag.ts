import { signal } from '@preact/signals';

// Out of utils.ts since 2026-11-26.

// ── Touch drag & drop support ─────────────────────────────────────────────────
// Translates touchstart/touchmove/touchend into synthetic DragEvents so that
// existing dragstart/dragover/drop handlers work on mobile without changes.
//
// Once per element: several callers attach it from an inline `ref`, which
// Preact calls again at every render, and each call stacked another set of
// listeners — as many ghosts as renders, under the finger at once.
//
// The element stops being `draggable` while a finger is on it. Chrome on
// Android starts a NATIVE drag of a draggable element on its own long press
// (~500 ms), and cancels the touch to do so: this drag, armed at 250 ms, was
// then dropped where it started and ended, and the native one went on with
// nothing accepting it — the card flew back to its place. Whether a drag
// worked came down to moving before or after the system's threshold: "one
// time in two" (2026-10-14, group feedback; the source card at full opacity
// in the tester's video gave it away, confirmed on the user's phone
// 2026-10-15). A mouse never goes through here, so desktop drag is untouched.
const touchDragAttached = new WeakSet<HTMLElement>();

/** A finger is carrying something. The Android app's pull-to-refresh reads
 *  it (native/appShell.ts): a card dragged DOWN from a list scrolled to its
 *  top is, to the native layout around the WebView, a pull — and it reloaded
 *  the page under the drop (2026-10-27, group feedback). Set as well by the
 *  drawer being swiped and by its edge being resized (drawerSwipe.ts,
 *  appRoot.tsx). */
export const touchDragActive = signal(false);

/** The scrolling box a drag can travel along: the nearest ancestor that
 *  scrolls vertically, else the page. */
function verticalScroller(el: HTMLElement): HTMLElement {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const oy = getComputedStyle(p).overflowY;
    if ((oy === 'auto' || oy === 'scroll') && p.scrollHeight > p.clientHeight) return p;
  }
  return (document.scrollingElement as HTMLElement | null) ?? document.documentElement;
}

export function addTouchDragSupport(el: HTMLElement): void {
  if (touchDragAttached.has(el)) return;
  touchDragAttached.add(el);
  // Keeps the text unselectable while `draggable` is off (styles.css).
  el.dataset.touchDrag = '';
  const LONG_PRESS_MS = 250;
  const MOVE_CANCEL_PX = 8;
  // Edge scrolling. A mouse drag gets it from the browser; a finger gets
  // nothing, and the move that carries the card also cancels the page's own
  // scroll — so a destination below the fold was out of reach (an analysis
  // dragged to a folder further down, 2026-10-27). Window pixels for the zone,
  // since it is compared with a touch's clientY; layout pixels for the step,
  // since it is added to scrollTop.
  const EDGE_PX = 56;
  const EDGE_MAX_STEP = 16;

  let pressTimer: ReturnType<typeof setTimeout> | null = null;
  let startX = 0, startY = 0;
  let dragging = false;
  let ghost: HTMLElement | null = null;
  let lastDragTarget: Element | null = null;
  let scroller: HTMLElement | null = null;
  let finger = { x: 0, y: 0 };
  let edgeLoop = 0;
  /** Window pixels per layout pixel — see `activate`. */
  let zoomScale = 1;
  /** Whether this touch is what turned `draggable` off — so that only this
   *  puts it back, never over a caller that turned it off itself (the
   *  attachment row does while its name is being edited). */
  let suspendedNative = false;

  const resumeNative = () => {
    if (suspendedNative) el.draggable = true;
    suspendedNative = false;
  };

  const dispatchDrag = (type: string, target: Element, clientX: number, clientY: number) =>
    target.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, clientX, clientY }));

  /** What is under the finger now hears it is being hovered — and what it
   *  left, that it was left. */
  const hover = (x: number, y: number) => {
    if (ghost) ghost.style.visibility = 'hidden';
    const target = document.elementFromPoint(x, y);
    if (ghost) ghost.style.visibility = '';
    if (target !== lastDragTarget) {
      if (lastDragTarget) dispatchDrag('dragleave', lastDragTarget, x, y);
      lastDragTarget = target;
    }
    if (target) dispatchDrag('dragover', target, x, y);
  };

  /** Every frame of a drag: a finger near the scroller's top or bottom edge
   *  scrolls it, the faster the closer. Only once the finger has travelled —
   *  a card picked up near an edge must not set the list running on its own.
   *  The list moving under a still finger changes what is under it, so the
   *  hover is told again. */
  const edgeScroll = () => {
    edgeLoop = requestAnimationFrame(edgeScroll);
    if (!scroller || Math.hypot(finger.x - startX, finger.y - startY) <= MOVE_CANCEL_PX) return;
    const page = scroller === document.scrollingElement || scroller === document.documentElement;
    const r = page ? { top: 0, bottom: innerHeight } : scroller.getBoundingClientRect();
    const top = Math.max(0, r.top), bottom = Math.min(innerHeight, r.bottom);
    const depth = finger.y < top + EDGE_PX ? finger.y - (top + EDGE_PX)
      : finger.y > bottom - EDGE_PX ? finger.y - (bottom - EDGE_PX)
      : 0;
    if (depth === 0) return;
    const step = Math.sign(depth) * Math.max(1, Math.round(EDGE_MAX_STEP * Math.min(1, Math.abs(depth) / EDGE_PX)));
    const before = scroller.scrollTop;
    scroller.scrollTop = before + step;
    if (scroller.scrollTop !== before) hover(finger.x, finger.y);
  };

  const activate = (touch: Touch) => {
    dragging = true;
    touchDragActive.value = true;
    scroller = verticalScroller(el);
    finger = { x: touch.clientX, y: touch.clientY };
    edgeLoop = requestAnimationFrame(edgeScroll);
    dispatchDrag('dragstart', el, touch.clientX, touch.clientY);
    // The ghost is drawn under the app's zoom on <html>, so what it is told
    // is in layout pixels while the rect and the finger are in window pixels
    // (see zoomService). Unconverted, it trailed off up and left of the finger
    // by the zoom's own factor — 20 % on a phone, measured 2026-10-27.
    const rect = el.getBoundingClientRect();
    zoomScale = el.offsetWidth ? rect.width / el.offsetWidth : 1;
    ghost = el.cloneNode(true) as HTMLElement;
    Object.assign(ghost.style, {
      position: 'fixed', pointerEvents: 'none', zIndex: '9999',
      opacity: '0.75', margin: '0', boxSizing: 'border-box',
      width: el.offsetWidth + 'px', height: el.offsetHeight + 'px',
      left: rect.left / zoomScale + 'px', top: rect.top / zoomScale + 'px',
    });
    document.body.appendChild(ghost);
  };

  const cleanup = () => {
    cancelAnimationFrame(edgeLoop);
    ghost?.remove(); ghost = null;
    dragging = false; lastDragTarget = null; scroller = null;
    touchDragActive.value = false;
  };

  el.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) return;
    const touch = e.touches[0]!;
    startX = touch.clientX; startY = touch.clientY;
    if (el.draggable) { el.draggable = false; suspendedNative = true; }
    // Not when the finger already carries something else — the drawer being
    // swiped over this row (drawerSwipe.ts): one finger, one thing.
    pressTimer = setTimeout(() => { if (!touchDragActive.value) activate(touch); }, LONG_PRESS_MS);
  }, { passive: true });

  el.addEventListener('touchmove', (e) => {
    const touch = e.touches[0]!;
    if (!dragging) {
      if (Math.hypot(touch.clientX - startX, touch.clientY - startY) > MOVE_CANCEL_PX) {
        clearTimeout(pressTimer!); pressTimer = null;
      }
      return;
    }
    e.preventDefault();
    finger = { x: touch.clientX, y: touch.clientY };
    if (ghost) {
      ghost.style.left = touch.clientX / zoomScale - el.offsetWidth / 2 + 'px';
      ghost.style.top  = touch.clientY / zoomScale - el.offsetHeight / 2 + 'px';
    }
    hover(touch.clientX, touch.clientY);
  }, { passive: false });

  /** The finger lifted (`drop`), or the system took the touch over: then
   *  nothing is dropped — a cancel is not a release, and dropping there is what
   *  landed a card on itself while the system's own drag went on. */
  const endDrag = (clientX: number, clientY: number, drop: boolean) => {
    clearTimeout(pressTimer!); pressTimer = null;
    resumeNative();
    if (!dragging) return;
    if (ghost) ghost.style.visibility = 'hidden';
    const target = drop ? document.elementFromPoint(clientX, clientY) : null;
    cleanup();
    if (target) dispatchDrag('drop', target, clientX, clientY);
    dispatchDrag('dragend', el, clientX, clientY);
  };

  el.addEventListener('touchend',    (e) => { const tc = e.changedTouches[0]!; endDrag(tc.clientX, tc.clientY, true); });
  el.addEventListener('touchcancel', (e) => { const tc = e.changedTouches[0]!; endDrag(tc.clientX, tc.clientY, false); });
}
