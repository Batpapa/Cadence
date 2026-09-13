// node v4/picks.js L K [out.json] — nested held-out selection over campaign + refinement:
// per fold, the configurations picked on the six training sessions, their result on
// the held-out session next to production's, and the distinct picks (written to out).
const fs = require('fs');
const path = require('path');
const OUT = path.join(__dirname, '..', '.out');
const SESS = ['Korea', 'Anglade', 'tabac', 'auberge', 'OneBest', '13thMoon', 'AudioF'];
const [l, k] = [Number(process.argv[2]), Number(process.argv[3])];
// COST=fp (default) penalises distinct false-positive ids, the campaign's own criterion.
// COST=mis penalises MISPLACED SEGMENTS instead: `fp` counts an id once however many
// phantoms it lays down, and the v4 candidate exploited exactly that (2265 eleven times
// in Audio F). COST=both adds the two.
const COST = process.env.COST || 'fp';
const cost = (r, s) => {
  const p = r.per[s];
  const fp = r.fp - p[2] + r.noise, mis = r.misplaced - p[3] + r.noise;
  return COST === 'mis' ? mis : COST === 'both' ? fp + mis : fp;
};
const heldCost = (p, noise) => (COST === 'mis' ? p[3] : COST === 'both' ? p[2] + p[3] : p[2]);
let rows = [];
for (const f of fs.readdirSync(OUT).filter(f => /^v4-seed2\d-anneal\d+\.json$/.test(f))) rows.push(...JSON.parse(fs.readFileSync(path.join(OUT, f), 'utf-8')));
const PROD = JSON.parse(fs.readFileSync(path.join(OUT, 'v4-check.json'), 'utf-8')).find(r => r.label === 'production');
const TOTAL = PROD.total;
const key = r => JSON.stringify([r.transform, r.floor, r.minSeg, r.confirm, r.weights, r.absent, r.rapid, r.mergeGap, r.flat, r.tempoSpread, r.minCand]);
const distinct = new Map();
let T = [0, 0, 0, 0, 0], Pr = [0, 0, 0, 0, 0];
for (let s = 0; s < 7; s++) {
  let best = -Infinity, tied = [];
  for (const r of rows) {
    const p = r.per[s];
    const sc = (r.found - p[0]) - l * cost(r, s) + k * 100 * (r.sumIoU - p[4]) / (TOTAL - p[1]);
    if (sc > best + 1e-9) { best = sc; tied = [r]; } else if (Math.abs(sc - best) <= 1e-9) tied.push(r);
  }
  const uniq = new Map(tied.map(r => [key(r), r]));
  const avg = i => tied.reduce((a, r) => a + r.per[s][i], 0) / tied.length;
  const pp = PROD.per[s];
  console.log(`${SESS[s].padEnd(9)} ${tied.length} ex-aequo (${uniq.size} distincts) : ${avg(0).toFixed(1)}/${avg(1)} fp ${avg(2).toFixed(1)} mal places ${avg(3).toFixed(1)} IoU ${(avg(4) / avg(5) * 100).toFixed(1)} | production ${pp[0]}/${pp[1]} fp ${pp[2]} mal places ${pp[3]} IoU ${(pp[4] / pp[5] * 100).toFixed(1)}`);
  T = [T[0] + avg(0), T[1] + avg(2), T[2] + avg(4), T[3] + avg(5), T[4] + avg(3)];
  Pr = [Pr[0] + pp[0], Pr[1] + pp[2], Pr[2] + pp[4], Pr[3] + pp[5], Pr[4] + pp[3]];
  for (const [kk, r] of uniq) { const d = distinct.get(kk) || { r, folds: 0 }; d.folds += 1 / 7; distinct.set(kk, d); }
}
console.log(`\n[COST=${COST}] hors echantillon : ${T[0].toFixed(1)} / fp ${T[1].toFixed(1)} / mal places ${T[4].toFixed(1)} / IoU ${(T[2] / T[3] * 100).toFixed(1)} %   production ${Pr[0]} / ${Pr[1]} / ${Pr[4]} / ${(Pr[2] / Pr[3] * 100).toFixed(1)} %`);
const list = [...distinct.values()].sort((a, b) => b.folds - a.folds);
for (const { r, folds } of list.slice(0, 8)) console.log(`  ${(folds * 7).toFixed(0)} pli(s) : ${r.transform} ${r.found}/${r.fp}+${r.noise} IoU ${(r.iouMean * 100).toFixed(1)} a=${r.absent.toFixed(3)} stay=${r.weights.unknownStay.toFixed(3)} in=${r.weights.unknownToTune.toFixed(3)} out=${r.weights.tuneToUnknown.toFixed(3)} chg=${r.weights.tuneChange.toFixed(3)} rap=${r.rapid.toFixed(2)} gap=${r.mergeGap} ts=${r.tempoSpread.toFixed(3)} mc=${r.minCand.toFixed(3)} flat=${r.flat} mS=${r.minSeg} ${r.confirm} fl=${r.floor}`);
if (process.argv[4]) fs.writeFileSync(process.argv[4], JSON.stringify(list.map(({ r, folds }, i) => ({ ...r, label: `pick${i}-${(folds * 7).toFixed(0)}plis` }))));
