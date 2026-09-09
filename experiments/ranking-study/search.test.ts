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

// ── Joint random search ──────────────────────────────────────────────────────
//
// The sweeps next door move one factor at a time. That is fine for building
// intuition and it is how the ratio transforms and the flat filter were found —
// but it cannot be the last word here, for a reason this study established
// itself: **the factors interact.** The transforms compress the emission scale,
// which changes what the transition costs weigh against the evidence. Tuning
// either alone lands in whatever optimum the other one's current value permits.
//
// Random search over the joint space is the standard answer, and in ten
// dimensions it beats a grid: a grid spends its budget refining coordinates that
// do not matter, while random sampling gives every dimension a different value
// on every draw.
//
// The objective is deliberately NOT a single scalar. Recall and false positives
// trade against each other and the exchange rate is the user's call, so this
// reports the PARETO FRONT — every configuration that no other beats on both
// counts at once — and leaves the choice of point on it open.
//
//   SEARCH_N=300 npm run ranking          # sample budget
//   SEARCH_SEED=7 npm run ranking         # reproducible draw

const N = Number(process.env['SEARCH_N'] ?? 0);      // 0 = skip entirely
const SEED = Number(process.env['SEARCH_SEED'] ?? 1);

// ── Sharding ────────────────────────────────────────────────────────────────
// The work parallelises without any shared state, because a group — one
// (transform, flat) pair with all the samples that drew it — is self-contained:
// it builds its own timelines and never looks at another group's. Assigning
// groups round-robin across processes is therefore exact, not approximate.
//
// Every shard draws the SAME sequence from the same seed and then keeps only its
// own groups, so the sampling is identical however many shards run. A run split
// eight ways and a run done in one process produce the same 240 configurations.
//
//   SEARCH_N=240 SEARCH_SHARDS=8 SEARCH_SHARD=3 npm run ranking   # one worker
//   SEARCH_MERGE=1 SEARCH_SEED=1 npm run ranking                  # collect them
const SHARDS = Number(process.env['SEARCH_SHARDS'] ?? 1);
const SHARD = Number(process.env['SEARCH_SHARD'] ?? 0);
const MERGE = process.env['SEARCH_MERGE'] === '1';
const OUT_DIR = nodePath.resolve(__dirname, '.out');

/** mulberry32 — small, fast, and seeded, so a promising sample can be replayed
 *  exactly. An unseeded search is not a measurement. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Sample {
  transform: string;
  flat: boolean;
  floorQ: number;
  floor: number;
  minSeg: number;
  confirm: string;
  weights: TransitionWeights;
}

interface Outcome extends Sample {
  found: number;
  total: number;
  fp: number;
  noise: number;
  coverage: number;
}

/** Pareto front: keep a configuration only if nothing else found at least as
 *  many tunes for no more false positives, and beat it on one of the two. */
function paretoFront(outcomes: Outcome[]): Outcome[] {
  return outcomes
    .filter(o => !outcomes.some(p => p.fp <= o.fp && p.found >= o.found && (p.fp < o.fp || p.found > o.found)))
    .sort((a, b) => a.fp - b.fp);
}

function report(outcomes: Outcome[], label: string): void {
  const front = paretoFront(outcomes);
  const w = (x: TransitionWeights) =>
    `chg=${x.tuneChange!.toFixed(2)} stay=${x.unknownStay!.toFixed(2)} out=${x.tuneToUnknown!.toFixed(2)} in=${x.unknownToTune!.toFixed(2)}`;

  console.log(`\n==== front de Pareto — ${label} (${front.length} sur ${outcomes.length} tirages) ====`);
  console.log('  rappel | fp | bruit | couv | transformation      | plat | plancher | minSeg | confirm     | poids');
  for (const o of front) {
    console.log(`  ${String(o.found).padStart(6)} | ${String(o.fp).padStart(2)} | ${String(o.noise).padStart(5)} `
      + `| ${(o.coverage * 100).toFixed(0).padStart(3)}% | ${o.transform.padEnd(19)} | ${(o.flat ? 'on' : 'off').padEnd(4)} `
      + `| ${o.floor.toFixed(4).padStart(8)} | ${String(o.minSeg).padStart(6)} | ${o.confirm.padEnd(11)} | ${w(o.weights)}`);
  }

  // Anything reaching BOTH production numbers is a strict improvement rather
  // than a trade. The pair is keyed by corpus size instead of written as a bare
  // literal, because it silently went stale once: the (177, 10) of the
  // six-session corpus survived the arrival of Audio F and kept printing a
  // headline that counted winners against a bar two thirds too low. `total` is
  // carried by every evaluation, so an unknown corpus now says so rather than
  // flattering itself.
  const PRODUCTION: Record<number, { found: number; fp: number }> = {
    192: { found: 177, fp: 10 },   // six sessions, before Audio F
    341: { found: 312, fp: 20 },   // seven sessions; measured by threshold-sweep at floor 0.20, 2026-09-09
  };
  const corpus = outcomes[0]!.total;
  const prod = PRODUCTION[corpus];
  if (!prod) {
    console.log(`\n  (corpus de ${corpus} morceaux inconnu — repere de production a mesurer avant de comparer)`);
    return;
  }
  const better = outcomes.filter(o => o.found >= prod.found && o.fp <= prod.fp).sort((a, b) => b.found - a.found || a.fp - b.fp);
  console.log(`\n  configurations dominant la production (>=${prod.found} morceaux, <=${prod.fp} faux positifs) : ${better.length}`);
  for (const o of better.slice(0, 12)) {
    console.log(`    ${o.found}/${o.total} fp=${o.fp} bruit=${o.noise} couv=${(o.coverage * 100).toFixed(0)}% | ${o.transform} plat=${o.flat ? 'on' : 'off'} `
      + `plancher=${o.floor.toFixed(4)} minSeg=${o.minSeg} conf=${o.confirm} | ${w(o.weights)}`);
  }
}

it('merges shard results', () => {
  if (!MERGE) { console.log('(SEARCH_MERGE absent — rien a fusionner)'); return; }
  // SEARCH_SEED=all pools every campaign in the directory. Legitimate, and the
  // point of writing each shard out rather than reporting in place: random
  // draws and annealing chains from different seeds are all just evaluations of
  // the same objective, so they belong on the same front.
  const prefix = process.env['SEARCH_SEED'] === 'all' ? 'search-seed' : `search-seed${SEED}-`;
  const files = fs.readdirSync(OUT_DIR).filter(f => f.startsWith(prefix) && f.endsWith('.json'));
  if (!files.length) throw new Error(`aucun fragment (${prefix}*) dans ${OUT_DIR}`);
  const all: Outcome[] = files.flatMap(f => JSON.parse(fs.readFileSync(nodePath.join(OUT_DIR, f), 'utf-8')) as Outcome[]);
  console.log(`${files.length} fragments, ${all.length} evaluations au total`);

  // A Pareto front is only meaningful over ONE corpus. `total` is the number of
  // scorable ground-truth tunes, so it identifies the corpus exactly: 192 for
  // the six sessions this study ran on until 2026-09-08, 341 once Audio F's CSV
  // arrived. Pooling both would rank a configuration that found 178 of 192
  // against one that found 178 of 341 and call the first better, silently.
  // Refuse rather than mix — the campaigns belong in separate directories.
  const byCorpus = new Map<number, number>();
  for (const o of all) byCorpus.set(o.total, (byCorpus.get(o.total) ?? 0) + 1);
  if (byCorpus.size > 1) {
    const seen = [...byCorpus.entries()].sort((a, b) => b[1] - a[1])
      .map(([t, n]) => `${n} evaluations sur ${t} morceaux`).join(', ');
    throw new Error(
      `${OUT_DIR} melange des corpus differents (${seen}). Une comparaison n'a de sens `
      + `qu'a corpus constant : archiver les anciens fragments ailleurs avant de fusionner.`);
  }
  console.log(`corpus : ${[...byCorpus.keys()][0]} morceaux de reference`);

  report(all, process.env['SEARCH_SEED'] === 'all' ? 'toutes campagnes' : `graine ${SEED}`);

  // Where the front's configurations concentrate — the aggregate answer to
  // "which choices actually matter", which no single winning row can give.
  const front = paretoFront(all);
  const tally = (get: (o: Outcome) => string) => {
    const m = new Map<string, number>();
    for (const o of front) m.set(get(o), (m.get(get(o)) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}:${n}`).join('  ');
  };
  console.log(`\n  front par transformation : ${tally(o => o.transform)}`);
  console.log(`  front par filtre plat    : ${tally(o => (o.flat ? 'on' : 'off'))}`);
  console.log(`  front par minSeg         : ${tally(o => `minSeg${o.minSeg}`)}`);
  console.log(`  front par confirmation   : ${tally(o => o.confirm.replace(/x[\d.]+$/, ''))}`);
}, 600_000);

it('searches the joint parameter space', () => {
  if (!N) { console.log('(SEARCH_N absent — recherche ignoree)'); return; }

  const sessions = SESSIONS.map(id => ({ id, windows: loadWindows(id), truth: loadTruth(DIR, id) as TruthEntry[] }));
  const noiseWindows = loadWindows(NOISE);

  // Timelines are built ONE GROUP AT A TIME and released before the next.
  //
  // The first version cached them all and died: a timeline holds one dense
  // Float array per state per window, so six sessions come to roughly 100 MB per
  // (transform, flat) pair — and there are twenty such pairs. The worker ran out
  // of heap around the fortieth sample. Drawing every sample up front and
  // grouping by timeline keeps exactly one alive, and builds each once instead
  // of on demand.
  function buildGroup(trName: string, flat: boolean) {
    const tr = ALL_TRANSFORMS.find(t => t.name === trName)!;
    const tls = sessions.map(s => ({ s, tl: buildTimeline(s.windows, tr, CFG, { flatFilter: flat }) }));
    const noiseTl = buildTimeline(noiseWindows, tr, CFG, { flatFilter: flat });
    const tops: number[] = [];
    for (const { tl } of tls) {
      for (let t = 0; t < tl.windows.length; t++) {
        let best = 0;
        for (const id of tl.tuneIds) { const v = tl.observations.get(id)![t]!; if (v > best) best = v; }
        if (best > 0) tops.push(best);
      }
    }
    tops.sort((a, b) => a - b);
    return { tls, noiseTl, tops };
  }

  const r = rng(SEED);
  const pick = <T,>(xs: T[]): T => xs[Math.floor(r() * xs.length)]!;
  const uni = (lo: number, hi: number) => lo + r() * (hi - lo);

  // Every draw made up front, so they can be grouped. The floor stays a
  // QUANTILE at this stage and is resolved to a number only once its own
  // transform's distribution exists — the transforms live on different scales,
  // and a shared numeric range would sample nonsense for most of them.
  interface Draw {
    trName: string; flat: boolean; floorQ: number; minSeg: number;
    cName: string; ratio: number; weights: TransitionWeights;
  }
  const draws: Draw[] = [];
  for (let i = 0; i < N; i++) {
    draws.push({
      trName: pick(ALL_TRANSFORMS).name,
      flat: r() < 0.5,
      floorQ: Math.pow(uni(0, 1), 2) * 0.25,          // squared: dense near zero
      minSeg: pick([0, 1, 2]),                        // restricted on request: a duration floor above production's is the wrong direction
      cName: pick(['none', 'none', 'mean', 'peak']),
      ratio: uni(1, 4),
      weights: {
        tuneChange: uni(0.2, 2),
        unknownStay: uni(0, 1),
        tuneToUnknown: uni(0, 1.5),
        unknownToTune: uni(0, 1.5),
      },
    });
  }

  const allGroups = new Map<string, Draw[]>();
  for (const d of draws) {
    const key = `${d.trName}|${d.flat}`;
    (allGroups.get(key) ?? allGroups.set(key, []).get(key)!).push(d);
  }
  // Round-robin over a SORTED key list, so the split is identical whatever
  // order the draws happened to create the groups in.
  const groups = new Map(
    [...allGroups.entries()].sort((a, b) => a[0].localeCompare(b[0])).filter((_, i) => i % SHARDS === SHARD),
  );
  console.log(`fragment ${SHARD + 1}/${SHARDS} : ${groups.size} groupes, `
    + `${[...groups.values()].reduce((a, g) => a + g.length, 0)} tirages sur ${N}`);

  const outcomes: Outcome[] = [];
  const t0 = Date.now();
  let done = 0;

  for (const [key, ds] of groups) {
    const [trName, flatStr] = key.split('|');
    const { tls, noiseTl, tops } = buildGroup(trName!, flatStr === 'true');

    for (const d of ds) {
      const floor = tops[Math.floor(d.floorQ * (tops.length - 1))]!;
      const confirm: ConfirmRule = d.cName === 'none'
        ? { kind: 'none' }
        : { kind: d.cName as 'mean' | 'peak', ratio: floor * d.ratio };

      let found = 0, total = 0, fp = 0;
      const covs: number[] = [];
      for (const { s, tl } of tls) {
        const sc = scoreSession(s.truth, decode(tl, CFG, floor, d.minSeg, d.weights, confirm));
        found += sc.found; total += sc.total; fp += sc.falsePositives;
        if (sc.found) covs.push(sc.meanCoverage * sc.found);
      }
      const noise = new Set(decode(noiseTl, CFG, floor, d.minSeg, d.weights, confirm).map(s => s.tuneId)).size;

      outcomes.push({
        transform: d.trName, flat: d.flat, floorQ: d.floorQ, floor, minSeg: d.minSeg,
        confirm: d.cName === 'none' ? 'none' : `${d.cName}x${d.ratio.toFixed(2)}`,
        weights: d.weights, found, total, fp, noise,
        coverage: found ? covs.reduce((a, b) => a + b, 0) / found : 0,
      });

      if (++done % 25 === 0) console.log(`  ${done}/${N} tirages, ${((Date.now() - t0) / 1000).toFixed(0)}s`);
    }
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const out = nodePath.join(OUT_DIR, `search-seed${SEED}-${String(SHARD).padStart(2, '0')}.json`);
  fs.writeFileSync(out, JSON.stringify(outcomes), 'utf-8');
  console.log(`\n${outcomes.length} tirages ecrits dans ${nodePath.basename(out)} `
    + `(${((Date.now() - t0) / 1000).toFixed(0)}s)`);

  // A single shard's front is only its own; the merge step is what produces the
  // real one. Printed anyway so a solo run needs no second command.
  report(outcomes, SHARDS > 1 ? `fragment ${SHARD + 1}/${SHARDS} SEUL` : `graine ${SEED}`);
}, 7_200_000);
