import * as fs from 'node:fs';
import * as nodePath from 'node:path';
import {
  buildTemporalTimeline, filterFlatWindows, filterByTempoSpread, UNKNOWN_STATE,
  type TemporalTimeline,
} from '../../src/session/recognition/temporalObservationBuilder';
import {
  runViterbiDetection, filterShortSegments, mergeNearbySameTune,
} from '../../src/session/recognition/viterbiDetector';
import type { DetectionTemporalConfig } from '../../src/session/recognition/detectionTemporalConfig';
import type { WindowResult } from '../../src/session/model';
import type { ObservationTransform } from './transforms';
import type { Seg } from './truth';

export const DIR = nodePath.resolve(__dirname, '../../test-fixtures/sessions');

/** Every annotated session EXCEPT `20240721_tocane_2_chapiteau` (Audio F),
 *  whose CSV is not written yet. Excluding it also removes the last consumer of
 *  name matching: all six below carry a `-timings.csv`. */
export const SESSIONS = [
  '1Hour_Trad_Irish_Music_Session_in_Korea',
  '20260523_1_matin_Anglade',
  '20260523_2_aprem_tabac',
  '20260523_5_auberge_fleurie',
  'One_of_the_Best_Traditional_Irish_Music_Sessions_Longer_Video',
  '13th_Moon_Gravity_Well_-_Irish_Trad_Session_2024_01_24',
];

/** Bar ambience, talk, glasses — no music at all. Ground truth is "zero
 *  detections, always", so it measures false positives with no recall to
 *  trade against. */
export const NOISE = '732984_11910076-lq';

export function loadWindows(session: string): WindowResult[] {
  const p = nodePath.join(DIR, `${session}-windows.json`);
  const raw = JSON.parse(fs.readFileSync(p, 'utf-8')) as WindowResult[] | Record<string, WindowResult>;
  const arr = Array.isArray(raw) ? raw : Object.values(raw);
  return [...arr].sort((a, b) => a.tWindowStart - b.tWindowStart);
}

export interface TimelineOptions {
  /** Whether the pre-Viterbi flat-window filter runs. Off is a real
   *  configuration to test, not a bug: several transforms encode decisiveness
   *  themselves, which makes a hard cliff redundant — and the cliff is what
   *  discarded windows where the missed tune was ranked first. */
  flatFilter: boolean;
}

/**
 * Raw windows -> TemporalTimeline, with the observation values rewritten.
 *
 * The one thing this does that production does not: it FREEZES THE STATE SPACE
 * ON THE RAW SCORES before transforming. `minCandidateProbability` (0.20) admits
 * a tune to the Viterbi state space if it ever scores that well, and every
 * transform changes the scale that threshold reads — so left alone it would
 * silently vary the state space from one transform to the next and confound the
 * whole comparison. Here the admitted set is computed exactly as production
 * computes it, from the untransformed scores; the transform then only changes
 * the numbers attached to states that were going to exist anyway.
 *
 * With the identity transform this is production, exactly. The harness asserts
 * that before believing anything else.
 */
export function buildTimeline(
  rawWindows: WindowResult[],
  transform: ObservationTransform,
  cfg: DetectionTemporalConfig,
  opts: TimelineOptions,
): TemporalTimeline {
  let ws = rawWindows;
  if (opts.flatFilter) ws = filterFlatWindows(ws, cfg.flatWindowTopN, cfg.flatWindowMarginThreshold);
  ws = filterByTempoSpread(ws, cfg.tempoSpreadThreshold);

  const maxRaw = new Map<string, number>();
  for (const w of ws) {
    for (const c of w.candidates) {
      if ((maxRaw.get(c.tuneId) ?? -Infinity) < c.score) maxRaw.set(c.tuneId, c.score);
    }
  }
  const admitted = new Set(
    [...maxRaw.entries()].filter(([, p]) => p >= cfg.minCandidateProbability).map(([id]) => id),
  );

  const transformed: WindowResult[] = ws.map(w => {
    if (w.candidates.length === 0) return w;
    // Applied to the FULL candidate list before any is dropped: `share` and the
    // margin terms are properties of the whole window, not of the survivors.
    const values = transform.apply(w.candidates.map(c => c.score));
    const candidates = w.candidates
      .map((c, i) => ({ ...c, score: values[i]! }))
      .filter(c => admitted.has(c.tuneId));
    return { ...w, candidates, empty: candidates.length === 0 };
  });

  // -Infinity, because admission has already been decided above on raw scores.
  return buildTemporalTimeline(transformed, { ...cfg, minCandidateProbability: -Infinity });
}

export interface DetectedSeg extends Seg {
  label: string;
  span: string;
}

/**
 * Viterbi's transition weights, individually overridable.
 *
 * `scale` alone was not enough, and could not be: multiplying all four together
 * moves every barrier at once, so it cannot answer the question our failures
 * actually pose — should the decoder commit FASTER while staying just as hard to
 * shake off? Three structural quantities hide in these four numbers, and only
 * two of them are visible to a common factor.
 *
 *  - **commitment barrier** = `unknownToTune - unknownStay` (0.5 - 0.2 = 0.3).
 *    What it costs to start believing a tune rather than idle. Prime suspect for
 *    "Viterbi declines to commit though the tune leads five windows".
 *  - **stickiness** = `tuneToUnknown - sameTune` (0.5 - 0 = 0.5). What it costs
 *    to give up on a tune. High values bridge doubtful windows.
 *  - **a standing pressure against idling**: UNKNOWN costs 0.2 per window to
 *    hold, while staying on a tune is free.
 *
 * `scale` remains, because it answers a different question: how loud the
 * transitions are relative to the evidence. The ratio transforms compress the
 * emission scale (a 0.20 -> 0.30 move is a log gap of 0.41 on raw scores, but
 * 1.15 -> 1.30 is only 0.12 on nullRatio3), so unchanged penalties weigh about
 * three times more against the evidence than they were tuned to.
 */
export interface TransitionWeights {
  scale?: number;
  tuneChange?: number;
  unknownStay?: number;
  tuneToUnknown?: number;
  unknownToTune?: number;
}

const mmss = (s: number): string => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

/**
 * Timeline -> final detections, reproducing the production chain EXACTLY:
 * `runViterbiDetection` then `filterShortSegments(..., false)` then
 * `mergeNearbySameTune`. See viterbiSegmenter.ts's recompute().
 *
 * The fourth argument to filterShortSegments is `!forceFinalizeAll`, and it is
 * false for a finished recording — the tolerance on a short LAST segment only
 * applies while windows are still streaming in. A harness that passed true, and
 * that stopped before mergeNearbySameTune, reported a tune as 10:52-11:07 where
 * the app showed 10:52-12:52. Every global number measured that way was void.
 */
export function decode(
  timeline: TemporalTimeline,
  cfg: DetectionTemporalConfig,
  unknownFloor: number,
  minSegmentWindows?: number,
  weights: TransitionWeights = {},
  confirm: ConfirmRule = { kind: 'none' },
): DetectedSeg[] {
  const k = weights.scale ?? 1;
  const runCfg = {
    ...cfg,
    unknownObservationProbability: unknownFloor,
    minSegmentWindows: minSegmentWindows ?? cfg.minSegmentWindows,
    sameTuneTransitionCost: cfg.sameTuneTransitionCost * k,
    tuneChangePenalty: (weights.tuneChange ?? cfg.tuneChangePenalty) * k,
    unknownStayPenalty: (weights.unknownStay ?? cfg.unknownStayPenalty) * k,
    tuneToUnknownPenalty: (weights.tuneToUnknown ?? cfg.tuneToUnknownPenalty) * k,
    unknownToTunePenalty: (weights.unknownToTune ?? cfg.unknownToTunePenalty) * k,
  };
  const result = runViterbiDetection(timeline, runCfg);
  const segments = mergeNearbySameTune(
    filterShortSegments(result.segments, timeline, runCfg.minSegmentWindows, false),
    timeline,
    runCfg.sameTuneMergeGapWindows,
  ).filter(s => s.tuneId !== UNKNOWN_STATE);

  return segments
    .filter(s => confirms(s, timeline, confirm))
    .map(s => ({
      tuneId: s.tuneId,
      label: timeline.meta.get(s.tuneId)?.displayName ?? s.tuneId,
      startTime: s.startTime,
      endTime: s.endTime,
      span: `${mmss(s.startTime)}-${mmss(s.endTime)}`,
    }));
}

/**
 * An alternative to `minSegmentWindows`, and the point of it is what it does NOT
 * do: impose a minimum duration.
 *
 * `filterShortSegments` confirms a segment by COUNTING windows where the tune
 * was FolkFriend's rank 1. Two of them, by default — which is a duration floor
 * in disguise. A tune the engine only dominates once (a short air, a brief
 * reprise, a tune half-buried under conversation) cannot be reported however
 * overwhelming that single window is. Worse, the floor is denominated in
 * windows-where-the-engine-leads rather than seconds, so it punishes difficult
 * passages twice over.
 *
 * These rules confirm on STRENGTH instead of quantity: how far the segment's own
 * observations sit above the floor it had to clear. A one-window segment with
 * overwhelming evidence passes; a long, limp one does not. That is only a
 * coherent thing to ask once the observation is a ratio — on raw scores,
 * "strength" still carries the recording's audio quality.
 */
export type ConfirmRule =
  | { kind: 'none' }
  /** Mean observation over the segment's windows, relative to the floor. */
  | { kind: 'mean'; ratio: number }
  /** Best single window, relative to the floor — the "one overwhelming window
   *  is enough" reading, which is exactly what a duration floor forbids. */
  | { kind: 'peak'; ratio: number };

function confirms(
  seg: { tuneId: string; firstWindowIndex: number; windowCount: number },
  timeline: TemporalTimeline,
  rule: ConfirmRule,
): boolean {
  if (rule.kind === 'none') return true;
  const obs = timeline.observations.get(seg.tuneId);
  if (!obs) return false;
  let sum = 0, peak = 0, n = 0;
  for (let i = seg.firstWindowIndex; i < seg.firstWindowIndex + seg.windowCount; i++) {
    const v = obs[i] ?? 0;
    sum += v; n++;
    if (v > peak) peak = v;
  }
  if (!n) return false;
  return rule.kind === 'peak' ? peak >= rule.ratio : sum / n >= rule.ratio;
}
