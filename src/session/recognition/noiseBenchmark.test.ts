import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { runViterbiDetection, filterShortSegments, mergeNearbySameTune } from './viterbiDetector';
import { buildTemporalTimeline, filterFlatWindows, filterByTempoSpread, UNKNOWN_STATE } from './temporalObservationBuilder';
import { DETECTION_TEMPORAL_CONFIG } from './detectionTemporalConfig';
import type { WindowResult } from '../model';

// ── Pure-noise benchmarks ────────────────────────────────────────────────────
// Real recordings with NO music at all (bar ambience, talk, glasses, etc.) —
// ground truth is zero real detections, always. Explicit user request
// (2026-08-17): "toute évolution de l'algo doit viser comme but de ne rien
// détecter dans cet audio." Unlike the 4 ground-truth-annotated session
// fixtures (recall/false-positive backtests), these have nothing to recall —
// any non-UNKNOWN detection here is unconditionally a false positive.
//
// Why this matters beyond one fixture: `732984_11910076-lq` shares NONE of
// the attractor names found across the 4 real-session fixtures (romanian
// fantasy, michael's lament, corsican, gan ainm, summer salsa, da thàbh air
// an fharaidh, prayer of long resolve) — confirming (see project memory,
// 2026-08-17 "noise signature" analysis) that a hardcoded attractor
// blacklist could never have caught this one. The current filters
// (minSegmentWindows rank-1 confirmation + mergeNearbySameTune) already get
// this specific fixture to zero, but that's empirical, not structural —
// future changes to the scoring/transition model could regress it.

const FIXTURE_DIR = path.resolve(__dirname, '../../../test-fixtures/sessions');
const NOISE_FIXTURES = ['732984_11910076-lq'];

describe('noise benchmarks (goal: zero detections, ever)', () => {
  for (const name of NOISE_FIXTURES) {
    it(`detects nothing in ${name}`, () => {
      const p = path.join(FIXTURE_DIR, `${name}-windows.json`);
      const windows = JSON.parse(fs.readFileSync(p, 'utf-8')) as WindowResult[];

      const marginFiltered = filterFlatWindows(windows, DETECTION_TEMPORAL_CONFIG.flatWindowTopN, DETECTION_TEMPORAL_CONFIG.flatWindowMarginThreshold);
      const detectionWindows = filterByTempoSpread(marginFiltered, DETECTION_TEMPORAL_CONFIG.tempoSpreadThreshold);
      const timeline = buildTemporalTimeline(detectionWindows, DETECTION_TEMPORAL_CONFIG);
      const raw = runViterbiDetection(timeline, DETECTION_TEMPORAL_CONFIG).segments;
      const filtered = filterShortSegments(raw, timeline, DETECTION_TEMPORAL_CONFIG.minSegmentWindows, false);
      const merged = mergeNearbySameTune(filtered, timeline, DETECTION_TEMPORAL_CONFIG.sameTuneMergeGapWindows);
      const detections = merged.filter(s => s.tuneId !== UNKNOWN_STATE);

      if (detections.length > 0) {
        console.log(`${name}: ${detections.length} false positive(s) — `, detections.map(d =>
          `${d.displayName} (${d.startTime.toFixed(0)}-${d.endTime.toFixed(0)}s, avgP=${d.averageProbability.toFixed(2)})`).join(', '));
      }
      expect(detections).toHaveLength(0);
    }, 30000);
  }
});
