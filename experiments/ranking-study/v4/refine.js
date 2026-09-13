// node v4/refine.js — B2: what each seeded chain found, per start and objective.
const fs = require('fs');
const path = require('path');
const OUT = path.join(__dirname, '..', '.out');
let rows = [];
for (const f of fs.readdirSync(OUT).filter(f => /^v4-seed22-anneal\d+\.json$/.test(f))) rows.push(...JSON.parse(fs.readFileSync(path.join(OUT, f), 'utf-8')));
const PROD = JSON.parse(fs.readFileSync(path.join(OUT, 'v4-check.json'), 'utf-8')).find(r => r.label === 'production');
const P = r => r.fp + r.noise;
const fmt = r => `${r.found}/${r.fp}+${r.noise} IoU ${(r.iouMean * 100).toFixed(1)} b90 ${r.startP90}/${r.endP90}`;
const chains = {};
for (const r of rows) (chains[r.chain] ||= []).push(r);
const byStart = {};
for (const rs of Object.values(chains)) {
  rs.sort((a, b) => a.step - b.step);
  const s0 = rs[0];
  (byStart[`${s0.transform} ${s0.found}/${s0.fp}+${s0.noise}`] ||= []).push(rs);
}
console.log(`${rows.length} evaluations ; production ${fmt(PROD)}`);
for (const [start, list] of Object.entries(byStart)) {
  console.log(`\n== depart ${start} ==`);
  for (const rs of list.sort((a, b) => a[0].lambda - b[0].lambda || a[0].kappa - b[0].kappa)) {
    const best = rs.reduce((a, b) => (b.score > a.score ? b : a));
    const dom = rs.filter(r => r.found >= PROD.found && P(r) <= P(PROD) && r.iouMean >= PROD.iouMean && (r.found > PROD.found || P(r) < P(PROD) || r.iouMean > PROD.iouMean)).length;
    console.log(`  L=${rs[0].lambda} K=${rs[0].kappa} : depart score ${rs[0].score.toFixed(1)} -> meilleur ${best.score.toFixed(1)} (pas ${best.step}) ${fmt(best)} | dominent la prod : ${dom}/${rs.length}`);
    console.log(`     a=${best.absent.toFixed(3)} stay=${best.weights.unknownStay.toFixed(3)} in=${best.weights.unknownToTune.toFixed(3)} out=${best.weights.tuneToUnknown.toFixed(3)} chg=${best.weights.tuneChange.toFixed(3)} rap=${best.rapid.toFixed(2)} gap=${best.mergeGap} ts=${best.tempoSpread.toFixed(3)} mc=${best.minCand.toFixed(3)} flat=${best.flat === null ? 'off' : best.flat.toFixed(3)} mS=${best.minSeg} ${best.confirm} fl=${best.floor.toFixed(4)}`);
  }
}
