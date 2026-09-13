'use strict';
// Experiment E1 — three-arm comparison at FIXED configurations.
//   node experiments/ranking-study/v3/e1-compare.js
// Reads v3/e1-committed.json, v3/e1-ctl.json, v3/e1-t320.json (evalset outputs,
// same config order). The engine-noise floor is ctl - committed: the same
// configurations, same tempo range, only the query build differs (tie order,
// candidate preselection). A tempo effect counts only if t320 - ctl clearly
// exceeds it, and in the same direction across sessions.

const fs = require('node:fs');
const path = require('node:path');
const SESS = ['Korea', 'Anglade', 'tabac', 'auberge', 'OneBest', '13thMoon', 'AudioF'];
const load = arm => {
  const p = path.join(__dirname, `e1-${arm}.json`);
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf-8')) : null;
};
const committed = load('committed'), ctl = load('ctl'), t320 = load('t320');
if (!committed || !ctl || !t320) {
  console.log(`bras manquants : ${[['committed', committed], ['ctl', ctl], ['t320', t320]].filter(([, v]) => !v).map(([k]) => k).join(', ')}`);
  process.exit(0);
}
const sign = v => (v > 0 ? `+${v}` : `${v}`);
let noiseAbsF = 0, noiseAbsP = 0, effF = 0, effP = 0;
for (let i = 0; i < committed.length; i++) {
  const c = committed[i], k = ctl[i], t = t320[i];
  console.log(`\n==== ${c.label} ====`);
  console.log(`  committed ${c.found}/${c.fp}  ctl ${k.found}/${k.fp}  t320 ${t.found}/${t.fp}   bruit moteur (ctl-committed) ${sign(k.found - c.found)}/${sign(k.fp - c.fp)}   effet tempo (t320-ctl) ${sign(t.found - k.found)}/${sign(t.fp - k.fp)}   bruit ${c.noise}/${k.noise}/${t.noise}`);
  console.log('  session   | committed | ctl     | t320    | t320-ctl');
  for (let s = 0; s < SESS.length; s++) {
    const a = c.per[s], b = k.per[s], d = t.per[s];
    console.log(`  ${SESS[s].padEnd(9)} | ${String(a[0]).padStart(3)}/${String(a[2]).padEnd(4)} | ${String(b[0]).padStart(3)}/${String(b[2]).padEnd(3)} | ${String(d[0]).padStart(3)}/${String(d[2]).padEnd(3)} | ${sign(d[0] - b[0])}/${sign(d[2] - b[2])}`);
  }
  noiseAbsF += Math.abs(k.found - c.found); noiseAbsP += Math.abs(k.fp - c.fp);
  effF += t.found - k.found; effP += t.fp - k.fp;
}
const n = committed.length;
console.log(`\nbruit moteur moyen |ctl-committed| : rappel ${(noiseAbsF / n).toFixed(1)}, fp ${(noiseAbsP / n).toFixed(1)}`);
console.log(`effet tempo moyen (t320-ctl)      : rappel ${(effF / n).toFixed(1)}, fp ${(effP / n).toFixed(1)}`);
