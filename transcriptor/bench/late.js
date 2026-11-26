'use strict';
// Per tuneset tune: share of annotated notes whose class is found 50-150 ms away (not
// within 50), ours and FolkFriend's, and our signed median offset — a tune where both are
// late in the same way points at its annotation.
const fs = require('node:fs'), v8 = require('node:v8'), path = require('node:path');
const { pathToFileURL } = require('node:url');
const B = 'C:/Perso/IrishMusicExperiments/transcription-bench';
const { tunesetItems } = require(`${B}/lib/corpora`);
(async () => {
  const D = await import(pathToFileURL(path.join(__dirname, '../src/decoder.ts')).href);
  const T = await import(pathToFileURL('C:/Perso/IrishMusicExperiments/Cadence/src/session/recognition/transcription.ts').href);
  const o = JSON.parse(process.argv[2] || '{}');
  const items = tunesetItems(), ff = v8.deserialize(fs.readFileSync(`${B}/cache/sweep/tuneset.v8`));
  items.forEach((item, i) => {
    const a = v8.deserialize(fs.readFileSync(path.join(__dirname, '../out', `ana-tuneset-${i}.v8`)));
    const ours = D.decode(a, o).map(n => ({ cls: n.cls, on: n.onset }));
    const theirs = T.classNotes(ff[i].classes).filter(x => x.power > 0.1 && x.frames >= 3).map(x => ({ cls: x.cls, on: x.start / 46.875 }));
    const stat = (h) => { let late = 0; const off = []; for (const t of item.truth) { let bd = Infinity, sd = 0; for (const x of h) if (x.cls === t.pitch % 12) { const d = x.on - t.onset; if (Math.abs(d) < bd) { bd = Math.abs(d); sd = d; } } if (bd < 0.15) off.push(sd); if (bd >= 0.05 && bd < 0.15) late++; } off.sort((a, b) => a - b); return { late: late / item.truth.length, med: off[off.length >> 1] }; };
    const s1 = stat(ours), s2 = stat(theirs);
    console.log(`${item.id.padEnd(32)} ours ${(100 * s1.late).toFixed(0).padStart(3)} % (median ${(1000 * s1.med).toFixed(0).padStart(4)} ms)   FF ${(100 * s2.late).toFixed(0).padStart(3)} % (median ${(1000 * s2.med).toFixed(0).padStart(4)} ms)`);
  });
})();
