import { describe, it, expect } from 'vitest';
import { decideReconcile, type ReconcileInputs } from './reconcilePolicy';

/** Baseline: version-regime install, fully in sync. Tests override the deltas. */
function base(over: Partial<ReconcileInputs> = {}): ReconcileInputs {
  return {
    hasData: true,
    driveTs: 1000,
    driveVersion: '7',
    syncedVersion: '7',
    syncedTs: 1000,
    localTs: 1000,
    editSeq: 4,
    syncedSeq: 4,
    ...over,
  };
}

describe('decideReconcile — version regime', () => {
  it('in sync → none', () => {
    expect(decideReconcile(base())).toEqual({ action: 'none', adoptVersion: false });
  });

  it('only local moved → none (a later flush pushes it)', () => {
    expect(decideReconcile(base({ editSeq: 5 })).action).toBe('none');
  });

  it('only Drive moved (real content change) → apply', () => {
    expect(decideReconcile(base({ driveVersion: '9', driveTs: 2000 })).action).toBe('apply');
  });

  it('both moved → conflict', () => {
    expect(decideReconcile(base({ driveVersion: '9', driveTs: 2000, editSeq: 5 })).action).toBe('conflict');
  });

  it('phantom version bump (server-side churn, content untouched) → none + adopt', () => {
    // Drive's version advanced but the file still carries exactly the
    // _lastModified we recorded — nobody wrote. This was the single-device
    // "conflict modal on my second push" bug (2026-08-31).
    expect(decideReconcile(base({ driveVersion: '9' , driveTs: 1000 })))
      .toEqual({ action: 'none', adoptVersion: true });
  });

  it('phantom bump with local edits pending → still none + adopt (push may proceed)', () => {
    expect(decideReconcile(base({ driveVersion: '9', driveTs: 1000, editSeq: 5 })))
      .toEqual({ action: 'none', adoptVersion: true });
  });

  it('a REVERTED Drive file (older content, new version) still registers as moved', () => {
    // The old timestamp logic returned 'none' here (driveTs < syncedTs) and the
    // revert could never win — the exact bug behind the 2026-08-31 incident test.
    const d = decideReconcile(base({ driveVersion: '9', driveTs: 500 }));
    expect(d.action).toBe('apply');
  });

  it('clock skew is irrelevant: local edits counted, not dated', () => {
    // Device clock rewound far before the sync point — editSeq still says moved.
    const d = decideReconcile(base({ driveVersion: '9', driveTs: 2000, localTs: 1, editSeq: 5 }));
    expect(d.action).toBe('conflict');
  });
});

describe('decideReconcile — base known by its content stamp only (no version recorded)', () => {
  // An upload whose answer carried no version, or a pre-redesign install
  // (its counters seeded from the old timestamps at init).
  const stampOnly = (over: Partial<ReconcileInputs> = {}) =>
    base({ syncedVersion: null, editSeq: 0, syncedSeq: 0, ...over });

  it('content stamp equals base → none + adopt', () => {
    expect(decideReconcile(stampOnly())).toEqual({ action: 'none', adoptVersion: true });
  });

  it('adopted with unsynced local edits pending too (the push follows)', () => {
    expect(decideReconcile(stampOnly({ localTs: 2000, editSeq: 1 }))).toEqual({ action: 'none', adoptVersion: true });
  });

  it('drive moved, local unchanged → apply', () => {
    expect(decideReconcile(stampOnly({ driveTs: 2000 }))).toEqual({ action: 'apply', adoptVersion: false });
  });

  it('both moved → conflict', () => {
    expect(decideReconcile(stampOnly({ driveTs: 2000, editSeq: 3 })).action).toBe('conflict');
  });

  it('a REVERTED Drive file (older stamp) registers as moved, as it does under versions', () => {
    // The transitional rule (until 2026-11-26) compared the stamps and said
    // 'none' here — keeping local and later pushing it over the revert.
    expect(decideReconcile(stampOnly({ driveTs: 500 })).action).toBe('apply');
    expect(decideReconcile(stampOnly({ driveTs: 500, editSeq: 1 })).action).toBe('conflict');
  });

  it('the local wall clock is not read: a stamp ahead with no counted edit is not a local move', () => {
    expect(decideReconcile(stampOnly({ driveTs: 2000, localTs: 5000 })).action).toBe('apply');
  });
});

describe('decideReconcile — no base at all', () => {
  const fresh = (over: Partial<ReconcileInputs> = {}) =>
    base({ syncedVersion: null, syncedTs: 0, localTs: 0, editSeq: 0, syncedSeq: 0, ...over });

  it('virgin local → apply', () => {
    expect(decideReconcile(fresh()).action).toBe('apply');
  });

  it('local has lived (timestamp) → conflict', () => {
    expect(decideReconcile(fresh({ localTs: 5 })).action).toBe('conflict');
  });

  it('local has lived (counter only) → conflict', () => {
    expect(decideReconcile(fresh({ editSeq: 1 })).action).toBe('conflict');
  });
});

describe('decideReconcile — unusable Drive content', () => {
  it('empty husk → none regardless of everything else', () => {
    expect(decideReconcile(base({ hasData: false, driveVersion: '99', editSeq: 9 })).action).toBe('none');
  });
});
