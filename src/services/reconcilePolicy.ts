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
//  - When only pre-redesign bookkeeping exists (timestamps, no version), the
//    old rules apply for that one read so existing installs migrate without a
//    spurious conflict — and graduate to version-based tracking at their next
//    successful sync (see `adoptVersion`).
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
  /** Legacy merge base: content timestamp at last sync (0 = none recorded). */
  syncedTs: number;
  /** Legacy local-edit stamp (wall clock of THIS device). */
  localTs: number;
  /** Local edit counter / its value at last sync. */
  editSeq: number;
  syncedSeq: number;
}

export interface ReconcileDecision {
  action: 'none' | 'apply' | 'conflict';
  /** True when this read PROVES local and Drive are the same content, so the
   *  caller should record driveVersion as the new base (legacy installs
   *  graduating to version-based tracking without a sync round trip). */
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
    if (!localMoved) return { action: 'apply', adoptVersion: false };
    return { action: 'conflict', adoptVersion: false };
  }

  if (i.syncedTs > 0) {
    // ── Transitional: pre-redesign install, timestamps only ──
    // Content stamp equal to our base proves Drive still holds exactly what we
    // last synced — in sync, adopt the current version as base silently. This
    // is the path virtually every existing install takes on its first boot
    // after the redesign deploys: no modal, no behavior change.
    if (i.driveTs === i.syncedTs) return { action: 'none', adoptVersion: true };
    // Otherwise fall back to the old stamp comparison for this one read (same
    // risks as the old code, no NEW regression — it graduates at the next
    // successful sync). The same-device shortcut is deliberately absent.
    const driveMoved = i.driveTs > i.syncedTs;
    const legacyLocalMoved = i.localTs > i.syncedTs || localMoved;
    if (!driveMoved) return { action: 'none', adoptVersion: false };
    if (!legacyLocalMoved) return { action: 'apply', adoptVersion: false };
    return { action: 'conflict', adoptVersion: false };
  }

  // ── No base at all (fresh connect, wiped bookkeeping) ──
  // Nothing proves how the two copies are related; only a never-modified local
  // has nothing to say. Everything else is the user's call.
  if (i.localTs === 0 && i.editSeq === 0) return { action: 'apply', adoptVersion: false };
  return { action: 'conflict', adoptVersion: false };
}
