// ── The app's analyser without a library (2026-10-26) ────────────────────────
// TuneAnalyser/, the standalone page, runs the app's own analyser for a user
// who lives in memory (store.ts's openEphemeralUser). There is no library
// behind it: the actions that make, link or rate a card are not offered —
// they would fill a library that vanishes with the page — nor analysis
// folders, which an account would one day have to merge. Set once, before
// anything renders; the app never sets it.

let withoutLibrary = false;

export function runWithoutLibrary(): void {
  withoutLibrary = true;
}

export function hasLibrary(): boolean {
  return !withoutLibrary;
}
