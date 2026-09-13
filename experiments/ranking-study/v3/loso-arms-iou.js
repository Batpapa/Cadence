'use strict';
// Out-of-sample check of the engine + post-processing choices, INCLUDING temporal quality.
// Needs `perT` (per session [sum of IoU over found tunes, count]) in e5-*-<arm>.json.
//
// For each held-out session k, the candidate (arm, configuration) is chosen on the six
// other sessions by
//     found - lambda * fp + kappa * IoU_train_mean_in_points
// (ties averaged), then its found, fp and IoU are read on session k. Held-out IoU is
// pooled over the found tunes of all seven held-out sessions (sum of IoU / count), so a
// session with more tunes weighs more, exactly like the in-sample mean.
// Production (ctl, production) needs no selection.
//   node experiments/ranking-study/v3/loso-arms-iou.js [arm ...]
const fs = require('node:fs');
const path = require('node:path');
const V = __dirname;
const arms = process.argv.slice(2).length ? process.argv.slice(2)
  : ['ctl', 'ctlL20', 't180', 't180L20', 't200', 't200L20', 'rep4000', 'rep4000L20', 't180-rep4000', 't180-rep4000L20',
    't200-rep8000', 't200-rep8000L20', 't180-rep8000', 't180-rep8000L20'];
const C = [];
const seen = new Set();
let missingPerT = 0;
for (const arm of arms) {
  for (const tag of ['fixed', 'floors', 'temporal']) {
    const p = path.join(V, `e5-${tag}-${arm}.json`);
    if (!fs.existsSync(p)) continue;
    for (const r of JSON.parse(fs.readFileSync(p, 'utf-8'))) {
      const key = `${arm}|${r.label}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (!Array.isArray(r.perT)) { missingPerT++; continue; }
      C.push({ arm, label: r.label, per: r.per, perT: r.perT, found: r.found, fp: r.fp });
    }
  }
}
if (missingPerT) console.log(`(${missingPerT} candidats sans perT ignores — rejouer evalset)`);
const prod = C.find(c => c.arm === 'ctl' && c.label === 'production');
if (!prod) { console.log('production introuvable (ctl sans perT ?)'); process.exit(1); }
const sumT = (c, skip) => c.perT.reduce((a, t, i) => (i === skip ? a : [a[0] + t[0], a[1] + t[1]]), [0, 0]);
const prodT = sumT(prod, -1);
console.log(`${C.length} candidats, ${new Set(C.map(c => c.arm)).size} bras`);
console.log(`production : ${prod.found}/${prod.fp}, IoU ${(100 * prodT[0] / prodT[1]).toFixed(1)} %`);

for (const kappa of [0, 0.5, 1]) {
  for (const L of [0.5, 1, 2]) {
    let tf = 0, tp = 0, tIou = 0, tN = 0;
    const picks = [];
    for (let k = 0; k < 7; k++) {
      let best = -Infinity, tied = [];
      for (const c of C) {
        const tr = sumT(c, k);
        const iouTrain = tr[1] ? 100 * tr[0] / tr[1] : 0;
        const s = (c.found - c.per[k][0]) - L * (c.fp - c.per[k][2]) + kappa * iouTrain;
        if (s > best + 1e-9) { best = s; tied = [c]; } else if (Math.abs(s - best) <= 1e-9) tied.push(c);
      }
      const n = tied.length;
      tf += tied.reduce((a, c) => a + c.per[k][0], 0) / n;
      tp += tied.reduce((a, c) => a + c.per[k][2], 0) / n;
      tIou += tied.reduce((a, c) => a + c.perT[k][0], 0) / n;
      tN += tied.reduce((a, c) => a + c.perT[k][1], 0) / n;
      picks.push(n === 1 ? `${tied[0].arm}:${tied[0].label}` : `${n} ex-aequo`);
    }
    const iou = tN ? 100 * tIou / tN : 0;
    console.log(`kappa=${kappa} lambda=${L} : hors echantillon ${tf.toFixed(1)}/${tp.toFixed(1)}, IoU ${iou.toFixed(1)} %`
      + `  (production ${prod.found}/${prod.fp}, ${(100 * prodT[0] / prodT[1]).toFixed(1)} %)  | ${picks.join(' ; ')}`);
  }
}
