'use strict';
const { REPO, WS } = require('./paths');
// Where the analysis time goes: each window alone, with and without its extras.
const path = require('node:path'), { pathToFileURL } = require('node:url');
const C = require(`${WS}/transcription-bench/lib/common`);
const { sessionItems } = require(`${WS}/transcription-bench/lib/corpora`);
(async () => {
  const S = await import(pathToFileURL(path.join(__dirname, '../src/spectrum.ts')).href);
  const it = sessionItems()[0];
  const pcm = C.decode(it.audio, { start: it.start, dur: 60, rate: 48000 });
  const time = (label, o) => { const t0 = performance.now(); S.analyse(pcm, 48000, o); console.log(label.padEnd(36), (performance.now() - t0).toFixed(0), 'ms'); };
  time('short plain', { size: 2048, hop: 256 });
  time('short + hpss', { size: 2048, hop: 256, hpssTime: 9 });
  time('short + hpss + acf', { size: 2048, hop: 256, hpssTime: 9, acf: true });
  time('long plain', { size: 4096, hop: 256 });
  time('long + hpss', { size: 4096, hop: 256, hpssTime: 9 });
  time('long + hpss, hop 512', { size: 4096, hop: 512, hpssTime: 9 });
})();
