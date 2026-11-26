'use strict';
const { REPO, WS } = require('./paths');
// Sessions: notes a second (ours, FolkFriend) and agreement with the settings in classes and
// in exact pitches (merged sequences), to tell octave trouble from note trouble.
const fs = require('node:fs'), v8 = require('node:v8'), { pathToFileURL } = require('node:url');
const B = `${WS}/transcription-bench`;
const C = require(`${B}/lib/common`);
const { sessionItems } = require(`${B}/lib/corpora`);
const { classShift } = require(`${B}/lib/sessionScore`);
(async () => {
  const T = await import(pathToFileURL(process.env.TS || `${REPO}/src/session/recognition/transcription.ts`).href);
  const items = sessionItems();
  const ours = v8.deserialize(fs.readFileSync(`${B}/cache/sweep/session${process.env.TAG || '-ct'}.v8`)), ff = v8.deserialize(fs.readFileSync(`${B}/cache/sweep/session.v8`));
  const agg = { o: { n: 0, cls: 0, ex: 0 }, f: { n: 0, cls: 0, ex: 0 } };
  items.forEach((it, i) => {
    for (const [k, c] of [['o', ours[i]], ['f', ff[i]]]) {
      const q = T.withOctaves(T.classNotes(c.classes)).map(h => h.pitch);
      agg[k].n += q.length / 30;
      let cls = 0, ex = 0;
      it.refs.forEach(r => { const s = classShift(q, r); cls = Math.max(cls, s.score); ex = Math.max(ex, C.tuneAgreement(q, r, [s.shift - 24, s.shift - 12, s.shift, s.shift + 12, s.shift + 24].filter(x => x >= -30 && x <= 30)).score); });
      agg[k].cls += cls; agg[k].ex += ex;
    }
  });
  for (const [k, a] of Object.entries(agg)) console.log(`${k === 'o' ? 'ours' : 'FF  '} notes/s ${(a.n / items.length).toFixed(2)}  classes ${(100 * a.cls / items.length).toFixed(1)}  exact ${(100 * a.ex / items.length).toFixed(1)}`);
})();
