'use strict';
// FolkFriend's cleaned energies of each item of a transcription-bench corpus, folded to 12 classes —
// the decoder's `extra` class view (option extraWeight). Cached in out/<tag>-<corpus>-<i>.v8, read
// by to-sweep.js when EXTRA_ANA=<tag>.
//   EXTRA='{"drone":469,"stride":47,"topk":5}' node bench/ff-extra.js <corpus> [tag=ffx]
const fs = require('node:fs'), v8 = require('node:v8'), path = require('node:path');
const { pathToFileURL } = require('node:url');
const BENCH = 'C:/Perso/IrishMusicExperiments/transcription-bench';
const C = require(`${BENCH}/lib/common`);
const corpora = require(`${BENCH}/lib/corpora`);
const { userItems } = require(`${BENCH}/lib/user`);
const [corpus, tag = 'ffx'] = process.argv.slice(2);
const X = JSON.parse(process.env.EXTRA || '{"drone":469,"stride":47,"topk":5}');
const VENDOR = path.join(__dirname, '../../vendor/folkfriend');

(async () => {
  const mod = await import(pathToFileURL(path.join(VENDOR, 'folkfriend.js')).href);
  await mod.default(fs.readFileSync(path.join(VENDOR, 'folkfriend_bg_simd.wasm')));
  process.env.FLUTE_EVERY = '1';
  const items = corpus === 'tuneset' ? corpora.tunesetItems() : corpus === 'session' ? corpora.sessionItems() : corpus === 'dotted' ? corpora.dottedItems() : corpus === 'flute' ? corpora.fluteItems() : userItems();
  for (let i = 0; i < items.length; i++) {
    const file = path.join(__dirname, '../out', `${tag}-${corpus}-${i}.v8`);
    if (fs.existsSync(file)) continue;
    const it = items[i];
    const pcm = C.decode(it.audio, { start: it.start ?? 0, dur: it.dur ?? null, rate: 48000 });
    const ff = new mod.FolkFriendWASM();
    ff.set_sample_rate(48000);
    ff.enable_clean_features();
    const ptr = ff.alloc_single_pcm_window();
    for (let s = 0; s + 1024 <= pcm.length; s += 1024) { ff.get_allocated_pcm_window(ptr).set(pcm.subarray(s, s + 1024)); ff.feed_single_pcm_window(ptr); }
    const f48 = ff.take_clean_features(X.drone ?? 469, false, X.stride ?? 47, 0);
    ff.free();
    const frames = f48.length / 48, out = new Float32Array(frames * 12);
    for (let f = 0; f < frames; f++) {
      for (let m = 0; m < 48; m++) out[f * 12 + (m % 12)] += f48[f * 48 + m];
      const k = X.topk ?? 0;
      if (k > 0 && k < 12) {
        const keep = Array.from(out.subarray(f * 12, f * 12 + 12)).sort((p, q) => q - p)[k - 1];
        for (let c = 0; c < 12; c++) if (out[f * 12 + c] < keep) out[f * 12 + c] = 0;
      }
    }
    fs.writeFileSync(file, v8.serialize(out));
    process.stderr.write('.');
  }
  process.stderr.write(`\n${corpus}: ${items.length} items\n`);
})();
