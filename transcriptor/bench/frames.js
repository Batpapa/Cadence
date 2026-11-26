'use strict';
// Frame-level judge: on tuneset, at every frame where an annotated note sounds, is the
// loudest pitch class the note's? (raw class accuracy of melody extraction). Ours against
// FolkFriend's 48-note features folded to classes (the current decoder's input).
//   node bench/frames.js '{"salience": {...}, "analysis": {...}}'
const fs = require('node:fs'), v8 = require('node:v8'), path = require('node:path');
const { pathToFileURL } = require('node:url');
const BENCH = 'C:/Perso/IrishMusicExperiments/transcription-bench';
const C = require(`${BENCH}/lib/common`);
const { tunesetItems } = require(`${BENCH}/lib/corpora`);
const opts = JSON.parse(process.argv[2] || '{}');

(async () => {
  const S = await import(pathToFileURL(path.join(__dirname, '../src/spectrum.ts')).href);
  const L = await import(pathToFileURL(path.join(__dirname, '../src/salience.ts')).href);
  const items = tunesetItems();
  const ffCache = v8.deserialize(fs.readFileSync(`${BENCH}/cache/sweep/tuneset.v8`));
  let ours = 0, ff = 0, n = 0, ms = 0, audio = 0;
  const per = [];
  for (let i = 0; i < items.length; i++) {
    const pcm = C.decode(items[i].audio, { rate: 48000 });
    const t0 = performance.now();
    const p = S.analyse(pcm, 48000, opts.analysis || {});
    const tuning = S.tuningOf(p);
    const sal = L.salience(p, tuning, opts.salience || {});
    ms += performance.now() - t0; audio += pcm.length / 48000;
    const hopS = p.hop / 48000, centre = (opts.analysis?.size ?? 2048) / 2 / 48000;
    const ffFps = 48000 / 1024, feat = ffCache[i].features;
    let o = 0, f = 0, k = 0;
    for (const note of items[i].truth) {
      for (let t = note.onset + 0.01; t < note.offset - 0.01; t += 0.01) {
        const cls = note.pitch % 12;
        const fr = Math.round((t - centre) / hopS);
        if (fr < 0 || fr >= sal.frames) continue;
        let best = 0; for (let c = 1; c < 12; c++) if (sal.cls[fr * 12 + c] > sal.cls[fr * 12 + best]) best = c;
        const g = Math.floor(t * ffFps);
        const fc = new Float64Array(12);
        for (let j = 0; j < 48; j++) fc[j % 12] += feat[g * 48 + j] || 0;
        let fb = 0; for (let c = 1; c < 12; c++) if (fc[c] > fc[fb]) fb = c;
        k++; if (best === cls) o++; if (fb === cls) f++;
      }
    }
    ours += o; ff += f; n += k;
    per.push(`${items[i].id.padEnd(30)} ours ${(100 * o / k).toFixed(1)}  ff ${(100 * f / k).toFixed(1)}  tuning ${tuning.toFixed(2)}`);
  }
  if (process.env.DETAIL) console.log(per.join('\n'));
  console.log(`class accuracy at sounding frames: ours ${(100 * ours / n).toFixed(1)} %, FolkFriend features ${(100 * ff / n).toFixed(1)} %  (${n} samples; ${(audio / (ms / 1000)).toFixed(0)}x realtime)`);
})();
