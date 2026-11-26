'use strict';
// One tuneset tune, side by side: annotated notes and ours over a stretch of time.
//   node bench/look.js <tune index> <from s> <to s> ['{decoder options}']
const fs = require('node:fs'), v8 = require('node:v8'), path = require('node:path');
const { pathToFileURL } = require('node:url');
const corpora = require('C:/Perso/IrishMusicExperiments/transcription-bench/lib/corpora');
process.env.FLUTE_EVERY = '1';
const CORPUS = process.env.CORPUS || 'tuneset';
const tunesetItems = () => (CORPUS === 'flute' ? corpora.fluteItems() : corpora.tunesetItems());
const N = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
(async () => {
  const D = await import(pathToFileURL(path.join(__dirname, '../src/decoder.ts')).href);
  const [i, from, to, o] = [Number(process.argv[2] || 0), Number(process.argv[3] || 10), Number(process.argv[4] || 14), JSON.parse(process.argv[5] || '{}')];
  const a = v8.deserialize(fs.readFileSync(path.join(__dirname, '../out', `${process.env.ANA || 'ana'}-${CORPUS}-${i}.v8`)));
  const notes = D.decode(a, o);
  const item = tunesetItems()[i];
  const tr = item.truth.filter(t => t.onset >= from && t.onset < to).map(t => `${t.onset.toFixed(3)} ${N[t.pitch % 12].padEnd(2)} ${(1000 * (t.offset - t.onset)).toFixed(0)}`);
  const ou = notes.filter(t => t.onset >= from && t.onset < to).map(t => `${t.onset.toFixed(3)} ${N[t.cls].padEnd(2)} ${(1000 * (t.offset - t.onset)).toFixed(0)} p${t.power.toFixed(2)}`);
  console.log(item.id, `notes in all: truth ${item.truth.length}, ours ${notes.length}`);
  for (let k = 0; k < Math.max(tr.length, ou.length); k++) console.log((tr[k] || '').padEnd(22), ou[k] || '');
})();
