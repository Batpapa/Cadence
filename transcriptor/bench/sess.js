'use strict';
const { REPO, WS } = require('./paths');
// Session judge, direct: our decoder on the cached analyses of the session excerpts (every
// STEP-th), octaves by transcription.ts's Viterbi; against the excerpt's TheSession settings
// (relative only): notes a second, agreement in classes and exact pitches (merged
// sequences, best key shift and octave). FolkFriend's figures from its cache alongside.
//   STEP=2 node bench/sess.js '{"sets": [{...}, ...]}'
const fs = require('node:fs'), v8 = require('node:v8'), path = require('node:path');
const { pathToFileURL } = require('node:url');
const B = `${WS}/transcription-bench`;
const C = require(`${B}/lib/common`);
const { sessionItems } = require(`${B}/lib/corpora`);
const { classShift } = require(`${B}/lib/sessionScore`);
const spec = JSON.parse(process.argv[2] || '{"sets":[{}]}');
const STEP = Number(process.env.STEP || 2);
(async () => {
  const D = await import(pathToFileURL(path.join(__dirname, '../src/decoder.ts')).href);
  const T = await import(pathToFileURL(`${REPO}/src/session/recognition/transcription.ts`).href);
  const items = sessionItems();
  const ff = v8.deserialize(fs.readFileSync(`${B}/cache/sweep/session.v8`));
  const idx = items.map((_, i) => i).filter(i => i % STEP === 0);
  const ana = new Map(idx.map(i => [i, v8.deserialize(fs.readFileSync(path.join(__dirname, '../out', `${process.env.ANA || "ana"}-session-${i}.v8`)))]));
  const judge = (q, it) => {
    let cls = 0, ex = 0;
    it.refs.forEach(r => { const s = classShift(q, r); cls = Math.max(cls, s.score); ex = Math.max(ex, C.tuneAgreement(q, r, [s.shift - 24, s.shift - 12, s.shift, s.shift + 12, s.shift + 24].filter(x => x >= -30 && x <= 30)).score); });
    return { cls, ex };
  };
  const run = (get) => { let n = 0, cls = 0, ex = 0; for (const i of idx) { const q = get(i); n += q.length / 30; const j = judge(q, items[i]); cls += j.cls; ex += j.ex; } return `notes/s ${(n / idx.length).toFixed(2)}  classes ${(100 * cls / idx.length).toFixed(1)}  exact ${(100 * ex / idx.length).toFixed(1)}`; };
  if (!process.env.NOFF) console.log(`${'FolkFriend'.padEnd(50)} ${run(i => T.withOctaves(T.classNotes(ff[i].classes)).map(h => h.pitch))}`);
  for (const o of spec.sets) {
    const r = run(i => { const notes = D.decode(ana.get(i), o); const flat = notes.flatMap(x => [x.cls, Math.round(x.onset * 1000), Math.max(1, Math.round((x.offset - x.onset) * 1000)), x.power, ...x.octaves]); return T.withOctaves(T.classNotes(flat)).map(h => h.pitch); });
    console.log(`${(JSON.stringify(o).slice(1, -1) || 'default').padEnd(50)} ${r}`);
  }
})();
