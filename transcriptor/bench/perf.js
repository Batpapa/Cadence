'use strict';
const { REPO, WS } = require('./paths');
// Speed: analysis and decoding of the first 60 s of a session recording, x realtime.
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const C = require(`${WS}/transcription-bench/lib/common`);
const { sessionItems } = require(`${WS}/transcription-bench/lib/corpora`);
(async () => {
  const D = await import(pathToFileURL(path.join(__dirname, '../src/decoder.ts')).href);
  const it = sessionItems()[0];
  const pcm = C.decode(it.audio, { start: it.start, dur: 60, rate: 48000 });
  const opts = JSON.parse(process.argv[2] || '{"hpssTime":9,"hpssFreq":9,"acf":true}');
  for (let r = 0; r < 2; r++) {
    const t0 = performance.now();
    const a = D.analyseAudio(pcm, 48000, opts);
    const t1 = performance.now();
    const notes = D.decode(a, JSON.parse(process.env.R || '{}'));
    const t2 = performance.now();
    console.log(`analysis ${(t1 - t0).toFixed(0)} ms (${(60000 / (t1 - t0)).toFixed(1)}x), decode ${(t2 - t1).toFixed(0)} ms, ${notes.length} notes`);
  }
})();
