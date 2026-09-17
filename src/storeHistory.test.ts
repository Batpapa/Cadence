// @vitest-environment jsdom
// The store reaches driveService, which reads localStorage at module evaluation
// — in a bare node environment the import throws before a single test runs.
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { routeSignal, canGoBack, canGoForward, navigate, replaceRoute, initRoutePersistence, leaveStudy } from './store';
import type { Route } from './types';

// ── The browser history bridge ───────────────────────────────────────────────
// Added with it (2026-09-10). The app declares `display: standalone`, so before
// this the Android back gesture left the application instead of going back —
// reported twice, and it is the gesture one user made moments before losing
// every recording on their phone.
//
// popstate is delivered here as a synthetic event rather than through
// history.back(): jsdom's implementation of session history is partial and
// asynchronous, and what matters is what the LISTENER does with a given state,
// which is exactly what a dispatched event pins down.

const HOME: Route = { view: 'folder', folderId: null };
const LIB: Route = { view: 'library' };

/** What the listener would receive for an entry at `idx`. */
const pop = (state: unknown) => window.dispatchEvent(new PopStateEvent('popstate', { state }));
const entry = (idx: number, route: Route, userId = 'u1') =>
  ({ cadence: true, idx, nav: 100 + idx, route, userId });

beforeEach(() => {
  routeSignal.value = HOME;
  initRoutePersistence('u1');
});

describe('navigate', () => {
  it('adds a history entry and can go back but not forward', () => {
    const before = history.length;
    navigate(LIB);
    expect(history.length).toBe(before + 1);
    expect(canGoBack.value).toBe(true);
    expect(canGoForward.value).toBe(false);
  });

  it('puts the route in the entry, so popstate can restore it without our stacks', () => {
    navigate(LIB);
    expect((history.state as { route: Route }).route).toEqual(LIB);
  });
});

describe('replaceRoute', () => {
  it('does not add an entry — a filter change is the same visit', () => {
    const before = history.length;
    replaceRoute({ view: 'library', search: 'kesh' });
    expect(history.length).toBe(before);
    expect(routeSignal.value).toEqual({ view: 'library', search: 'kesh' });
  });
});

describe('leaveStudy', () => {
  // Every card of a session is its own entry, so "Back to deck" used to reopen
  // the last card rated (2026-09-15). What it must do is jump over the whole
  // run of study entries at once.
  const DECK: Route = { view: 'deck', deckId: 'd1' };
  const card = (id: string | null): Route => ({ view: 'study', deckId: 'd1', strategy: 'optimal', currentCardId: id });

  it('jumps back over every card of the session to the page it started from', () => {
    const go = vi.spyOn(history, 'go').mockImplementation(() => {});
    navigate(DECK);
    navigate(card('a'));
    navigate(card('b'));
    navigate(card(null));   // the end screen
    expect(leaveStudy()).toBe(true);
    expect(go).toHaveBeenCalledWith(-3);
    go.mockRestore();
  });

  it('stops at the page just before the session, not at an older one', () => {
    const go = vi.spyOn(history, 'go').mockImplementation(() => {});
    navigate(DECK);
    navigate(LIB);
    navigate(card('a'));
    expect(leaveStudy()).toBe(true);
    expect(go).toHaveBeenCalledWith(-1);
    go.mockRestore();
  });

  it('reports false when the app was reopened straight onto the session', () => {
    routeSignal.value = card('a');
    initRoutePersistence('u1');
    const go = vi.spyOn(history, 'go').mockImplementation(() => {});
    expect(leaveStudy()).toBe(false);
    expect(go).not.toHaveBeenCalled();
    go.mockRestore();
  });
});

describe('popstate', () => {
  it('restores the route the entry carries', () => {
    navigate(LIB);
    pop(entry(0, HOME));
    expect(routeSignal.value).toEqual(HOME);
  });

  it('reports forward as available once back has been used', () => {
    navigate(LIB);
    pop(entry(0, HOME));
    expect(canGoBack.value).toBe(false);
    expect(canGoForward.value).toBe(true);
  });

  it('handles a jump of more than one entry, which the long-press menu allows', () => {
    navigate(LIB);
    navigate({ view: 'card', cardId: 'c1' });
    navigate({ view: 'modules' });
    pop(entry(0, HOME));           // three back in one go
    expect(routeSignal.value).toEqual(HOME);
    expect(canGoBack.value).toBe(false);
    expect(canGoForward.value).toBe(true);
  });

  it('ignores an entry that is not ours', () => {
    navigate(LIB);
    pop({ someOtherApp: true });
    expect(routeSignal.value).toEqual(LIB);
  });

  it('ignores a null state, which is what an entry from before the app carries', () => {
    navigate(LIB);
    pop(null);
    expect(routeSignal.value).toEqual(LIB);
  });

  it('lands home rather than on another profile route after a user switch', () => {
    // The browser's history survives logging out, so an entry pushed by the
    // previous user is still reachable — and its route names their data.
    navigate(LIB);
    pop(entry(0, { view: 'card', cardId: 'someone-elses-card' }, 'u2'));
    expect(routeSignal.value).toEqual(HOME);
  });
});
