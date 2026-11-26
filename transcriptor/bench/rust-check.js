'use strict';
// The Rust analysis (rust/pkg-node) against spectrum.ts on 60 s of a session: speed and the
// largest differences, for the short window (flux, acf) and the long one (peaks).
const path = require('node:path'), { pathToFileURL } = require('node:url');
const C = require('C:/Perso/IrishMusicExperiments/transcription-bench/lib/common');
const { sessionItems } = require('C:/Perso/IrishMusicExperiments/transcription-bench/lib/corpora');
const R = require(path.join(__dirname, '../rust/' + (process.env.PKG || 'pkg-node') + '/cadence_transcriptor.js'));
(async () => {
  const S = await import(pathToFileURL(path.join(__dirname, '../src/spectrum.ts')).href);
  const it = sessionItems()[Number(process.argv[2] || 0)];
  const pcm = C.decode(it.audio, { start: it.start, dur: 60, rate: 48000 });
  const rel = (a, b) => { let d = 0, m = 0; for (let i = 0; i < Math.min(a.length, b.length); i++) { d = Math.max(d, Math.abs(a[i] - b[i])); m = Math.max(m, Math.abs(a[i])); } return (d / (m || 1)).toExponential(1); };
  for (const [label, o] of [['short', { size: 2048, hop: 256, acf: true, peaks: false, fluxLag: 4 }], ['long', { size: 4096, hop: 512, hpssTime: 5, hpssFreq: 9, maxPeaks: 60 }]]) {
    let t0 = performance.now();
    const ts = S.analyse(pcm, 48000, o);
    const tTs = performance.now() - t0;
    t0 = performance.now();
    const rs = R.analyse(pcm, 48000, o.size, o.hop, 50, 60, 8000, o.hpssTime || 0, o.hpssFreq || 9, !!o.acf, 1, o.peaks !== false, o.fluxLag || 1, o.maxPeaks || 0);
    const out = { frames: rs.frames(), start: rs.start(), freq: rs.freq(), mag: rs.mag(), energy: rs.energy(), flux: rs.flux(), acf: rs.acf() };
    rs.free();
    const tRs = performance.now() - t0;
    console.log(`${label}: TS ${tTs.toFixed(0)} ms, Rust ${tRs.toFixed(0)} ms (x${(tTs / tRs).toFixed(1)}); frames ${ts.frames}/${out.frames}; peaks ${ts.freq.length}/${out.freq.length}; energy ${rel(ts.energy, out.energy)} flux ${rel(ts.flux, out.flux)}${o.acf ? ' acf ' + rel(ts.acf, out.acf) : ''}${o.peaks !== false ? ' freq ' + rel(ts.freq, out.freq) + ' mag ' + rel(ts.mag, out.mag) : ''}`);
  }
})();
