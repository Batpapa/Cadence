'use strict';
// The Rust analysis (rust/pkg-node*) as a drop-in for spectrum.ts's analyse, for the benches:
// fed 10 s at a time, as Cadence's transcriptorInit.ts does.
const path = require('node:path');
function nativeAnalyse(pkg = 'pkg-node-simd') {
  const R = require(path.join(__dirname, '../rust', pkg, 'cadence_transcriptor.js'));
  return (pcm, rate, o = {}) => {
    const a = new R.Analyzer(rate, o.size ?? 2048, o.hop ?? 256, o.floorDb ?? 50, o.fmin ?? 60, o.fmax ?? 8000,
      o.hpssTime ?? 0, o.hpssFreq ?? 9, !!o.acf, o.acfEvery ?? 1, o.peaks ?? true, o.fluxLag ?? 1, o.maxPeaks ?? 0);
    const chunk = Math.round(10 * rate);
    for (let i = 0; i < pcm.length; i += chunk) { a.push(pcm.subarray(i, i + chunk)); o.progress?.(Math.min(1, (i + chunk) / pcm.length)); }
    const s = a.finish();
    const p = { rate, hop: o.hop ?? 256, frames: s.frames(), start: s.start(), freq: s.freq(), mag: s.mag(), energy: s.energy(), flux: s.flux() };
    if (o.acf) Object.assign(p, { acf: s.acf(), acfLow: 40, acfNotes: 61 });
    s.free();
    return p;
  };
}
module.exports = { nativeAnalyse };
