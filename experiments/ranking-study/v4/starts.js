// node v4/starts.js out.json — seeds for the refinement (B2): production, the
// configurations the held-out selection actually picked, the best in-sample
// dominators, and each transform's best at the product's exchange rate.
const fs = require('fs');
const path = require('path');
const OUT = path.join(__dirname, '..', '.out');
let rows = [];
for (const f of fs.readdirSync(OUT).filter(f => /^v4-seed21-anneal\d+\.json$/.test(f))) rows.push(...JSON.parse(fs.readFileSync(path.join(OUT, f), 'utf-8')));
const PROD = JSON.parse(fs.readFileSync(path.join(OUT, 'v4-check.json'), 'utf-8')).find(r => r.label === 'production');
const TOTAL = PROD.total;
const P = r => r.fp + r.noise;
const key = r => JSON.stringify([r.transform, r.floorQ, r.minSeg, r.confirm, r.weights, r.absent, r.rapid, r.mergeGap, r.flat, r.tempoSpread, r.minCand]);
const picked = new Map();
const add = (r, why) => { const k = key(r); if (!picked.has(k)) picked.set(k, { ...r, label: why }); else picked.get(k).label += ` + ${why}`; };

// held-out picks
for (const [l, k] of [[0.5, 0.5], [0.25, 0.5], [0.5, 1], [1, 0.5], [2, 0.5]]) {
  const cnt = new Map();
  for (let s = 0; s < 7; s++) {
    let best = -Infinity, tied = [];
    for (const r of rows) {
      const p = r.per[s];
      const sc = (r.found - p[0]) - l * (r.fp - p[2] + r.noise) + k * 100 * (r.sumIoU - p[4]) / (TOTAL - p[1]);
      if (sc > best + 1e-9) { best = sc; tied = [r]; } else if (Math.abs(sc - best) <= 1e-9) tied.push(r);
    }
    for (const r of tied) { const kk = key(r); cnt.set(kk, (cnt.get(kk) || 0) + 1 / tied.length); if (!cnt.has('r' + kk)) cnt.set('r' + kk, r); }
  }
  const top = [...cnt.entries()].filter(([kk]) => !kk.startsWith('r')).sort((a, b) => b[1] - a[1]).slice(0, 2);
  for (const [kk, c] of top) add(cnt.get('r' + kk), `loso L${l}K${k} (${c.toFixed(1)} plis)`);
}
// in-sample best dominators and per-transform bests at L=0.5 K=0.5
const sc = r => r.found - 0.5 * P(r) + 0.5 * r.iouPts;
const dom = rows.filter(r => r.found >= PROD.found && P(r) <= P(PROD) && r.iouPts >= PROD.iouPts).sort((a, b) => sc(b) - sc(a));
for (const t of [...new Set(dom.map(r => r.transform))]) add(dom.find(r => r.transform === t), `meilleur dominant ${t}`);
for (const t of ['identity', 'nullRatio5', 'nullRatioTailMean', 'share', 'shareXMargin']) {
  add([...rows.filter(r => r.transform === t)].sort((a, b) => sc(b) - sc(a))[0], `meilleur ${t} L0.5K0.5`);
}
const list = [{ ...PROD, label: 'production' }, ...picked.values()];
for (const r of list) console.log(`${r.label}\n   ${r.transform} ${r.found}/${r.fp}+${r.noise} IoU ${(r.iouMean * 100).toFixed(1)} a=${r.absent} stay=${r.weights.unknownStay} in=${r.weights.unknownToTune} ts=${r.tempoSpread} flat=${r.flat} mS=${r.minSeg} gap=${r.mergeGap}`);
fs.writeFileSync(process.argv[2], JSON.stringify(list));
console.log(`${list.length} departs -> ${process.argv[2]}`);
