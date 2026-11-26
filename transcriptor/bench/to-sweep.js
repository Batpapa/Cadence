'use strict';
// Our decoder's notes into the transcription bench: for each item of a corpus cached there
// (cache/sweep/<corpus>.v8), the FolkFriend classes replaced by ours, at FolkFriend's frames
// (8 values a note: class, first frame, frames, power, 4 octave energies); novelty and
// features kept, so the grid and bars are the same and only the notes differ.
// Our analysis of each item is cached in out/ana-<corpus>-<i>.v8.
//   node bench/to-sweep.js <corpus> '{decoder options}' [tag]   -> cache/sweep/<corpus><tag>.v8
const fs = require('node:fs'), v8 = require('node:v8'), path = require('node:path');
const { pathToFileURL } = require('node:url');
const BENCH = 'C:/Perso/IrishMusicExperiments/transcription-bench';
const C = require(`${BENCH}/lib/common`);
const corpora = require(`${BENCH}/lib/corpora`);
const { userItems } = require(`${BENCH}/lib/user`);
const [corpus, optsJson, tag] = process.argv.slice(2);
const FPS = 48000 / 1024;

(async () => {
  const D = await import(pathToFileURL(path.join(__dirname, '../src/decoder.ts')).href);
  const LT = await import(pathToFileURL('C:/Perso/IrishMusicExperiments/Cadence/src/session/liveTempo.ts').href);
  process.env.FLUTE_EVERY = '1';
  const items = corpus === 'tuneset' ? corpora.tunesetItems() : corpus === 'session' ? corpora.sessionItems() : corpus === 'dotted' ? corpora.dottedItems() : corpus === 'flute' ? corpora.fluteItems() : userItems();
  const cache = v8.deserialize(fs.readFileSync(`${BENCH}/cache/sweep/${corpus}.v8`));
  const opts = JSON.parse(optsJson || '{}');
  for (let i = 0; i < cache.length; i++) {
    const file = path.join(__dirname, '../out', `${process.env.ANA || "ana"}-${corpus}-${i}.v8`);
    let a;
    if (fs.existsSync(file)) a = v8.deserialize(fs.readFileSync(file));
    else {
      const it = items[i];
      a = D.analyseAudio(C.decode(it.audio, { start: it.start ?? 0, dur: it.dur ?? null, rate: 48000 }), 48000);
      fs.writeFileSync(file, v8.serialize(a));
    }
    // EXTRA_ANA=<tag>: FolkFriend's cleaned class energies (bench/ff-extra.js) as the decoder's extra view
    if (process.env.EXTRA_ANA) { a.extra = v8.deserialize(fs.readFileSync(path.join(__dirname, '../out', `${process.env.EXTRA_ANA}-${corpus}-${i}.v8`))); a.extraHop = 1024; }
    const notes = D.decode(a, opts);
    const flat = [];
    for (const n of notes) {
      const shift = Number(process.env.ONSET_SHIFT || 0); // frames, to meet another engine's novelty
      // FRACTIONAL=1: starts between frames, as Cadence's worker now hands them (asClassNotes)
      const s = process.env.FRACTIONAL ? n.onset * FPS + shift : Math.round(n.onset * FPS) + shift;
      const e = process.env.FRACTIONAL ? s + Math.max(1, (n.offset - n.onset) * FPS) : Math.max(s + 1, Math.round(n.offset * FPS) + shift);
      flat.push(n.cls, s, e - s, n.power, ...n.octaves);
    }
    cache[i].classes = Float32Array.from(flat);
    if (process.env.OUR_NOVELTY) {
      // our onset function at FolkFriend's frames: the most of the 4 short frames centred in each
      // the decoder's own mapping (gridNovelty with weight 1: ours alone, over its mean)
      // GRID_ANA: the onset function of another analysis (e.g. a 2048 window) for the grid
      const ga = process.env.GRID_ANA ? v8.deserialize(fs.readFileSync(path.join(__dirname, '../out', `${process.env.GRID_ANA}-${corpus}-${i}.v8`))) : a;
      // GRID_EVEN=1: only the even frames (hop 512 with lag 2 = hop 256 with lag 4 on even frames)
      const gf = process.env.GRID_EVEN ? Float32Array.from(ga.short.flux, (v, t) => (t % 2 === (process.env.GRID_EVEN === "odd" ? 0 : 1) ? 0 : v)) : ga.short.flux;
      const nov = D.gridNovelty(cache[i].novelty, { onsets: gf, onsetCentre: (ga.shortSize ?? 2048) / 2 }, 1024, 1);
      // NOVELTY_MIX=w: (1 - w) x FolkFriend's + w x ours, each over its mean
      const w = Number(process.env.NOVELTY_MIX ?? 1), old = cache[i].novelty;
      cache[i].metreNovelty = old; // the metre keeps FolkFriend's
      const mean = (x) => { let s = 0; for (const v of x) s += v; return s / (x.length || 1) || 1; };
      const mo = mean(old), mn = mean(nov);
      cache[i].novelty = Float32Array.from(nov, (v, k) => (1 - w) * (old[k] ?? 0) / mo + w * v / mn);
      const est = LT.estimateRate(nov, FPS);
      if (process.env.OUR_RATE && est) cache[i].rate = est.rate;
    }
    process.stderr.write('.');
  }
  fs.writeFileSync(`${BENCH}/cache/sweep/${corpus}${tag || '-ct'}.v8`, v8.serialize(cache));
  console.log(`\n${corpus}: ${cache.length} items`);
})();
