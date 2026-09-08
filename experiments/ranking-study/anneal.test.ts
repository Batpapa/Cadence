import { it } from 'vitest';
import * as fs from 'node:fs';
import * as nodePath from 'node:path';
import { DETECTION_TEMPORAL_CONFIG as CFG } from '../../src/session/recognition/detectionTemporalConfig';
import {
  SESSIONS, NOISE, DIR, loadWindows, buildTimeline, decode,
  type TransitionWeights, type ConfirmRule,
} from './pipeline';
import { loadTruth, scoreSession, type TruthEntry } from './truth';
import { ALL_TRANSFORMS } from './transforms';

// ── Simulated annealing over the joint space ─────────────────────────────────
//
// Random search maps the space; it does not refine. With 400 draws in ten
// dimensions the Pareto front it produced is a lower bound, and the obvious next
// move is to spend evaluations near the points that already work.
//
// Two adaptations matter here.
//
// **The objective is bi-criteria.** Annealing needs a scalar, so each chain gets
// its own exchange rate `found - lambda * fp` and several lambdas run in
// parallel: a recall-hungry chain, a balanced one, and a false-positive-averse
// one. Every evaluation any chain makes is written out regardless of which chain
// made it, so they all feed ONE global Pareto front. The scalarisation steers the
// search; it never decides the answer.
//
// **A chain is bound to one (transform, flat) pair.** Changing either forces a
// timeline rebuild, which costs more than a hundred evaluations. Fixing them per
// chain means one build per chain, and makes chains independent — so they shard
// across processes with no coordination, exactly like the random search groups.
//
//   ANNEAL_STEPS=35 ANNEAL_SHARDS=10 ANNEAL_SHARD=0 npm run ranking
//   SEARCH_MERGE=1 npm run ranking      # merges these with the random draws

const STEPS = Number(process.env['ANNEAL_STEPS'] ?? 0);   // 0 = skip entirely
const SEED = Number(process.env['SEARCH_SEED'] ?? 1);
const SHARDS = Number(process.env['ANNEAL_SHARDS'] ?? 1);
const SHARD = Number(process.env['ANNEAL_SHARD'] ?? 0);
const OUT_DIR = nodePath.resolve(__dirname, '.out');

/** Exchange rates between a found tune and a false positive. Deliberately
 *  spread: the user's own stated preference is that a false positive is visible
 *  and dismissed in a click while a missed tune is invisible, which argues for
 *  the low end — but the choice is theirs, so the search covers the range. */
const LAMBDAS = [0.2, 0.6, 1.5];

/** Restricted to {0, 1, 2} on request. The earlier sweep put 3 on the
 *  low-false-positive end of the front, but a duration floor above production's
 *  is the wrong direction for the product. */
const MIN_SEGS = [0, 1, 2];

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

  // One chain per (transform, flat, lambda). Sharded round-robin over a stable
  // ordering, so every process does the same amount of work — the random search
  // sharded by GROUP instead and the largest shard had more than twice the
  // draws of the smallest, which left cores idle at the end.
  const chains: { trName: string; flat: boolean; lambda: number }[] = [];
  for (const tr of ALL_TRANSFORMS) {
    for (const flat of [true, false]) {
      for (const lambda of LAMBDAS) chains.push({ trName: tr.name, flat, lambda });
    }
  }
  const mine = chains.filter((_, i) => i % SHARDS === SHARD);
  console.log(`recuit ${SHARD + 1}/${SHARDS} : ${mine.length} chaines x ${STEPS} pas = ${mine.length * STEPS} evaluations`);

  const outcomes: unknown[] = [];
  const t0 = Date.now();
  let evals = 0;

  for (const [ci, chain] of mine.entries()) {
    const tr = ALL_TRANSFORMS.find(t => t.name === chain.trName)!;
    const tls = sessions.map(s => ({ s, tl: buildTimeline(s.windows, tr, CFG, { flatFilter: chain.flat }) }));
    const noiseTl = buildTimeline(noiseWindows, tr, CFG, { flatFilter: chain.flat });

    const tops: number[] = [];
    for (const { tl } of tls) {
      for (let t = 0; t < tl.windows.length; t++) {
        let best = 0;
        for (const id of tl.tuneIds) { const v = tl.observations.get(id)![t]!; if (v > best) best = v; }
        if (best > 0) tops.push(best);
      }
    }
    tops.sort((a, b) => a - b);

    // Seeded per chain, so any chain can be replayed on its own.
    const r = rng(SEED * 7919 + ci * 104729 + SHARD * 31);
    const uni = (lo: number, hi: number) => lo + r() * (hi - lo);
    const gauss = () => {
      const u = Math.max(r(), 1e-9);
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r());
    };

    function evaluate(st: State) {
      const floor = tops[Math.floor(st.floorQ * (tops.length - 1))]!;
      const confirm: ConfirmRule = st.cName === 'none'
        ? { kind: 'none' } : { kind: st.cName, ratio: floor * st.ratio };
      let found = 0, total = 0, fp = 0;
      const covs: number[] = [];
      for (const { s, tl } of tls) {
        const sc = scoreSession(s.truth, decode(tl, CFG, floor, st.minSeg, st.weights, confirm));
        found += sc.found; total += sc.total; fp += sc.falsePositives;
        if (sc.found) covs.push(sc.meanCoverage * sc.found);
      }
      const noise = new Set(decode(noiseTl, CFG, floor, st.minSeg, st.weights, confirm).map(s => s.tuneId)).size;
      evals++;
      outcomes.push({
        transform: chain.trName, flat: chain.flat, floorQ: st.floorQ, floor, minSeg: st.minSeg,
        confirm: st.cName === 'none' ? 'none' : `${st.cName}x${st.ratio.toFixed(2)}`,
        weights: st.weights, found, total, fp, noise,
        coverage: found ? covs.reduce((a, b) => a + b, 0) / found : 0,
        lambda: chain.lambda,
      });
      return { found, fp, score: found - chain.lambda * fp };
    }

    /** One coordinate moved per step, mostly — small Gaussian jumps on the
     *  continuous axes, occasional resampling on the discrete ones. */
    function neighbour(st: State): State {
      const n: State = { ...st, weights: { ...st.weights } };
      const dice = r();
      if (dice < 0.30) {
        n.floorQ = clamp(st.floorQ * Math.exp(gauss() * 0.25), 0.0002, 0.30);
      } else if (dice < 0.40) {
        n.minSeg = MIN_SEGS[Math.floor(r() * MIN_SEGS.length)]!;
      } else if (dice < 0.55) {
        n.cName = (['none', 'mean', 'peak'] as const)[Math.floor(r() * 3)]!;
        n.ratio = clamp(st.ratio + gauss() * 0.4, 1, 5);
      } else {
        const k = (['tuneChange', 'unknownStay', 'tuneToUnknown', 'unknownToTune'] as const)[Math.floor(r() * 4)]!;
        const hi = k === 'tuneChange' ? 2.5 : 1.5;
        n.weights[k] = clamp(st.weights[k] + gauss() * 0.2, 0, hi);
      }
      return n;
    }

    let cur: State = {
      floorQ: Math.pow(uni(0, 1), 2) * 0.25,
      minSeg: MIN_SEGS[Math.floor(r() * MIN_SEGS.length)]!,
      cName: (['none', 'mean', 'peak'] as const)[Math.floor(r() * 3)]!,
      ratio: uni(1, 4),
      weights: {
        tuneChange: uni(0.2, 2), unknownStay: uni(0, 1),
        tuneToUnknown: uni(0, 1.5), unknownToTune: uni(0, 1.5),
      },
    };
    let curScore = evaluate(cur).score;

    const T0 = 6, T1 = 0.15;
    for (let step = 1; step < STEPS; step++) {
      const temp = T0 * Math.pow(T1 / T0, step / (STEPS - 1));
      const cand = neighbour(cur);
      const s = evaluate(cand).score;
      // Metropolis: always take an improvement, take a worsening with
      // probability exp(-delta/T) so the chain can leave a local optimum early
      // on and settles as the temperature falls.
      if (s >= curScore || r() < Math.exp((s - curScore) / temp)) { cur = cand; curScore = s; }
    }

    if ((ci + 1) % 2 === 0) {
      console.log(`  chaine ${ci + 1}/${mine.length} (${chain.trName} plat=${chain.flat ? 'on' : 'off'} L=${chain.lambda}), `
        + `${evals} evaluations, ${((Date.now() - t0) / 1000).toFixed(0)}s`);
    }
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const out = nodePath.join(OUT_DIR, `search-seed${SEED}-anneal${String(SHARD).padStart(2, '0')}.json`);
  fs.writeFileSync(out, JSON.stringify(outcomes), 'utf-8');
  console.log(`\n${outcomes.length} evaluations ecrites dans ${nodePath.basename(out)} `
    + `(${((Date.now() - t0) / 1000).toFixed(0)}s)`);
}, 14_400_000);
