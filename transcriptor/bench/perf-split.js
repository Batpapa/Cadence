'use strict';
// Where hear() spends its time on 6 min of session, with the Rust analysis (SIMD): each of the
// three windows, the saliences (prepare), the decoding.
const path = require('node:path'), { pathToFileURL } = require('node:url');
const C = require('C:/Perso/IrishMusicExperiments/transcription-bench/lib/common');
const { sessionItems } = require('C:/Perso/IrishMusicExperiments/transcription-bench/lib/corpora');
const { nativeAnalyse } = require('./native');
(async () => {
  const D = await import(pathToFileURL(path.join(__dirname, '../src/decoder.ts')).href);
  const S = await import(pathToFileURL(path.join(__dirname, '../src/salience.ts')).href);
  const it = sessionItems()[0];
  const dur = +(process.env.DUR || 360);
  const pcm = C.decode(it.audio, { start: 0, dur, rate: 48000 });
  const nat = nativeAnalyse();
  const parts = {};
  const timed = (label, f) => { const t0 = performance.now(); const r = f(); parts[label] = (parts[label] || 0) + performance.now() - t0; return r; };
  D.useAnalysis((p, rate, o) => timed(o.peaks === false ? (o.size === 2048 ? 'grid window' : 'short window') : 'long window', () => nat(p, rate, o)));
  for (let r = 0; r < 2; r++) {
    for (const k of Object.keys(parts)) delete parts[k];
    const a = timed('analyseAudio', () => D.analyseAudio(pcm, 48000));
    const o = D.DEFAULTS;
    timed('salience', () => S.salience(a.long, a.tuning, { floorDb: o.peakFloorDb, maxPeaks: 60 }));
    const sal = S.salience(a.long, a.tuning, { floorDb: o.peakFloorDb, maxPeaks: 60 });
    timed('removeSustained x2', () => { S.removeSustained(sal.note, sal.frames, sal.notes, 469, 0.5, 25); S.removeSustained(sal.odd, sal.frames, sal.notes, 469, 0.5, 25); });
    const x = Float32Array.from(a.short.acf);
    timed('removeSustained acf', () => S.removeSustained(x, a.short.frames, a.short.acfNotes, 1875, 0.5));
    timed('decode (with prepare)', () => D.decode(a));
    timed('decode (prepared)', () => D.decode(a));
    console.log(Object.entries(parts).map(([k, v]) => `${k.padEnd(24)} ${v.toFixed(0).padStart(6)} ms`).join('\n'), '\n');
  }
})();
