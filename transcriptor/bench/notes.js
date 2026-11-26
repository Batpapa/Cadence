'use strict';
const { REPO, WS } = require('./paths');
// Note judge on tuneset: our decoder's notes against the annotation (played notes, repeats
// merged in it, so our notes are merged the same way before matching): F-measure in pitch
// classes and in exact pitches (octaves by transcription.ts's Viterbi), within 50 and 25 ms,
// and the error budget (bench/diag-errors.js's categories). FolkFriend's notes alongside.
// The analysis is cached per tune (out/ana-*.v8) so decoder settings can be swept quickly.
//   node bench/notes.js '{decoder options}' [label]
const fs = require('node:fs'), v8 = require('node:v8'), path = require('node:path');
const { pathToFileURL } = require('node:url');
const BENCH = `${WS}/transcription-bench`;
const C = require(`${BENCH}/lib/common`);
const { tunesetItems } = require(`${BENCH}/lib/corpora`);
const opts = JSON.parse(process.argv[2] || '{}');
const label = process.argv[3] || 'ours';

function f(est, truth, tol, key) {
  const used = new Uint8Array(est.length); let hit = 0;
  for (const t of truth) {
    let best = -1, bd = Infinity;
    for (let j = 0; j < est.length; j++) if (!used[j] && key(est[j]) === key(t)) { const d = Math.abs(est[j].onset - t.onset); if (d <= tol && d < bd) { bd = d; best = j; } }
    if (best >= 0) { used[best] = 1; hit++; }
  }
  return { hit, est: est.length, tru: truth.length };
}
const merge = (notes) => { const out = []; for (const n of notes) { const l = out[out.length - 1]; if (l && l.pitch === n.pitch && n.onset - l.offset < 0.03) l.offset = n.offset; else out.push({ ...n }); } return out; };

(async () => {
  const D = await import(pathToFileURL(path.join(__dirname, '../src/decoder.ts')).href);
  const T = await import(pathToFileURL(`${REPO}/src/session/recognition/transcription.ts`).href);
  const items = tunesetItems();
  const ffCache = v8.deserialize(fs.readFileSync(`${BENCH}/cache/sweep/tuneset.v8`));
  fs.mkdirSync(path.join(__dirname, '../out'), { recursive: true });
  const acc = {}; const add = (k, m) => { acc[k] ??= { hit: 0, est: 0, tru: 0 }; for (const x of ['hit', 'est', 'tru']) acc[k][x] += m[x]; };
  let ms = 0, audio = 0;
  for (let i = 0; i < items.length; i++) {
    const file = path.join(__dirname, '../out', `${process.env.ANA || "ana"}-tuneset-${i}.v8`);
    let a;
    if (fs.existsSync(file)) a = v8.deserialize(fs.readFileSync(file));
    else { const pcm = C.decode(items[i].audio, { rate: 48000 }); a = D.analyseAudio(pcm, 48000); fs.writeFileSync(file, v8.serialize(a)); }
    const t0 = performance.now();
    const notes = D.decode(a, opts);
    ms += performance.now() - t0; audio += a.short.frames * a.hopS;
    // octaves: transcription.ts's Viterbi on our class notes (8 values a note, frames of 1 s / 1000)
    const flat = notes.flatMap(n => [n.cls, Math.round(n.onset * 1000), Math.max(1, Math.round((n.offset - n.onset) * 1000)), n.power, ...n.octaves]);
    const withOct = T.withOctaves(T.classNotes(flat)).map(h => ({ pitch: h.pitch, onset: h.start / 1000, offset: (h.start + h.frames) / 1000 }));
    const ours = merge(withOct);
    const oursCls = merge(notes.map(n => ({ pitch: n.cls, onset: n.onset, offset: n.offset })));
    const ffN = T.withOctaves(T.classNotes(ffCache[i].classes)).map(h => ({ pitch: h.pitch, onset: h.start / 46.875, offset: (h.start + h.frames) / 46.875 }));
    const ff = merge(ffN), ffCls = merge(ffN.map(n => ({ ...n, pitch: n.pitch % 12 })));
    const truth = items[i].truth, truthCls = truth.map(t => ({ ...t, pitch: t.pitch % 12 }));
    for (const tol of [0.05, 0.025]) {
      add(`${label} pitch@${tol * 1000}`, f(ours, truth, tol, x => x.pitch));
      add(`${label} class@${tol * 1000}`, f(oursCls, truthCls, tol, x => x.pitch));
      add(`ff pitch@${tol * 1000}`, f(ff, truth, tol, x => x.pitch));
      add(`ff class@${tol * 1000}`, f(ffCls, truthCls, tol, x => x.pitch));
    }
  }
  const rows = Object.entries(acc).map(([k, a]) => { const p = a.hit / a.est, r = a.hit / a.tru; return `${k.padEnd(22)} F ${(100 * 2 * p * r / (p + r)).toFixed(1)}  P ${(100 * p).toFixed(1)}  R ${(100 * r).toFixed(1)}`; });
  console.log(rows.filter(r => process.env.ALL || !r.startsWith('ff')).join('\n') + `\n(decode ${(audio / (ms / 1000)).toFixed(0)}x realtime)`);
  if (process.env.ALL) console.log();
})();
