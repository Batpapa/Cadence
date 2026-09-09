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

describe('assessStorage — capacity', () => {
  // The second danger, and the one that outranks durability: a persistent
  // grant is never revoked when the origin fills up, so "safe" would keep
  // reporting safe while writes started failing. And SessionFileRecorder
  // swallows exactly those failures ("keep recording, chunk lost"), so nothing
  // else on screen would say a word.
  it('warns at 80% of the quota even when persistence was granted', () => {
    expect(assessStorage(true, 80, 100)).toBe('full');
  });

  it('outranks a refusal, because it is already losing data rather than risking it', () => {
    expect(assessStorage(false, 95, 100)).toBe('full');
  });

  it('stays quiet below the threshold', () => {
    expect(assessStorage(true, 79, 100)).toBe('none');
  });

  it('still reports the durability problem below the threshold', () => {
    expect(assessStorage(false, 10, 100)).toBe('refused');
  });

  it('says nothing about capacity when the browser gives no figures', () => {
    expect(assessStorage(true, null, null)).toBe('none');
    expect(assessStorage(true)).toBe('none');
  });

  it('does not divide by a zero quota', () => {
    expect(assessStorage(true, 0, 0)).toBe('none');
  });
});
