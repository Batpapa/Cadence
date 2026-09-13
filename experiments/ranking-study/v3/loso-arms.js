'use strict';
// Out-of-sample check of the ENGINE + post-processing choices (E5/E6 arms).
// Candidates = every (arm, configuration) evaluated in e5-{fixed,floors,temporal}-<arm>.json.
// Leave one session out: pick the candidate maximising found - lambda*fp on the six
// training sessions (ties averaged), score it on the held-out one. The honest estimate
// of "choose engine variant, gate, floor and absent ratio from the data".
// Production (ctl, identity, flat on, floor 0.20, no absent floor) needs no selection:
// its out-of-sample figure is its own per-session sum.
//   node experiments/ranking-study/v3/loso-arms.js [arm ...]
const fs = require('node:fs');
const path = require('node:path');
const V = __dirname;
const arms = process.argv.slice(2).length ? process.argv.slice(2)
  : ['ctl', 'ctlL20', 't180', 't180L20', 't200', 't200L20', 'rep4000', 'rep4000L20', 't180-rep4000', 't180-rep4000L20'];
const cands = [];
for (const arm of arms) {
  for (const tag of ['fixed', 'floors', 'temporal']) {
    const p = path.join(V, `e5-${tag}-${arm}.json`);
    if (!fs.existsSync(p)) continue;
    for (const r of JSON.parse(fs.readFileSync(p, 'utf-8'))) cands.push({ arm, label: r.label, per: r.per, found: r.found, fp: r.fp });
  }
}
// De-duplicate identical (arm, label) pairs coming from two config files.
const seen = new Set();
const C = cands.filter(c => { const k = `${c.arm}|${c.label}`; if (seen.has(k)) return false; seen.add(k); return true; });
const prod = C.find(c => c.arm === 'ctl' && c.label === 'production');
console.log(`${C.length} candidats (bras x configuration), ${arms.length} bras`);
console.log(`production (ctl, production) : ${prod.found}/${prod.fp}`);
for (const L of [0.5, 1, 2]) {
  let tf = 0, tp = 0;
  const picks = [];
  for (let k = 0; k < 7; k++) {
    let best = -Infinity, tied = [];
    for (const c of C) {
      const s = (c.found - c.per[k][0]) - L * (c.fp - c.per[k][2]);
      if (s > best + 1e-9) { best = s; tied = [c]; } else if (Math.abs(s - best) <= 1e-9) tied.push(c);
    }
    tf += tied.reduce((a, c) => a + c.per[k][0], 0) / tied.length;
    tp += tied.reduce((a, c) => a + c.per[k][2], 0) / tied.length;
    picks.push(tied.length === 1 ? `${tied[0].arm}:${tied[0].label}` : `${tied.length} ex-aequo (${[...new Set(tied.map(t => t.arm))].join(',')})`);
  }
  const gain = (tf - L * tp) - (prod.found - L * prod.fp);
  console.log(`\nlambda=${L} : hors echantillon ${tf.toFixed(1)}/${tp.toFixed(1)}  (production ${prod.found}/${prod.fp})  score - production = ${gain >= 0 ? '+' : ''}${gain.toFixed(1)}`);
  picks.forEach((p, k) => console.log(`   pli ${k} : ${p}`));
}
