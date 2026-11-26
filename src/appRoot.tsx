import { render } from 'preact';
import { useState, useRef, useEffect, useLayoutEffect } from 'preact/hooks';
import { appState, routeSignal, stateEpoch, canGoBack, canGoForward, navigate, goBack, goForward, mutate, navEntry } from './store';
import type { AppContext } from './types';
import { isMobileDevice } from './services/device';
import { touchDragActive } from './components/touchDrag';
import { Sidebar } from './components/sidebar';
import { AppHeader, BottomNav, headerCompact } from './components/header';
import { ModalHost } from './components/modal';
import { CommandPaletteHost } from './components/commandPalette';
import { initScrollRestoration } from './components/scrollRestoration';
import { DeckPickerHost } from './components/deckSelector';
import { FolderView } from './views/folder';
import { DeckView } from './views/deck';
import { CardView } from './views/card';
import { LibraryView } from './views/library';
import { StudyView } from './views/study';
import { ModulesView } from './views/modules';
import { SessionsView } from './views/sessions';
import { TrendingView } from './views/trending';
import { useDrawerSwipe } from './components/drawerSwipe';

const SIDEBAR_WIDTH_KEY     = 'cadence_sidebar_width';
const SIDEBAR_COLLAPSED_KEY = 'cadence_sidebar_collapsed';
const SIDEBAR_DEFAULT       = 224;
const SIDEBAR_MIN           = 120;
const SIDEBAR_MAX           = 400;
/** The long press that takes the drawer's edge, and how far the finger may
 *  wander meanwhile — the card list's own long press is 250 ms and 8 px
 *  (addTouchDragSupport); longer here, the swipe beside it being the
 *  common gesture. */
const RESIZE_PRESS_MS       = 300;
const RESIZE_PRESS_SLOP_PX  = 8;
/** Two taps on the edge this close together fit its width to the names. */
const DOUBLE_TAP_MS         = 300;
/** Left after a fitted name, on top of the row's gap: the margin of the icon
 *  in its slot before the name — (24 − 14) / 2 in sidebar.tsx. */
const FIT_ROOM_PX           = 5;
/** The drawer's handle, made for a finger: 28 layout px (Tailwind w-7), of
 *  which this much over the drawer and the rest over the shade — the 8 px of
 *  the mouse's handle were about 13 physical pixels on a phone, under a
 *  fingertip, and hard to catch (2026-11-19). */
const NARROW_HANDLE_INSIDE_PX = 6;

/** Whether the side panel is put away in the wide layout: as last left, else
 *  away on a touch device. */
function wideSidebarCollapsed(): boolean {
  const stored = localStorage.getItem(SIDEBAR_COLLAPSED_KEY);
  if (stored !== null) return stored === 'true';
  return isMobileDevice();
}

// Routes to the appropriate Preact component.
// key= on stateful views forces a remount when the ID changes (resets local
// state) — and, via stateEpoch, when a Drive apply replaces the whole state
// (mount-time drafts would otherwise keep showing the pre-apply data).
// SessionsView is deliberately OUTSIDE the epoch: a remount there would tear
// down a live recording in progress, and its library reads reactively anyway.
function ContentSwitch() {
  const route = routeSignal.value;
  const e = `e${stateEpoch.value}:`;
  if (route.view === 'study')   return <StudyView key={e} deckId={route.deckId} cardIds={route.cardIds} studyTitle={route.studyTitle} strategy={route.strategy} currentCardId={route.currentCardId} contextDeckId={route.contextDeckId} skippedCardIds={route.skippedCardIds} ratedTs={route.ratedTs} />;
  if (route.view === 'deck')    return <DeckView   key={e + route.deckId}   deckId={route.deckId} />;
  if (route.view === 'library') return <LibraryView key={e} />;
  if (route.view === 'card')    return <CardView   key={e + route.cardId}   cardId={route.cardId} contextDeckId={route.contextDeckId} />;
  if (route.view === 'folder')  return <FolderView key={e + (route.folderId ?? 'root')} folderId={route.folderId} />;
  if (route.view === 'modules') return <ModulesView key={e} />;
  // Spread, not field by field: this route now carries the whole shape of the
  // list (tab, ordering, chips), and enumerating them here was one more place
  // to forget one.
  // The analyses and the detections keyed apart (2026-11-20): two pages, so
  // arriving on one mounts it afresh — the detections read their route at
  // mount only. The analyses' folders share one key, see SessionLibrary.
  if (route.view === 'sessions') return <SessionsView key={route.sessionId ?? (route.tab === 'tunes' ? 'detections' : 'library')} {...route} />;
  if (route.view === 'trending') return <TrendingView key={e} />;
  const _: never = route; return _;
}

function AppRoot() {
  const wrapperRef    = useRef<HTMLDivElement>(null);
  const resizeLineRef = useRef<HTMLDivElement>(null);
  const resizeHandleRef = useRef<HTMLDivElement>(null);
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const n = parseInt(localStorage.getItem(SIDEBAR_WIDTH_KEY) ?? '', 10);
    return isNaN(n) ? SIDEBAR_DEFAULT : Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, n));
  });
  const [isNarrow, setIsNarrow] = useState(() => window.innerWidth < 768);
  // The stored state is the WIDE layout's only (2026-11-11). Where the panel
  // slides over the page it is a drawer: it opens put away, and an open
  // drawer is never remembered — it used to be, so a phone reopened on a
  // covered page after any visit that had left it open.
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => isNarrow || wideSidebarCollapsed());

  // A drawer is put away by the navigation it was opened for: picking a deck
  // in it used to leave it over the deck just opened, one more tap to close.
  // Setting, not toggling: the walkthrough's own close after a row
  // (scenarios.ts, act.click on the backdrop) stays harmless. On a new
  // history entry only (navEntry: navigate, back/forward), not on every route
  // write: a rewrite of the same visit can come from background work —
  // Trending's load ends in replaceRoute — and would shut the drawer under
  // the finger that just opened it.
  const entry = navEntry.value;
  useEffect(() => {
    if (isNarrow) setSidebarCollapsed(true);
  }, [entry]);

  // Hides the static legal footer of index.html while a user is open: its
  // links are in Settings → About here (see styles.css).
  useLayoutEffect(() => {
    document.documentElement.classList.add('app-open');
    return () => document.documentElement.classList.remove('app-open');
  }, []);

  useEffect(() => {
    const mq = window.matchMedia('(max-width: 767px)');
    const handler = (e: MediaQueryListEvent) => {
      const el = wrapperRef.current;
      if (el) el.style.transition = 'none';
      setIsNarrow(e.matches);
      // Into a drawer: put away. Back to the wide layout: as it was left there.
      setSidebarCollapsed(e.matches || wideSidebarCollapsed());
      requestAnimationFrame(() => requestAnimationFrame(() => {
        if (el) el.style.removeProperty('transition');
      }));
    };
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  const PORTRAIT_PHONE_QUERY = '(max-width: 767px) and (orientation: portrait) and (pointer: coarse)';
  const [isPortraitPhone, setIsPortraitPhone] = useState(() => window.matchMedia(PORTRAIT_PHONE_QUERY).matches);

  useEffect(() => {
    const mq = window.matchMedia(PORTRAIT_PHONE_QUERY);
    const handler = (e: MediaQueryListEvent) => setIsPortraitPhone(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  const toggleSidebar = () => {
    setSidebarCollapsed(c => {
      const next = !c;
      if (!isNarrow) localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(next));
      return next;
    });
  };

  // The drawer opened and closed by a swipe from the left edge (2026-11-18,
  // group feedback) — the narrow layout only. Setting, not toggling: a swipe
  // says where the drawer goes. The drawer is never remembered (see above).
  const areaRef  = useRef<HTMLDivElement>(null);
  const shadeRef = useRef<HTMLDivElement>(null);
  useDrawerSwipe({
    enabled: isNarrow,
    open: !sidebarCollapsed,
    area: areaRef,
    panel: wrapperRef,
    shade: shadeRef,
    onOpen: () => setSidebarCollapsed(false),
    onClose: () => setSidebarCollapsed(true),
  });

  // Explicitly read every signal so Preact subscribes AppRoot to re-render on each change.
  const ctx: AppContext = {
    user:         appState.value,
    route:        routeSignal.value,
    navigate,
    back:         goBack,
    forward:      goForward,
    canGoBack:    canGoBack.value,
    canGoForward: canGoForward.value,
    mutate,
  };

  const startResize = (startX: number, byFinger = false) => {
    const startW = wrapperRef.current!.offsetWidth;
    // Window pixels per layout pixel: the pointer moves in the first, the
    // width is set in the second, and the app's zoom on <html> (90 % on a
    // phone, 125 % on a desktop) parts them — unconverted, the edge ran ahead
    // of the finger or lagged behind the mouse (2026-11-19).
    const scale = (startW && wrapperRef.current!.getBoundingClientRect().width / startW) || 1;
    wrapperRef.current!.style.transition = 'none';
    // A finger carrying the edge: the drawer's swipe stands aside
    // (drawerSwipe.ts), and so does the Android app's pull-to-refresh.
    if (byFinger) touchDragActive.value = true;
    if (resizeLineRef.current) resizeLineRef.current.style.background = 'rgb(var(--color-accent-ch)/0.4)';

    const onMove = (x: number) => {
      const w = Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, startW + (x - startX) / scale));
      wrapperRef.current!.style.width = w + 'px';
      // Out of the flow over a drawer, the handle is placed, not carried:
      // moved here with the edge, until the width is set on release.
      if (isNarrow && resizeHandleRef.current) resizeHandleRef.current.style.left = w - NARROW_HANDLE_INSIDE_PX + 'px';
    };
    const onEnd = () => {
      const w = wrapperRef.current!.offsetWidth;
      wrapperRef.current!.style.removeProperty('transition');
      if (resizeLineRef.current) resizeLineRef.current.style.removeProperty('background');
      setSidebarWidth(w);
      localStorage.setItem(SIDEBAR_WIDTH_KEY, String(w));
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      document.removeEventListener('touchmove', onTouchMove);
      document.removeEventListener('touchend', onEnd);
      document.removeEventListener('touchcancel', onEnd);
      if (byFinger) touchDragActive.value = false;
      document.body.style.removeProperty('cursor');
      document.body.style.removeProperty('user-select');
    };

    const onMouseMove = (ev: MouseEvent) => onMove(ev.clientX);
    const onMouseUp   = onEnd;
    const onTouchMove = (ev: TouchEvent) => { ev.preventDefault(); onMove(ev.touches[0]!.clientX); };

    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    document.addEventListener('touchmove', onTouchMove, { passive: false });
    document.addEventListener('touchend', onEnd);
    // Taken over by the system: ended all the same — else the line stayed
    // lit and the next touch went on resizing.
    document.addEventListener('touchcancel', onEnd);
  };

  /** A double click on the edge (2026-11-19): the panel as wide as its
   *  longest name needs — the narrowest width at which no folder or deck
   *  name is cut short, within the bounds, and the widest if even that cuts
   *  one. Found by trying widths on the live panel, between two paints:
   *  a row's room for its name depends on its depth, its icons and its dots,
   *  which only the layout knows. */
  const fitSidebarWidth = () => {
    const panel = wrapperRef.current;
    if (!panel) return;
    const names = Array.from(panel.querySelectorAll<HTMLElement>('.truncate'));
    const before = panel.style.width;
    panel.style.transition = 'none';
    // The text against its box, both to the fraction of a pixel. scrollWidth
    // and clientWidth are whole pixels: a name over its box by 0.06 px
    // rounded to 102 against 102 — "fits" — and lost its last letters to the
    // ellipsis (app at 90 %, measured 2026-11-20; seen on a desktop too).
    // And as much room after the name as before it: before, the icon's own
    // margin in its slot adds to the row's gap (sidebar.tsx: a 14 px icon in
    // a 24 px slot), so a name fitted to the gap alone sat closer to its dots
    // than to its icon (2026-11-20). In window pixels, like the rects.
    const room = FIT_ROOM_PX * ((panel.offsetWidth && panel.getBoundingClientRect().width / panel.offsetWidth) || 1);
    const range = document.createRange();
    const cut = (n: HTMLElement) => {
      range.selectNodeContents(n);
      return range.getBoundingClientRect().width + room > n.getBoundingClientRect().width;
    };
    const cutAt = (w: number) => {
      panel.style.width = w + 'px';
      return names.some(cut);
    };
    // The narrowest width that cuts nothing lies between lo (cuts) and hi.
    let lo = SIDEBAR_MIN, hi = SIDEBAR_MAX;
    if (!cutAt(lo)) hi = lo;
    else if (cutAt(hi)) lo = hi;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (cutAt(mid)) lo = mid; else hi = mid;
    }
    // From where it stood, so the change of width below is animated.
    panel.style.width = before;
    void panel.offsetWidth;
    panel.style.removeProperty('transition');
    setSidebarWidth(hi);
    localStorage.setItem(SIDEBAR_WIDTH_KEY, String(hi));
  };

  /** When the last tap on the edge ended, for a second one to make a double
   *  tap; and the drawer's close that first tap put off meanwhile. */
  const lastEdgeTap = useRef(0);
  const pendingClose = useRef<ReturnType<typeof setTimeout>>();

  const onResizeStart  = (e: MouseEvent) => { e.preventDefault(); startResize(e.clientX); };
  // In the drawer, the handle waits for a long press (2026-11-19): the swipe
  // that closes the drawer starts at its edge, right there, and a touch that
  // resized at once took that swipe — the blue line lit, the drawer neither
  // closed nor resized as meant. Held still, it resizes; moved first, the
  // swipe has it. Beside the content (wide layout), no swipe: at once.
  // Two taps in a row fit the width, as a double click does.
  const onResizeTouch  = (e: TouchEvent) => {
    const touch = e.touches[0];
    if (!touch || e.touches.length !== 1) return;
    if (performance.now() - lastEdgeTap.current < DOUBLE_TAP_MS) {
      e.preventDefault();
      lastEdgeTap.current = 0;
      clearTimeout(pendingClose.current);
      fitSidebarWidth();
      return;
    }
    const x = touch.clientX, y = touch.clientY;
    let held = false;
    const stop = () => {
      clearTimeout(timer);
      document.removeEventListener('touchmove', onMove);
      document.removeEventListener('touchend', onTap);
      document.removeEventListener('touchcancel', stop);
    };
    const onMove = (ev: TouchEvent) => {
      const t = ev.touches[0];
      if (!t || Math.hypot(t.clientX - x, t.clientY - y) > RESIZE_PRESS_SLOP_PX) stop();
    };
    // Lifted without moving, before any long press: a tap. The drawer's handle
    // reaches over the shade, whose tap closes the drawer — so does this one
    // there, once it is clear no second tap follows.
    const onTap = () => {
      stop();
      if (held) return;
      lastEdgeTap.current = performance.now();
      const panel = wrapperRef.current;
      if (isNarrow && panel && x > panel.getBoundingClientRect().right) {
        pendingClose.current = setTimeout(() => setSidebarCollapsed(true), DOUBLE_TAP_MS);
      }
    };
    const timer = isNarrow
      ? setTimeout(() => { held = true; startResize(x, true); }, RESIZE_PRESS_MS)
      : undefined;
    if (!isNarrow) { e.preventDefault(); startResize(x, true); }
    document.addEventListener('touchmove', onMove, { passive: true });
    document.addEventListener('touchend', onTap);
    document.addEventListener('touchcancel', stop);
  };

  return (
    <div class="flex flex-col flex-1 overflow-hidden">
      <AppHeader ctx={ctx} sidebarCollapsed={sidebarCollapsed} onToggleSidebar={toggleSidebar} isPortraitPhone={isPortraitPhone} />
      <div ref={areaRef} class="relative flex flex-1 overflow-hidden min-h-0">
        {/* Always there in the narrow layout, faded out and click-through
            while the drawer is put away: a swipe fades it with the drawer
            (drawerSwipe.ts), which a shade that only existed once open could
            not follow. */}
        {isNarrow && (
          <div
            ref={shadeRef}
            class={`absolute inset-0 z-20 bg-black/40 transition-opacity duration-200 ${sidebarCollapsed ? 'opacity-0 pointer-events-none' : 'opacity-100'}`}
            data-tour="sidebar-backdrop"
            // Closes, never toggles: it is there while the drawer is put away
            // too, and the walkthrough clicks it to close the drawer after a
            // row (scenarios.ts) — a toggle would open it again.
            onClick={() => setSidebarCollapsed(true)}
          />
        )}
        <div
          ref={wrapperRef}
          style={{ width: (isNarrow || !sidebarCollapsed) ? sidebarWidth + 'px' : '0px' }}
          class={isNarrow
            ? `absolute top-0 bottom-0 left-0 z-30 overflow-hidden transition-transform duration-200 ease-in-out ${sidebarCollapsed ? '-translate-x-full' : 'translate-x-0'}`
            : `shrink-0 overflow-hidden transition-[width] duration-200 ease-in-out`}
        >
          <div class="h-full" data-tour="sidebar-panel">
            <Sidebar ctx={ctx} />
          </div>
        </div>
        {/* Wide layout: the handle stays in the flex flow (so it follows the
            sidebar's width while dragging, which writes the width straight to
            the DOM) but its negative margins cancel its 8px: it straddles the
            sidebar's edge instead of opening a strip of empty background
            between the sidebar and the content. */}
        {!sidebarCollapsed && (
          <div
            ref={resizeHandleRef}
            class={`cursor-col-resize touch-none group ${isNarrow ? 'absolute top-0 bottom-0 w-7 z-30' : 'relative z-10 shrink-0 w-2 -mx-1'}`}
            style={isNarrow ? { left: sidebarWidth - NARROW_HANDLE_INSIDE_PX + 'px' } : undefined}
            onMouseDown={onResizeStart}
            onDblClick={fitSidebarWidth}
            onTouchStart={onResizeTouch}
            // No mouse events made up after a tap: their mousedown would
            // start a resize the long press above was there to hold back.
            onTouchEnd={(e: TouchEvent) => { if (e.cancelable) e.preventDefault(); }}
          >
            <div
              ref={resizeLineRef}
              class={`w-px h-full bg-transparent group-hover:bg-accent/40 transition-colors ${isNarrow ? '' : 'mx-auto'}`}
              // On the drawer's edge, wherever the handle reaches.
              style={isNarrow ? { marginLeft: NARROW_HANDLE_INSIDE_PX + 'px' } : undefined}
            />
          </div>
        )}
        <main class="flex-1 overflow-hidden bg-bg">
          <ContentSwitch />
        </main>
      </div>
      {/* Also wherever the header found no room for its wide layout: Home,
          Library, Modules and ‹ › then live down here, as on a phone. */}
      {(isPortraitPhone || headerCompact.value) && <BottomNav ctx={ctx} />}
      <ModalHost />
      <CommandPaletteHost />
      <DeckPickerHost />
    </div>
  );
}

export function mountApp(root: HTMLElement): void {
  render(null, root);
  render(<AppRoot />, root);
  initScrollRestoration();
}
