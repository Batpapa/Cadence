import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { StreamingViterbiDecoder, runViterbiDetectionReference, describeViterbiDivergence, type ViterbiResult } from './viterbiDetector';
import { buildTemporalTimeline } from './temporalObservationBuilder';
import { DETECTION_TEMPORAL_CONFIG, type DetectionTemporalConfig } from './detectionTemporalConfig';
import type { WindowResult, WindowCandidate } from '../model';

// ── Streaming equivalence oracle ─────────────────────────────────────────────
// StreamingViterbiDecoder (viterbiDetector.ts) must produce a result
// byte-identical to runViterbiDetectionReference() over the SAME window
// history at EVERY step, not just once fully fed — that step-by-step
// agreement is exactly what proves the incremental decode is exact, not an
// approximation (see StreamingViterbiDecoder's header doc for the
// correctness argument).
//
// 2026-08-25: this used to be double-checked by a per-step shadow-assert
// built into StreamingViterbiDecoder.extend() itself (active whenever
// NODE_ENV !== 'production'), independent of this suite. That internal net
// was removed on explicit user request — its own cost is O(T×S²) per call
// (it re-runs the reference decoder from scratch every step), so it made
// every real dev-mode import get slower and slower as the session grew,
// which is exactly the "gets slower over a long import" behavior a user
// reported and profiled. This suite is now the ONLY place this equivalence
// property is checked at all — verification happens exclusively when this
// test runs, never as a side effect of ordinary dev or production usage.

const HOP = 5;

function cand(tuneId: string, score: number): WindowCandidate {
  return { tuneId, settingId: `s${tuneId}`, displayName: `Tune ${tuneId}`, dance: 'reel', meter: '4/4', score };
}

function win(i: number, candidates: WindowCandidate[]): WindowResult {
  const t = i * HOP;
  return { tWindowStart: t, tWindowEnd: t + 15, empty: candidates.length === 0, candidates };
}

// Deterministic PRNG (mulberry32) — same generator as viterbiDetectorEquivalence.test.ts.
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ROUND_PROBS = [0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.7, 0.8, 0.9];

function randomWindows(rng: () => number, T: number, numTunes: number, tieProne: boolean): WindowResult[] {
  const tuneIds = Array.from({ length: numTunes }, (_, i) => `T${i}`);
  const windows: WindowResult[] = [];
  for (let t = 0; t < T; t++) {
    const candidates: WindowCandidate[] = [];
    const present = Math.floor(rng() * Math.min(numTunes, 10) + 1);
    const shuffled = [...tuneIds].sort(() => rng() - 0.5);
    for (let i = 0; i < present; i++) {
      const score = tieProne ? ROUND_PROBS[Math.floor(rng() * ROUND_PROBS.length)]! : 0.05 + rng() * 0.9;
      candidates.push(cand(shuffled[i]!, score));
    }
    candidates.sort((a, b) => b.score - a.score);
    windows.push(win(t, candidates));
  }
  return windows;
}

interface Mismatch { where: string; detail: string }

/** Feeds `windows` into a FRESH StreamingViterbiDecoder one at a time and, at
 *  EVERY step, compares its result against a from-scratch
 *  runViterbiDetectionReference() over the same growing prefix — this is the
 *  step-by-step check that proves the incremental decode, not just its final
 *  answer. Mismatches are aggregated (with context) here rather than thrown
 *  mid-loop, so one bad case doesn't hide the rest. */
function stepByStepMismatches(windows: WindowResult[], cfg: DetectionTemporalConfig, label: string): Mismatch[] {
  const decoder = new StreamingViterbiDecoder();
  const mismatches: Mismatch[] = [];
  for (let t = 1; t <= windows.length; t++) {
    const timeline = buildTemporalTimeline(windows.slice(0, t), cfg);
    const streaming = decoder.extend(timeline, cfg);
    const reference = runViterbiDetectionReference(timeline, cfg);
    const mismatch = describeViterbiDivergence(streaming, reference);
    if (mismatch) mismatches.push({ where: `${label} t=${t}`, detail: mismatch });
  }
  return mismatches;
}

const CONFIGS: Record<string, DetectionTemporalConfig> = {
  default: DETECTION_TEMPORAL_CONFIG,
  noRapidChange: { ...DETECTION_TEMPORAL_CONFIG, rapidChangePenalty: 0 },
  highRapidChange: { ...DETECTION_TEMPORAL_CONFIG, rapidChangePenalty: 5 },
  cheapUnknownStay: { ...DETECTION_TEMPORAL_CONFIG, unknownStayPenalty: 0 },
  nonzeroSameCost: { ...DETECTION_TEMPORAL_CONFIG, sameTuneTransitionCost: 0.1 },
};

describe('StreamingViterbiDecoder == runViterbiDetectionReference at every step (mandatory equivalence oracle)', () => {
  it('random synthetic timelines, tie-prone (round probabilities)', () => {
    const rng = mulberry32(24601);
    const allMismatches: Mismatch[] = [];
    const N = 60;
    for (let i = 0; i < N; i++) {
      const T = 5 + Math.floor(rng() * 35);
      const numTunes = 2 + Math.floor(rng() * 10);
      const windows = randomWindows(rng, T, numTunes, true);
      for (const [cfgName, cfg] of Object.entries(CONFIGS)) {
        allMismatches.push(...stepByStepMismatches(windows, cfg, `iter${i}/${cfgName}/T${T}/S${numTunes}`));
      }
    }
    if (allMismatches.length > 0) {
      console.log(`${allMismatches.length} mismatches found:`);
      for (const m of allMismatches.slice(0, 30)) console.log(`  ${m.where}: ${m.detail}`);
    }
    expect(allMismatches).toEqual([]);
  }, 120000);

  it('random synthetic timelines, continuous scores (realistic, ties rare)', () => {
    const rng = mulberry32(112358);
    const allMismatches: Mismatch[] = [];
    const N = 40;
    for (let i = 0; i < N; i++) {
      const T = 5 + Math.floor(rng() * 40);
      const numTunes = 2 + Math.floor(rng() * 12);
      const windows = randomWindows(rng, T, numTunes, false);
      allMismatches.push(...stepByStepMismatches(windows, DETECTION_TEMPORAL_CONFIG, `iter${i}/T${T}/S${numTunes}`));
    }
    if (allMismatches.length > 0) {
      console.log(`${allMismatches.length} mismatches found:`);
      for (const m of allMismatches.slice(0, 30)) console.log(`  ${m.where}: ${m.detail}`);
    }
    expect(allMismatches).toEqual([]);
  }, 60000);

  it('edge cases: T=1, all-empty windows, single tune, huge tie clusters, a tune joining late', () => {
    const rng = mulberry32(1);
    const allMismatches: Mismatch[] = [];

    allMismatches.push(...stepByStepMismatches([win(0, [cand('A', 0.5)])], DETECTION_TEMPORAL_CONFIG, 'T=1'));
    allMismatches.push(...stepByStepMismatches([win(0, []), win(1, []), win(2, [])], DETECTION_TEMPORAL_CONFIG, 'all-empty'));
    allMismatches.push(...stepByStepMismatches(randomWindows(rng, 20, 1, true), DETECTION_TEMPORAL_CONFIG, 'single-tune'));

    const uniform: WindowResult[] = [];
    for (let t = 0; t < 12; t++) uniform.push(win(t, ['A', 'B', 'C', 'D', 'E'].map(id => cand(id, 0.45))));
    allMismatches.push(...stepByStepMismatches(uniform, DETECTION_TEMPORAL_CONFIG, 'uniform-ties'));

    // A plays alone for a while, then a brand-new tune B joins late (the
    // exact scenario the -Infinity seeding step (gotcha #1) exists for) and
    // eventually overtakes A — exercises the seed path directly, at every
    // step across the join.
    const lateJoin: WindowResult[] = [
      ...Array.from({ length: 10 }, (_, i) => win(i, [cand('A', 0.9)])),
      ...Array.from({ length: 10 }, (_, i) => win(10 + i, [cand('A', 0.3), cand('B', 0.92)])),
    ];
    allMismatches.push(...stepByStepMismatches(lateJoin, DETECTION_TEMPORAL_CONFIG, 'late-joining-tune'));

    if (allMismatches.length > 0) {
      console.log(`${allMismatches.length} mismatches found:`);
      for (const m of allMismatches) console.log(`  ${m.where}: ${m.detail}`);
    }
    expect(allMismatches).toEqual([]);
  });

  // Real-session equivalence, streaming decoder specifically — nightly only
  // (scheduled GitHub Actions job, see .github/workflows/nightly.yml), NOT
  // part of `npm test`: unlike the synthetic suites above, comparing against
  // the O(T×S²) reference at EVERY step for a real multi-hundred-window
  // fixture would multiply that cost by T (the whole problem the streaming
  // decoder exists to avoid) — so each of these streams through every window
  // first (cheap, no reference comparison at all along the way), then does
  // exactly ONE from-scratch reference decode over the FULL fixture at the
  // end. Timing budget carried over from viterbiDetectorEquivalence.test.ts's
  // existing single-shot fixture tests (~35s for 434 windows, ~155s for 955).
  const FIXTURE_DIR = path.resolve(__dirname, '../../../test-fixtures/sessions');
  const REAL_FIXTURES = [
    'One_of_the_Best_Traditional_Irish_Music_Sessions_Longer_Video-windows.json',
    '20260523_5_auberge_fleurie-windows.json',
    '20260523_2_aprem_tabac-windows.json',
    '20260523_1_matin_Anglade-windows.json',
    '13th_Moon_Gravity_Well_-_Irish_Trad_Session_2024_01_24-windows.json',
  ];

  for (const file of REAL_FIXTURES) {
    it.skipIf(!process.env.CADENCE_NIGHTLY)(`real session (streaming, step-by-step): ${file}`, () => {
      const p = path.join(FIXTURE_DIR, file);
      if (!fs.existsSync(p)) { console.log('SKIP: fixture not found'); return; }
      const windows = JSON.parse(fs.readFileSync(p, 'utf-8')) as WindowResult[];

      const decoder = new StreamingViterbiDecoder();
      let streaming: ViterbiResult = { segments: [], stats: { numberOfTransitions: 0, numberOfWindows: 0 }, convergedThroughIndex: -1 };
      for (let t = 1; t <= windows.length; t++) {
        streaming = decoder.extend(buildTemporalTimeline(windows.slice(0, t), DETECTION_TEMPORAL_CONFIG), DETECTION_TEMPORAL_CONFIG);
      }

      const fullTimeline = buildTemporalTimeline(windows, DETECTION_TEMPORAL_CONFIG);
      const reference = runViterbiDetectionReference(fullTimeline, DETECTION_TEMPORAL_CONFIG);
      const mismatch = describeViterbiDivergence(streaming, reference);
      if (mismatch) console.log(`MISMATCH: ${mismatch}`);
      expect(mismatch).toBeNull();

      // Criterion #3: zero NaN/±Infinity leaking into reported segment stats.
      for (const s of streaming.segments) {
        for (const v of [s.confidence, s.averageProbability, s.minimumProbability, s.maximumProbability]) {
          expect(Number.isFinite(v)).toBe(true);
        }
      }
    }, 3600000);
  }
});
