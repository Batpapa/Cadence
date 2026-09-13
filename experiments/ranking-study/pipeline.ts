import * as fs from 'node:fs';
import * as nodePath from 'node:path';
import {
  buildTemporalTimeline, filterFlatWindows, filterByTempoSpread, UNKNOWN_STATE,
  observationAt, rowStartAt,
  type TemporalTimeline,
} from '../../src/session/recognition/temporalObservationBuilder';
import {
  runViterbiDetection, filterShortSegments, mergeNearbySameTune,
} from '../../src/session/recognition/viterbiDetector';
import type { DetectionTemporalConfig } from '../../src/session/recognition/detectionTemporalConfig';
import type { WindowResult } from '../../src/session/model';
import type { ObservationTransform } from './transforms';
import type { Seg } from './truth';

/** Overridable since 2026-09-13 (experiment E1): windows regenerated with a
 *  modified engine live in their own directory, next to a copy of the CSVs,
 *  and the committed fixtures are never overwritten. */
export const DIR = process.env['RANKING_FIXTURES_DIR']
  ?? nodePath.resolve(__dirname, '../../test-fixtures/sessions');

/** Every annotated session. Complete since 2026-09-09, when Audio F's CSV
 *  finally arrived — it is the largest of the corpus at 5 h 26 and 149 scorable
 *  tunes, so every figure measured before it landed was taken on roughly half
 *  the material. All seven carry a `-timings.csv`; nothing here reads a
 *  setlist by name any more. */
export const SESSIONS = [
  '1Hour_Trad_Irish_Music_Session_in_Korea',
  '20260523_1_matin_Anglade',
  '20260523_2_aprem_tabac',
  '20260523_5_auberge_fleurie',
  'One_of_the_Best_Traditional_Irish_Music_Sessions_Longer_Video',
  '13th_Moon_Gravity_Well_-_Irish_Trad_Session_2024_01_24',
  '20240721_tocane_2_chapiteau',
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
  /** Temporal hold, see buildTimeline. Absent or k=0 = production. */
  hold?: { k: number; decay: number };
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

  // Temporal hold (campaign v3, hypothesis H1): each tune's observation becomes
  // the max of its own and its neighbours' within ±k windows, attenuated by
  // decay^distance. A tune absent from a window but present next door gets a
  // candidate appended AFTER the real ten, so its rank is > 10 and the rank-1
  // gate (countTop1Windows) still only counts what FolkFriend actually ranked
  // first. Runs after the transform, on its scale. `empty` is read by no decoder.
  let held = transformed;
  if (opts.hold && opts.hold.k > 0) {
    const { k, decay } = opts.hold;
    held = transformed.map((w, t) => {
      const best = new Map<string, WindowResult['candidates'][number]>();
      for (let d = 1; d <= k; d++) {
        const f = Math.pow(decay, d);
        for (const u of [t - d, t + d]) {
          const src = transformed[u];
          if (!src) continue;
          for (const c of src.candidates) {
            const v = c.score * f;
            const cur = best.get(c.tuneId);
            if (!cur || cur.score < v) best.set(c.tuneId, { ...c, score: v });
          }
        }
      }
      if (!best.size) return w;
      const own = w.candidates.map(c => {
        const b = best.get(c.tuneId);
        best.delete(c.tuneId);
        return b && b.score > c.score ? { ...c, score: b.score } : c;
      });
      const extra = [...best.values()].sort((a, b) => b.score - a.score);
      return { ...w, candidates: [...own, ...extra], empty: false };
    });
  }

  // Admission WINDOW on raw scores too, for the decoder (admissionIndex): the rows
  // below hold transformed values, against which the 0.20 threshold means nothing.
  const admittedAt = new Map<string, number>();
  ws.forEach((w, t) => {
    for (const c of w.candidates) {
      if (c.score >= cfg.minCandidateProbability && !admittedAt.has(c.tuneId)) admittedAt.set(c.tuneId, t);
    }
  });

  // -Infinity, because admission has already been decided above on raw scores.
  return { ...buildTemporalTimeline(held, { ...cfg, minCandidateProbability: -Infinity }), admittedAt };
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
  /** Rank-1 gate as a PROPORTION (added 2026-09-13, campaign v3): a segment
   *  needs max(minSegmentWindows, ceil(topFrac x its window count)) rank-1
   *  windows, counted anywhere in it exactly as production counts them. 0 is
   *  production's absolute-count gate, through production's own code path. */
  topFrac = 0,
  /** What an ABSENT tune observes, as a fraction of the UNKNOWN floor (added
   *  2026-09-13, campaign v3, hypothesis H1). 0 is production: absence reads
   *  log(epsilon) = -13.8, so one missing window outweighs ~30 rank-1 windows
   *  at 0.30 against a 0.20 floor, and intermittent evidence cannot hold a
   *  segment together. Plugged through production's own observationScoreFn hook;
   *  every present value is > 0 (transforms clamp at 1e-4), so only absence moves. */
  absentRatio = 0,
): DetectedSeg[] {
  const k = weights.scale ?? 1;
  const runCfg = {
    ...cfg,
    // Explicit, never inherited: production now sets absentObservationRatio, and
    // this harness must keep meaning what it meant when every figure in
    // CAMPAIGN_V3.md was measured — absentRatio 0 = the plain epsilon floor.
    // (It used to be emulated through observationScoreFn; the detector now has
    // the field itself, with the identical formula.)
    absentObservationRatio: absentRatio > 0 ? absentRatio : undefined,
    unknownObservationProbability: unknownFloor,
    minSegmentWindows: minSegmentWindows ?? cfg.minSegmentWindows,
    sameTuneTransitionCost: cfg.sameTuneTransitionCost * k,
    tuneChangePenalty: (weights.tuneChange ?? cfg.tuneChangePenalty) * k,
    unknownStayPenalty: (weights.unknownStay ?? cfg.unknownStayPenalty) * k,
    tuneToUnknownPenalty: (weights.tuneToUnknown ?? cfg.tuneToUnknownPenalty) * k,
    unknownToTunePenalty: (weights.unknownToTune ?? cfg.unknownToTunePenalty) * k,
  };
  const result = runViterbiDetection(timeline, runCfg);
  // The proportional gate reuses production's own relabelling twice rather than
  // copying it: once per segment with that segment's own requirement (so a
  // failing segment becomes exactly production's UNKNOWN), then once over the
  // whole list with a requirement of 0, which relabels nothing and only merges
  // the UNKNOWN neighbours — mergeNearbySameTune depends on that merge.
  const gated = topFrac > 0
    ? filterShortSegments(
      result.segments.map(s => filterShortSegments(
        [s], timeline, Math.max(runCfg.minSegmentWindows, Math.ceil(topFrac * s.windowCount)), false)[0]!),
      timeline, 0, false)
    : filterShortSegments(result.segments, timeline, runCfg.minSegmentWindows, false);
  const segments = mergeNearbySameTune(
    gated,
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
  const row = timeline.rows.get(seg.tuneId);
  if (!row) return false;
  // Only the windows the tune was a candidate in are visited. The others are 0:
  // adding 0 leaves a float sum bit-for-bit unchanged, and a peak that starts
  // at 0 is never raised by one — so this is the dense loop's answer exactly.
  const end = seg.firstWindowIndex + seg.windowCount;
  let sum = 0, peak = 0;
  for (let k = rowStartAt(row, seg.firstWindowIndex); k < row.t.length && row.t[k]! < end; k++) {
    const v = row.score[k]!;
    sum += v;
    if (v > peak) peak = v;
  }
  const n = seg.windowCount;
  if (!n) return false;
  return rule.kind === 'peak' ? peak >= rule.ratio : sum / n >= rule.ratio;
}

/** Every window's best observation above 0, across the given timelines — the
 *  pool the floor grids are drawn from (unsorted; callers sort).
 *
 *  Reads each window's own candidates instead of every admitted tune. A tune
 *  that is not a candidate in a window reads 0 there, which a strict `> best`
 *  starting from 0 skips anyway, and a candidate that was never admitted has no
 *  row and reads 0 too — so the maximum is the one the dense sweep found, at
 *  ten lookups per window instead of thousands. The values come through
 *  `observationAt`, i.e. the timeline's own transformed numbers, not the raw
 *  candidate scores. */
export function windowTops(tls: TemporalTimeline[]): number[] {
  const tops: number[] = [];
  for (const tl of tls) {
    for (let t = 0; t < tl.windows.length; t++) {
      let best = 0;
      for (const c of tl.windows[t]!.candidates) {
        const v = observationAt(tl, c.tuneId, t);
        if (v > best) best = v;
      }
      if (best > 0) tops.push(best);
    }
  }
  return tops;
}

/** 1-based rank of `tuneId` at window `t`, or null where it was not a candidate
 *  — the dense `ranks[t]` reading, for the inspection output. Kept here rather
 *  than in the timeline module: nothing in the app reads a single rank cell,
 *  only ranges (see countTop1Windows), and an export with no caller there is
 *  exactly what ts-prune exists to catch. */
export function rankAt(tl: TemporalTimeline, tuneId: string, t: number): number | null {
  const row = tl.rows.get(tuneId);
  if (!row) return null;
  const k = rowStartAt(row, t);
  return k < row.t.length && row.t[k] === t ? row.rank[k]! : null;
}
