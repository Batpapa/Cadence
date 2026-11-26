'use strict';
// Notes decoded from the TypeScript analysis and from the Rust one, on session excerpts:
// how many are the same (class, onset within 10 ms), and the time each takes.
const path = require('node:path'), { pathToFileURL } = require('node:url');
const C = require('C:/Perso/IrishMusicExperiments/transcription-bench/lib/common');
const { sessionItems } = require('C:/Perso/IrishMusicExperiments/transcription-bench/lib/corpora');
const { nativeAnalyse } = require('./native');
(async () => {
  const D = await import(pathToFileURL(path.join(__dirname, '../src/decoder.ts')).href);
  const { analyse } = await import(pathToFileURL(path.join(__dirname, '../src/spectrum.ts')).href);
  const items = sessionItems();
  let same = 0, total = 0, tTs = 0, tRs = 0;
  for (const i of [0, 20, 40, 60, 80, 100, 120, 140]) {
    const it = items[i], pcm = C.decode(it.audio, { start: it.start, dur: 30, rate: 48000 });
    D.useAnalysis(analyse); let t0 = performance.now(); const a = D.transcribeNotes(pcm, 48000); tTs += performance.now() - t0;
    D.useAnalysis(nativeAnalyse()); t0 = performance.now(); const b = D.transcribeNotes(pcm, 48000); tRs += performance.now() - t0;
    total += Math.max(a.length, b.length);
    for (const x of a) if (b.some(y => y.cls === x.cls && Math.abs(y.onset - x.onset) < 0.01)) same++;
  }
  console.log(`same notes ${same}/${total} (${(100 * same / total).toFixed(1)} %); transcribeNotes: TS ${tTs.toFixed(0)} ms, Rust analysis ${tRs.toFixed(0)} ms (x${(tTs / tRs).toFixed(2)}) for 4 min of audio`);
})();
