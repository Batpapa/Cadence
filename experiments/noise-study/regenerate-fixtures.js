'use strict';
// Regenerates test-fixtures/sessions/<name>-windows.json with debug
// instrumentation (note/tempo/quant/rhythm features, full candidate list,
// contour) — replicates ffWorker.ts's analyzeSignal()/maybeAnalyzeLive()
// windowing exactly (15s window, 5s hop, 48kHz), offline, via a
// `--target nodejs` build of the (locally patched) FolkFriend WASM. See
// experiments/noise-study/README.md.
//
// Usage: node experiments/noise-study/regenerate-fixtures.js [name...]
//   (no args = all 5 fixtures)

const fs = require('node:fs');
const path = require('node:path');
const { decodeToFloat32Mono48k, SAMPLE_RATE } = require('./lib/decodeAudio');
const { loadTuneIndex } = require('./lib/tuneIndex');
const { WasmClient } = require('./lib/wasmClient');

const ANALYSIS_WINDOW_S = 15;
const ANALYSIS_HOP_S = 5;

const AUDIO_DIR = path.resolve(__dirname, '../../test-fixtures/audio');
const OUT_DIR = path.resolve(__dirname, '../../test-fixtures/sessions');

const FIXTURES = [
  { name: '20260523_1_matin_Anglade', audio: '20260523_1_matin_Anglade.m4a' },
  { name: '20260523_2_aprem_tabac', audio: '20260523_2_aprem_tabac.m4a' },
  { name: '20260523_5_auberge_fleurie', audio: '20260523_5_auberge_fleurie.m4a' },
  { name: 'One_of_the_Best_Traditional_Irish_Music_Sessions_Longer_Video', audio: 'One_of_the_Best_Traditional_Irish_Music_Sessions_Longer_Video.mp3' },
  { name: '732984_11910076-lq', audio: '732984_11910076-lq.mp3' },
  // 20240228_session_dubliners removed (2026-08-18) — user call: the session
  // leader plays too poorly that day, not a representative example (see
  // project memory). Its low recall (64.6%) was a real signal quality issue,
  // not a detector bug, but it skews the dataset as a noise-study sample.
  { name: '20240721_tocane_2_chapiteau', audio: '20240721_tocane_2_chapiteau.m4a' },
];

function windowize(pcm) {
  const windowSamples = ANALYSIS_WINDOW_S * SAMPLE_RATE;
  const hopSamples = ANALYSIS_HOP_S * SAMPLE_RATE;
  const windows = [];
  if (pcm.length < windowSamples) return windows;
  const numWindows = Math.floor((pcm.length - windowSamples) / hopSamples) + 1;
  for (let k = 0; k < numWindows; k++) {
    const endSample = windowSamples + k * hopSamples;
    const startSample = endSample - windowSamples;
    windows.push({
      pcm: pcm.subarray(startSample, endSample),
      tStart: startSample / SAMPLE_RATE,
      tEnd: endSample / SAMPLE_RATE,
    });
  }
  return windows;
}

async function main() {
  const requested = process.argv.slice(2);
  const fixtures = requested.length ? FIXTURES.filter(f => requested.includes(f.name)) : FIXTURES;
  if (fixtures.length === 0) {
    console.error('No matching fixtures for', requested);
    process.exit(1);
  }

  console.log('Loading tune index...');
  const indexData = await loadTuneIndex();

  const client = new WasmClient();
  client.loadIndex(indexData);
  console.log('WASM ready, version:', client.ff.version());

  for (const fx of fixtures) {
    const audioPath = path.join(AUDIO_DIR, fx.audio);
    if (!fs.existsSync(audioPath)) {
      console.error(`SKIP ${fx.name}: audio not found at ${audioPath}`);
      continue;
    }
    console.log(`\n[${fx.name}] decoding ${fx.audio} ...`);
    const t0 = Date.now();
    const pcm = decodeToFloat32Mono48k(audioPath);
    console.log(`  decoded ${(pcm.length / SAMPLE_RATE / 60).toFixed(1)} min of audio in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

    const windows = windowize(pcm);
    console.log(`  ${windows.length} windows to analyze`);

    const results = [];
    const tAnalyzeStart = Date.now();
    for (let i = 0; i < windows.length; i++) {
      const w = windows[i];
      const r = client.analyzeWindow(w.pcm, w.tStart, w.tEnd);
      results.push(r);
      if ((i + 1) % 100 === 0 || i === windows.length - 1) {
        const elapsed = (Date.now() - tAnalyzeStart) / 1000;
        console.log(`  ${i + 1}/${windows.length} windows analyzed (${elapsed.toFixed(0)}s elapsed)`);
      }
    }

    const outPath = path.join(OUT_DIR, `${fx.name}-windows.json`);
    fs.writeFileSync(outPath, JSON.stringify(results));
    console.log(`  wrote ${outPath} (${(fs.statSync(outPath).size / 1e6).toFixed(1)} MB)`);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
