import { render, type ComponentChildren } from 'preact';
import { useState, useRef, useEffect, useLayoutEffect } from 'preact/hooks';
import { appState, routeSignal, stateEpoch, canGoBack, canGoForward, navigate, goBack, goForward, mutate, navEntry } from './store';
import type { AppContext } from './types';
import { isMobileDevice, touchDragActive } from './utils';
import { Sidebar } from './components/sidebar';
import { AppHeader, BottomNav, headerCompact } from './components/header';
import { ModalHost } from './components/modal';
import { CommandPaletteHost } from './components/commandPalette';
import { initScrollRestoration } from './components/scrollRestoration';
import { DeckPickerHost } from './components/deckSelector';
import { WelcomePrefs } from './components/welcomePrefs';
import { GithubIcon, CloudDownIcon, UpdateIcon, InstallIcon, GooglePlayIcon, PlusIcon } from './components/icons';
import { InlineStatus } from './components/ui';
import { WelcomeTour } from './components/welcomeTour';
import { webAppButtonAction, openPlayStore } from './components/installOffer';
import { isNative } from './native/platform';
import { t } from './services/i18nService';
import { updateReady, applyUpdate, versionLabel } from './services/updateService';
import { initDriveClient } from './services/driveService';
import type { User } from './types';
import { FolderView } from './views/folder';
import { DeckView } from './views/deck';
import { CardView } from './views/card';
import { LibraryView } from './views/library';
import { StudyView } from './views/study';
import { ModulesView } from './views/modules';
import { SessionsView } from './views/sessions';
import { TrendingView } from './views/trending';
import { CadenceMark } from './components/cadenceMark';
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
  if (route.view === 'sessions') return <SessionsView key={route.sessionId ?? "library"} {...route} />;
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

// ── User selector ─────────────────────────────────────────────────────────────

const initialsOf = (name: string) =>
  name.split(/[\s-]+/).slice(0, 2).map(w => w[0] ?? '').join('').toUpperCase() || '?';

/** The source link and the version, at the foot of the welcome screen.
 *  No privacy/terms links here: index.html's static footer carries them on
 *  this screen, and is what the OAuth review reads. */
function Signature({ class: extra }: { class: string }) {
  return (
    <div class={`flex-col items-center gap-2.5 ${extra}`}>
      <a
        href="https://github.com/Batpapa/Cadence"
        target="_blank"
        rel="noopener noreferrer"
        title={t('welcome.sourceTitle')}
        class="flex items-center gap-1.5 text-2xs text-dim hover:text-primary transition-colors"
      >
        <GithubIcon size={12} />
        <span>Batpapa</span>
      </a>

      {/* Quiet, like the signature: for the screenshot someone sends
          when asking for help. When a newer build is ready it becomes the
          way to get it — nothing is open on this screen for a reload to
          lose, and there is no header here to carry the pill. */}
      <div class="flex items-center gap-2 text-2xs text-dim tabular-nums">
        <span>{versionLabel()}</span>
        {updateReady.value && (
          <button
            class="flex items-center gap-1 text-accent hover:underline cursor-pointer"
            title={t('update.title', { version: versionLabel(updateReady.value) })}
            onClick={applyUpdate}
          >
            <UpdateIcon size={12} />
            {t('update.button')}
          </button>
        )}
      </div>
    </div>
  );
}

/** How the welcome screen's Drive recovery ended (see main.ts). Only 'empty'
 *  hands control back: a Google account with no Cadence data on it, where the
 *  connection is kept only if a name is given for a new user. */
export type DriveRecovery =
  | { kind: 'opened' }
  | { kind: 'cancelled' }
  | { kind: 'failed'; inAppBrowser: boolean }
  | { kind: 'empty'; email: string; finish: (name: string) => Promise<void>; cancel: () => void };

type EmptyDrive = Extract<DriveRecovery, { kind: 'empty' }>;

function UserSelector({ users, onSelect, onCreate, onRecover }: {
  users: User[];
  onSelect: (id: string) => Promise<void>;
  onCreate: (name: string) => Promise<void>;
  /** null when Drive sync is not configured in this build. */
  onRecover: (() => Promise<DriveRecovery>) | null;
}) {
  const [loading,  setLoading]  = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName,  setNewName]  = useState('');
  // Set while the name being typed is for a user bound to an empty Drive.
  const [emptyDrive, setEmptyDrive] = useState<EmptyDrive | null>(null);
  const [recoverError, setRecoverError] = useState<'failed' | 'inAppBrowser' | null>(null);
  // t() is not reactive: a language picked on this screen redraws it.
  const [, redraw] = useState(0);
  // Both ways in, side by side under the sign-in (2026-11-08) — it used to be
  // one discreet link in the top corner, which a visitor who had just scanned
  // a neighbour's QR at a session never saw. No "Web app" where it cannot
  // apply: inside the Android app, or inside the web app itself. No "Android
  // app" inside the Android app — so nothing at all there.
  const installWebApp = webAppButtonAction();
  const showPlay = !isNative();

  const select = async (id: string) => {
    setLoading(id);
    await onSelect(id);
  };

  const create = async () => {
    const name = newName.trim();
    if (!name) return;
    setLoading('new');
    if (emptyDrive) await emptyDrive.finish(name);
    else await onCreate(name);
  };

  const cancelCreate = () => {
    emptyDrive?.cancel();
    setEmptyDrive(null);
    setCreating(false);
    setNewName('');
  };

  const recover = async () => {
    if (!onRecover) return;
    setRecoverError(null);
    setLoading('drive');
    const outcome = await onRecover();
    if (outcome.kind === 'opened') return;
    setLoading(null);
    if (outcome.kind === 'failed') setRecoverError(outcome.inAppBrowser ? 'inAppBrowser' : 'failed');
    if (outcome.kind === 'empty') {
      setEmptyDrive(outcome);
      setCreating(true);
    }
  };

  // No way to REMOVE a user from here any more (2026-09-13). The ✕ it used to
  // carry was revealed by hover and by nothing else, so on a touch screen it
  // was reachable only because :hover sticks to whatever was tapped last —
  // an interaction nobody chose, holding a destructive action. Removing a user
  // now lives in Settings → User, where it is a button that is simply visible.
  return (
    // The sign-in, then what Cadence does (WelcomeTour) under it — beside it
    // on a wide screen, each column scrolling on its own so that the sign-in
    // stays in view. Auto margins rather than centring by flex: a column taller
    // than the screen must not lose its top.
    <div class="fixed inset-0 bg-bg overflow-y-auto flex flex-col lg:flex-row lg:overflow-hidden">
      {/* No Settings before a user exists: language and theme are here. Below
          the status bar where the page runs under it (Android 15+, iOS). */}
      <div class="fade-in absolute z-10 right-3 flex items-center gap-1" style="top:calc(var(--safe-top) + 8px);animation-delay:1s">
        <WelcomePrefs onLanguageChange={() => redraw(x => x + 1)} />
      </div>
      <div class="shrink-0 flex flex-col items-center px-4 pt-14 pb-12 lg:flex-1 lg:min-w-0 lg:overflow-y-auto lg:py-10">
      <div class="w-full max-w-[352px] lg:my-auto flex flex-col items-center">

        {/* ── Marque ── */}
        <div class="mark-in mb-[22px]">
          <CadenceMark size={78} />
        </div>

        <div class="rise-in text-center" style="animation-delay:.7s">
          <div class="text-[38px] font-extralight tracking-[-0.015em] leading-none text-primary">{/* ui-ok: Vitrine register */}
            Cadence
          </div>
          <p class="text-[13.5px] text-muted leading-relaxed mt-3.5 text-pretty">{/* ui-ok: Vitrine register */}
            {t('welcome.tagline')}
          </p>
        </div>

        <div class="fade-in w-11 h-px bg-border mt-[30px] mb-[26px]" style="animation-delay:1s" />

        {/* ── Sélection ── */}
        <div class="rise-in w-full" style="animation-delay:1.05s">
          <h1 class="text-2xs font-semibold text-dim uppercase tracking-[0.16em] text-center mb-3.5">
            {t('userSelector.title')}
          </h1>

          <div class="flex flex-col gap-2">
            {users.map((u, i) => (
              <button
                key={u.id}
                disabled={!!loading}
                onClick={() => void select(u.id)}
                class={`rise-in w-full flex items-center gap-3 px-3.5 py-[11px] rounded-xl border border-border bg-elevated hover:border-muted hover:bg-surface transition-colors cursor-pointer text-left ${loading === u.id ? 'opacity-60' : ''}`}
                style={`animation-delay:${1.1 + i * 0.07}s`}
              >
                <div class="w-8 h-8 rounded-lg flex items-center justify-center shrink-0" style="background:rgb(var(--color-accent-ch)/0.18)">
                  <span class="text-xs font-mono font-bold text-accent">{initialsOf(u.name)}</span>
                </div>
                <span class="text-sm font-medium text-primary truncate flex-1">{u.name}</span>
              </button>
            ))}

            {creating ? (
              <div class="flex flex-col gap-2 pt-1">
                {emptyDrive && (
                  <p class="text-xs text-muted leading-relaxed text-pretty">
                    {t('userSelector.recover.empty', { account: emptyDrive.email || t('userSelector.recover.thisAccount') })}
                  </p>
                )}
                <div class="flex gap-2">
                  <input
                    autoFocus
                    type="text"
                    value={newName}
                    placeholder={t('userSelector.namePlaceholder')}
                    class="input flex-1 text-sm"
                    onInput={(e) => setNewName((e.target as HTMLInputElement).value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter')  void create();
                      if (e.key === 'Escape') cancelCreate();
                    }}
                  />
                  <button
                    class="btn-primary text-sm px-3"
                    disabled={!!loading || !newName.trim()}
                    onClick={() => void create()}
                  >
                    {t('common.confirm')}
                  </button>
                </div>
                {/* Escape alone was enough for a plain new user; here the
                    Drive connection made a moment ago has to be undone
                    deliberately, and a phone has no Escape key. */}
                {emptyDrive && (
                  <button class="btn-ghost text-xs self-center" disabled={!!loading} onClick={cancelCreate}>
                    {t('common.cancel')}
                  </button>
                )}
              </div>
            ) : (
              <>
                <button
                  class="rise-in w-full flex items-center justify-center gap-2 px-3.5 py-[11px] rounded-xl border border-dashed border-border text-dim hover:border-muted hover:text-primary transition-colors cursor-pointer text-[13.5px]" // ui-ok: Vitrine register
                  style={`animation-delay:${1.1 + users.length * 0.07}s`}
                  disabled={!!loading}
                  onClick={() => setCreating(true)}
                >
                  <PlusIcon size={14} />
                  {t('userSelector.new')}
                </button>
                {onRecover && (
                  <button
                    class={`rise-in w-full flex items-center justify-center gap-2 px-3.5 py-[11px] rounded-xl border border-dashed border-border text-dim hover:border-muted hover:text-primary transition-colors cursor-pointer text-[13.5px] ${loading === 'drive' ? 'opacity-60' : ''}`} // ui-ok: Vitrine register
                    style={`animation-delay:${1.1 + (users.length + 1) * 0.07}s`}
                    disabled={!!loading}
                    // Google's script is only fetched on first use. Starting it
                    // on approach keeps the consent window close to the click
                    // that opens it, which is what browsers let through.
                    onPointerEnter={preloadDrive}
                    onFocus={preloadDrive}
                    onPointerDown={preloadDrive}
                    onClick={() => void recover()}
                  >
                    <CloudDownIcon size={14} />
                    {loading === 'drive' ? t('settings.sync.connecting') : t('userSelector.recover')}
                  </button>
                )}
              </>
            )}
          </div>

          {/* An error, said as one (UI charter, 2026-11-11): it was grey. */}
          {recoverError && (
            <InlineStatus tone="error" class="justify-center text-center leading-relaxed text-pretty mt-2.5">
              {t(recoverError === 'inAppBrowser' ? 'settings.sync.inAppBrowserError' : 'userSelector.recover.failed')}
            </InlineStatus>
          )}

          {(installWebApp || showPlay) && (
            <div class="rise-in mt-8" style={`animation-delay:${1.1 + (users.length + 2) * 0.07}s`}>
              <div class="text-2xs font-semibold text-dim uppercase tracking-[0.16em] text-center mb-3.5">
                {t('settings.install')}
              </div>
              <div class="flex gap-2">
                {installWebApp && <InstallTile icon={<InstallIcon size={16} />} label={t('welcome.install.webApp')} onClick={installWebApp} />}
                {showPlay && <InstallTile icon={<GooglePlayIcon size={16} />} label={t('shareApp.target.android')} onClick={openPlayStore} />}
              </div>
            </div>
          )}

          {/* Under the sign-in when the tour is beside it; at the very end
              of the page when the tour is below. */}
          <Signature class="hidden lg:flex mt-10" />
        </div>
      </div>
      </div>

      <div
        class="fade-in shrink-0 px-[19px] sm:px-14 pt-6 pb-16 lg:flex-[1.3] lg:min-w-0 lg:overflow-y-auto lg:pt-[72px] lg:bg-surface/40 lg:border-l lg:border-border"
        style="animation-delay:1.3s"
      >
        {/* Below the sign-in, the whole width between the side-by-side
            layout's margins (2026-10-26): not the sign-in's narrow column. */}
        <div class="w-full lg:max-w-[640px]">
          <WelcomeTour />
          <Signature class="flex lg:hidden mt-14" />
        </div>
      </div>
      <ModalHost />
    </div>
  );
}

export function mountUserSelector(
  root: HTMLElement,
  users: User[],
  onSelect: (id: string) => Promise<void>,
  onCreate: (name: string) => Promise<void>,
  onRecover: (() => Promise<DriveRecovery>) | null,
): void {
  render(<UserSelector users={users} onSelect={onSelect} onCreate={onCreate} onRecover={onRecover} />, root);
}

/** One of the welcome screen's two install buttons: logo and name, nothing
 *  else — no state, no detection (the author, 2026-11-08). */
function InstallTile({ icon, label, onClick }: {
  icon: ComponentChildren;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      class="flex-1 min-w-0 flex items-center justify-center gap-2 px-3 py-[11px] rounded-xl border border-border bg-elevated hover:border-muted hover:bg-surface transition-colors cursor-pointer text-[13.5px] text-primary" // ui-ok: Vitrine register
      onClick={onClick}
    >
      <span class="shrink-0 flex">{icon}</span>
      <span class="truncate">{label}</span>
    </button>
  );
}

const preloadDrive = () => { void initDriveClient().catch(() => { /* retried by the click itself */ }); };
