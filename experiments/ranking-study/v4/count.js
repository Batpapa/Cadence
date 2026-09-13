// node v4/count.js — evaluations written per shard of campaign v4, and throughput.
const fs = require('fs');
const path = require('path');
const dir = path.join(__dirname, '..', '.out');
let total = 0;
const lines = [];
for (const f of fs.readdirSync(dir).filter(f => /^v4-seed\d+-anneal\d+\.json$/.test(f)).sort()) {
  let n = 0;
  try { n = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8')).length; } catch { n = -1; }
  const m = fs.statSync(path.join(dir, f)).mtime;
  lines.push(`${f} ${n} ${m.toISOString()}`);
  if (n > 0) total += n;
}
console.log(lines.join('\n'));
console.log(`total ${total} @ ${new Date().toISOString()}`);
