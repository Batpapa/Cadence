import { describe, expect, it } from 'vitest';
import { assessStorage } from './storageService';

// The rule behind the header's warning triangle, kept pure so it can be pinned
// down without a browser. It exists because of a real loss on 2026-09-09: an
// installed PWA holding many hours of recordings came back with an empty user
// store, and nothing in the app had ever asked the browser to stop evicting it.
//
// Two properties matter and neither is obvious from the code that reads it:
// silence is not consent, and a full disk is not the same danger as an
// evictable one.

describe('assessStorage', () => {
  it('says nothing once the browser has granted persistence', () => {
    expect(assessStorage(true)).toBe('none');
  });

  it('warns when the browser has refused', () => {
    expect(assessStorage(false)).toBe('refused');
  });

  it('warns when the browser will not say', () => {
    // A browser with no StorageManager reports null. Treating that as safe is
    // how someone finds out afterwards, which is exactly what happened.
    expect(assessStorage(null)).toBe('unknown');
  });

  it('stays quiet while the boot request is still in flight', () => {
    // undefined is "not asked yet", which is not the same as "cannot tell".
    // Warning here would flash a triangle on every cold start that resolves
    // away a moment later, and that is how people learn to ignore triangles.
    expect(assessStorage(undefined)).toBe('none');
  });
});
