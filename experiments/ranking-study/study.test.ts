import { it, expect } from 'vitest';
import { DETECTION_TEMPORAL_CONFIG as CFG } from '../../src/session/recognition/detectionTemporalConfig';
import { SESSIONS, NOISE, DIR, loadWindows, buildTimeline, decode, type DetectedSeg, type TransitionWeights, type ConfirmRule } from './pipeline';
import { loadTruth, scoreSession, type TruthEntry } from './truth';
import { ALL_TRANSFORMS, identity, type ObservationTransform } from './transforms';

// ── Does ranking beat an absolute score? ─────────────────────────────────────
//
// The question, from detectionTemporalConfig.ts: `unknownObservationProbability`
// compares an ABSOLUTE score, and a correct tune under accompaniment can sit
// below the floor for its whole run while topping every window.
//
// The trap this harness is built around: every transform changes the SCALE of
// the observations, so the floor does not mean the same thing from one to the
// next. Comparing them at a fixed floor would be meaningless. Each is therefore
// swept over its own range, chosen from its own distribution of top-1 values,
// and the comparison is between CURVES — recall at equal false positives —
// never between points.
//
//   npm run ranking                          # everything, ~N minutes
//   STUDY_ONLY=identity,share npm run ranking
//   STUDY_FLOORS=9 npm run ranking           # coarser sweep
//   STUDY_FLAT=off npm run ranking           # flat filter disabled

const PRODUCTION_FLOOR = CFG.unknownObservationProbability;   // 0.20

/** Per-session production results at 0.20, measured by the independent
 *  threshold-sweep harness on 2026-09-08. Reproducing these from a second
 *  implementation is the acceptance test: two harnesses agreeing is stronger
 *  evidence than one being self-consistent. */
const PRODUCTION_BASELINE: Record<string, { found: number; total: number }> = {
  '1Hour_Trad_Irish_Music_Session_in_Korea': { found: 31, total: 31 },
  // 35, not the 34 first written here: that figure predated the annotator's
  // correction of Audio E's first row (365 -> 635, a digit transposition). The
  // acceptance test caught the stale expectation rather than a bug in either
  // harness — which is what it is for.
  '20260523_1_matin_Anglade': { found: 35, total: 36 },
  '20260523_2_aprem_tabac': { found: 21, total: 27 },
  '20260523_5_auberge_fleurie': { found: 29, total: 30 },
  'One_of_the_Best_Traditional_Irish_Music_Sessions_Longer_Video': { found: 25, total: 26 },
  '13th_Moon_Gravity_Well_-_Irish_Trad_Session_2024_01_24': { found: 36, total: 42 },
};

/** Named transition-weight settings, chosen to move ONE structural quantity at
 *  a time rather than to fill a grid. See TransitionWeights for what each of
 *  those quantities is; the defaults are 1.0 / 0.2 / 0.5 / 0.5.
 *
 *  `eager*` lowers the commitment barrier — the direct answer to "Viterbi
 *  declines to commit though the tune leads five windows". `sticky` raises the
 *  cost of giving up instead. `restless` attacks the same asymmetry from the
 *  other side, by making idling expensive rather than committing cheap: worth
 *  separating, because it also penalises genuine silence, which `eager` does
 *  not. `quiet` scales all four down, which is the compensation the ratio
 *  transforms call for on their compressed emission scale. */
const WEIGHT_PRESETS: Record<string, TransitionWeights> = {
  base: {},
  quiet: { scale: 0.5 },
  veryQuiet: { scale: 0.3 },
  eager: { unknownToTune: 0.2 },
  veryEager: { unknownToTune: 0.0 },
  sticky: { tuneToUnknown: 1.0 },
  eagerSticky: { unknownToTune: 0.2, tuneToUnknown: 1.0 },
  restless: { unknownStay: 0.5 },
  freeSwitch: { tuneChange: 0.5 },
};

/** Confirmation rules, expressed as a multiple OF THE FLOOR so they mean the
 *  same thing at every operating point and on every transform's scale.
 *  `mean1.2` = the segment's average observation must sit 20% above the floor
 *  it had to clear; `peak2` = one window at twice the floor is enough, which is
 *  precisely the judgement a duration floor cannot make. */
function confirmRule(name: string, floor: number): ConfirmRule {
  if (name === 'none') return { kind: 'none' };
  const m = name.match(/^(mean|peak)([\d.]+)$/);
  if (!m) throw new Error(`regle de confirmation inconnue: ${name}`);
  return { kind: m[1] as 'mean' | 'peak', ratio: floor * Number(m[2]) };
}

interface Loaded { id: string; windows: ReturnType<typeof loadWindows>; truth: TruthEntry[] }

const sessions: Loaded[] = SESSIONS.map(id => ({ id, windows: loadWindows(id), truth: loadTruth(DIR, id) }));
const noiseWindows = loadWindows(NOISE);

const pct = (v: number, d = 1) => `${(v * 100).toFixed(d)}%`;

/** Aggregate over the six sessions plus the noise fixture. */
interface Point {
  floor: number;
  found: number;
  total: number;
  fp: number;
  onOffIndex: number;
  misplaced: number;
  noise: number;
  coverage: number;
  slivers: number;
}

function evaluate(
  timelines: { s: Loaded; tl: ReturnType<typeof buildTimeline> }[],
  noiseTl: ReturnType<typeof buildTimeline>,
  floor: number,
  minSeg: number,
  weights: TransitionWeights,
  wName: string,
  confirm: ConfirmRule,
): Point {
  let found = 0, total = 0, fp = 0, onOffIndex = 0, slivers = 0, misplaced = 0;
  const covs: number[] = [];
  for (const { s, tl } of timelines) {
    const segs: DetectedSeg[] = decode(tl, CFG, floor, minSeg, weights, confirm);
    const sc = scoreSession(s.truth, segs);
    found += sc.found; total += sc.total; fp += sc.falsePositives;
    onOffIndex += sc.onOffIndex; slivers += sc.slivers; misplaced += sc.misplaced;
    if (sc.found) covs.push(sc.meanCoverage * sc.found);
  }
  const noise = new Set(decode(noiseTl, CFG, floor, minSeg, weights, confirm).map(s => s.tuneId)).size;
  return {
    floor, found, total, fp, onOffIndex, misplaced, noise, slivers,
    coverage: found ? covs.reduce((a, b) => a + b, 0) / found : 0,
  };
}

/** Floors to try for THIS transform, taken from its own distribution of
 *  per-window top-1 observation values. A fixed grid would be meaningless
 *  across transforms whose outputs live on different scales; quantiles make
 *  "how many windows can clear the floor" comparable instead.
 *
 *  DENSE AT THE BOTTOM, and that is the whole point. The first version spread
 *  quantiles evenly from p5 to p95 and measured nothing useful: production's
 *  own floor of 0.20 sits BELOW the p5 of identity's top-1 values, so every
 *  transform was compared in a region above its operating point (identity
 *  scored 169 there against the 177 it really achieves). A floor only detects
 *  anything while it stays under most windows' best candidate, so the whole
 *  usable range lives in the first few percent. */
const QUANTILES = [0.0005, 0.002, 0.005, 0.01, 0.02, 0.035, 0.05, 0.08, 0.12, 0.20, 0.35, 0.55, 0.80];

function floorGrid(timelines: { tl: ReturnType<typeof buildTimeline> }[], n: number): number[] {
  const tops: number[] = [];
  for (const { tl } of timelines) {
    const T = tl.windows.length;
    for (let t = 0; t < T; t++) {
      let best = 0;
      for (const id of tl.tuneIds) {
        const v = tl.observations.get(id)![t]!;
        if (v > best) best = v;
      }
      if (best > 0) tops.push(best);
    }
  }
  tops.sort((a, b) => a - b);
  if (!tops.length) return [0];

  // A transform whose top-1 value is the same constant everywhere (relLeader,
  // rankDecay) has no operating curve at all: every floor below the constant
  // accepts every window's leader, every floor above rejects all of them. That
  // IS the finding — sample either side of it rather than pretend otherwise.
  const distinct = new Set(tops).size;
  if (distinct < 3) {
    const c = tops[0]!;
    return [c * 0.5, c * 0.99, c, c * 1.01];
  }

  const qs = QUANTILES.slice(0, Math.max(3, n));
  const out = new Set<number>();
  for (const q of qs) out.add(Number(tops[Math.floor(q * (tops.length - 1))]!.toFixed(6)));
  return [...out].sort((a, b) => a - b);
}

it('identity reproduces production exactly', () => {
  const timelines = sessions.map(s => ({ s, tl: buildTimeline(s.windows, identity, CFG, { flatFilter: true }) }));
  const lines: string[] = [];
  let ok = true;
  for (const { s, tl } of timelines) {
    const sc = scoreSession(s.truth, decode(tl, CFG, PRODUCTION_FLOOR));
    const want = PRODUCTION_BASELINE[s.id]!;
    const same = sc.found === want.found && sc.total === want.total;
    ok &&= same;
    lines.push(`  ${same ? 'OK ' : 'ECART'} ${s.id.slice(0, 34).padEnd(34)} ${sc.found}/${sc.total}`
      + `  (attendu ${want.found}/${want.total})  fp=${sc.falsePositives}  couverture=${pct(sc.meanCoverage, 0)}`);
  }
  console.log('\n---- temoin : identite au plancher de production (0.20) ----');
  for (const l of lines) console.log(l);
  expect(ok, 'la transformation identite doit reproduire le harnais threshold-sweep').toBe(true);
}, 600_000);

it('sweeps every transform over its own floor range', () => {
  const only = process.env['STUDY_ONLY']?.split(',').map(s => s.trim());
  const nFloors = Number(process.env['STUDY_FLOORS'] ?? 13);
  const weightNames = (process.env['STUDY_WEIGHTS'] ?? 'base').split(',').map(s => s.trim());
  const confirmNames = (process.env['STUDY_CONFIRM'] ?? 'none').split(',').map(s => s.trim());
  const minSegs = (process.env['STUDY_MINSEG'] ?? String(CFG.minSegmentWindows)).split(',').map(Number);
  const flatModes: boolean[] = process.env['STUDY_FLAT'] === 'off' ? [false]
    : process.env['STUDY_FLAT'] === 'on' ? [true]
      : [true, false];

  const transforms: ObservationTransform[] = only
    ? ALL_TRANSFORMS.filter(t => only.includes(t.name))
    : ALL_TRANSFORMS;

  const rows: { key: string; pts: Point[] }[] = [];

  for (const flatFilter of flatModes) {
    for (const tr of transforms) {
      const t0 = Date.now();
      // Built once and reused across every floor: only runViterbiDetection
      // depends on the floor, and the timeline is the expensive half.
      const timelines = sessions.map(s => ({ s, tl: buildTimeline(s.windows, tr, CFG, { flatFilter }) }));
      const noiseTl = buildTimeline(noiseWindows, tr, CFG, { flatFilter });
      const floors = floorGrid(timelines, nFloors);
      for (const minSeg of minSegs) {
      for (const wName of weightNames) {
      for (const cName of confirmNames) {
      const pts = floors.map(f => evaluate(timelines, noiseTl, f, minSeg, WEIGHT_PRESETS[wName]!, wName, confirmRule(cName, f)));
      const key = `${tr.name} [plat ${flatFilter ? "on" : "off"}, minSeg ${minSeg}, ${wName}, conf ${cName}]`;
      rows.push({ key, pts });

      console.log(`\n---- ${key} ----   ${tr.blurb}`);
      console.log(`     ${((Date.now() - t0) / 1000).toFixed(0)}s, ${floors.length} planchers, `
        + `${timelines.reduce((a, x) => a + x.tl.tuneIds.length, 0)} etats au total`);
      console.log('  plancher | rappel        | faux pos | mal places | hors-idx | bruit | couverture');
      for (const p of pts) {
        console.log(`  ${p.floor.toFixed(4).padStart(8)} | ${String(p.found).padStart(3)}/${p.total} `
          + `(${pct(p.found / p.total).padStart(6)}) | ${String(p.fp).padStart(8)} `
          + `| ${String(p.misplaced).padStart(10)} | ${String(p.onOffIndex).padStart(8)} | ${String(p.noise).padStart(5)} | ${pct(p.coverage, 0).padStart(10)}`);
      }
      }
      }
      }
    }
  }

  // ── The comparison that matters: recall at an equal false-positive budget ──
  // Comparing peak recall alone would reward whichever transform simply
  // detects more of everything. Budgets are taken around the production
  // operating point so the answer reads as "same cost, more tunes?".
  const baseline = rows.find(r => r.key.startsWith('identity [plat on]'));
  // Budgets sized to the observed range, not guessed: production sits at 10
  // false positives over these six sessions, and no configuration measured so
  // far exceeds ~15. The first grid used 10..40 and every column returned the
  // same number, which says the table was measuring nothing.
  const budgets = [0, 2, 4, 6, 10, 15, 25];
  console.log('\n\n==== rappel maximal a budget de faux positifs egal ====');
  console.log('  transformation                    | ' + budgets.map(b => `<=${String(b).padStart(3)}`).join(' | '));
  for (const r of rows) {
    const cells = budgets.map(b => {
      const ok = r.pts.filter(p => p.fp <= b);
      if (!ok.length) return '   - ';
      const best = ok.reduce((a, p) => (p.found > a.found ? p : a));
      return String(best.found).padStart(4) + ' ';
    });
    console.log(`  ${r.key.padEnd(33)} | ${cells.join(' | ')}`);
  }
  if (baseline) {
    const tot = baseline.pts[0]!.total;
    console.log(`\n  (${tot} morceaux de reference, 6 sessions ; Audio F exclu faute de CSV)`);
  }
}, 3_600_000);
