// node v4/replay-sample.js make N out.json  -> picks N campaign rows (spread over shards) + production
// node v4/replay-sample.js cmp in.json results.json -> field-by-field comparison
const fs = require('fs');
const path = require('path');
const OUT = path.join(__dirname, '..', '.out');
const [, , cmd, a, b] = process.argv;
if (cmd === 'make') {
  const n = Number(a);
  let rows = [];
  for (const f of fs.readdirSync(OUT).filter(f => /^v4-seed21-anneal\d+\.json$/.test(f))) rows.push(...JSON.parse(fs.readFileSync(path.join(OUT, f), 'utf-8')));
  const pick = [];
  for (let i = 0; i < n; i++) pick.push({ label: `row${i}`, ...rows[Math.floor((i + 0.5) * rows.length / n)] });
  const prod = JSON.parse(fs.readFileSync(path.join(OUT, 'v4-check.json'), 'utf-8')).find(r => r.label === 'production');
  pick.push({ ...prod, label: 'production' });
  fs.writeFileSync(b, JSON.stringify(pick));
  console.log(`${pick.length} lignes -> ${b}`);
} else if (cmd === 'cmp') {
  const inp = JSON.parse(fs.readFileSync(a, 'utf-8'));
  const res = JSON.parse(fs.readFileSync(b, 'utf-8'));
  let diff = 0;
  inp.forEach((r, i) => {
    const o = res[i];
    const keys = ['found', 'fp', 'noise', 'misplaced', 'sumIoU'];
    const bad = keys.filter(k => Math.abs(r[k] - o[k]) > 1e-3);
    if (JSON.stringify(r.per.map(p => p.slice(0, 4))) !== JSON.stringify(o.per.map(p => p.slice(0, 4)))) bad.push('per');
    if (bad.length) { diff++; console.log(`${r.label} DIFF ${bad.join(',')} : ${r.found}/${r.fp}+${r.noise} ${r.sumIoU} -> ${o.found}/${o.fp}+${o.noise} ${o.sumIoU} (floor ${r.floor} -> ${o.floor})`); }
  });
  console.log(`${inp.length} lignes, ${diff} differentes`);
}
