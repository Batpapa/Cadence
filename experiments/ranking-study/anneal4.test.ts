import { it } from 'vitest';
import * as fs from 'node:fs';
import * as nodePath from 'node:path';
import { DETECTION_TEMPORAL_CONFIG as CFG, type DetectionTemporalConfig } from '../../src/session/recognition/detectionTemporalConfig';
import { SESSIONS, NOISE, DIR, loadWindows, buildTimeline, decode, type ConfirmRule } from './pipeline';
import { loadTruth, scoreSession, matchFor, type TruthEntry } from './truth';
import { ALL_TRANSFORMS, type ObservationTransform } from './transforms';

// ── Campaign v4: simulated annealing over the WHOLE post-processing chain ─────
//
// Written 2026-09-13 evening, after the engine change (tempo 60-180, preselection
// 4000, contour gate L=20) regenerated every fixture. The windows are the fixed
// input; everything between them and the final detections is searched.
//
// What changed from anneal.test.ts (v3), and why:
//
//  - **Three criteria, not two.** The chain objective is
//      found − λ·(fp + noise) + κ·iouPts,  iouPts = 100·ΣIoU / total
//    so a tune found with a tight span is worth more than one found as a sliver.
//    Noise-recording detections join the false positives: a phantom on a bar
//    recording is as real as one between two sets. Every raw quantity is stored,
//    so the analysis can re-scalarise any way it likes.
//  - **Parameters that v3 held fixed are searched**: the absent-tune floor, the
//    bounce-back penalty, the same-tune merge gap, and the three pre-Viterbi
//    gates (flat-window margin, tempo-spread threshold, admission threshold).
//    The tempo-spread gate is the pressing one: it was calibrated on 36 tempo
//    candidates (60-235) and the production engine now emits 24 (60-175), so the
//    distribution of its statistic has moved under it.
//  - **Only the transform binds a chain.** Timeline-level parameters are cheap to
//    rebuild (~80 ms for the corpus against ~2 s of decoding), so a chain moves
//    them like any other coordinate. The transform stays bound because transition
//    weights are absolute in log space while each transform has its own emission
//    scale — a chain switching transform would land somewhere meaningless.
//  - **The floor quantile reads a FIXED distribution per transform**: the best
//    transformed value of every non-empty raw window, before any gate. In v3 the
//    pool came after the gates, which would now tie floorQ to the gate settings.
//  - minSegmentWindows ∈ {0, 1, 2}: the user asked not to go past 2 (the gate
//    delays the first display of a detection).
//
//   ANNEAL_STEPS=166 ANNEAL_SHARDS=6 ANNEAL_SHARD=0 SEARCH_SEED=21 \
//     npx vitest run --config vitest.ranking.config.ts experiments/ranking-study/anneal4.test.ts
//
// ANNEAL_CHECK=1 evaluates production through the same code instead, and prints it.

const STEPS = Number(process.env['ANNEAL_STEPS'] ?? 0);
const CHECK = process.env['ANNEAL_CHECK'] === '1';
const SEED = Number(process.env['SEARCH_SEED'] ?? 21);
const SHARDS = Number(process.env['ANNEAL_SHARDS'] ?? 1);
const SHARD = Number(process.env['ANNEAL_SHARD'] ?? 0);
const ROUND = Number(process.env['ANNEAL_ROUND'] ?? 10);
const OUT_DIR = nodePath.resolve(__dirname, '.out');

/** (λ, κ) per chain. κ=0.5 is the rule that held out of sample in v3; the two
 *  extra rows bracket it on the IoU axis at the product's own exchange rate. */
const OBJECTIVES = (process.env['ANNEAL_OBJ'] ?? '0.25:0.5,0.5:0.5,1:0.5,2:0.5,0.5:0,0.5:2')
  .split(',').map(p => { const [l, k] = p.split(':').map(Number); return { lambda: l!, kappa: k! }; });

/** Seeded refinement (added the same evening): ANNEAL_START names a JSON array of
 *  campaign rows (or production's check row); each seeds one chain per objective,
 *  bound to its transform, and ANNEAL_T0 / ANNEAL_T1 set a colder schedule. The
 *  campaign found that random starts had not reached production's region after
 *  half the budget, so "nothing beats production" needs chains that start there. */
const START = process.env['ANNEAL_START'];
const T_START = Number(process.env['ANNEAL_T0'] ?? 6);
const T_END = Number(process.env['ANNEAL_T1'] ?? 0.15);

const MIN_SEGS = [0, 1, 2];
const W_HI = { tuneChange: 3, unknownStay: 2, tuneToUnknown: 2, unknownToTune: 2 } as const;

export interface Params {
  floorQ: number;
  minSeg: number;
  cName: 'none' | 'mean' | 'peak';
  ratio: number;
  weights: { tuneChange: number; unknownStay: number; tuneToUnknown: number; unknownToTune: number };
  /** absentObservationRatio; 0 = plain epsilon floor. */
  absent: number;
  rapid: number;
  mergeGap: number;
  flatOn: boolean;
  flatMargin: number;
  tempoSpread: number;
  minCand: number;
}

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const r4 = (v: number) => Math.round(v * 1e4) / 1e4;

it('anneals the whole post-processing chain (v4)', () => {
  if (!STEPS && !CHECK && !process.env['ANNEAL_EVAL']) { console.log('(ANNEAL_STEPS absent — recuit v4 ignore)'); return; }

  const sessions = SESSIONS.map(id => ({ id, windows: loadWindows(id), truth: loadTruth(DIR, id) as TruthEntry[] }));
  const noiseWindows = loadWindows(NOISE);

  const rawTopsCache = new Map<string, number[]>();
  const rawTops = (tr: ObservationTransform): number[] => {
    let tops = rawTopsCache.get(tr.name);
    if (tops) return tops;
    tops = [];
    for (const s of sessions) {
      for (const w of s.windows) {
        if (!w.candidates.length) continue;
        let best = -Infinity;
        for (const v of tr.apply(w.candidates.map(c => c.score))) if (v > best) best = v;
        if (best > 0) tops.push(best);
      }
    }
    tops.sort((a, b) => a - b);
    // relLeader and rankDecay give every leader exactly 1: a pool of tops would
    // pin their floor at 1 whatever floorQ says. Those read every candidate value.
    if (tops[0] === tops[tops.length - 1]) {
      tops = [];
      for (const s of sessions) for (const w of s.windows) for (const v of tr.apply(w.candidates.map(c => c.score))) if (v > 0) tops.push(v);
      tops.sort((a, b) => a - b);
    }
    rawTopsCache.set(tr.name, tops);
    return tops;
  };

  const cfgOf = (p: Params): DetectionTemporalConfig => ({
    ...CFG,
    flatWindowMarginThreshold: p.flatMargin,
    tempoSpreadThreshold: p.tempoSpread,
    minCandidateProbability: p.minCand,
    rapidChangePenalty: p.rapid,
    sameTuneMergeGapWindows: p.mergeGap,
  });

  const timelineKey = (p: Params) => `${p.flatOn ? p.flatMargin : 'off'}|${p.tempoSpread}|${p.minCand}`;

  function buildAll(tr: ObservationTransform, p: Params) {
    const cfg = cfgOf(p);
    const opts = { flatFilter: p.flatOn };
    return {
      key: timelineKey(p),
      tls: sessions.map(s => ({ s, tl: buildTimeline(s.windows, tr, cfg, opts) })),
      noiseTl: buildTimeline(noiseWindows, tr, cfg, opts),
    };
  }

  const qt = (a: number[], q: number) => { if (!a.length) return NaN; const b = [...a].sort((x, y) => x - y); return b[Math.min(b.length - 1, Math.floor(q * b.length))]!; };

  /** One full evaluation. `floorOverride` is for the production check only. */
  function evaluate(tr: ObservationTransform, p: Params, g: ReturnType<typeof buildAll>, floorOverride?: number) {
    const t0 = Date.now();
    const tops = rawTops(tr);
    const floor = floorOverride ?? tops[Math.floor(p.floorQ * (tops.length - 1))]!;
    const cfg = cfgOf(p);
    const confirm: ConfirmRule = p.cName === 'none' ? { kind: 'none' } : { kind: p.cName, ratio: floor * p.ratio };
    let found = 0, total = 0, fp = 0, misplaced = 0, sumIoU = 0, nIoU = 0, covSum = 0;
    const startErr: number[] = [], endErr: number[] = [];
    const per: number[][] = [];
    for (const { s, tl } of g.tls) {
      const segs = decode(tl, cfg, floor, p.minSeg, p.weights, confirm, 0, p.absent);
      const sc = scoreSession(s.truth, segs);
      found += sc.found; total += sc.total; fp += sc.falsePositives; misplaced += sc.misplaced;
      covSum += sc.meanCoverage * sc.found;
      let sI = 0, nI = 0;
      for (const row of s.truth) {
        if (row.kind !== 'tune' || !(row.end > row.start)) continue;
        const hit = matchFor(row, segs);
        if (!hit) continue;
        const inter = Math.max(0, Math.min(hit.endTime, row.end) - Math.max(hit.startTime, row.start));
        const union = Math.max(hit.endTime, row.end) - Math.min(hit.startTime, row.start);
        sI += union > 0 ? inter / union : 0; nI++;
        startErr.push(Math.abs(hit.startTime - row.start));
        endErr.push(Math.abs(hit.endTime - row.end));
      }
      sumIoU += sI; nIoU += nI;
      per.push([sc.found, sc.total, sc.falsePositives, sc.misplaced, r4(sI), nI]);
    }
    const noise = new Set(decode(g.noiseTl, cfg, floor, p.minSeg, p.weights, confirm, 0, p.absent).map(s => s.tuneId)).size;
    return {
      transform: tr.name,
      // Unrounded: floorQ indexes a pool of ~9 000 values, and a 4-decimal floorQ can
      // land one index off on replay (the seed-21 rows carry the rounding).
      floorQ: p.floorQ, floor, minSeg: p.minSeg,
      confirm: p.cName === 'none' ? 'none' : `${p.cName}x${p.ratio.toFixed(2)}`,
      // Parameters unrounded too: the seed-21 rows, rounded to 4 decimals, replay with
      // identical counts but a ΣIoU off by up to 0.4 (boundaries move on ties).
      weights: { ...p.weights },
      absent: p.absent, rapid: p.rapid, mergeGap: p.mergeGap,
      flat: p.flatOn ? p.flatMargin : null, tempoSpread: p.tempoSpread, minCand: p.minCand,
      found, total, fp, noise, misplaced,
      sumIoU: r4(sumIoU), iouMean: nIoU ? r4(sumIoU / nIoU) : 0, iouPts: total ? r4(100 * sumIoU / total) : 0,
      coverage: found ? r4(covSum / found) : 0,
      startP50: qt(startErr, 0.5), startP90: qt(startErr, 0.9), endP50: qt(endErr, 0.5), endP90: qt(endErr, 0.9),
      per, ms: Date.now() - t0,
    };
  }

  if (CHECK) {
    const prod: Params = {
      floorQ: 0, minSeg: CFG.minSegmentWindows, cName: 'none', ratio: 1,
      weights: { tuneChange: CFG.tuneChangePenalty, unknownStay: CFG.unknownStayPenalty, tuneToUnknown: CFG.tuneToUnknownPenalty, unknownToTune: CFG.unknownToTunePenalty },
      absent: CFG.absentObservationRatio ?? 0, rapid: CFG.rapidChangePenalty, mergeGap: CFG.sameTuneMergeGapWindows,
      flatOn: true, flatMargin: CFG.flatWindowMarginThreshold, tempoSpread: CFG.tempoSpreadThreshold, minCand: CFG.minCandidateProbability,
    };
    const tr = ALL_TRANSFORMS.find(t => t.name === 'identity')!;
    const tops = rawTops(tr);
    const q = tops.findIndex(v => v >= CFG.unknownObservationProbability) / (tops.length - 1);
    const variants: [string, Partial<Params>][] = [
      ['production', {}],
      ['production minCand 0.14', { minCand: 0.14 }],
      ['production tempoSpread 0', { tempoSpread: 0 }],
    ];
    const rows: unknown[] = [];
    for (const [label, over] of variants) {
      const p = { ...prod, ...over };
      const t0 = Date.now();
      const g = buildAll(tr, p);
      const tb = Date.now() - t0;
      const o = evaluate(tr, p, g, CFG.unknownObservationProbability);
      rows.push({ label, ...o });
      console.log(`${label}: ${o.found}/${o.total} fp=${o.fp} bruit=${o.noise} IoU=${(o.iouMean * 100).toFixed(1)}% `
        + `debut p50/p90=${o.startP50}/${o.startP90} fin=${o.endP50}/${o.endP90} | ${o.per.map(x => `${x[0]}/${x[2]}`).join(' ')} `
        + `| build ${tb} ms, eval ${o.ms} ms`);
    }
    console.log(`identity : plancher 0.20 = quantile ${q.toFixed(4)} des ${tops.length} tops bruts`);
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(nodePath.join(OUT_DIR, 'v4-check.json'), JSON.stringify(rows, null, 1), 'utf-8');
    return;
  }

  type StartRow = {
    transform: string; floorQ?: number; floor: number; minSeg: number; confirm: string;
    weights: Params['weights']; absent: number; rapid: number; mergeGap: number;
    flat: number | null; tempoSpread: number; minCand: number;
  };
  const toParams = (s: StartRow, tr: ObservationTransform): Params => {
    const tops = rawTops(tr);
    // Production's check row carries an absolute floor (floorQ 0): take the
    // smallest pool value at or above it.
    const idx = s.floorQ ? -1 : Math.max(0, tops.findIndex(v => v >= s.floor));
    const m = /^(mean|peak)x([\d.]+)$/.exec(s.confirm);
    return {
      floorQ: s.floorQ ? s.floorQ : idx / (tops.length - 1),
      minSeg: s.minSeg, cName: m ? m[1] as 'mean' | 'peak' : 'none', ratio: m ? Number(m[2]) : 1,
      weights: { ...s.weights }, absent: s.absent, rapid: s.rapid, mergeGap: s.mergeGap,
      flatOn: s.flat !== null, flatMargin: s.flat ?? CFG.flatWindowMarginThreshold,
      tempoSpread: s.tempoSpread, minCand: s.minCand,
    };
  };

  // ANNEAL_EVAL=in.json [ANNEAL_EVAL_OUT=out.json]: evaluate rows as given, no search —
  // neighbourhood and robustness probes. A row with `floorQ` reads the pool; one
  // without it uses `floor` as an absolute value.
  const EVAL = process.env['ANNEAL_EVAL'];
  if (EVAL) {
    // Sharded like the campaign: ANNEAL_SHARDS / ANNEAL_SHARD split the list by index,
    // and each shard writes <out>-<shard>.json.
    const list = (JSON.parse(fs.readFileSync(EVAL, 'utf-8')) as (StartRow & { label?: string })[])
      .filter((_, i) => i % SHARDS === SHARD);
    const res: unknown[] = [];
    const t0 = Date.now();
    let g: ReturnType<typeof buildAll> | null = null;
    let gTr = '';
    for (const s of list) {
      const tr = ALL_TRANSFORMS.find(t => t.name === s.transform);
      if (!tr) throw new Error(`transformation inconnue : ${s.transform}`);
      const p = toParams(s, tr);
      if (!g || gTr !== tr.name || g.key !== timelineKey(p)) { g = buildAll(tr, p); gTr = tr.name; }
      const o = evaluate(tr, p, g, s.floorQ ? undefined : s.floor);
      // ANNEAL_EVAL_DETAIL=1: per session, which annotated rows were found (row index ->
      // IoU) and which detected ids counted as false positives — for paired tests.
      let detail: unknown;
      if (process.env['ANNEAL_EVAL_DETAIL'] === '1') {
        const floor = s.floorQ ? rawTops(tr)[Math.floor(p.floorQ * (rawTops(tr).length - 1))]! : s.floor;
        const cfg = cfgOf(p);
        const confirm: ConfirmRule = p.cName === 'none' ? { kind: 'none' } : { kind: p.cName, ratio: floor * p.ratio };
        detail = g.tls.map(({ s: sess, tl }) => {
          const segs = decode(tl, cfg, floor, p.minSeg, p.weights, confirm, 0, p.absent);
          const hits: Record<number, number> = {};
          sess.truth.forEach((row, i) => {
            if (row.kind !== 'tune') return;
            const hit = matchFor(row, segs);
            if (!hit) return;
            const inter = Math.max(0, Math.min(hit.endTime, row.end) - Math.max(hit.startTime, row.start));
            const union = Math.max(hit.endTime, row.end) - Math.min(hit.startTime, row.start);
            hits[i] = union > 0 ? inter / union : 0;
          });
          const tuneIds = new Set(sess.truth.filter(x => x.kind === 'tune').flatMap(x => [...x.ids]));
          const excused = new Set(segs.filter(sg => sess.truth.some(x => x.kind === 'unknown' && sg.startTime < x.end && sg.endTime > x.start)).map(sg => sg.tuneId));
          const fpIds = [...new Set(segs.map(sg => sg.tuneId))].filter(id => !tuneIds.has(id) && !excused.has(id));
          // Segments answering no annotated row where they sit (scoreSession's `misplaced`).
          const misplaced = segs.filter(sg =>
            !sess.truth.some(x => x.kind === 'tune' && x.ids.has(sg.tuneId) && sg.startTime < x.end && sg.endTime > x.start)
            && !sess.truth.some(x => x.kind === 'unknown' && sg.startTime < x.end && sg.endTime > x.start))
            .map(sg => ({ id: sg.tuneId, name: sg.label, span: sg.span, claimed: tuneIds.has(sg.tuneId) }));
          return { session: sess.id, hits, fpIds, misplaced };
        });
      }
      res.push({ label: s.label, ...o, ...(detail ? { detail } : {}) });
      console.log(`  ${s.label ?? ''} ${o.found}/${o.total} fp=${o.fp}+${o.noise} IoU=${(o.iouMean * 100).toFixed(1)}% | ${o.per.map(x => `${x[0]}/${x[2]}`).join(' ')}`);
    }
    const outBase = process.env['ANNEAL_EVAL_OUT'] ?? EVAL.replace(/\.json$/, '-results.json');
    fs.writeFileSync(SHARDS > 1 ? outBase.replace(/\.json$/, `-${SHARD}.json`) : outBase, JSON.stringify(res), 'utf-8');
    console.log(`${res.length} configurations en ${((Date.now() - t0) / 1000).toFixed(0)}s`);
    return;
  }

  const chains: { tr: ObservationTransform; lambda: number; kappa: number; id: number; start?: StartRow }[] = [];
  if (START) {
    for (const s of JSON.parse(fs.readFileSync(START, 'utf-8')) as StartRow[]) {
      const tr = ALL_TRANSFORMS.find(t => t.name === s.transform);
      if (!tr) throw new Error(`transformation inconnue : ${s.transform}`);
      for (const o of OBJECTIVES) chains.push({ tr, ...o, id: chains.length, start: s });
    }
  } else {
    for (const tr of ALL_TRANSFORMS) for (const o of OBJECTIVES) chains.push({ tr, ...o, id: chains.length });
  }
  const mine = chains.filter((_, i) => i % SHARDS === SHARD);
  console.log(`recuit v4 ${SHARD + 1}/${SHARDS} : ${mine.length} chaines x ${STEPS} pas = ${mine.length * STEPS} evaluations`);

  const outcomes: Record<string, unknown>[] = [];
  const t0 = Date.now();
  let evals = 0;
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const tag = process.env['ANNEAL_TAG'] ? `-${process.env['ANNEAL_TAG']}` : '';
  const out = nodePath.join(OUT_DIR, `v4-seed${SEED}-anneal${String(SHARD).padStart(2, '0')}${tag}.json`);
  const flush = (): void => { fs.writeFileSync(out, JSON.stringify(outcomes), 'utf-8'); };

  const runners = mine.map(chain => {
    const r = rng(SEED * 7919 + chain.id * 104729);
    const uni = (lo: number, hi: number) => lo + r() * (hi - lo);
    const gauss = () => {
      const u = Math.max(r(), 1e-9);
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r());
    };
    // One timeline set per chain, rebuilt only when a timeline-level coordinate moves.
    let g: ReturnType<typeof buildAll> | null = null;
    const timelinesFor = (p: Params) => {
      if (!g || g.key !== timelineKey(p)) g = buildAll(chain.tr, p);
      return g;
    };

    function run(p: Params, step: number, temp: number) {
      const o: Record<string, unknown> & ReturnType<typeof evaluate> = evaluate(chain.tr, p, timelinesFor(p));
      evals++;
      const score = o.found - chain.lambda * (o.fp + o.noise) + chain.kappa * o.iouPts;
      Object.assign(o, { lambda: chain.lambda, kappa: chain.kappa, chain: chain.id, step, temp: r4(temp), score: r4(score), accepted: true });
      outcomes.push(o);
      if (evals % 20 === 0) flush();
      return { o, score };
    }

    /** One coordinate per step. */
    function neighbour(st: Params): Params {
      const n: Params = { ...st, weights: { ...st.weights } };
      const d = r();
      if (d < 0.18) n.floorQ = clamp(st.floorQ * Math.exp(gauss() * 0.25), 0.0005, 0.9);
      else if (d < 0.24) n.minSeg = MIN_SEGS[Math.floor(r() * MIN_SEGS.length)]!;
      else if (d < 0.32) { n.cName = (['none', 'mean', 'peak'] as const)[Math.floor(r() * 3)]!; n.ratio = clamp(st.ratio + gauss() * 0.4, 1, 5); }
      else if (d < 0.60) {
        const k = (['tuneChange', 'unknownStay', 'tuneToUnknown', 'unknownToTune'] as const)[Math.floor(r() * 4)]!;
        n.weights[k] = clamp(st.weights[k] + gauss() * 0.2, 0, W_HI[k]);
      }
      else if (d < 0.70) n.absent = clamp(st.absent + gauss() * 0.12, 0, 0.99);
      else if (d < 0.75) n.rapid = clamp(st.rapid + gauss() * 0.5, 0, 4);
      else if (d < 0.82) n.mergeGap = clamp(st.mergeGap + (r() < 0.5 ? -1 : 1) * (1 + Math.floor(r() * 4)), 0, 24);
      else if (d < 0.88) {
        if (r() < 0.3) n.flatOn = !st.flatOn;
        else { n.flatOn = true; n.flatMargin = clamp(st.flatMargin + gauss() * 0.025, 0, 0.25); }
      }
      else if (d < 0.94) n.tempoSpread = clamp(st.tempoSpread + gauss() * 0.03, 0, 0.3);
      else n.minCand = clamp(st.minCand + gauss() * 0.025, 0.12, 0.32);
      return n;
    }

    const T0 = T_START, T1 = T_END;
    let cur: Params = chain.start ? toParams(chain.start, chain.tr) : {
      floorQ: uni(0.01, 0.7),
      minSeg: MIN_SEGS[Math.floor(r() * MIN_SEGS.length)]!,
      cName: (['none', 'mean', 'peak'] as const)[Math.floor(r() * 3)]!,
      ratio: uni(1, 4),
      weights: { tuneChange: uni(0.2, 2), unknownStay: uni(0, 1), tuneToUnknown: uni(0, 1.5), unknownToTune: uni(0, 1.5) },
      absent: uni(0, 0.95),
      rapid: uni(0, 4),
      mergeGap: Math.floor(uni(0, 21)),
      flatOn: r() < 0.5,
      flatMargin: uni(0, 0.15),
      tempoSpread: uni(0, 0.2),
      minCand: uni(0.14, 0.30),
    };
    let curScore = NaN;
    let step = 0;

    return (n: number): boolean => {
      for (let i = 0; i < n && step < STEPS; i++, step++) {
        const temp = T0 * Math.pow(T1 / T0, step / Math.max(1, STEPS - 1));
        if (step === 0) { curScore = run(cur, 0, temp).score; continue; }
        const cand = neighbour(cur);
        const { o, score } = run(cand, step, temp);
        if (score >= curScore || r() < Math.exp((score - curScore) / temp)) { cur = cand; curScore = score; }
        else o['accepted'] = false;
      }
      return step < STEPS;
    };
  });

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
  console.log(`\n${outcomes.length} evaluations ecrites dans ${nodePath.basename(out)} (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
}, 36_000_000);
