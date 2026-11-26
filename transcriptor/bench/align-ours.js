'use strict';
// The repeat-consistency judge's excerpts (transcription-bench/cache/sweep/<corpus>-align60.v8,
// 60 s score-followed) with our decoder's notes in place of FolkFriend's (fractional frames).
//   node bench/align-ours.js <session|dotted> [part] [parts]   -> <corpus>-align60-ours[-part].v8
const fs = require('node:fs'), v8 = require('node:v8'), path = require('node:path');
const { pathToFileURL } = require('node:url');
const B = 'C:/Perso/IrishMusicExperiments/transcription-bench';
const C = require(`${B}/lib/common`);
const corpora = require(`${B}/lib/corpora`);
const [corpus, part, parts] = [process.argv[2], Number(process.argv[3] || 0), Number(process.argv[4] || 1)];
process.env.SEG = '60'; // the excerpts align-cache.js followed
(async () => {
  const D = await import(pathToFileURL(path.join(__dirname, '../src/decoder.ts')).href);
  const items = corpus === 'dotted' ? corpora.dottedItems() : corpora.sessionItems();
  const cache = v8.deserialize(fs.readFileSync(`${B}/cache/sweep/${corpus}-align60.v8`));
  const out = [];
  for (let i = part; i < cache.length; i += parts) {
    const c = cache[i], it = items[i];
    if (c.id !== it.id) throw new Error('order');
    if (c.follow) {
      const start = it.start + it.dur / 2 - 30;
      const pcm = C.decode(it.audio, { start, dur: 60, rate: 48000 });
      c.classes = D.asClassNotes(D.transcribeNotes(pcm, 48000), 48000 / 1024);
    }
    out.push([i, c]);
  }
  fs.writeFileSync(path.join(__dirname, '../out', `${corpus}-align60-ours-${part}.v8`), v8.serialize(out));
  console.log(`${corpus} part ${part} done`);
})();
