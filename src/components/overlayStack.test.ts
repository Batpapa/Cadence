import { describe, expect, it, beforeEach } from 'vitest';
import { registerOverlay, closeTopOverlay, anyOverlayOpen } from './overlayStack';

// The registry the back gesture asks. Before it, "close the topmost thing" had
// no answer anywhere in the app: modal.tsx had a stack, and the settings
// dialog, the library's export picker and the new-card overlay each had their
// own escape hatch. Escape survived that because every listener stopped at its
// own scope; the Android back gesture asks from outside all of them.

beforeEach(() => {
  // Drain whatever a previous test left, so each starts empty.
  while (closeTopOverlay()) { /* pop */ }
});

describe('overlayStack', () => {
  it('reports nothing open when nothing is', () => {
    expect(anyOverlayOpen()).toBe(false);
    expect(closeTopOverlay()).toBe(false);
  });

  it('closes the most recently opened one', () => {
    const closed: string[] = [];
    registerOverlay(() => closed.push('first'));
    registerOverlay(() => closed.push('second'));
    closeTopOverlay();
    expect(closed).toEqual(['second']);
  });

  it('unwinds one layer at a time', () => {
    const closed: string[] = [];
    registerOverlay(() => closed.push('a'));
    registerOverlay(() => closed.push('b'));
    registerOverlay(() => closed.push('c'));
    while (closeTopOverlay()) { /* pop */ }
    expect(closed).toEqual(['c', 'b', 'a']);
  });

  it('forgets one closed by its own means, without closing it twice', () => {
    // The ✕, Escape, or an action that finishes: the overlay is gone and calls
    // its unregister. Holding its closer would mean a later back "closes"
    // something that is not there.
    let calls = 0;
    const unregister = registerOverlay(() => { calls++; });
    unregister();
    expect(anyOverlayOpen()).toBe(false);
    expect(closeTopOverlay()).toBe(false);
    expect(calls).toBe(0);
  });

  it('removes the right one when a lower layer closes first', () => {
    // Not the usual order, but it happens: an action inside a dialog can close
    // something underneath it. Removal is by identity, not by position.
    const closed: string[] = [];
    const unregisterLow = registerOverlay(() => closed.push('low'));
    registerOverlay(() => closed.push('high'));
    unregisterLow();
    closeTopOverlay();
    expect(closed).toEqual(['high']);
    expect(anyOverlayOpen()).toBe(false);
  });

  it('cannot be left with an entry nothing can close', () => {
    // The closer is expected to run its own unregister; one that forgets must
    // not leave the stack stuck, so the pop happens first.
    registerOverlay(() => { /* forgets to unregister */ });
    expect(closeTopOverlay()).toBe(true);
    expect(anyOverlayOpen()).toBe(false);
  });
});
