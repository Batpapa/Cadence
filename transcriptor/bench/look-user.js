'use strict';
// clean.mp3: our decoder's notes over a stretch.   node bench/look-user.js <from> <to> ['{opts}']
const fs = require('node:fs'), v8 = require('node:v8'), path = require('node:path');
const { pathToFileURL } = require('node:url');
const N = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
(async () => {
  const D = await import(pathToFileURL(path.join(__dirname, '../src/decoder.ts')).href);
  const [from, to, o] = [Number(process.argv[2] || 0), Number(process.argv[3] || 4), JSON.parse(process.argv[4] || '{}')];
  const a = v8.deserialize(fs.readFileSync(path.join(__dirname, '../out', 'ana-user-0.v8')));
  const notes = D.decode(a, o);
  console.log(`notes ${notes.length} (truth 96)`);
  for (const n of notes.filter(x => x.onset >= from && x.onset < to)) console.log(n.onset.toFixed(3), N[n.cls].padEnd(2), (1000 * (n.offset - n.onset)).toFixed(0).padStart(4), 'p' + n.power.toFixed(2), n.octaves.map(x => x.toFixed(0)).join(' '));
})();
