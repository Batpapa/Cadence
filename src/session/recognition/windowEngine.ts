import type { DetectionEvent, WindowResult } from '../model';

// ── What hears a recognition window ──────────────────────────────────────────
// (2026-11-26) The recognition worker (ffWorker.ts) owns the audio, the index
// and the segmenter; an engine turns each window of audio into its candidates.
// The engine is transcriptor/'s note decoder (transcriptorEngine.ts), querying
// FolkFriend's index (folkfriendQuery.ts). FolkFriend's own decoder, which heard
// the windows until then, is compared with in the benches only, not in the app.
// The contract stays its own: another engine would be another implementation.

export interface WindowEngine {
  /** The window [tStart, tEnd] of `pcm` (at the worker's rate) heard: its candidates, and the
   *  contour written as ABC for display. */
  analyze(pcm: Float32Array, tStart: number, tEnd: number): { result: WindowResult; abc: string | null };
  /** The segmenter's events once it has stepped the last window analysed. */
  stepped(events: DetectionEvent[]): void;
  /** A new recording starts. */
  reset(): void;
}
