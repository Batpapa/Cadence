// ── Drive reconciliation policy ──────────────────────────────────────────────
// The decision table for "local vs Drive", extracted PURE so it can be unit
// tested exhaustively (driveService.ts touches localStorage at module eval and
// cannot be imported under node). driveService feeds it from its bookkeeping
// and applies its verdict — no I/O happens here.
//
// Trust model (2026-08-31 redesign, after a real user lost hours of work):
//  - "Did Drive move?" is answered by Drive's own server-side file `version`
//    (a monotonic write counter) against the version recorded at our last sync
//    point. Never by comparing device wall clocks — clocks across devices
//    proved able to hide a moved Drive ("reverted file loses to any local
//    timestamp") and to hide moved local edits (a fast-forward applied over
//    real work).
//  - "Did local move?" is answered by a local edit counter (editSeq vs
//    syncedSeq) — same-device, monotonic, immune to clock changes and to the
//    old bug where a successful upload rewound the local timestamp over edits
//    made during the upload.
//  - With no version recorded, the content stamp at the last sync point (when
//    there is one) stands in for it — equality only, never a clock comparison.
//    With neither, nothing proves how the copies are related: everything but
//    a never-modified local is the user's call.
//  - Divergence is NEVER resolved silently. The old "same device wrote Drive →
//    newer timestamp wins" shortcut is gone: last writer says nothing about
//    lineage (a stale tab writes later yet carries older data).

export interface ReconcileInputs {
  /** False when the Drive file exists but holds nothing usable (empty husk). */
  hasData: boolean;
  /** `_lastModified` stamped inside the Drive payload (0 if absent). */
  driveTs: number;
  /** Drive's server-side file version at this read. */
  driveVersion: string;
  /** File version recorded at our last sync point — null before first
   *  version-based sync (fresh connect, or an install predating the redesign). */
  syncedVersion: string | null;
  /** Content timestamp at last sync (0 = none recorded): what tells a phantom
   *  version bump from a real write, and the base itself when no version was
   *  recorded. */
  syncedTs: number;
  /** Local-edit stamp (wall clock of THIS device): with no base, whether
   *  local has lived at all. */
  localTs: number;
  /** Local edit counter / its value at last sync. */
  editSeq: number;
  syncedSeq: number;
}

export interface ReconcileDecision {
  action: 'none' | 'apply' | 'conflict';
  /** True when this read PROVES local and Drive are the same content, so the
   *  caller should record driveVersion as the new base (a phantom version
   *  bump, or a base known by its content stamp only — below). */
  adoptVersion: boolean;
}

export function decideReconcile(i: ReconcileInputs): ReconcileDecision {
  // Drive holds nothing usable: local is the only real copy, keep it (a later
  // flush pushes it; Drive's own revision history retains the husk anyway).
  if (!i.hasData) return { action: 'none', adoptVersion: false };

  const localMoved = i.editSeq > i.syncedSeq;

  if (i.syncedVersion !== null) {
    // ── Version-based (normal regime) ──
    const driveMoved = i.driveVersion !== i.syncedVersion;
    if (!driveMoved) return { action: 'none', adoptVersion: false };
    // Phantom bump: Drive's `version` reflects EVERY server-side change, not
    // just writes ("even those not visible to the user" — indexing and other
    // post-processing), so it can advance right after our own upload with
    // nobody having written anything. The content stamp is the ground truth:
    // if the file still carries exactly the `_lastModified` we recorded at our
    // last sync point, no one wrote — adopt the new version and move on.
    // (2026-08-31: without this, a single device hit the conflict modal on its
    // SECOND push — precondition mismatch → reconcile → "both moved".)
    if (i.hasData && i.driveTs > 0 && i.driveTs === i.syncedTs) {
      return { action: 'none', adoptVersion: true };
    }
    if (!localMoved) return { action: 'apply', adoptVersion: false };
    return { action: 'conflict', adoptVersion: false };
  }

  if (i.syncedTs > 0) {
    // ── Base known by its content stamp only ──
    // No version recorded, but the content last agreed on is known by its
    // `_lastModified`: an upload whose answer carried no usable version
    // (recordSyncPoint drops the version rather than keep a stale one), or an
    // install from before the 2026-08-31 redesign. The same rule as above with
    // the stamp in the version's place — no clock is compared, only equality:
    // an equal stamp proves Drive still holds exactly that content (in sync,
    // adopt its version); any other stamp means Drive moved, a revert to an
    // older stamp included. Local's side is the edit counter, as above.
    //
    // Until 2026-11-26 this was a "transitional" branch that compared the
    // stamps and the local wall clock as the pre-redesign code did; the clock
    // comparisons went, the stamp's proof stays — it is not transitional.
    if (i.driveTs === i.syncedTs) return { action: 'none', adoptVersion: true };
    if (!localMoved) return { action: 'apply', adoptVersion: false };
    return { action: 'conflict', adoptVersion: false };
  }

  // ── No base at all (fresh connect, wiped bookkeeping) ──
  // Nothing proves how the two copies are related; only a never-modified local
  // has nothing to say. Everything else is the user's call.
  if (i.localTs === 0 && i.editSeq === 0) return { action: 'apply', adoptVersion: false };
  return { action: 'conflict', adoptVersion: false };
}
