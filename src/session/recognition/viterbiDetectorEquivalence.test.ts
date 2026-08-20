import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { runViterbiDetectionReference, runViterbiDetectionOptimized } from './viterbiDetector';
import { buildTemporalTimeline } from './temporalObservationBuilder';
import { DETECTION_TEMPORAL_CONFIG, type DetectionTemporalConfig } from './detectionTemporalConfig';
import type { WindowResult, WindowCandidate } from '../model';

// ── Equivalence oracle ───────────────────────────────────────────────────────
// Mandatory per the 2026-08-14 optimization spec: the optimized O(T×S)
// Viterbi must be provably path-identical to the O(T×S²) reference — not just
// score-identical, not just segment-identical. Every one of these is checked:
// final score, per-window selected state, backpointers (bestPrevious per
// candidate per window, via debug mode), and the final merged segments
// including timestamps/probabilities. A single mismatch anywhere fails the
// whole comparison.

const HOP = 5;

function cand(tuneId: string, score: number): WindowCandidate {
  return { tuneId, settingId: `s${tuneId}`, displayName: `Tune ${tuneId}`, dance: 'reel', meter: '4/4', score };
}

function win(i: number, candidates: WindowCandidate[]): WindowResult {
  const t = i * HOP;
  return { tWindowStart: t, tWindowEnd: t + 15, empty: candidates.length === 0, candidates };
}

// Deterministic PRNG (mulberry32) so failures are reproducible from the seed alone.
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

/** Random synthetic windows. `tieProne` uses a small set of round probability
 *  values (deliberately produces frequent EXACT ties) — `false` uses
 *  continuous floats (closer to real recognizer output, ties essentially never). */
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

function comparePaths(
  windows: WindowResult[],
  cfg: DetectionTemporalConfig,
  label: string,
): Mismatch[] {
  const timeline = buildTemporalTimeline(windows, cfg);
  const ref = runViterbiDetectionReference(timeline, cfg, { debug: true });
  const opt = runViterbiDetectionOptimized(timeline, cfg, { debug: true });
  const mismatches: Mismatch[] = [];

  if (ref.debug!.selectedPath.length !== opt.debug!.selectedPath.length) {
    mismatches.push({ where: label, detail: 'selectedPath length differs' });
    return mismatches;
  }

  for (let t = 0; t < ref.debug!.selectedPath.length; t++) {
    const r = ref.debug!.selectedPath[t]!;
    const o = opt.debug!.selectedPath[t]!;
    if (r.state !== o.state) mismatches.push({ where: `${label} t=${t}`, detail: `state ref=${r.state} opt=${o.state}` });
    if (Math.abs(r.cumulativeScore - o.cumulativeScore) > 1e-9) {
      mismatches.push({ where: `${label} t=${t}`, detail: `cumulativeScore ref=${r.cumulativeScore} opt=${o.cumulativeScore}` });
    }
  }

  // Backpointers: for every window, every candidate state's chosen
  // predecessor and transition cost must match — not just the winning path's.
  for (let t = 1; t < ref.debug!.steps.length; t++) {
    const refByState = new Map(ref.debug!.steps[t]!.map(e => [e.state, e]));
    const optByState = new Map(opt.debug!.steps[t]!.map(e => [e.state, e]));
    if (refByState.size !== optByState.size) {
      mismatches.push({ where: `${label} t=${t}`, detail: `step entry count ref=${refByState.size} opt=${optByState.size}` });
      continue;
    }
    for (const [state, r] of refByState) {
      const o = optByState.get(state);
      if (!o) { mismatches.push({ where: `${label} t=${t} state=${state}`, detail: 'missing in optimized' }); continue; }
      if (r.bestPrevious !== o.bestPrevious) mismatches.push({ where: `${label} t=${t} state=${state}`, detail: `bestPrevious ref=${r.bestPrevious} opt=${o.bestPrevious}` });
      if (Math.abs(r.transitionCost - o.transitionCost) > 1e-9) mismatches.push({ where: `${label} t=${t} state=${state}`, detail: `transitionCost ref=${r.transitionCost} opt=${o.transitionCost}` });
      if (Math.abs(r.totalScore - o.totalScore) > 1e-9) mismatches.push({ where: `${label} t=${t} state=${state}`, detail: `totalScore ref=${r.totalScore} opt=${o.totalScore}` });
    }
  }

  // Final segments: every field, not just tuneId.
  if (ref.segments.length !== opt.segments.length) {
    mismatches.push({ where: label, detail: `segment count ref=${ref.segments.length} opt=${opt.segments.length}` });
  } else {
    for (let i = 0; i < ref.segments.length; i++) {
      const r = ref.segments[i]!, o = opt.segments[i]!;
      if (r.tuneId !== o.tuneId || r.startTime !== o.startTime || r.endTime !== o.endTime
        || Math.abs(r.averageProbability - o.averageProbability) > 1e-9
        || Math.abs(r.minimumProbability - o.minimumProbability) > 1e-9
        || Math.abs(r.maximumProbability - o.maximumProbability) > 1e-9
        || r.windowCount !== o.windowCount) {
        mismatches.push({ where: `${label} segment[${i}]`, detail: `ref=${JSON.stringify(r)} opt=${JSON.stringify(o)}` });
      }
    }
  }

  if (ref.stats.numberOfTransitions !== opt.stats.numberOfTransitions) {
    mismatches.push({ where: label, detail: `numberOfTransitions ref=${ref.stats.numberOfTransitions} opt=${opt.stats.numberOfTransitions}` });
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

describe('Viterbi optimized == reference (mandatory equivalence oracle)', () => {
  it('random synthetic timelines, tie-prone (round probabilities)', () => {
    const rng = mulberry32(12345);
    const allMismatches: Mismatch[] = [];
    const N = 300;
    for (let i = 0; i < N; i++) {
      const T = 5 + Math.floor(rng() * 60);
      const numTunes = 2 + Math.floor(rng() * 12);
      const windows = randomWindows(rng, T, numTunes, true);
      for (const [cfgName, cfg] of Object.entries(CONFIGS)) {
        const mismatches = comparePaths(windows, cfg, `iter${i}/${cfgName}/T${T}/S${numTunes}`);
        allMismatches.push(...mismatches);
      }
    }
    if (allMismatches.length > 0) {
      console.log(`${allMismatches.length} mismatches found:`);
      for (const m of allMismatches.slice(0, 30)) console.log(`  ${m.where}: ${m.detail}`);
    }
    expect(allMismatches).toEqual([]);
  }, 120000);

  it('random synthetic timelines, continuous scores (realistic, ties rare)', () => {
    const rng = mulberry32(67890);
    const allMismatches: Mismatch[] = [];
    const N = 150;
    for (let i = 0; i < N; i++) {
      const T = 5 + Math.floor(rng() * 80);
      const numTunes = 2 + Math.floor(rng() * 15);
      const windows = randomWindows(rng, T, numTunes, false);
      const mismatches = comparePaths(windows, DETECTION_TEMPORAL_CONFIG, `iter${i}/T${T}/S${numTunes}`);
      allMismatches.push(...mismatches);
    }
    if (allMismatches.length > 0) {
      console.log(`${allMismatches.length} mismatches found:`);
      for (const m of allMismatches.slice(0, 30)) console.log(`  ${m.where}: ${m.detail}`);
    }
    expect(allMismatches).toEqual([]);
  }, 60000);

  it('edge cases: T=1, all-empty windows, single tune, huge tie clusters', () => {
    const rng = mulberry32(1);
    const allMismatches: Mismatch[] = [];

    allMismatches.push(...comparePaths([win(0, [cand('A', 0.5)])], DETECTION_TEMPORAL_CONFIG, 'T=1'));
    allMismatches.push(...comparePaths([win(0, []), win(1, []), win(2, [])], DETECTION_TEMPORAL_CONFIG, 'all-empty'));
    allMismatches.push(...comparePaths(randomWindows(rng, 20, 1, true), DETECTION_TEMPORAL_CONFIG, 'single-tune'));

    // Every window offers the SAME score for every tune — maximal tie pressure.
    const uniform: WindowResult[] = [];
    for (let t = 0; t < 15; t++) uniform.push(win(t, ['A', 'B', 'C', 'D', 'E'].map(id => cand(id, 0.45))));
    allMismatches.push(...comparePaths(uniform, DETECTION_TEMPORAL_CONFIG, 'uniform-ties'));

    if (allMismatches.length > 0) {
      console.log(`${allMismatches.length} mismatches found:`);
      for (const m of allMismatches) console.log(`  ${m.where}: ${m.detail}`);
    }
    expect(allMismatches).toEqual([]);
  });

  // Real-session equivalence: validated once (2026-08-14/15) against all 4
  // fixtures in test-fixtures/sessions/ — zero mismatches on every one (final
  // confirmed run: One_of_the_Best_... 24.8s, auberge_fleurie 231.4s,
  // aprem_tabac 243.2s, matin_Anglade 260.2s). Skipped by default since the
  // reference O(T×S²) run alone takes minutes per fixture — not something
  // routine `npm test` should pay for. Un-skip to re-verify after any future
  // change to either implementation.
  const FIXTURE_DIR = path.resolve(__dirname, '../../../test-fixtures/sessions');
  const REAL_FIXTURES = [
    'One_of_the_Best_Traditional_Irish_Music_Sessions_Longer_Video-windows.json',
    '20260523_5_auberge_fleurie-windows.json',
    '20260523_2_aprem_tabac-windows.json',
    '20260523_1_matin_Anglade-windows.json',
    '13th_Moon_Gravity_Well_-_Irish_Trad_Session_2024_01_24-windows.json',
  ];

  for (const file of REAL_FIXTURES) {
    it.skip(`real session: ${file}`, () => {
      const p = path.join(FIXTURE_DIR, file);
      if (!fs.existsSync(p)) { console.log('SKIP: fixture not found'); return; }
      const windows = JSON.parse(fs.readFileSync(p, 'utf-8')) as WindowResult[];
      const mismatches = comparePaths(windows, DETECTION_TEMPORAL_CONFIG, file);
      if (mismatches.length > 0) {
        console.log(`${mismatches.length} mismatches found:`);
        for (const m of mismatches.slice(0, 30)) console.log(`  ${m.where}: ${m.detail}`);
      }
      expect(mismatches).toEqual([]);
    }, 3600000);
  }
});
