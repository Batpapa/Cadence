import type { WindowResult } from '../model';
import type { DetectionTemporalConfig } from './detectionTemporalConfig';

// ── Temporal observation builder ────────────────────────────────────────────
// RecognitionResult (WindowResult[]) -> TemporalTimeline. Pure, no DP here —
// just reshapes "N windows, each with up to N candidates" into "one dense
// probability array per candidate tuneId, 0 where absent that window", which
// is what viterbiDetector.ts's Viterbi sweep needs. See the 2026-08-13 spec's
// section 2 ("un morceau absent du top 100 doit être considéré comme ayant
// une probabilité de 0" — NOT simply ignored).

export const UNKNOWN_STATE = '__UNKNOWN__';

export interface TuneMeta {
  settingId: string;
  displayName: string;
  dance: string;
  meter: string;
}

export interface TemporalTimeline {
  windows: WindowResult[];
  /** The filtered global candidate set — every real tuneId Viterbi will
   *  consider as a state, across the WHOLE recording (not per-window). */
  tuneIds: string[];
  /** Best-scoring incarnation's metadata seen for each tuneId (settingId can
   *  drift between settings of the same tune window to window). */
  meta: Map<string, TuneMeta>;
  /** observations.get(tuneId)![windowIndex] = probability, 0 if that tuneId
   *  wasn't in this window's candidates. */
  observations: Map<string, number[]>;
  /** ranks.get(tuneId)![windowIndex] = 1-based rank that window, null if
   *  absent. Not used by the V1 scoring — kept for a V2 that wants it
   *  (see DetectionTemporalConfig.observationScoreFn). */
  ranks: Map<string, (number | null)[]>;
}

export function buildTemporalTimeline(windows: WindowResult[], cfg: DetectionTemporalConfig): TemporalTimeline {
  const T = windows.length;

  // Pass 1: global candidate set = every tuneId whose best-ever probability
  // in this recording clears minCandidateProbability. A tune that's
  // sometimes weak but later strong must NOT be dropped — hence "best-ever",
  // not "first window" or "average".
  const maxProbSeen = new Map<string, number>();
  const meta = new Map<string, TuneMeta>();
  for (const w of windows) {
    for (const c of w.candidates) {
      if ((maxProbSeen.get(c.tuneId) ?? -Infinity) < c.score) {
        maxProbSeen.set(c.tuneId, c.score);
        meta.set(c.tuneId, { settingId: c.settingId, displayName: c.displayName, dance: c.dance, meter: c.meter });
      }
    }
  }
  const tuneIds = [...maxProbSeen.entries()]
    .filter(([, p]) => p >= cfg.minCandidateProbability)
    .map(([id]) => id);

  // Pass 2: dense per-tune arrays, zero-filled, populated only where present.
  const observations = new Map<string, number[]>();
  const ranks = new Map<string, (number | null)[]>();
  for (const id of tuneIds) {
    observations.set(id, new Array(T).fill(0));
    ranks.set(id, new Array(T).fill(null));
  }
  windows.forEach((w, t) => {
    w.candidates.forEach((c, idx) => {
      const obsArr = observations.get(c.tuneId);
      if (!obsArr) return; // filtered out of the global candidate set
      obsArr[t] = c.score;
      ranks.get(c.tuneId)![t] = idx + 1;
    });
  });

  return { windows, tuneIds, meta, observations, ranks };
}
