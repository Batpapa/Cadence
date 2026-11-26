'use strict';
const { REPO, WS } = require('./paths');
// clean.mp3 through our decoder and transcription.ts's octaves: the notes against the truth
// (aligned by edit distance), each difference shown.   node bench/look-clean.js '{opts}' [ANA prefix]
const fs = require('node:fs'), v8 = require('node:v8'), path = require('node:path');
const { pathToFileURL } = require('node:url');
const { userItems } = require(`${WS}/transcription-bench/lib/user`);
const N = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const nm = m => N[m % 12] + (Math.floor(m / 12) - 1);
(async () => {
  const D = await import(pathToFileURL(path.join(__dirname, '../src/decoder.ts')).href);
  const T = await import(pathToFileURL(`${REPO}/src/session/recognition/transcription.ts`).href);
  const o = JSON.parse(process.argv[2] || '{}');
  const a = v8.deserialize(fs.readFileSync(path.join(__dirname, '../out', `${process.argv[3] || 'hpa'}-user-0.v8`)));
  const notes = D.decode(a, o);
  const flat = notes.flatMap(x => [x.cls, Math.round(x.onset * 1000), Math.max(1, Math.round((x.offset - x.onset) * 1000)), x.power, ...x.octaves]);
  const heard = T.withOctaves(T.classNotes(flat)).map(h => ({ p: h.pitch, t: h.start / 1000, d: h.frames }));
  const truth = userItems()[0].truth.map(x => x.pitch);
  const q = heard.map(h => h.p);
  // edit alignment
  const n = q.length, m = truth.length, Dm = Array.from({ length: n + 1 }, (_, i) => Array.from({ length: m + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= n; i++) for (let j = 1; j <= m; j++) Dm[i][j] = Math.min(Dm[i - 1][j] + 1, Dm[i][j - 1] + 1, Dm[i - 1][j - 1] + (q[i - 1] === truth[j - 1] ? 0 : 1));
  let i = n, j = m; const ops = [];
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && Dm[i][j] === Dm[i - 1][j - 1] + (q[i - 1] === truth[j - 1] ? 0 : 1)) { if (q[i - 1] !== truth[j - 1]) ops.push(`${heard[i - 1].t.toFixed(2)}s ${nm(q[i - 1])} for ${nm(truth[j - 1])}`); i--; j--; }
    else if (i > 0 && Dm[i][j] === Dm[i - 1][j] + 1) { ops.push(`${heard[i - 1].t.toFixed(2)}s extra ${nm(q[i - 1])} (${heard[i - 1].d} ms)`); i--; }
    else { ops.push(`missing ${nm(truth[j - 1])} (truth #${j})`); j--; }
  }
  console.log(`heard ${n}, truth ${m}, edits ${Dm[n][m]}`);
  console.log(ops.reverse().join('\n'));
})();
