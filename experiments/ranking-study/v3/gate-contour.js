'use strict';
// Experiment E4 — contour-length gate, applied offline to existing fixtures.
// A window whose contour (debug.contour, the one actually queried, after the
// octave fallback) is shorter than L symbols is emptied: no candidates, as if
// FolkFriend had heard no music. Everything else is copied untouched, CSVs too.
//
//   node experiments/ranking-study/v3/gate-contour.js <srcDir> <outDir> <L>
//
// Engine-side equivalent: refuse to query a contour shorter than L. Exact for
// window-level screening and for the Viterbi chain alike, since a gated window
// is exactly what the engine's own "too few notes" error already produces.
const fs = require('node:fs');
const path = require('node:path');
const [src, out, Ls] = process.argv.slice(2);
const L = Number(Ls);
if (!src || !out || !Number.isFinite(L)) { console.error('usage: gate-contour.js <srcDir> <outDir> <L>'); process.exit(1); }
if (path.resolve(out).endsWith(path.join('test-fixtures', 'sessions'))) throw new Error('refusing to write into the committed fixtures');
fs.mkdirSync(out, { recursive: true });
let total = 0, gated = 0, gatedNoise = 0, totalNoise = 0;
for (const f of fs.readdirSync(src)) {
  const p = path.join(src, f);
  if (f.endsWith('-timings.csv')) { fs.copyFileSync(p, path.join(out, f)); continue; }
  if (!f.endsWith('-windows.json')) continue;
  const raw = JSON.parse(fs.readFileSync(p, 'utf-8'));
  const arr = Array.isArray(raw) ? raw : Object.values(raw);
  const isNoise = f.startsWith('732984_11910076-lq');
  for (const w of arr) {
    total++; if (isNoise) totalNoise++;
    const c = w.debug?.contour;
    if (typeof c === 'string' && c.length < L && w.candidates.length) {
      w.candidates = [];
      w.empty = true;
      gated++; if (isNoise) gatedNoise++;
    }
  }
  fs.writeFileSync(path.join(out, f), JSON.stringify(arr));
}
console.log(`L=${L} : ${gated}/${total} fenetres videes (${(100 * gated / total).toFixed(1)}%), dont bruit ${gatedNoise}/${totalNoise}`);
