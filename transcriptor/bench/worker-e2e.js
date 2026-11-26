'use strict';
const { REPO, WS } = require('./paths');
// Cadence's scoreFollowWorker.writeOut, step for step in Node, with the files Cadence ships
// (transcriptor/src and src/session/recognition/transcription.ts, FolkFriend's Node build):
// the ABC of an audio file, and the time each stage takes.
//   node bench/worker-e2e.js <audio> [native]
const path = require('node:path'), { pathToFileURL } = require('node:url');
const C = require(`${WS}/transcription-bench/lib/common`);
const { FolkFriendWASM } = require(`${WS}/folkfriend-src/rust/pkg-node-transcribe-simd/folkfriend.js`);
const REC = `${REPO}/src/session/recognition`;
const CH = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUV';
(async () => {
  const X = await import(pathToFileURL(path.join(__dirname, '../src/decoder.ts')).href);
  const V = await import(pathToFileURL(path.join(__dirname, '../src/folkfriendView.ts')).href);
  // OLD=1: the committed chain (FolkFriend's notes and novelty, transcription.ts as committed)
  const T = await import(pathToFileURL(process.env.OLD ? `${WS}/transcription-bench/variants/head-src.ts` : `${REC}/transcription.ts`).href);
  const L = await import(pathToFileURL(`${REPO}/src/session/liveTempo.ts`).href);
  if (process.argv[3] === 'native') X.useAnalysis(require('./native').nativeAnalyse());
  // RATE: decoded at that rate; TO48=1: then brought to 48 kHz by linear interpolation
  let rate = Number(process.env.RATE || 48000), pcm = C.decode(process.argv[2], { rate, ...(process.env.DUR ? { start: 0, dur: Number(process.env.DUR) } : {}) });
  if (process.env.TO48 && rate !== 48000) {
    const out = new Float32Array(Math.floor((pcm.length * 48000) / rate));
    for (let i = 0; i < out.length; i++) { const x = (i * rate) / 48000, k = Math.floor(x), f = x - k; out[i] = (pcm[k] ?? 0) * (1 - f) + (pcm[k + 1] ?? 0) * f; }
    pcm = out; rate = 48000;
  }
  const t0 = performance.now();
  const f = new FolkFriendWASM();
  f.set_sample_rate(rate); f.keep_magnitudes();
  const at = f.alloc_single_pcm_window();
  for (let i = 0; i + 1024 <= pcm.length; i += 1024) { f.get_allocated_pcm_window(at).set(pcm.subarray(i, i + 1024)); f.feed_single_pcm_window(at); }
  const features = f.take_magnitude_features();
  // FolkFriend's cleaned class energies, the decoder's extra view (NOVIEW=1: without)
  let extra;
  if (!process.env.NOVIEW && !process.env.OLD) {
    const v = new FolkFriendWASM();
    v.set_sample_rate(rate); v.enable_clean_features();
    const vat = v.alloc_single_pcm_window();
    for (let i = 0; i + 1024 <= pcm.length; i += 1024) { v.get_allocated_pcm_window(vat).set(pcm.subarray(i, i + 1024)); v.feed_single_pcm_window(vat); }
    extra = V.classView(v.take_clean_features(V.CLEAN_VIEW.drone, false, V.CLEAN_VIEW.stride, 0));
    v.free();
  }
  const t1 = performance.now();
  const fps = rate / 1024;
  const heard = process.env.OLD ? null : X.hear(pcm, rate, undefined, extra);
  const classes = process.env.OLD ? f.transcribe_notes() : X.asClassNotes(heard.notes, fps);
  const t2 = performance.now();
  const novelty = new L.Novelty().of(features);
  const tempo = L.estimateRate(novelty, fps);
  const gridNov = process.env.NOMIX || process.env.OLD ? novelty : (process.env.MIXW ? X.gridNovelty(novelty, heard, 1024, Number(process.env.MIXW)) : X.gridNovelty(novelty, heard, 1024));
  const tune = process.env.OLD ? T.transcribe(classes, novelty, features, fps, tempo.rate) : T.transcribe(classes, gridNov, features, fps, tempo.rate, novelty);
  const contour = T.quaverContour(tune).map(m => CH[Math.min(95, Math.max(48, m)) - 48]).join('');
  const key = (contour.length ? T.keyOfAbc(f.contour_to_abc(contour)) : null) ?? T.makeKey(0, 'maj');
  const abc = T.writeAbc(tune, key);
  const t3 = performance.now();
  f.free();
  console.log(abc);
  console.log(`\n${(pcm.length / rate).toFixed(1)} s of audio: FolkFriend ${(t1 - t0).toFixed(0)} ms, notes ${(t2 - t1).toFixed(0)} ms, tune ${(t3 - t2).toFixed(0)} ms`);
})();
