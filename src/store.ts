import { signal, effect } from '@preact/signals';
import type { AppState, AppContext, Route } from './types';
import { emptyState } from './utils';
import { saveUser } from './db';
import { syncToCloud } from './services/driveService';
import { normaliseState } from './services/stateNormalise';
import { closeTopOverlay } from './components/overlayStack';

export const appState    = signal<AppState>(emptyState());
export const routeSignal = signal<Route>({ view: 'folder', folderId: null });
/** Bumped ONLY when the whole state is replaced from OUTSIDE (a Drive apply) —
 *  never on ordinary local mutations. Views hold mount-time copies of the data
 *  they edit (drafts, edit modes: e.g. card.tsx's notesDraft, read even for
 *  display), so a wholesale replacement must remount them to be visible —
 *  appRoot keys the view tree on this. A local mutation must NOT remount:
 *  it would wipe the very draft being typed. */
export const stateEpoch  = signal(0);
export const canGoBack   = signal(false);
export const canGoForward = signal(false);

const ROUTE_STORAGE_KEY = 'cadence_last_route';

function isValidRoute(route: Route, user: AppState): boolean {
  switch (route.view) {
    case 'folder':  return route.folderId === null || !!user.folders[route.folderId];
    case 'deck':    return !!user.decks[route.deckId];
    case 'card':    return !!user.cards[route.cardId];
    case 'study':   return route.deckId ? !!user.decks[route.deckId] : (route.cardIds?.length ?? 0) > 0;
    case 'library':  return true;
    case 'modules':  return true;
    // Sessions live in a separate IndexedDB, not `user` — can't validate synchronously
    // here; SessionsView redirects to the library itself if the id doesn't resolve.
    case 'sessions': return true;
    case 'trending': return true;
  }
}

/** Reads the last route saved for this user, validated against their current data. */
export function loadSavedRoute(user: AppState): Route | null {
  try {
    const raw = localStorage.getItem(`${ROUTE_STORAGE_KEY}:${user.id}`);
    if (!raw) return null;
    const route = JSON.parse(raw) as Route;
    return isValidRoute(route, user) ? route : null;
  } catch {
    return null;
  }
}

/** Persists every future route change for this user. Call once per session, after restoring the saved route. */
export function initRoutePersistence(userId: string): void {
  initHistory(userId);
  effect(() => {
    localStorage.setItem(`${ROUTE_STORAGE_KEY}:${userId}`, JSON.stringify(routeSignal.value));
  });
}

// ── History, and the scroll position that belongs to each entry ──────────────
//
// Offsets are keyed by HISTORY ENTRY, not by route: going back to a list must
// land where that particular visit left off, while arriving at the same list
// afresh — a sidebar link, a command palette jump — must start at the top.
// Keying by route conflates the two and gets the second one wrong.
//
// (Briefly tried the other way on 2026-09-08, as a fallback for reaching a
// section through the sidebar. Reverted: going back and clicking a section are
// not the same gesture, and pretending otherwise makes a deliberate "show me
// this list" land somewhere the user did not ask to be.)
//
// Only the id travels through here — the offsets themselves are written by the
// view layer (components/scrollRestoration.ts), which is the only part that
// knows which element scrolls.

// ── The browser IS the history ───────────────────────────────────────────────
// Until 2026-09-10 this file kept its own back and forward stacks, and the
// browser knew nothing: the app declares `display: standalone`, so on Android
// the system back gesture left the application instead of going back. Two
// users reported it, and it is the gesture one of them made moments before
// losing every recording on their phone.
//
// The two models were already the same shape — a back stack, a forward stack
// truncated on every new navigation, a cursor, a scroll offset per entry — so
// this is an engine swap rather than a graft. `popstate` is now the ONLY thing
// that changes the route on a back or forward, and the "<" / ">" buttons go
// through it too: one source of truth instead of two that can drift.
//
// Entries carry NO url. `pushState(state, '')` with no third argument keeps the
// address bar untouched, which matters here: the app is served from GitHub
// Pages, which has no SPA fallback, so a real path would 404 on a refresh. The
// price is that routes are not linkable — which they were not before either.
// Hash routing is the upgrade path if that ever changes; nothing here forbids it.
//
// A position index rather than a step-by-step mirror, because a back can move
// by more than one entry (the long-press menu on desktop). `idx` is where we
// are, `maxIdx` the furthest forward that still exists, and the two answer
// canGoBack/canGoForward exactly — the platform offers no way to ask whether a
// forward entry exists, which is the one thing we still have to count.

interface NavState {
  /** The one entry that sits BEHIND the app, so a back at the root has
   *  something to land on. Without it the first entry is the tab's first
   *  entry, the document unloads, and popstate never fires — which meant a
   *  back with a dialog open left the app instead of closing the dialog. */
  sentinel?: true;
  /** Ours, so an entry pushed by anything else is left alone. */
  cadence: true;
  /** Position in this app's run of entries. */
  idx: number;
  /** Identity of the entry, for the scroll offsets — NOT the position: coming
   *  back and navigating elsewhere reuses an index but is a different entry. */
  nav: number;
  route: Route;
  /** Whose route this is. The browser's history survives a user switch, so
   *  without this a back could restore a route belonging to another profile. */
  userId: string;
}

let _navSeq = 0;
let _currentNav = 0;
let _idx = 0;
let _maxIdx = 0;
let _userId = '';
const _scrollByNav = new Map<number, number>();

/** Offsets outlive their entries only until this many have accumulated. The
 *  old bookkeeping dropped them alongside a 50-entry stack that no longer
 *  exists; a plain cap on insertion order does the same job without one. */
const MAX_SCROLL_MEMORY = 100;

/** Id of the history entry now on screen. Subscribed to from outside the
 *  component tree, so navigating costs no extra re-render of the app shell. */
export const navEntry = signal(0);

export function rememberScroll(navId: number, top: number): void {
  _scrollByNav.set(navId, top);
  if (_scrollByNav.size > MAX_SCROLL_MEMORY) {
    // Map iterates in insertion order, so the first key is the oldest.
    _scrollByNav.delete(_scrollByNav.keys().next().value!);
  }
}

/** Where to land. A history entry that has been scrolled before answers with
 *  its own offset; anything else answers 0, which is the top — so arriving
 *  somewhere new needs no special case. */
export function recallScroll(navId: number): number {
  return _scrollByNav.get(navId) ?? 0;
}

const stateFor = (route: Route): NavState =>
  ({ cadence: true, idx: _idx, nav: _currentNav, route, userId: _userId });

export function navigate(route: Route): void {
  _idx = _maxIdx = _idx + 1;
  _currentNav = ++_navSeq;
  routeSignal.value  = route;
  canGoBack.value    = true;
  canGoForward.value = false;
  navEntry.value     = _currentNav;
  history.pushState(stateFor(route), '');
}

/** Rate at which the current entry is rewritten. The library view calls
 *  replaceRoute from an effect on its filters, so it fires on every
 *  keystroke in the search box — and browsers throttle history writes
 *  (Safari: 100 per 30 seconds), after which they start being dropped or
 *  throwing. The signal still moves immediately; only the write waits. */
const REPLACE_THROTTLE_MS = 400;
let _replaceTimer: ReturnType<typeof setTimeout> | null = null;

/** Rewrites the CURRENT entry rather than adding one: a filter change is the
 *  same visit, and giving each of them a history entry would make the back
 *  button walk backwards through someone typing. */
export function replaceRoute(route: Route): void {
  routeSignal.value = route;
  if (_replaceTimer) return;   // a trailing write is already scheduled
  _replaceTimer = setTimeout(() => {
    _replaceTimer = null;
    // Reads the signal rather than the captured argument: the last value
    // wins, which is the point of coalescing them.
    history.replaceState(stateFor(routeSignal.value), '');
  }, REPLACE_THROTTLE_MS);
}

// Deliberately thin: they hand the gesture to the platform and let popstate do
// the work, so the button and the system gesture cannot diverge. Neither is
// synchronous — popstate arrives on a later task — which is why the enabled
// state is read from the signals rather than recomputed here.
export function goBack(): void { history.back(); }
export function goForward(): void { history.forward(); }

/** Installs the bridge for this user, and makes the current route the baseline.
 *
 *  Called on every user open, which is also what re-baselines after a switch:
 *  entries pushed by the previous profile stay in the browser's stack, so they
 *  are recognised by their userId and answered with the home view rather than
 *  with someone else's route. */
function initHistory(userId: string): void {
  _userId = userId;
  _idx = _maxIdx = 0;
  _currentNav = ++_navSeq;
  navEntry.value = _currentNav;
  canGoBack.value = false;
  canGoForward.value = false;
  // Or the browser restores its own scroll position and fights _scrollByNav.
  if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
  if (!_sentinelPushed) {
    _sentinelPushed = true;
    // Replace the current entry with the sentinel, then push the real
    // baseline on top of it. Net effect: one entry of ours behind the app.
    history.replaceState({ ...stateFor(routeSignal.value), sentinel: true }, '');
    history.pushState(stateFor(routeSignal.value), '');
  } else {
    history.replaceState(stateFor(routeSignal.value), '');
  }

  if (_popstateBound) return;
  _popstateBound = true;
  window.addEventListener('popstate', (e) => {
    // Our own doing (see the forward below): the cursor is back where it
    // belongs and there is nothing to decide.
    if (_swallowNextPop > 0) { _swallowNextPop--; return; }

    const st = e.state as NavState | null;
    // Not ours (an entry from before the app loaded): nothing to apply.
    if (!st || st.cadence !== true) return;

    // Something is open on top: the gesture belongs to IT, not to the route.
    // Close one layer and put the cursor back where it was.
    //
    // `forward()`, NOT `pushState`. Both return the cursor, but pushState
    // TRUNCATES everything ahead of it — so closing a dialog after having
    // gone back used to destroy the forward history. forward() only moves
    // the cursor and leaves the entries alone.
    //
    // This is also why overlays own no history entry of their own: pushing
    // one on open would truncate the forward stack at the moment the dialog
    // APPEARS, which is worse — the entry would be gone before the user had
    // done anything at all.
    // Cancelled in the OPPOSITE direction to the gesture, or the cursor ends
    // up somewhere the app is not showing — and the swallow counter, primed
    // for an event that never comes, eats the next real one. The sentinel is
    // always behind us, so landing on it is always a back.
    const wentBack = st.sentinel === true || st.idx < _idx;
    if (closeTopOverlay()) {
      _swallowNextPop++;
      if (wentBack) history.forward(); else history.back();
      return;
    }

    // The sentinel, with nothing open: the user asked to leave, so let them.
    if (st.sentinel) { history.back(); return; }

    _idx = st.idx;
    _currentNav = st.nav;
    canGoBack.value    = _idx > 0;
    canGoForward.value = _idx < _maxIdx;
    routeSignal.value  = st.userId === _userId ? st.route : { view: 'folder', folderId: null };
    navEntry.value     = _currentNav;
  });
}

let _popstateBound = false;
let _sentinelPushed = false;
/** popstate events this handler caused itself, and must not act on again.
 *  Cancelling a back means moving the cursor forward, which fires a second
 *  popstate for the entry we just returned to. */
let _swallowNextPop = 0;

/** The single place a new state becomes the current one.
 *
 *  Derived fields are brought back in line here rather than at each site that
 *  could invalidate them: every state change in the app passes through this
 *  function or one of main.ts's boot paths, so recomputing unconditionally at
 *  the choke point cannot miss a writer — whereas enumerating writers can, and
 *  silently. Call it BEFORE persisting, so what is saved is what is shown.
 *
 *  Idempotent (see normaliseState), so a state that is already in order costs
 *  a pass and changes nothing. */
export function commitState(next: AppState): void {
  normaliseState(next);
  appState.value = next;
}

export async function mutate(fn: (user: AppState) => void): Promise<void> {
  const next = structuredClone(appState.value);
  fn(next);
  commitState(next);
  await saveUser(next);
  syncToCloud(next);
}

/** Apply data received from Drive without triggering a sync-back. */
export async function applyFromDrive(fn: (user: AppState) => void): Promise<void> {
  const next = structuredClone(appState.value);
  fn(next);
  commitState(next);
  // The world changed under the user's feet: remount the current view so its
  // mount-time drafts re-derive from the applied state. If what it showed no
  // longer exists (a card deleted on another device), the view's own
  // not-found fallback handles it — no forced navigation.
  stateEpoch.value++;
  await saveUser(next);
}

export function getContext(): AppContext {
  return {
    user:         appState.value,
    route:        routeSignal.value,
    navigate,
    back:         goBack,
    forward:      goForward,
    canGoBack:    canGoBack.value,
    canGoForward: canGoForward.value,
    mutate,
  };
}
