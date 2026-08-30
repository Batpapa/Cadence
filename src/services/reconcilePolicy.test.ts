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

describe('decideReconcile — transitional (legacy install, no version recorded)', () => {
  const legacy = (over: Partial<ReconcileInputs> = {}) =>
    base({ syncedVersion: null, editSeq: 0, syncedSeq: 0, ...over });

  it('content stamp equals base → none + adopt (the silent graduation every deployed install takes)', () => {
    expect(decideReconcile(legacy())).toEqual({ action: 'none', adoptVersion: true });
  });

  it('graduation still happens with unsynced local edits pending', () => {
    const d = decideReconcile(legacy({ localTs: 2000, editSeq: 1 }));
    expect(d).toEqual({ action: 'none', adoptVersion: true });
  });

  it('drive ahead, local unchanged → apply (old behavior preserved)', () => {
    expect(decideReconcile(legacy({ driveTs: 2000 })).action).toBe('apply');
  });

  it('both ahead → conflict — the same-device shortcut is gone', () => {
    const d = decideReconcile(legacy({ driveTs: 2000, localTs: 1500 }));
    expect(d.action).toBe('conflict');
  });

  it('local ahead via seq only (timestamps rewound) → still conflict', () => {
    const d = decideReconcile(legacy({ driveTs: 2000, localTs: 900, editSeq: 3 }));
    expect(d.action).toBe('conflict');
  });

  it('drive behind base (legacy revert) → none, as before the redesign (no NEW regression)', () => {
    expect(decideReconcile(legacy({ driveTs: 500 })).action).toBe('none');
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
