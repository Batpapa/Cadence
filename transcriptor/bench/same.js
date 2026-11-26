'use strict';
// The analysis now against a cached one (an earlier code): largest differences.
//   node bench/same.js <cache file> <corpus> <index> '{analyse options}'
const fs = require('node:fs'), v8 = require('node:v8'), path = require('node:path');
const { pathToFileURL } = require('node:url');
const B = 'C:/Perso/IrishMusicExperiments/transcription-bench';
const C = require(`${B}/lib/common`);
const corpora = require(`${B}/lib/corpora`);
const { userItems } = require(`${B}/lib/user`);
(async () => {
  const D = await import(pathToFileURL(path.join(__dirname, '../src/decoder.ts')).href);
  const [file, corpus, idx, json] = process.argv.slice(2);
  const it = (corpus === 'user' ? userItems() : corpora.sessionItems())[Number(idx)];
  const old = v8.deserialize(fs.readFileSync(file));
  const t0 = performance.now();
  const now = D.analyseAudio(C.decode(it.audio, { start: it.start ?? 0, dur: it.dur ?? null, rate: 48000 }), 48000, JSON.parse(json || '{}'));
  console.log(`analysis ${(performance.now() - t0).toFixed(0)} ms`);
  for (const w of ['short', 'long']) {
    const a = old[w], b = now[w];
    const diff = (x, y) => { if (!x || !y) return 'n/a'; if (x.length !== y.length) return `lengths ${x.length} / ${y.length}`; let d = 0, m = 0; for (let i = 0; i < x.length; i++) { d = Math.max(d, Math.abs(x[i] - y[i])); m = Math.max(m, Math.abs(x[i])); } return `${(d / (m || 1)).toExponential(1)} rel`; };
    console.log(w, 'peaks', a.freq.length, b.freq.length, 'freq', diff(a.freq, b.freq), 'mag', diff(a.mag, b.mag), 'flux', diff(a.flux, b.flux), 'acf', diff(a.acf, b.acf));
  }
  const o = { octaveFrom: 'odd', sustainSpan: 1875, sustainFraction: 0.5, acfWeight: 0.3, octavePower: 5 };
  const n1 = D.decode(old, o), n2 = D.decode(now, o);
  let same = n1.length === n2.length; for (let i = 0; same && i < n1.length; i++) same = n1[i].cls === n2[i].cls && Math.abs(n1[i].onset - n2[i].onset) < 1e-9;
  console.log('notes', n1.length, n2.length, same ? 'identical' : 'DIFFERENT');
})();
