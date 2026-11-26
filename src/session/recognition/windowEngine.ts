import type { DetectionEvent, WindowResult } from '../model';

// ── What hears a recognition window ──────────────────────────────────────────
// (2026-11-26) The recognition worker (ffWorker.ts) owns the audio, the index
// and the segmenter; an engine turns each window of audio into its candidates.
// Two engines, the same contract:
//   - 'transcriptor' (transcriptorEngine.ts), the default: transcriptor/'s note
//     decoder writes the contour;
//   - 'folkfriend' (folkfriendEngine.ts): FolkFriend's own decoder, as Cadence
//     recognised before — kept to compare with, behind a hidden switch
//     (services/recognitionEngine.ts).
// Both query the same index the same way (folkfriendQuery.ts).

export type RecognitionEngineId = 'transcriptor' | 'folkfriend';

export interface WindowEngine {
  /** The window [tStart, tEnd] of `pcm` (at the worker's rate) heard: its candidates, and the
   *  contour written as ABC for display. */
  analyze(pcm: Float32Array, tStart: number, tEnd: number): { result: WindowResult; abc: string | null };
  /** The segmenter's events once it has stepped the last window analysed. */
  stepped(events: DetectionEvent[]): void;
  /** A new recording starts. */
  reset(): void;
}
