'use strict';
// Analyses of a corpus cached for the benches: node bench/build-ana.js <corpus> <prefix> '{analyse options}' [step]
const fs = require('node:fs'), v8 = require('node:v8'), path = require('node:path');
const { pathToFileURL } = require('node:url');
const B = 'C:/Perso/IrishMusicExperiments/transcription-bench';
const C = require(`${B}/lib/common`);
const corpora = require(`${B}/lib/corpora`);
const { userItems } = require(`${B}/lib/user`);
const [corpus, prefix, json, step] = process.argv.slice(2);
(async () => {
  const D = await import(pathToFileURL(path.join(__dirname, '../src/decoder.ts')).href);
  process.env.FLUTE_EVERY = '1';
  const items = corpus === 'tuneset' ? corpora.tunesetItems() : corpus === 'session' ? corpora.sessionItems() : corpus === 'dotted' ? corpora.dottedItems() : corpus === 'flute' ? corpora.fluteItems() : userItems();
  const o = JSON.parse(json || '{}');
  for (let i = 0; i < items.length; i += Number(step || 1)) {
    const file = path.join(__dirname, '../out', `${prefix}-${corpus}-${i}.v8`);
    if (fs.existsSync(file)) continue;
    const it = items[i];
    fs.writeFileSync(file, v8.serialize(D.analyseAudio(C.decode(it.audio, { start: it.start ?? 0, dur: it.dur ?? null, rate: 48000 }), 48000, o)));
  }
  console.log(`${corpus} ${prefix} done`);
})();
