import { signal } from '@preact/signals';
import { LiveSession } from '../liveSession';
import { ImportSession } from '../importSession';
import type { WindowResult } from '../model';

// ── Long-lived session store ──────────────────────────────────────────────────
// LiveSession / ImportSession are NOT tied to any component's lifecycle: a
// recording keeps running when the user navigates away, and the UI just
// re-synchronizes on it when they come back. That's why these live in
// module-level signals here, not in a component's useState/useEffect — an
// effect that created/destroyed one on mount/unmount would kill the
// recording on every navigation. Components read and write this store; they
// never own the objects in it.
//
// Step 1 of the Preact migration (2026-08-24): this file exists purely to
// hold what used to be sessionModule.ts's own module-level variables, with
// the exact same read/write semantics — no UI behavior changes here. The
// live annotation feed / import progress become their own signals in a later
// step, once something actually consumes them reactively (wiring them now,
// unconsumed, would be dead code carrying real risk for a checkpoint whose
// entire point is "verify nothing changed").

export const activeLive = signal<LiveSession | null>(null);
export const activeImport = signal<ImportSession | null>(null);

/** Reactive mirror of activeLive/activeImport — plain signals aren't enough on
 *  their own for chrome far from the session screens (header dot, modules
 *  page): this one dedicated boolean is what lets them update live without
 *  the user having to reopen the sessions view. */
export const sessionRecordingSignal = signal(false);

function syncRecordingSignal(): void {
  sessionRecordingSignal.value = activeLive.value !== null || activeImport.value !== null;
}

export function setActiveLive(v: LiveSession | null): void {
  activeLive.value = v;
  syncRecordingSignal();
}

export function setActiveImport(v: ImportSession | null): void {
  activeImport.value = v;
  syncRecordingSignal();
}

/** Raw window dump of the last completed import — detectionTemporalConfig.ts
 *  calibration tool, read once by the summary screen. Not reactive: nothing
 *  needs to re-render when it changes, it's set once right before navigating
 *  to the summary that reads it. */
export const lastImportDump = signal<{ sessionId: string; windows: WindowResult[] } | null>(null);

/** Same idea for the last completed LIVE session, plus a wall-clock cross
 *  reference per window (see LiveSession.windows) — lets a drift
 *  investigation compare the worker's sample-counted clock against real
 *  elapsed time directly, which an import dump can't do (import runs faster
 *  than real time). */
export const lastLiveDump = signal<{ sessionId: string; windows: (WindowResult & { wallMs: number })[] } | null>(null);

/** Synchronous re-entrancy guard: startImport/startReanalyze await before
 *  setting activeImport — a session-scoped singleton flag, not view state. */
export const importStarting = signal(false);

/** Playback warning for the current import (format analysable but not
 *  playable) — a property of the in-progress ImportSession, not of whichever
 *  component happens to be showing it. */
export const importPlaybackWarn = signal(false);
