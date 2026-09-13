// Characterise the difference between two window fixture files: contour, score
// deltas, rank swaps among near-ties, and genuinely different candidate sets.
//   node experiments/ranking-study/v3/diff-detail.js a.json b.json
const fs = require("fs");
const load = f => { const r = JSON.parse(fs.readFileSync(f, "utf-8")); return (Array.isArray(r) ? r : Object.values(r)).sort((x, y) => x.tWindowStart - y.tWindowStart); };
const [fa, fb] = process.argv.slice(2);
const a = load(fa), b = load(fb);
let contourDiff = 0, sameSetDiffOrder = 0, setDiff = 0, top1Diff = 0, maxDelta = 0, fullSetDiff = 0;
const deltas = [];
let examples = 0;
for (let i = 0; i < Math.min(a.length, b.length); i++) {
  const x = a[i], y = b[i];
  if ((x.debug && x.debug.contour) !== (y.debug && y.debug.contour)) contourDiff++;
  const ca = x.candidates, cb = y.candidates;
  const ja = JSON.stringify(ca.map(c => [c.tuneId, c.score])), jb = JSON.stringify(cb.map(c => [c.tuneId, c.score]));
  if (ja === jb) continue;
  const sa = new Map(ca.map(c => [c.tuneId, c.score])), sb = new Map(cb.map(c => [c.tuneId, c.score]));
  for (const [k, v] of sa) if (sb.has(k)) { const d = Math.abs(v - sb.get(k)); deltas.push(d); if (d > maxDelta) maxDelta = d; }
  const same = ca.length === cb.length && ca.every(c => sb.has(c.tuneId));
  if (same) sameSetDiffOrder++; else setDiff++;
  if ((ca[0] && ca[0].tuneId) !== (cb[0] && cb[0].tuneId)) top1Diff++;
  const fa2 = new Set((x.debug && x.debug.fullCandidates || []).map(c => c.tuneId)), fb2 = new Set((y.debug && y.debug.fullCandidates || []).map(c => c.tuneId));
  if (fa2.size !== fb2.size || [...fa2].some(k => !fb2.has(k))) fullSetDiff++;
  if (examples++ < 3) {
    console.log("window " + i + " @" + x.tWindowStart + "s octave " + (x.debug && x.debug.octaveShiftApplied) + "/" + (y.debug && y.debug.octaveShiftApplied));
    console.log("  A: " + ca.slice(0, 6).map(c => c.tuneId + ":" + c.score.toFixed(6)).join(" "));
    console.log("  B: " + cb.slice(0, 6).map(c => c.tuneId + ":" + c.score.toFixed(6)).join(" "));
    console.log("  full lists: A " + fa2.size + " B " + fb2.size);
  }
}
deltas.sort((p, q) => p - q);
const nz = deltas.filter(d => d > 0);
console.log("contours differents : " + contourDiff);
console.log("fenetres differentes : meme ensemble top10 ordre/score different " + sameSetDiffOrder + " ; ensemble top10 different " + setDiff + " ; top1 different " + top1Diff + " ; liste complete differente " + fullSetDiff);
console.log("ecarts de score sur ids communs : n=" + deltas.length + " non nuls=" + nz.length + " mediane non nulle=" + (nz.length ? nz[Math.floor(nz.length / 2)].toExponential(2) : "-") + " max=" + maxDelta.toExponential(2));
