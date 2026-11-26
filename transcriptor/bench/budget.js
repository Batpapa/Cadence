'use strict';
const { REPO, WS } = require('./paths');
// The error budget (transcription-bench/diag-errors.js's categories) of our decoder's notes
// on tuneset, by note length.   node bench/budget.js '{decoder options}'
const fs = require('node:fs'), v8 = require('node:v8'), path = require('node:path');
const { pathToFileURL } = require('node:url');
const { tunesetItems } = require(`${WS}/transcription-bench/lib/corpora`);
(async () => {
  const D = await import(pathToFileURL(path.join(__dirname, '../src/decoder.ts')).href);
  const o = JSON.parse(process.argv[2] || '{}');
  const items = tunesetItems();
  const count = {}, byLen = {}; let truthN = 0, heardN = 0, extra = 0;
  items.forEach((item, i) => {
    const a = v8.deserialize(fs.readFileSync(path.join(__dirname, '../out', `ana-tuneset-${i}.v8`)));
    const heard = D.decode(a, o).map(n => ({ cls: n.cls, on: n.onset, off: n.offset }));
    heardN += heard.length;
    const used = new Set();
    item.truth.forEach((t, k) => {
      truthN++;
      const cls = t.pitch % 12, d = t.offset - t.onset;
      const lb = d < 0.08 ? '<80' : d < 0.11 ? '80-110' : d < 0.2 ? '110-200' : '>200';
      const near = (lo, hi) => heard.findIndex((h, j) => !used.has(j) && h.cls === cls && Math.abs(h.on - t.onset) >= lo && Math.abs(h.on - t.onset) < hi);
      let kind, j = near(0, 0.05);
      if (j >= 0) { used.add(j); kind = 'found'; }
      else if ((j = near(0.05, 0.15)) >= 0) { used.add(j); kind = 'late/early'; }
      else {
        const prev = item.truth[k - 1];
        const s = heard.find(h => h.on <= t.onset + 0.03 && h.off > t.onset + 0.03);
        if (prev && prev.pitch % 12 === cls && s && s.cls === cls) kind = 'repeat merged';
        else if (s && prev && s.cls === prev.pitch % 12) kind = 'previous note held on';
        else if (s) { const nx = item.truth[k + 1]; const iv = ((s.cls - cls) % 12 + 12) % 12; kind = nx && s.cls === nx.pitch % 12 ? 'other class: the next note' : 'other class: interval ' + iv; }
        else kind = 'absent';
      }
      count[kind] = (count[kind] || 0) + 1; byLen[lb] ??= {}; byLen[lb][kind] = (byLen[lb][kind] || 0) + 1;
    });
    extra += heard.filter((_, j) => !used.has(j)).length;
  });
  for (const [k, n] of Object.entries(count).sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(24)} ${(100 * n / truthN).toFixed(1)} %`);
  console.log(`  extra (match nothing)    ${(100 * extra / heardN).toFixed(1)} % of ${heardN} heard (truth ${truthN})`);
  for (const [lb, m] of Object.entries(byLen)) { const tot = Object.values(m).reduce((a, b) => a + b, 0); console.log(`  ${lb.padEnd(8)}: ${Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, n]) => `${k} ${(100 * n / tot).toFixed(0)}%`).join(', ')}`); }
})();
