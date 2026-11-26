// ── When this page's boot has done its work with Drive ───────────────────────
// Settles once the boot reconciliation is over — Drive read and its copy
// applied or the question asked, the read failed, or there was nothing to read
// (Drive not connected, the device offline). Never rejects.
//
// What only makes sense after it, or would compete with it for the network and
// the token, waits on this instead of a fixed delay: until 2026-11-26 the launch
// pass of the recordings' uploads and the snapshots' sweep each waited 8 s, too
// long where there was nothing to wait for, too short on a slow phone whose
// reconciliation took longer than that.
//
// Set by main.ts's finishBoot, once per page. A page that never boots a user
// (the recovery screen, the standalone pages) never settles it, and what waits
// on it does not run there — none of it belongs there.

let settle!: () => void;

export const bootSettled: Promise<void> = new Promise(resolve => { settle = resolve; });

export function markBootSettled(): void {
  settle();
}
