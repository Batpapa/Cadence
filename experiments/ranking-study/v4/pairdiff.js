// node v4/pairdiff.js pair-out.json — paired comparison of two configurations (A = first
// row, B = second): tunes gained / lost (exact sign test), false-positive ids gained /
// lost, and IoU on tunes both find (sign test on the per-tune differences).
const fs = require('fs');
const [A, B] = JSON.parse(fs.readFileSync(process.argv[2], 'utf-8'));
const binom = (k, n) => { // two-sided exact sign test, p = 0.5
  if (n === 0) return 1;
  const lo = Math.min(k, n - k);
  let p = 0;
  for (let i = 0; i <= lo; i++) { let c = 1; for (let j = 0; j < i; j++) c = c * (n - j) / (j + 1); p += c; }
  return Math.min(1, 2 * p / Math.pow(2, n));
};
let gained = 0, lost = 0, fpGained = 0, fpLost = 0, better = 0, worse = 0, same = 0, dSum = 0, nBoth = 0;
const lines = [];
A.detail.forEach((da, s) => {
  const db = B.detail[s];
  const ka = new Set(Object.keys(da.hits)), kb = new Set(Object.keys(db.hits));
  const g = [...kb].filter(i => !ka.has(i)), l = [...ka].filter(i => !kb.has(i));
  gained += g.length; lost += l.length;
  const fa = new Set(da.fpIds), fb = new Set(db.fpIds);
  const fg = [...fb].filter(i => !fa.has(i)), fl = [...fa].filter(i => !fb.has(i));
  fpGained += fg.length; fpLost += fl.length;
  let sb = 0, sw = 0;
  for (const i of [...ka].filter(i => kb.has(i))) {
    const d = db.hits[i] - da.hits[i];
    nBoth++; dSum += d;
    if (d > 1e-6) { better++; sb++; } else if (d < -1e-6) { worse++; sw++; } else same++;
  }
  lines.push(`${da.session.slice(0, 28).padEnd(28)} morceaux +${g.length} -${l.length} [${g.join(',')}|${l.join(',')}]  fp +${fg.length} -${fl.length} [${fg.join(',')}|${fl.join(',')}]  IoU mieux ${sb} pire ${sw}`);
});
console.log(`A = ${A.label} ${A.found}/${A.fp}+${A.noise} IoU ${(A.iouMean * 100).toFixed(1)} ; B = ${B.label} ${B.found}/${B.fp}+${B.noise} IoU ${(B.iouMean * 100).toFixed(1)}`);
console.log(lines.join('\n'));
console.log(`\nmorceaux : B gagne ${gained}, perd ${lost} -> test du signe p = ${binom(gained, gained + lost).toPrecision(3)}`);
console.log(`faux positifs (ids) : B en ajoute ${fpGained}, en retire ${fpLost} -> p = ${binom(fpGained, fpGained + fpLost).toPrecision(3)}`);
console.log(`IoU sur les ${nBoth} morceaux communs : B mieux ${better}, pire ${worse}, egal ${same} -> p = ${binom(better, better + worse).toPrecision(3)} ; ecart moyen ${(100 * dSum / nBoth).toFixed(2)} point`);
