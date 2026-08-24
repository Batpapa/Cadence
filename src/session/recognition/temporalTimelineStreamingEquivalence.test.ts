import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { IncrementalTimelineBuilder, buildTemporalTimeline, describeTimelineDivergence, filterFlatWindows, filterByTempoSpread, type TemporalTimeline } from './temporalObservationBuilder';
import { DETECTION_TEMPORAL_CONFIG, type DetectionTemporalConfig } from './detectionTemporalConfig';
import type { WindowResult, WindowCandidate } from '../model';

// ── Incremental timeline equivalence oracle ─────────────────────────────────
// IncrementalTimelineBuilder (temporalObservationBuilder.ts) must produce a
// TemporalTimeline byte-identical to buildTemporalTimeline(sameFilteredWindows,
// cfg) at EVERY step, not just once fully fed — same role
// viterbiStreamingEquivalence.test.ts plays for StreamingViterbiDecoder, and
// for the same reason: this is the ONLY place this equivalence property is
// checked at all (no dev-only shadow-assert — see
// IncrementalTimelineBuilder's header doc for why: that pattern was removed
// from the Viterbi decoder on explicit user request because it re-paid the
// full from-scratch cost every window, which is exactly the quadratic blowup
// this class exists to eliminate).

const HOP = 5;

function cand(tuneId: string, score: number): WindowCandidate {
  return { tuneId, settingId: `s${tuneId}`, displayName: `Tune ${tuneId}`, dance: 'reel', meter: '4/4', score };
}

function win(i: number, candidates: WindowCandidate[]): WindowResult {
  const t = i * HOP;
  return { tWindowStart: t, tWindowEnd: t + 15, empty: candidates.length === 0, candidates };
}

// Deterministic PRNG (mulberry32) — same generator as
// viterbiStreamingEquivalence.test.ts / viterbiDetectorEquivalence.test.ts.
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

/** What a from-scratch rebuild would produce for the first `t` raw windows —
 *  applies the SAME two pre-filters IncrementalTimelineBuilder applies
 *  internally, then buildTemporalTimeline (the oracle). */
function referenceTimelineFor(rawWindows: WindowResult[], cfg: DetectionTemporalConfig): TemporalTimeline {
  const margin = filterFlatWindows(rawWindows, cfg.flatWindowTopN, cfg.flatWindowMarginThreshold);
  const filtered = filterByTempoSpread(margin, cfg.tempoSpreadThreshold);
  return buildTemporalTimeline(filtered, cfg);
}

interface Mismatch { where: string; detail: string }

/** Feeds `rawWindows` into a FRESH IncrementalTimelineBuilder one at a time
 *  and, at EVERY step, compares its result against referenceTimelineFor() of
 *  the same growing prefix — the step-by-step check that proves the
 *  incremental builder, not just its final answer. Mismatches are aggregated
 *  (with context) rather than thrown mid-loop, so one bad case doesn't hide
 *  the rest. */
function stepByStepMismatches(rawWindows: WindowResult[], cfg: DetectionTemporalConfig, label: string): Mismatch[] {
  const builder = new IncrementalTimelineBuilder(cfg);
  const mismatches: Mismatch[] = [];
  for (let t = 1; t <= rawWindows.length; t++) {
    const incremental = builder.push(rawWindows[t - 1]!);
    const reference = referenceTimelineFor(rawWindows.slice(0, t), cfg);
    const mismatch = describeTimelineDivergence(incremental, reference);
    if (mismatch) mismatches.push({ where: `${label} t=${t}`, detail: mismatch });
  }
  return mismatches;
}

describe('IncrementalTimelineBuilder == from-scratch buildTemporalTimeline at every step (mandatory equivalence oracle)', () => {
  it('random synthetic timelines, tie-prone (round probabilities, first-appearance-order stress)', () => {
    const rng = mulberry32(24601);
    const allMismatches: Mismatch[] = [];
    const N = 60;
    for (let i = 0; i < N; i++) {
      const T = 5 + Math.floor(rng() * 35);
      const numTunes = 2 + Math.floor(rng() * 10);
      const windows = randomWindows(rng, T, numTunes, true);
      allMismatches.push(...stepByStepMismatches(windows, DETECTION_TEMPORAL_CONFIG, `iter${i}/T${T}/S${numTunes}`));
    }
    if (allMismatches.length > 0) {
      console.log(`${allMismatches.length} mismatches found:`);
      for (const m of allMismatches.slice(0, 30)) console.log(`  ${m.where}: ${m.detail}`);
    }
    expect(allMismatches).toEqual([]);
  }, 60000);

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

  it('edge cases: T=1, all-empty windows, single tune, a tune weak-then-crossing-late repeatedly, ties across many tunes', () => {
    const rng = mulberry32(1);
    const allMismatches: Mismatch[] = [];

    allMismatches.push(...stepByStepMismatches([win(0, [cand('A', 0.5)])], DETECTION_TEMPORAL_CONFIG, 'T=1'));
    allMismatches.push(...stepByStepMismatches([win(0, []), win(1, []), win(2, [])], DETECTION_TEMPORAL_CONFIG, 'all-empty'));
    allMismatches.push(...stepByStepMismatches(randomWindows(rng, 20, 1, true), DETECTION_TEMPORAL_CONFIG, 'single-tune'));

    const uniform: WindowResult[] = [];
    for (let t = 0; t < 12; t++) uniform.push(win(t, ['A', 'B', 'C', 'D', 'E'].map(id => cand(id, 0.45))));
    allMismatches.push(...stepByStepMismatches(uniform, DETECTION_TEMPORAL_CONFIG, 'uniform-ties'));

    // Several tunes each spend a few windows below minCandidateProbability
    // before crossing at different, staggered times — exercises the
    // appearances-log backfill (piège B) repeatedly, with tunes crossing in
    // an order that differs from their first-appearance order (piège A)
    // whenever a later-appearing tune happens to cross sooner.
    const staggered: WindowResult[] = [
      win(0, [cand('A', 0.05), cand('B', 0.10)]),
      win(1, [cand('A', 0.06), cand('B', 0.9), cand('C', 0.07)]),
      win(2, [cand('A', 0.9), cand('C', 0.08)]),
      win(3, [cand('C', 0.85), cand('D', 0.95)]),
      win(4, [cand('A', 0.3), cand('D', 0.1)]),
    ];
    allMismatches.push(...stepByStepMismatches(staggered, DETECTION_TEMPORAL_CONFIG, 'staggered-late-crossings'));

    if (allMismatches.length > 0) {
      console.log(`${allMismatches.length} mismatches found:`);
      for (const m of allMismatches) console.log(`  ${m.where}: ${m.detail}`);
    }
    expect(allMismatches).toEqual([]);
  });

  // Real-session equivalence — nightly only (scheduled GitHub Actions job,
  // see .github/workflows/nightly.yml), NOT part of `npm test`. Full
  // step-by-step (every one of T~1000 steps pays the oracle's real O(t×S)
  // rebuild) — measured (2026-08-24) at ~12.2s for the largest fixture
  // (1059 windows), well within the existing per-fixture nightly budget
  // (single-shot fixture tests already run up to ~155s — see
  // viterbiStreamingEquivalence.test.ts). Unlike StreamingViterbiDecoder's
  // reference (O(T×S²) per call — genuinely too expensive to pay T times),
  // buildTemporalTimeline is only O(t×S) per call, cheap enough here to check
  // literally every step rather than sampling.
  const FIXTURE_DIR = path.resolve(__dirname, '../../../test-fixtures/sessions');
  const REAL_FIXTURES = [
    'One_of_the_Best_Traditional_Irish_Music_Sessions_Longer_Video-windows.json',
    '20260523_5_auberge_fleurie-windows.json',
    '20260523_2_aprem_tabac-windows.json',
    '20260523_1_matin_Anglade-windows.json',
    '13th_Moon_Gravity_Well_-_Irish_Trad_Session_2024_01_24-windows.json',
  ];

  for (const file of REAL_FIXTURES) {
    it.skipIf(!process.env.CADENCE_NIGHTLY)(`real session (step-by-step): ${file}`, () => {
      const p = path.join(FIXTURE_DIR, file);
      if (!fs.existsSync(p)) { console.log('SKIP: fixture not found'); return; }
      const windows = JSON.parse(fs.readFileSync(p, 'utf-8')) as WindowResult[];

      const builder = new IncrementalTimelineBuilder(DETECTION_TEMPORAL_CONFIG);
      const mismatches: Mismatch[] = [];
      for (let t = 1; t <= windows.length; t++) {
        const incremental = builder.push(windows[t - 1]!);
        const reference = referenceTimelineFor(windows.slice(0, t), DETECTION_TEMPORAL_CONFIG);
        const mismatch = describeTimelineDivergence(incremental, reference);
        if (mismatch) mismatches.push({ where: `${file} t=${t}`, detail: mismatch });
      }
      if (mismatches.length > 0) {
        console.log(`${mismatches.length} mismatches found:`);
        for (const m of mismatches.slice(0, 30)) console.log(`  ${m.where}: ${m.detail}`);
      }
      expect(mismatches).toEqual([]);
    }, 3600000);
  }
});
