import { it } from 'vitest';
import * as fs from 'node:fs';
import * as nodePath from 'node:path';
import { DETECTION_TEMPORAL_CONFIG as CFG } from '../../src/session/recognition/detectionTemporalConfig';
import {
  SESSIONS, NOISE, DIR, loadWindows, buildTimeline, decode, windowTops,
  type TransitionWeights, type ConfirmRule,
} from './pipeline';
import { loadTruth, scoreSession, type TruthEntry } from './truth';
import { ALL_TRANSFORMS } from './transforms';

// ── Simulated annealing over the joint space ─────────────────────────────────
//
// Random search maps the space; it does not refine. The obvious next move is to
// spend evaluations near the points that already work.
//
// Two adaptations matter here.
//
// **The objective is bi-criteria.** Annealing needs a scalar, so each chain gets
// its own exchange rate `found - lambda * fp` and several lambdas run in
// parallel, from recall-hungry to false-positive-averse. Every evaluation any
// chain makes is written out regardless of which chain made it, so they all feed
// ONE global Pareto front. The scalarisation steers the search; it never decides
// the answer.
//
// **A chain is bound to one (transform, flat) pair.** Its timelines are built
// once and cached for the shard's lifetime — 24 MB per pair since the timeline
// went sparse, so holding every pair a shard owns is affordable.
//
// Campaign v3 (2026-09-13) changed three things, all for the analysis rather
// than the search:
//
//  - **Per-session results are stored** with every evaluation. The v2 campaign
//    kept only corpus totals, which made any held-out check impossible after the
//    fact. With `per`, a leave-one-session-out validation of the front is a
//    merge-time computation, not a new campaign.
//  - **Chains advance in interleaved rounds** (`ANNEAL_ROUND` steps each), so the
//    campaign is anytime: stopped at any moment, every chain has progressed by
//    the same amount and the partial result is a fair, equal-budget comparison
//    rather than the first half of the chain list.
//  - **Chain bookkeeping** (`chain`, `step`, `temp`, `accepted`) is stored, so
//    convergence can be judged instead of assumed.
//
//   ANNEAL_STEPS=200 ANNEAL_SHARDS=6 ANNEAL_SHARD=0 SEARCH_SEED=11 \
//     npx vitest run --config vitest.ranking.config.ts experiments/ranking-study/anneal.test.ts

const STEPS = Number(process.env['ANNEAL_STEPS'] ?? 0);   // 0 = skip entirely
const SEED = Number(process.env['SEARCH_SEED'] ?? 1);
const SHARDS = Number(process.env['ANNEAL_SHARDS'] ?? 1);
const SHARD = Number(process.env['ANNEAL_SHARD'] ?? 0);
const ROUND = Number(process.env['ANNEAL_ROUND'] ?? 10);
const OUT_DIR = nodePath.resolve(__dirname, '.out');

/** Two dimensions added for the reserve phase (2026-09-13, hypothesis H1 in
 *  CAMPAIGN_V3.md). Both default OFF, and off they draw nothing from the
 *  generator, so a seed replays exactly as it did before they existed.
 *  ANNEAL_ABSENT=1 searches the absent-tune observation (fraction of the floor).
 *  ANNEAL_HOLDS="0:1,2:0.8" binds chains to temporal-hold settings (k:decay) —
 *  like the transform, because the hold changes the timeline. */
const ABSENT = process.env['ANNEAL_ABSENT'] === '1';
const HOLDS = (process.env['ANNEAL_HOLDS'] ?? '0:1').split(',').map(h => {
  const [k, decay] = h.split(':').map(Number);
  return { k: k!, decay: decay! };
});

/** Exchange rates between a found tune and a false positive. Deliberately
 *  spread over a factor of 40: the trade-off is a product decision, so the
 *  search has to put points at both ends of the front and in between. */
const LAMBDAS = (process.env['ANNEAL_LAMBDAS'] ?? '0.1,0.25,0.5,1,2,4').split(',').map(Number);

/** Restricted to {0, 1, 2} on request. A duration floor above production's is
 *  the wrong direction for the product. */
const MIN_SEGS = [0, 1, 2];

/** Upper bounds of the transition weights. Widened for v3 (production sits at
 *  1.0 / 0.2 / 0.5 / 0.5): a bound the front piles up against is a bound that
 *  decided the answer. */
const W_HI = { tuneChange: 3, unknownStay: 2, tuneToUnknown: 2, unknownToTune: 2 } as const;

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface State {
  floorQ: number;
  absent: number;
  minSeg: number;
  cName: 'none' | 'mean' | 'peak';
  ratio: number;
  weights: Required<Omit<TransitionWeights, 'scale'>>;
}

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

it('anneals around the promising regions', () => {
  if (!STEPS) { console.log('(ANNEAL_STEPS absent — recuit ignore)'); return; }

  const sessions = SESSIONS.map(id => ({ id, windows: loadWindows(id), truth: loadTruth(DIR, id) as TruthEntry[] }));
  const noiseWindows = loadWindows(NOISE);

  // ANNEAL_ONLY / ANNEAL_FLAT narrow the campaign to a region already known to
  // matter. v3 runs without them: a fresh, equal-budget look at the whole space.
  const only = process.env['ANNEAL_ONLY']?.split(',').map(s => s.trim()).filter(Boolean);
  const flats: boolean[] = process.env['ANNEAL_FLAT'] === 'off' ? [false]
    : process.env['ANNEAL_FLAT'] === 'on' ? [true]
      : [true, false];
  if (only) {
    const unknown = only.filter(n => !ALL_TRANSFORMS.some(t => t.name === n));
    if (unknown.length) throw new Error(`ANNEAL_ONLY : transformation inconnue ${unknown.join(', ')}`);
  }

  const chains: { trName: string; flat: boolean; hold: { k: number; decay: number }; lambda: number; id: number }[] = [];
  for (const tr of ALL_TRANSFORMS) {
    if (only && !only.includes(tr.name)) continue;
    for (const flat of flats) {
      for (const hold of HOLDS) {
        for (const lambda of LAMBDAS) chains.push({ trName: tr.name, flat, hold, lambda, id: chains.length });
      }
    }
  }
  // Round-robin over a stable ordering, so every process does the same work.
  const mine = chains.filter((_, i) => i % SHARDS === SHARD);
  console.log(`recuit ${SHARD + 1}/${SHARDS} : ${mine.length} chaines x ${STEPS} pas = ${mine.length * STEPS} evaluations`);

  const outcomes: unknown[] = [];
  const t0 = Date.now();
  let evals = 0;

  // Flushed as it goes: safe to kill at any moment, the merge reads what exists.
  fs.mkdirSync(OUT_DIR, { recursive: true });
  // ANNEAL_TAG keeps a check run from overwriting a campaign's own shard file.
  const tag = process.env['ANNEAL_TAG'] ? `-${process.env['ANNEAL_TAG']}` : '';
  const out = nodePath.join(OUT_DIR, `search-seed${SEED}-anneal${String(SHARD).padStart(2, '0')}${tag}.json`);
  const flush = (): void => { fs.writeFileSync(out, JSON.stringify(outcomes), 'utf-8'); };

  const groups = new Map<string, ReturnType<typeof buildGroup>>();
  function buildGroup(trName: string, flat: boolean, hold: { k: number; decay: number }) {
    const tr = ALL_TRANSFORMS.find(t => t.name === trName)!;
    const tls = sessions.map(s => ({ s, tl: buildTimeline(s.windows, tr, CFG, { flatFilter: flat, hold }) }));
    const noiseTl = buildTimeline(noiseWindows, tr, CFG, { flatFilter: flat, hold });
    const tops = windowTops(tls.map(x => x.tl));
    tops.sort((a, b) => a - b);
    return { tls, noiseTl, tops };
  }
  const groupOf = (trName: string, flat: boolean, hold: { k: number; decay: number }) => {
    const key = `${trName}|${flat}|${hold.k}:${hold.decay}`;
    let g = groups.get(key);
    if (!g) { g = buildGroup(trName, flat, hold); groups.set(key, g); }
    return g;
  };

  // Each chain is a small closure over its own seeded generator, so any chain
  // can be replayed on its own and interleaving changes nothing it draws.
  const runners = mine.map(chain => {
    const { tls, noiseTl, tops } = groupOf(chain.trName, chain.flat, chain.hold);
    const r = rng(SEED * 7919 + chain.id * 104729);
    const uni = (lo: number, hi: number) => lo + r() * (hi - lo);
    const gauss = () => {
      const u = Math.max(r(), 1e-9);
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r());
    };

    function evaluate(st: State, step: number, temp: number) {
      const floor = tops[Math.floor(st.floorQ * (tops.length - 1))]!;
      const confirm: ConfirmRule = st.cName === 'none'
        ? { kind: 'none' } : { kind: st.cName, ratio: floor * st.ratio };
      let found = 0, total = 0, fp = 0;
      const covs: number[] = [];
      const per: number[][] = [];
      for (const { s, tl } of tls) {
        const sc = scoreSession(s.truth, decode(tl, CFG, floor, st.minSeg, st.weights, confirm, 0, st.absent));
        found += sc.found; total += sc.total; fp += sc.falsePositives;
        // 4th column since 2026-09-13 06:05: segments answering no annotated row
        // where they sit. `fp` counts distinct ids, so five phantoms of the same
        // tune count once — see CAMPAIGN_V3.md, H2.
        per.push([sc.found, sc.total, sc.falsePositives, sc.misplaced]);
        if (sc.found) covs.push(sc.meanCoverage * sc.found);
      }
      const noise = new Set(decode(noiseTl, CFG, floor, st.minSeg, st.weights, confirm, 0, st.absent).map(s => s.tuneId)).size;
      evals++;
      const o = {
        transform: chain.trName, flat: chain.flat, floorQ: st.floorQ, floor, minSeg: st.minSeg,
        absentRatio: st.absent, hold: chain.hold,
        confirm: st.cName === 'none' ? 'none' : `${st.cName}x${st.ratio.toFixed(2)}`,
        weights: st.weights, found, total, fp, noise,
        coverage: found ? covs.reduce((a, b) => a + b, 0) / found : 0,
        lambda: chain.lambda, chain: chain.id, step, temp, accepted: true, per,
      };
      outcomes.push(o);
      if (evals % 20 === 0) flush();
      return { o, score: found - chain.lambda * fp };
    }

    /** One coordinate moved per step — small Gaussian jumps on the continuous
     *  axes, resampling on the discrete ones. */
    function neighbour(st: State): State {
      const n: State = { ...st, weights: { ...st.weights } };
      const roll = r();
      if (ABSENT && roll < 0.15) {
        n.absent = clamp(st.absent + gauss() * 0.15, 0, 0.95);
        return n;
      }
      const dice = ABSENT ? (roll - 0.15) / 0.85 : roll;
      if (dice < 0.30) {
        n.floorQ = clamp(st.floorQ * Math.exp(gauss() * 0.25), 0.0002, 0.60);
      } else if (dice < 0.40) {
        n.minSeg = MIN_SEGS[Math.floor(r() * MIN_SEGS.length)]!;
      } else if (dice < 0.55) {
        n.cName = (['none', 'mean', 'peak'] as const)[Math.floor(r() * 3)]!;
        n.ratio = clamp(st.ratio + gauss() * 0.4, 1, 5);
      } else {
        const k = (['tuneChange', 'unknownStay', 'tuneToUnknown', 'unknownToTune'] as const)[Math.floor(r() * 4)]!;
        n.weights[k] = clamp(st.weights[k] + gauss() * 0.2, 0, W_HI[k]);
      }
      return n;
    }

    const T0 = 6, T1 = 0.15;
    let cur: State = {
      floorQ: Math.pow(uni(0, 1), 2) * 0.25,
      minSeg: MIN_SEGS[Math.floor(r() * MIN_SEGS.length)]!,
      cName: (['none', 'mean', 'peak'] as const)[Math.floor(r() * 3)]!,
      ratio: uni(1, 4),
      weights: {
        tuneChange: uni(0.2, 2), unknownStay: uni(0, 1),
        tuneToUnknown: uni(0, 1.5), unknownToTune: uni(0, 1.5),
      },
      absent: 0,
    };
    // Drawn after everything else, and only when searched, so a seed that ran
    // without it replays unchanged.
    if (ABSENT) cur.absent = uni(0, 0.9);
    let curScore = NaN;
    let step = 0;

    /** Advances this chain by up to `n` steps; returns false once finished. */
    return (n: number): boolean => {
      for (let i = 0; i < n && step < STEPS; i++, step++) {
        const temp = T0 * Math.pow(T1 / T0, step / Math.max(1, STEPS - 1));
        if (step === 0) { curScore = evaluate(cur, 0, temp).score; continue; }
        const cand = neighbour(cur);
        const { o, score } = evaluate(cand, step, temp);
        // Metropolis: always take an improvement, take a worsening with
        // probability exp(-delta/T) so the chain can leave a local optimum early
        // on and settles as the temperature falls.
        if (score >= curScore || r() < Math.exp((score - curScore) / temp)) { cur = cand; curScore = score; }
        else o.accepted = false;
      }
      return step < STEPS;
    };
  });

  // ANNEAL_MAX_EVALS stops early, for replay checks: a campaign's first rows can
  // be reproduced without re-running it, as long as STEPS (which sets the
  // temperature schedule), ROUND and the sharding are the campaign's own.
  const maxEvals = Number(process.env['ANNEAL_MAX_EVALS'] ?? Infinity);
  for (let round = 1; ; round++) {
    let alive = false;
    for (const advance of runners) {
      if (evals >= maxEvals) break;
      alive = advance(ROUND) || alive;
    }
    if (evals >= maxEvals) alive = false;
    flush();
    console.log(`  ronde ${round} : ${evals} evaluations, ${((Date.now() - t0) / 1000).toFixed(0)}s`);
    if (!alive) break;
  }

  console.log(`\n${outcomes.length} evaluations ecrites dans ${nodePath.basename(out)} `
    + `(${((Date.now() - t0) / 1000).toFixed(0)}s)`);
}, 36_000_000);
