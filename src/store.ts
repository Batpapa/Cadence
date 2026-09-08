import { signal, effect } from '@preact/signals';
import type { AppState, AppContext, Route } from './types';
import { emptyState } from './utils';
import { saveUser } from './db';
import { syncToCloud } from './services/driveService';
import { normaliseState } from './services/stateNormalise';

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

interface HistoryEntry { route: Route; nav: number }

const _history: HistoryEntry[] = [];
const _future:  HistoryEntry[] = [];

let _navSeq = 0;
let _currentNav = 0;
const _scrollByNav = new Map<number, number>();

/** Id of the history entry now on screen. Subscribed to from outside the
 *  component tree, so navigating costs no extra re-render of the app shell. */
export const navEntry = signal(0);

export function rememberScroll(navId: number, top: number): void {
  _scrollByNav.set(navId, top);
}

/** Where to land. A history entry that has been scrolled before answers with
 *  its own offset; anything else answers 0, which is the top — so arriving
 *  somewhere new needs no special case. */
export function recallScroll(navId: number): number {
  return _scrollByNav.get(navId) ?? 0;
}

/** Entries that can never be returned to must not keep their offset alive —
 *  the map would otherwise grow for the lifetime of the session. */
function forgetScroll(entries: HistoryEntry[]): void {
  for (const e of entries) _scrollByNav.delete(e.nav);
}

export function navigate(route: Route): void {
  _history.push({ route: routeSignal.value, nav: _currentNav });
  if (_history.length > 50) forgetScroll(_history.splice(0, _history.length - 50));
  forgetScroll(_future);
  _future.length     = 0;
  _currentNav        = ++_navSeq;
  routeSignal.value  = route;
  canGoBack.value    = true;
  canGoForward.value = false;
  navEntry.value     = _currentNav;
}

export function replaceRoute(route: Route): void {
  routeSignal.value = route;
}

export function goBack(): void {
  const prev = _history.pop();
  if (!prev) return;
  _future.push({ route: routeSignal.value, nav: _currentNav });
  _currentNav        = prev.nav;
  routeSignal.value  = prev.route;
  canGoBack.value    = _history.length > 0;
  canGoForward.value = true;
  navEntry.value     = _currentNav;
}

export function goForward(): void {
  const next = _future.pop();
  if (!next) return;
  _history.push({ route: routeSignal.value, nav: _currentNav });
  _currentNav        = next.nav;
  routeSignal.value  = next.route;
  canGoBack.value    = true;
  canGoForward.value = _future.length > 0;
  navEntry.value     = _currentNav;
}

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
