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

// ── Pre-Viterbi flat-window filter (2026-08-17, wired into production 2026-08-18) ──
// Applied to raw WindowResult[] BEFORE buildTemporalTimeline sees them: a
// window whose top-1 candidate doesn't beat its own topN-th candidate by at
// least marginThreshold is "flat" — FolkFriend has no clear opinion this
// window (many stylistically unrelated tunes near-tied, the hallmark of
// noise found in the 2026-08-17 signature analysis, see project memory).
// A flat window is stripped of all candidates so it contributes NO evidence
// for or against any tune — same effect as FolkFriend reporting nothing that
// window. Windows with fewer than topN candidates are left untouched (not
// enough data to judge flatness). Pure, does not mutate input.
// Called from viterbiSegmenter.ts::recompute() with
// cfg.flatWindowTopN/cfg.flatWindowMarginThreshold — see
// detectionTemporalConfig.ts for the A/B-tested values and why topN=3 (not
// the initially-tried topN=2).
export function filterFlatWindows(windows: WindowResult[], topN: number, marginThreshold: number): WindowResult[] {
  return windows.map(w => {
    if (w.candidates.length < topN) return w;
    const gap = w.candidates[0].score - w.candidates[topN - 1].score;
    if (gap >= marginThreshold) return w;
    return { ...w, candidates: [], empty: true };
  });
}

// ── Pre-Viterbi tempo-spread filter (2026-08-18, wired into production same day) ──
// Applied AFTER filterFlatWindows, same idea, different signal: the noise
// study found that known recurring false-positive attractors (romanian
// fantasy, michael's lament, ...) match almost EQUALLY well regardless of
// which of the 36 tempo candidates (60-240 BPM) is tried — a "tempo-agnostic"
// contour, which real tunes essentially never are. `tempo_score_std` (std dev
// of combined_score across all 36 tempo candidates, from
// WindowResult.debug.features.tempo_candidates) captures exactly this. A
// window whose spread is below threshold is stripped of all candidates, same
// "contributes no evidence" effect as filterFlatWindows. Windows without
// debug tempo data (any window from before the WASM was updated to export
// it, or any window where FolkFriend found too few notes to try tempos at
// all) are left untouched — NOT flattened just because the data is missing.
// Called from viterbiSegmenter.ts::recompute() with cfg.tempoSpreadThreshold
// — see detectionTemporalConfig.ts for the A/B-tested value.
export function filterByTempoSpread(windows: WindowResult[], threshold: number): WindowResult[] {
  return windows.map(w => {
    const tempoCandidates = w.debug?.features?.tempo_candidates;
    if (!tempoCandidates || tempoCandidates.length === 0) return w;
    const scores = tempoCandidates.map(t => t.combined_score);
    const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
    const variance = scores.reduce((a, b) => a + (b - mean) ** 2, 0) / scores.length;
    const std = Math.sqrt(variance);
    if (std >= threshold) return w;
    return { ...w, candidates: [], empty: true };
  });
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
