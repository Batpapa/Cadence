'use strict';
const { REPO, WS } = require('./paths');
// Decoder settings swept in memory on tuneset's cached analyses (bench/notes.js builds them):
// F of exact pitches and classes at 50 and 25 ms, FolkFriend's for reference.
//   node bench/sweep.js '{"base": {...}, "grid": {"cutCost": [1, 2, 3], ...}}'   (one axis at a time)
//   node bench/sweep.js '{"base": {...}, "sets": [{...}, ...]}'
const fs = require('node:fs'), v8 = require('node:v8'), path = require('node:path');
const { pathToFileURL } = require('node:url');
const corpora = require(`${WS}/transcription-bench/lib/corpora`);
process.env.FLUTE_EVERY = '1';
const CORPUS = process.env.CORPUS || 'tuneset';
const tunesetItems = () => (CORPUS === 'flute' ? corpora.fluteItems() : corpora.tunesetItems());
const spec = JSON.parse(process.argv[2] || '{}');

function hits(est, truth, tol, key) {
  const used = new Uint8Array(est.length); let hit = 0;
  for (const t of truth) {
    let best = -1, bd = Infinity;
    for (let j = 0; j < est.length; j++) { if (est[j].onset > t.onset + tol) break; if (!used[j] && key(est[j]) === key(t)) { const d = Math.abs(est[j].onset - t.onset); if (d <= tol && d < bd) { bd = d; best = j; } } }
    if (best >= 0) { used[best] = 1; hit++; }
  }
  return hit;
}
const merge = (notes) => { const out = []; for (const n of notes) { const l = out[out.length - 1]; if (l && l.pitch === n.pitch && n.onset - l.offset < 0.03) l.offset = n.offset; else out.push({ ...n }); } return out; };

(async () => {
  const D = await import(pathToFileURL(path.join(__dirname, '../src/decoder.ts')).href);
  const T = await import(pathToFileURL(`${REPO}/src/session/recognition/transcription.ts`).href);
  const items = tunesetItems();
  const ana = items.map((_, i) => v8.deserialize(fs.readFileSync(path.join(__dirname, '../out', `${process.env.ANA || "ana"}-${CORPUS}-${i}.v8`))));
  const score = (o) => {
    const a = { p50: 0, c50: 0, p25: 0, est: 0, estC: 0, tru: 0 };
    ana.forEach((an, i) => {
      const notes = D.decode(an, o);
      const flat = notes.flatMap(n => [n.cls, Math.round(n.onset * 1000), Math.max(1, Math.round((n.offset - n.onset) * 1000)), n.power, ...n.octaves]);
      const ours = merge(T.withOctaves(T.classNotes(flat)).map(h => ({ pitch: h.pitch, onset: h.start / 1000, offset: (h.start + h.frames) / 1000 })));
      const oursC = merge(notes.map(n => ({ pitch: n.cls, onset: n.onset, offset: n.offset })));
      const truth = items[i].truth, truthC = truth.map(t => ({ ...t, pitch: t.pitch % 12 }));
      a.p50 += hits(ours, truth, 0.05, x => x.pitch); a.p25 += hits(ours, truth, 0.025, x => x.pitch);
      a.c50 += hits(oursC, truthC, 0.05, x => x.pitch);
      a.est += ours.length; a.estC += oursC.length; a.tru += truth.length;
    });
    const F = (h, e) => 200 * h / (e + a.tru);
    return { p50: F(a.p50, a.est), c50: F(a.c50, a.estC), p25: F(a.p25, a.est), ratio: a.est / a.tru };
  };
  const base = spec.base || {};
  const sets = spec.sets ? spec.sets.map(s => ({ ...base, ...s })) : [base];
  if (spec.grid) for (const [k, vs] of Object.entries(spec.grid)) for (const v of vs) sets.push({ ...base, [k]: v });
  for (const s of sets) {
    const r = score(s);
    const diff = Object.entries(s).filter(([k, v]) => base[k] !== v || spec.sets).map(([k, v]) => `${k}=${v}`).join(' ') || 'base';
    console.log(`${diff.padEnd(48)} pitch@50 ${r.p50.toFixed(1)}  class@50 ${r.c50.toFixed(1)}  pitch@25 ${r.p25.toFixed(1)}  notes/truth ${r.ratio.toFixed(2)}`);
  }
})();
