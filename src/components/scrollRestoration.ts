import { effect } from '@preact/signals';
import { navEntry, recallScroll, rememberScroll, stateEpoch } from '../store';

// ── Scroll restoration ────────────────────────────────────────────────────────
// Going back to a list returns to where that visit left off, instead of to the
// top — the behaviour every browser and phone has, which this app did not (a
// user with thirty recordings had to scroll down again after opening each one).
//
// Deliberately outside the component tree. Subscribing to navEntry from inside
// AppRoot would re-render the whole shell — sidebar, header, bottom nav — on
// every navigation, purely to move one element's scrollTop; ContentSwitch is a
// separate component precisely so that a route change re-renders only the view.
// A plain signal effect plus a DOM lookup costs nothing and touches nothing.
//
// Which element scrolls is a fact about the view layer, so it is decided here
// rather than in store.ts, which only carries the offsets from one entry to the
// next.

/** Every view roots itself in `.overflow-y-auto h-full`; `<main>` itself is
 *  `overflow-hidden`. First match in document order is the view's own
 *  container — anything else with this class (a dropdown's inner list) is
 *  nested deeper and appears later. */
function scroller(): HTMLElement | null {
  return document.querySelector<HTMLElement>('main .overflow-y-auto');
}

/** How long to keep trying before settling for whatever height exists. Long
 *  enough for an IndexedDB read plus a render, short enough that a view which
 *  never grows back to its old height stops being touched while it is read. */
const RESTORE_BUDGET_MS = 1500;

/** Records this entry's offset as the user scrolls, coalesced to one write per
 *  frame. Attached only once restoration has settled: while the view is still
 *  growing, `scrollTop` reads back clamped, and saving that would overwrite the
 *  very offset being restored. */
function attachSaver(el: HTMLElement, navId: number): () => void {
  let frame = 0;
  const onScroll = () => {
    if (frame) return;
    frame = requestAnimationFrame(() => { frame = 0; rememberScroll(navId, el.scrollTop); });
  };
  el.addEventListener('scroll', onScroll, { passive: true });
  return () => {
    el.removeEventListener('scroll', onScroll);
    // FLUSHED, not dropped. Scrolling and immediately clicking through leaves a
    // write pending in a frame that will never run, and cancelling it would
    // throw away the last thing the reader did — the position they most want
    // back.
    if (frame) { cancelAnimationFrame(frame); rememberScroll(navId, el.scrollTop); }
  };
}

/** Applies `target` as soon as the view is tall enough to accept it.
 *
 *  Not a single assignment, because the content is not there yet on the frame a
 *  view mounts: the session library reads IndexedDB in an effect, a summary
 *  loads its metadata first, a card view resolves attachments. Assigning
 *  `scrollTop` to an empty container silently clamps to 0 — which is exactly
 *  the bug being fixed, so it would look like the code had no effect at all.
 *
 *  Returns a cancel function for the case where another navigation arrives
 *  mid-restore; cancelling never calls `onSettled`, so the saver is never armed
 *  against an entry that is no longer on screen. */
function restoreTo(el: HTMLElement, target: number, onSettled: () => void): () => void {
  let raf = 0;
  let finished = false;

  const detach = () => {
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    window.removeEventListener('wheel', settle, true);
    window.removeEventListener('touchstart', settle, true);
    window.removeEventListener('keydown', settle, true);
  };
  function settle(): void {
    if (finished) return;
    finished = true;
    detach();
    onSettled();
  }
  const cancel = () => {
    if (finished) return;
    finished = true;
    detach();
  };

  // Explicitly, rather than trusting a freshly mounted element to be at 0: a
  // view Preact reused would keep whatever offset it had.
  if (target <= 0) { el.scrollTop = 0; settle(); return cancel; }

  // The reader's own scrolling ends this immediately: a page that pulls itself
  // back while someone is reading it is worse than one that starts at the top.
  window.addEventListener('wheel', settle, true);
  window.addEventListener('touchstart', settle, true);
  window.addEventListener('keydown', settle, true);

  const deadline = performance.now() + RESTORE_BUDGET_MS;
  const tick = () => {
    raf = 0;
    if (finished) return;
    if (el.scrollHeight - el.clientHeight >= target) { el.scrollTop = target; settle(); return; }
    if (performance.now() >= deadline) {
      // Never grew back — content was deleted, or a filter is narrowing it.
      // The bottom is still nearer to where the reader was than the top is.
      el.scrollTop = Math.max(0, el.scrollHeight - el.clientHeight);
      settle();
      return;
    }
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
  return cancel;
}

/** Subscribes the caller to wholesale state replacements (a Drive apply), which
 *  remount the view tree and so detach the element the saver is listening to.
 *
 *  A function call rather than a bare `stateEpoch.value;` statement: the value
 *  is genuinely unused — only the subscription the read creates matters — and a
 *  lone property access is exactly the shape a minifier may treat as dead code.
 *  A call is not droppable, so the subscription cannot be optimised away. */
function subscribeToStateEpoch(): number {
  return stateEpoch.value;
}

let started = false;

/** Call once, after the app tree is mounted. Idempotent: logging out and back
 *  in re-runs mountApp, and a second effect would mean two savers racing to
 *  write the same entry. */
export function initScrollRestoration(): void {
  if (started) return;
  started = true;

  let teardown: (() => void) | null = null;

  effect(() => {
    const id = navEntry.value;
    subscribeToStateEpoch();

    teardown?.();

    let cancelRestore: (() => void) | null = null;
    let detachSaver: (() => void) | null = null;

    // Preact re-renders on a microtask after the signal write, so by the next
    // animation frame the element in the document belongs to the new view.
    const raf = requestAnimationFrame(() => {
      const el = scroller();
      if (!el) return;
      const startSaving = () => { detachSaver = attachSaver(el, id); };
      // One path, whatever brought us here. recallScroll answers with this
      // history entry's own offset when it has one — going back, or a view
      // rebuilt underneath the reader by a Drive apply — and 0 for an entry
      // never scrolled, which is every fresh arrival.
      cancelRestore = restoreTo(el, recallScroll(id), startSaving);
    });

    teardown = () => {
      cancelAnimationFrame(raf);
      cancelRestore?.();
      detachSaver?.();
    };
  });
}
