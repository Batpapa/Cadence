'use strict';
// Compare evalset outputs across arms: recall, false positives AND coverage,
// per configuration (matched by label), with deltas against the first arm.
//   node experiments/ranking-study/v3/arms-compare.js ref.json armB.json [armC.json ...]
// Coverage is the mean fraction of each found tune's annotated span covered by
// its detection — the user's second goal, reported next to recall and fp.
const fs = require('node:fs');
const path = require('node:path');
const SESS = ['Korea', 'Anglade', 'tabac', 'auberge', 'OneBest', '13thMoon', 'AudioF'];
const files = process.argv.slice(2);
if (files.length < 2) { console.error('usage: arms-compare.js ref.json armB.json [...]'); process.exit(1); }
const arms = files.map(f => ({ name: path.basename(f, '.json'), rows: JSON.parse(fs.readFileSync(f, 'utf-8')) }));
const labels = [...new Set(arms.flatMap(a => a.rows.map(r => r.label)))];
const sign = v => (v > 0 ? `+${v}` : `${v}`);
const pct = v => `${(100 * v).toFixed(1)}%`;
for (const label of labels) {
  const ref = arms[0].rows.find(r => r.label === label);
  console.log(`\n==== ${label} ====`);
  console.log('  bras'.padEnd(26) + 'rappel'.padStart(8) + 'fp'.padStart(6) + 'bruit'.padStart(7) + 'couv'.padStart(8) + '  delta ref (rappel/fp/couv)'.padStart(30) + '   par session trouves/fp');
  for (const a of arms) {
    const r = a.rows.find(x => x.label === label);
    if (!r) { console.log('  ' + a.name.padEnd(24) + '   (absent)'); continue; }
    const d = ref ? `${sign(r.found - ref.found)} / ${sign(r.fp - ref.fp)} / ${sign(+(100 * (r.coverage - ref.coverage)).toFixed(1))}pt` : '-';
    console.log('  ' + a.name.padEnd(24) + String(r.found).padStart(8) + String(r.fp).padStart(6) + String(r.noise).padStart(7) + pct(r.coverage).padStart(8)
      + d.padStart(30) + '   ' + r.per.map((p, i) => `${SESS[i]} ${p[0]}/${p[2]}`).join(' '));
    if (r.temporal) {
      const t = r.temporal;
      const dIou = ref?.temporal ? ` (${sign(+(100 * (t.iouMean - ref.temporal.iouMean)).toFixed(1))}pt)` : '';
      console.log('  ' + ''.padEnd(24) + `   IoU moyenne ${(100 * t.iouMean).toFixed(1)}%${dIou} | erreur debut p50/p90 ${t.startErrP50.toFixed(0)}/${t.startErrP90.toFixed(0)} s | erreur fin p50/p90 ${t.endErrP50.toFixed(0)}/${t.endErrP90.toFixed(0)} s`);
    }
  }
}
