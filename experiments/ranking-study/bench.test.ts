import { describe, it } from 'vitest';
import { loadWindows, buildTimeline, decode } from './pipeline';
import { identity } from './transforms';
import { DETECTION_TEMPORAL_CONFIG } from '../../src/session/recognition/detectionTemporalConfig';

/** Where one evaluation spends its time, and what an optimisation actually
 *  bought. Not an assertion — a measurement, run on demand:
 *
 *    npx vitest run --config vitest.ranking.config.ts experiments/ranking-study/bench.test.ts
 *
 *  Baseline measured 2026-09-13, before any of this work: the decode was 97-98%
 *  of a repeat evaluation, at ~430 ns per (window × state) cell. See NEXT.md. */
describe('bench', () => {
  it('decode cost per cell', () => {
    const cfg = DETECTION_TEMPORAL_CONFIG;

    for (const session of [
      '20260523_1_matin_Anglade',
      '13th_Moon_Gravity_Well_-_Irish_Trad_Session_2024_01_24',
    ]) {
      const raw = loadWindows(session);
      const t0 = performance.now();
      const timeline = buildTimeline(raw, identity, cfg, { flatFilter: true });
      const tBuild = performance.now() - t0;

      const T = timeline.windows.length;
      const S = timeline.tuneIds.length;
      const cells = T * (S + 1);

      // Three runs: the first pays for JIT warm-up, the best of the rest is
      // steady state. Reported as a range so a noisy machine is visible rather
      // than averaged away.
      const runs: number[] = [];
      for (let i = 0; i < 3; i++) {
        const t1 = performance.now();
        decode(timeline, cfg, cfg.unknownObservationProbability);
        runs.push(performance.now() - t1);
      }
      const best = Math.min(...runs);

      console.log(
        `\n${session}\n` +
        `  T=${T} windows  S=${S} states  ${cells.toLocaleString()} cells\n` +
        `  buildTimeline : ${tBuild.toFixed(0)} ms\n` +
        `  decode        : ${runs.map(r => r.toFixed(0)).join(' / ')} ms  → best ${best.toFixed(0)} ms\n` +
        `  per cell      : ${(best * 1e6 / cells).toFixed(0)} ns`,
      );
    }
  }, 600_000);
});
