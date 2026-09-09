import { it } from 'vitest';
import { DETECTION_TEMPORAL_CONFIG as CFG } from '../../src/session/recognition/detectionTemporalConfig';
import {
  SESSIONS, DIR, loadWindows, buildTimeline, decode,
  type TransitionWeights, type ConfirmRule,
} from './pipeline';
import { loadTruth, scoreSession } from './truth';
import { ALL_TRANSFORMS, identity, type ObservationTransform } from './transforms';

// ── Where does a candidate's gain actually come from? ────────────────────────
//
// The merged Pareto front reports ONE pair of numbers per configuration, summed
// over the whole corpus. That is the right objective to optimise and the wrong
// thing to trust: Audio F alone carries 10 of production's 20 false positives
// and 14 of its 29 misses, so a candidate can look like a model improvement
// while being a single session's quirk.
//
// This prints the same evaluations session by session. A gain spread across
// sessions is a property of the scoring; a gain concentrated in one session is
// an artefact of that recording, and would not survive the next one.
//
//   npx vitest run --config vitest.ranking.config.ts experiments/ranking-study/breakdown.test.ts

interface Candidate {
  label: string;
  transform: ObservationTransform;
  flat: boolean;
  /** Absolute floor, as recorded in the outcome rows. */
  floor: number;
  minSeg: number | undefined;
  weights: TransitionWeights;
  confirm: ConfirmRule;
}

const byName = (n: string): ObservationTransform => {
  const t = ALL_TRANSFORMS.find(x => x.name === n);
  if (!t) throw new Error(`transformation inconnue : ${n}`);
  return t;
};

/** Production, then the three front points worth arbitrating between. Values
 *  copied from the merged front of the 2026-09-09 campaign. */
const CANDIDATES: Candidate[] = [
  {
    label: 'production (identity, plat=on, 0.20)',
    transform: identity, flat: true, floor: CFG.unknownObservationProbability,
    minSeg: undefined, weights: {}, confirm: { kind: 'none' },
  },
  {
    label: '312/17  share plat=off 0.1101 minSeg2',
    transform: byName('share'), flat: false, floor: 0.1101, minSeg: 2,
    weights: { tuneChange: 1.62, unknownStay: 0.05, tuneToUnknown: 0.72, unknownToTune: 0.00 },
    confirm: { kind: 'none' },
  },
  {
    label: '305/7   nullRatioTailMean plat=off 1.0197 minSeg0',
    transform: byName('nullRatioTailMean'), flat: false, floor: 1.0197, minSeg: 0,
    weights: { tuneChange: 1.58, unknownStay: 0.21, tuneToUnknown: 0.77, unknownToTune: 1.28 },
    confirm: { kind: 'none' },
  },
  {
    label: '294/3   share plat=off 0.0959 minSeg2',
    transform: byName('share'), flat: false, floor: 0.0959, minSeg: 2,
    weights: { tuneChange: 1.39, unknownStay: 0.00, tuneToUnknown: 0.52, unknownToTune: 0.96 },
    confirm: { kind: 'none' },
  },
];

it('breaks each candidate down by session', () => {
  const sessions = SESSIONS.map(id => ({ id, windows: loadWindows(id), truth: loadTruth(DIR, id) }));

  type Row = { found: number; total: number; fp: number };
  const results = new Map<string, Row[]>();

  for (const c of CANDIDATES) {
    const rows: Row[] = [];
    for (const s of sessions) {
      const tl = buildTimeline(s.windows, c.transform, CFG, { flatFilter: c.flat });
      const sc = scoreSession(s.truth, decode(tl, CFG, c.floor, c.minSeg, c.weights, c.confirm));
      rows.push({ found: sc.found, total: sc.total, fp: sc.falsePositives });
    }
    results.set(c.label, rows);
  }

  const prod = results.get(CANDIDATES[0]!.label)!;
  const name = (id: string) => id.slice(0, 30).padEnd(30);

  for (const c of CANDIDATES.slice(1)) {
    const rows = results.get(c.label)!;
    console.log(`\n==== ${c.label} ====`);
    console.log('  session                        | rappel      | fp        | delta rappel | delta fp');
    let dFoundTot = 0, dFpTot = 0;
    for (const [i, s] of sessions.entries()) {
      const r = rows[i]!, p = prod[i]!;
      const dF = r.found - p.found, dFp = r.fp - p.fp;
      dFoundTot += dF; dFpTot += dFp;
      const mark = (dF !== 0 || dFp !== 0) ? ' ' : ' (inchange)';
      console.log(`  ${name(s.id)} | ${String(r.found).padStart(3)}/${String(r.total).padEnd(3)} (${String(p.found).padStart(3)}) `
        + `| ${String(r.fp).padStart(2)} (${String(p.fp).padStart(2)}) `
        + `| ${(dF >= 0 ? '+' : '') + dF} `.padStart(14) + `| ${(dFp >= 0 ? '+' : '') + dFp}${mark}`);
    }
    console.log(`  ${'TOTAL'.padEnd(30)} | ${'   '} ${'   '}      |     `
      + `     | ${(dFoundTot >= 0 ? '+' : '') + dFoundTot} `.padStart(14) + `| ${(dFpTot >= 0 ? '+' : '') + dFpTot}`);

    // The question this file exists to answer: is the false-positive gain the
    // property of the scoring, or of one recording?
    const gains = sessions.map((s, i) => ({ id: s.id, d: rows[i]!.fp - prod[i]!.fp })).filter(g => g.d < 0);
    const worst = gains.reduce((a, b) => (b.d < a.d ? b : a), { id: '-', d: 0 });
    const share = dFpTot < 0 ? Math.round((worst.d / dFpTot) * 100) : 0;
    console.log(`  -> ${gains.length} session(s) contribuent au gain en fp ; la plus grosse (${worst.id.slice(0, 30)}) en porte ${share}%`);
  }
}, 900_000);
