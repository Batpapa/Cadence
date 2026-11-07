// Turns an analysis exported from Cadence (Share → CSV, checked and corrected by ear in the bound
// editor) into a fixture's ground truth: `Début,Fin,TheSession ID,Commentaires`.
//
//   node from-cadence-export.cjs <export.csv> <out-timings.csv> [--force]
//
// The export only holds tunes, so songs (-1) and tunes nobody could name (0) have to be added to the
// result by hand afterwards. It refuses to overwrite an existing file without --force.
const fs = require('fs');

const [src, out, force] = process.argv.slice(2);
if (!src || !out) { console.error('usage: node from-cadence-export.cjs <export.csv> <out-timings.csv> [--force]'); process.exit(1); }
if (fs.existsSync(out) && force !== '--force') { console.error(`${out} exists; pass --force to replace it`); process.exit(1); }

function split(line) {
  const o = []; let c = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) { if (ch !== '"') c += ch; else if (line[i + 1] === '"') { c += '"'; i++; } else q = false; }
    else if (ch === '"') q = true;
    else if (ch === ',') { o.push(c); c = ''; }
    else c += ch;
  }
  o.push(c);
  return o;
}
const quote = (s) => (/[",]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

const lines = fs.readFileSync(src, 'utf-8').replace(/^﻿/, '').split(/\r?\n/);
const head = split(lines[0]);
const col = (name) => { const i = head.indexOf(name); if (i < 0) throw new Error(`no "${name}" column: export from a Cadence that has it`); return i; };
const [iStart, iEnd, iTune, iLink] = ['Start', 'End', 'Tune', 'TheSession'].map(col);

const rows = ['Début,Fin,TheSession ID,Commentaires'];
for (const line of lines.slice(1)) {
  if (!line.trim()) continue; // the blank line between sets
  const f = split(line);
  const id = /tunes\/(\d+)/.exec(f[iLink] ?? '')?.[1];
  if (!id) { console.warn(`no tune id, skipped: ${line}`); continue; }
  rows.push([f[iStart], f[iEnd], id, quote(f[iTune])].join(','));
}
fs.writeFileSync(out, rows.join('\n') + '\n', 'utf-8');
console.log(`${rows.length - 1} tunes written to ${out}`);
