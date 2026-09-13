'use strict';
// Is the CHOICE of tempo causal for the ranking? A free natural experiment from E1:
// the same audio decoded twice, the only difference being the tempo search range.
// Windows whose best_bpm differs between the two arms had their contour built at a
// different tempo; if the annotated tune's rank moves there, tempo choice matters.
//   node experiments/ranking-study/v3/tempo-natural.js
const fs = require('node:fs');
const path = require('node:path');
const V = __dirname;
const CSV_DIR = path.resolve(V, '../../../test-fixtures/sessions');
const SESSIONS = ['1Hour_Trad_Irish_Music_Session_in_Korea', '20260523_1_matin_Anglade', '20260523_2_aprem_tabac', '20260523_5_auberge_fleurie', 'One_of_the_Best_Traditional_Irish_Music_Sessions_Longer_Video', '13th_Moon_Gravity_Well_-_Irish_Trad_Session_2024_01_24', '20240721_tocane_2_chapiteau'];
const idx = JSON.parse(fs.readFileSync(path.resolve(V, '../../noise-study/.cache/tune-index.json'), 'utf-8')).settings;
const dance = new Map();
for (const s of Object.values(idx)) if (!dance.has(String(s.tune_id))) dance.set(String(s.tune_id), s.dance);
const secs = v => v.trim().split(':').filter(Boolean).map(Number).reduce((a, n) => a * 60 + n, 0);
const load = (arm, id) => {
  const r = JSON.parse(fs.readFileSync(path.join(V, `fixtures-${arm}`, `${id}-windows.json`), 'utf-8'));
  return (Array.isArray(r) ? r : Object.values(r)).sort((a, b) => a.tWindowStart - b.tWindowStart);
};
const rankOf = (w, tid) => { const k = w.candidates.findIndex(c => c.tuneId === tid); return k < 0 ? 11 : k + 1; };

const agg = new Map();
const get = k => { if (!agg.has(k)) agg.set(k, { n: 0, same: 0, changed: 0, better: 0, worse: 0, r1gain: 0, r1loss: 0, toHigh: 0, toHighBetter: 0, toHighWorse: 0 }); return agg.get(k); };
for (const id of SESSIONS) {
  const A = load('ctl', id), B = load('t320', id);
  const rows = fs.readFileSync(path.join(CSV_DIR, `${id}-timings.csv`), 'utf-8').split('\n').map(l => l.trim()).filter(Boolean).slice(1);
  for (const l of rows) {
    const c = l.split(',');
    const tid = c[2].trim();
    if (!/^[1-9][0-9]*$/.test(tid)) continue;
    const st = secs(c[0]), en = secs(c[1]);
    const d = dance.get(tid) || '?';
    for (let i = 0; i < A.length; i++) {
      const x = (A[i].tWindowStart + A[i].tWindowEnd) / 2;
      if (x < st || x > en) continue;
      const ba = A[i].debug?.features?.best_bpm, bb = B[i].debug?.features?.best_bpm;
      if (ba === undefined || bb === undefined) continue;
      for (const key of [d, 'TOUS']) {
        const e = get(key);
        e.n++;
        if (ba === bb) { e.same++; continue; }
        e.changed++;
        const ra = rankOf(A[i], tid), rb = rankOf(B[i], tid);
        if (rb < ra) e.better++; else if (rb > ra) e.worse++;
        if (ra !== 1 && rb === 1) e.r1gain++;
        if (ra === 1 && rb !== 1) e.r1loss++;
        if (bb >= 240) { e.toHigh++; if (rb < ra) e.toHighBetter++; else if (rb > ra) e.toHighWorse++; }
      }
    }
  }
}
console.log('type       | fenetres | tempo change | rang meilleur / pire | rang1 gagne / perdu | dont vers >=240 : meilleur / pire');
for (const [k, e] of [...agg.entries()].sort((a, b) => b[1].n - a[1].n)) {
  if (e.n < 30) continue;
  console.log(`${k.padEnd(10)} | ${String(e.n).padStart(8)} | ${String(e.changed).padStart(5)} (${(100 * e.changed / e.n).toFixed(0).padStart(2)}%) | ${String(e.better).padStart(5)} / ${String(e.worse).padEnd(5)} | ${String(e.r1gain).padStart(4)} / ${String(e.r1loss).padEnd(4)} | ${e.toHigh} : ${e.toHighBetter} / ${e.toHighWorse}`);
}
