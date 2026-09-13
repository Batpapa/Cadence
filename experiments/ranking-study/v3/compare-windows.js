'use strict';
// Bit-level comparison of two window fixture files (experiment E1 control).
//   node experiments/ranking-study/v3/compare-windows.js <a-windows.json> <b-windows.json>
// Compares geometry, emptiness, the top-10 candidates (id and score, exactly),
// best_bpm and the octave shift. Prints the first differences and a summary.

const fs = require('node:fs');
const [fa, fb] = process.argv.slice(2);
const load = f => {
  const raw = JSON.parse(fs.readFileSync(f, 'utf-8'));
  return (Array.isArray(raw) ? raw : Object.values(raw)).sort((x, y) => x.tWindowStart - y.tWindowStart);
};
const a = load(fa), b = load(fb);
console.log(`windows: ${a.length} vs ${b.length}`);
let diffs = 0, candDiffs = 0, bpmDiffs = 0, shown = 0;
const n = Math.min(a.length, b.length);
for (let i = 0; i < n; i++) {
  const x = a[i], y = b[i];
  const problems = [];
  if (x.tWindowStart !== y.tWindowStart || x.tWindowEnd !== y.tWindowEnd) problems.push('geometry');
  if (x.empty !== y.empty) problems.push('empty');
  const cx = JSON.stringify(x.candidates.map(c => [c.tuneId, c.score]));
  const cy = JSON.stringify(y.candidates.map(c => [c.tuneId, c.score]));
  if (cx !== cy) { problems.push('candidates'); candDiffs++; }
  const bx = x.debug?.features?.best_bpm, by = y.debug?.features?.best_bpm;
  if (bx !== by) { problems.push(`best_bpm ${bx}->${by}`); bpmDiffs++; }
  if ((x.debug?.octaveShiftApplied ?? 0) !== (y.debug?.octaveShiftApplied ?? 0)) problems.push('octave');
  if (problems.length) {
    diffs++;
    if (shown++ < 8) console.log(`  window ${i} @${x.tWindowStart}s: ${problems.join(', ')}`);
  }
}
console.log(`windows differing: ${diffs} / ${n} (candidates ${candDiffs}, best_bpm ${bpmDiffs})`);
console.log(diffs === 0 && a.length === b.length ? 'IDENTICAL' : 'DIFFERENT');
