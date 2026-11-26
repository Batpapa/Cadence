'use strict';
// Two builds of the Rust analysis (PKG_A, PKG_B under rust/) heard on session excerpts: notes
// exactly the same (class, onset, offset), largest relative gap of the grid onset function,
// and the time each takes. For changes meant to keep the results (speed).
const path = require('node:path'), { pathToFileURL } = require('node:url');
const C = require('C:/Perso/IrishMusicExperiments/transcription-bench/lib/common');
const { sessionItems } = require('C:/Perso/IrishMusicExperiments/transcription-bench/lib/corpora');
const { nativeAnalyse } = require('./native');
(async () => {
  const D = await import(pathToFileURL(path.join(__dirname, '../src/decoder.ts')).href);
  const A = nativeAnalyse(process.env.PKG_A || 'pkg-node-simd-old'), B = nativeAnalyse(process.env.PKG_B || 'pkg-node-simd');
  const items = sessionItems();
  const step = +(process.env.STEP || 5);
  let same = 0, total = 0, tA = 0, tB = 0, gap = 0, n = 0;
  for (let i = 0; i < items.length; i += step) {
    const it = items[i], pcm = C.decode(it.audio, { start: it.start, dur: 30, rate: 48000 });
    D.useAnalysis(A); let t0 = performance.now(); const a = D.hear(pcm, 48000); tA += performance.now() - t0;
    D.useAnalysis(B); t0 = performance.now(); const b = D.hear(pcm, 48000); tB += performance.now() - t0;
    total += Math.max(a.notes.length, b.notes.length);
    for (const x of a.notes) if (b.notes.some(y => y.cls === x.cls && y.onset === x.onset && y.offset === x.offset)) same++;
    let mo = 0; for (const v of a.onsets) mo = Math.max(mo, v);
    for (let t = 0; t < a.onsets.length; t++) gap = Math.max(gap, Math.abs(a.onsets[t] - b.onsets[t]) / (mo || 1));
    n++;
  }
  console.log(`${n} excerpts of 30 s: same notes ${same}/${total} (${(100 * same / total).toFixed(2)} %), grid onsets max gap ${gap.toExponential(2)} of the max; hear: A ${tA.toFixed(0)} ms, B ${tB.toFixed(0)} ms`);
})();
