// Turns a "relevé" from the annotating group (session_id,start,end,thesession_id,tune,set,notes)
// into a fixture's ground truth: `Début,Fin,TheSession ID,Commentaires`, the tune's name and the
// annotator's notes kept as the comment.
//
//   node import-releve.cjs <releve.csv> <out-timings.csv> [--force]
const fs = require('fs');

const [src, out, force] = process.argv.slice(2);
if (!src || !out) { console.error('usage: node import-releve.cjs <releve.csv> <out-timings.csv> [--force]'); process.exit(1); }
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

const lines = fs.readFileSync(src, 'utf-8').replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim());
const head = split(lines[0]);
const col = (name) => { const i = head.indexOf(name); if (i < 0) throw new Error(`no "${name}" column`); return i; };
const [iStart, iEnd, iId, iTune, iNotes] = ['start', 'end', 'thesession_id', 'tune', 'notes'].map(col);

const rows = ['Début,Fin,TheSession ID,Commentaires'];
for (const line of lines.slice(1)) {
  const f = split(line);
  const id = f[iId].trim();
  if (!/^(-1|0|[1-9]\d*)$/.test(id)) { console.warn(`id not understood, skipped: ${line}`); continue; }
  const comment = [f[iTune], f[iNotes]].map((s) => (s ?? '').trim()).filter(Boolean).join(' - ');
  rows.push([f[iStart].trim(), f[iEnd].trim(), id, quote(comment)].join(','));
}
fs.writeFileSync(out, rows.join('\n') + '\n', 'utf-8');
console.log(`${rows.length - 1} rows written to ${out}`);
