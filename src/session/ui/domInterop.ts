import { useEffect, useLayoutEffect, useRef } from 'preact/hooks';

// ── Interop primitives for the session UI ─────────────────────────────────────
// Small, generic, reused by more than one container — that's the bar for
// living here instead of duplicated per-file (see AnnotationCard.tsx's doc
// for the general "duplicate small local helpers" convention this codebase
// otherwise follows).

function scrollContainerOf(el: HTMLElement | null): HTMLElement | null {
  // `el` itself (e.g. the feed wrapper) is a plain, non-scrolling content div
  // in every screen that uses this — the actual scrollable element is its
  // `.overflow-y-auto` ANCESTOR (the page's own wrapper). Auto-follow needs
  // the real scroll position, not the feed wrapper's own (which never moves).
  if (!el) return null;
  return (el.closest('.overflow-y-auto') as HTMLElement | null) ?? el;
}

/** Mirrors the original imperative renderFeed()'s "stay pinned to the bottom
 *  of the feed unless the user has scrolled away" behavior, for the live and
 *  import screens' growing annotation feeds. `anchorRef` should point to an
 *  element INSIDE the scrollable container (its actual scrolling ancestor is
 *  found via scrollContainerOf, same lookup as before) — pass the feed list's
 *  own wrapper. Re-snaps to the bottom whenever `deps` changes, unless the
 *  user has manually scrolled away (tracked via a live scroll listener, not
 *  recomputed from scratch each time — simpler and more standard than the
 *  original's "measure distance-to-bottom right before the rebuild" trick,
 *  same practical effect). */
export function useAutoFollowScroll(anchorRef: { current: HTMLElement | null }, deps: unknown[]): void {
  const awayRef = useRef(false);

  useEffect(() => {
    const scrollEl = scrollContainerOf(anchorRef.current);
    if (!scrollEl) return;
    const onScroll = () => {
      awayRef.current = scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight >= 80;
    };
    scrollEl.addEventListener('scroll', onScroll);
    return () => scrollEl.removeEventListener('scroll', onScroll);
    // eslint-disable-next-line
  }, []);

  useLayoutEffect(() => {
    if (awayRef.current) return;
    const scrollEl = scrollContainerOf(anchorRef.current);
    if (scrollEl) scrollEl.scrollTop = scrollEl.scrollHeight;
    // eslint-disable-next-line
  }, deps);
}
