'use strict';
// Experiment E1 — regenerate window fixtures with a different FolkFriend tempo
// search range, WITHOUT touching test-fixtures/sessions/ or noise-study/wasm-node/.
//
//   node experiments/ranking-study/v3/regen-tempo.js --wasm <pkg dir> --low 60 --high 240 --out <dir> [name...]
//
// Mirrors experiments/noise-study/regenerate-fixtures.js and lib/wasmClient.js
// exactly (window geometry from sessionConfig.ts, 48 kHz, 1024-sample PCM
// frames, octave fallback below 0.40, top 10 kept, debug fields) — the only
// intended difference is `set_tempo_range`. A run at 60/240 must reproduce the
// committed fixtures bit for bit (see compare-windows.js) before any variant is
// believed.

const fs = require('node:fs');
const path = require('node:path');

const CADENCE = path.resolve(__dirname, '../../..');
const NOISE_LIB = path.join(CADENCE, 'experiments/noise-study/lib');
const { decodeToFloat32Mono48k, SAMPLE_RATE } = require(path.join(NOISE_LIB, 'decodeAudio'));
const { loadTuneIndex } = require(path.join(NOISE_LIB, 'tuneIndex'));
const { shiftContour } = require(path.join(NOISE_LIB, 'shiftContour'));

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return def;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};
const WASM_DIR = path.resolve(opt('wasm', path.join(CADENCE, '../folkfriend-src/rust/pkg-node-tempo')));
const LOW = Number(opt('low', 60));
const HIGH = Number(opt('high', 240));
const OUT_DIR = path.resolve(opt('out', ''));
// --stride k analyses windows 0, k, 2k... only. Windows are independent (the
// feature buffer is flushed for each), so a sub-sampled run is exact for
// window-level screening (screen.js), not for the Viterbi chain.
const STRIDE = Number(opt('stride', 1));
const OCTAVE_OPT = Number(opt('octave', 0.40));
// --call method:a,b (repeatable) calls ff.method(a, b) after construction, for
// engine knobs beyond the tempo range. Numbers only.
const CALLS = [];
for (let v = opt('call', null); v !== null; v = opt('call', null)) {
  const [m, a = ''] = v.split(':');
  CALLS.push({ m, args: a ? a.split(',').map(Number) : [] });
}
if (!OUT_DIR || OUT_DIR === path.resolve('')) throw new Error('--out is required');
const SESSIONS_DIR = path.join(CADENCE, 'test-fixtures/sessions');
if (path.resolve(OUT_DIR) === path.resolve(SESSIONS_DIR)) throw new Error('refusing to overwrite the committed fixtures');

function constFromConfig(name) {
  const src = fs.readFileSync(path.join(CADENCE, 'src/session/sessionConfig.ts'), 'utf8');
  const m = new RegExp(`export const ${name}\\s*=\\s*([0-9.]+)`).exec(src);
  if (!m) throw new Error(`${name} not found in sessionConfig.ts`);
  return Number(m[1]);
}
const ANALYSIS_WINDOW_S = constFromConfig('ANALYSIS_WINDOW_S');
const ANALYSIS_HOP_S = constFromConfig('ANALYSIS_HOP_S');

const AUDIO_DIR = path.join(CADENCE, 'test-fixtures/audio');
const FIXTURES = [
  { name: '20260523_1_matin_Anglade', audio: '20260523_1_matin_Anglade.m4a' },
  { name: '20260523_2_aprem_tabac', audio: '20260523_2_aprem_tabac.m4a' },
  { name: '20260523_5_auberge_fleurie', audio: '20260523_5_auberge_fleurie.m4a' },
  { name: 'One_of_the_Best_Traditional_Irish_Music_Sessions_Longer_Video', audio: 'One_of_the_Best_Traditional_Irish_Music_Sessions_Longer_Video.mp3' },
  { name: '732984_11910076-lq', audio: '732984_11910076-lq.mp3' },
  { name: '20240721_tocane_2_chapiteau', audio: '20240721_tocane_2_chapiteau.m4a' },
  { name: '13th_Moon_Gravity_Well_-_Irish_Trad_Session_2024_01_24', audio: '13th Moon Gravity Well - Irish Trad Session 2024.01.24.mp3' },
  { name: '1Hour_Trad_Irish_Music_Session_in_Korea', audio: '1Hour Trad Irish Music Session in Korea.mp3' },
];

const FF_PCM_WINDOW = 1024;
// --octave t overrides the JS-side octave fallback threshold (ffWorker.ts uses 0.40).
const OCTAVE_FALLBACK_THRESHOLD = OCTAVE_OPT;

function mapCandidates(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map(r => ({
    tuneId: r.setting.tune_id,
    settingId: r.setting_id,
    displayName: r.display_name,
    dance: r.setting.dance,
    meter: r.setting.meter,
    score: r.score,
  }));
}

function makeClient(indexData) {
  const { FolkFriendWASM } = require(path.join(WASM_DIR, 'folkfriend.js'));
  const ff = new FolkFriendWASM();
  ff.set_sample_rate(48000);
  if (typeof ff.set_tempo_range !== 'function') throw new Error(`${WASM_DIR} has no set_tempo_range`);
  ff.set_tempo_range(LOW, HIGH);
  for (const { m, args: a } of CALLS) {
    if (typeof ff[m] !== 'function') throw new Error(`${WASM_DIR} has no ${m}`);
    ff[m](...a);
  }
  const pcmPtr = ff.alloc_single_pcm_window();
  ff.load_index_from_json_obj(indexData);
  const queryFull = contour => {
    const raw = JSON.parse(ff.run_transcription_query_debug(contour));
    return Array.isArray(raw) ? raw : [];
  };
  return {
    ff,
    analyzeWindow(pcm, tStart, tEnd) {
      ff.flush_pcm_buffer();
      const frames = Math.floor(pcm.length / FF_PCM_WINDOW);
      for (let i = 0; i < frames; i++) {
        const view = ff.get_allocated_pcm_window(pcmPtr);
        view.set(pcm.subarray(i * FF_PCM_WINDOW, (i + 1) * FF_PCM_WINDOW));
        ff.feed_single_pcm_window(pcmPtr);
      }
      const raw = JSON.parse(ff.transcribe_pcm_buffer_debug());
      if (raw.error) {
        return {
          tWindowStart: tStart, tWindowEnd: tEnd, empty: true, candidates: [],
          debug: { contour: null, octaveShiftApplied: 0, features: null, fullCandidates: [] },
        };
      }
      const contour = raw.contour;
      const features = raw.features;
      let fullCandidates = queryFull(contour);
      let usedContour = contour;
      let octaveShiftApplied = 0;
      const top1 = fullCandidates[0]?.score ?? 0;
      if (top1 < OCTAVE_FALLBACK_THRESHOLD) {
        const lifted = shiftContour(contour, 12);
        const liftedCandidates = lifted.length > 0 ? queryFull(lifted) : [];
        const liftedTop1 = liftedCandidates[0]?.score ?? 0;
        if (liftedTop1 > top1) {
          fullCandidates = liftedCandidates;
          usedContour = lifted;
          octaveShiftApplied = 12;
        }
      }
      const mapped = mapCandidates(fullCandidates);
      const candidates = mapped.slice(0, 10);
      return {
        tWindowStart: tStart, tWindowEnd: tEnd, empty: candidates.length === 0, candidates,
        debug: { contour: usedContour, octaveShiftApplied, features, fullCandidates: mapped },
      };
    },
  };
}

function windowize(pcm) {
  const windowSamples = ANALYSIS_WINDOW_S * SAMPLE_RATE;
  const hopSamples = ANALYSIS_HOP_S * SAMPLE_RATE;
  const windows = [];
  if (pcm.length < windowSamples) return windows;
  const numWindows = Math.floor((pcm.length - windowSamples) / hopSamples) + 1;
  for (let k = 0; k < numWindows; k += STRIDE) {
    const endSample = windowSamples + k * hopSamples;
    const startSample = endSample - windowSamples;
    windows.push({ pcm: pcm.subarray(startSample, endSample), tStart: startSample / SAMPLE_RATE, tEnd: endSample / SAMPLE_RATE });
  }
  return windows;
}

async function main() {
  const fixtures = args.length ? FIXTURES.filter(f => args.includes(f.name)) : FIXTURES;
  if (!fixtures.length) throw new Error(`no matching fixtures for ${args.join(', ')}`);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log(`wasm ${WASM_DIR} | tempo ${LOW}..${HIGH} | stride ${STRIDE} | octave ${OCTAVE_FALLBACK_THRESHOLD} | calls ${JSON.stringify(CALLS)} | out ${OUT_DIR}`);
  const client = makeClient(await loadTuneIndex());
  for (const fx of fixtures) {
    const t0 = Date.now();
    const pcm = decodeToFloat32Mono48k(path.join(AUDIO_DIR, fx.audio));
    const windows = windowize(pcm);
    const results = [];
    for (let i = 0; i < windows.length; i++) {
      const w = windows[i];
      results.push(client.analyzeWindow(w.pcm, w.tStart, w.tEnd));
      if ((i + 1) % 200 === 0 || i === windows.length - 1) {
        console.log(`  [${fx.name.slice(0, 24)}] ${i + 1}/${windows.length} (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
      }
    }
    fs.writeFileSync(path.join(OUT_DIR, `${fx.name}-windows.json`), JSON.stringify(results));
    const csv = path.join(SESSIONS_DIR, `${fx.name}-timings.csv`);
    if (fs.existsSync(csv)) fs.copyFileSync(csv, path.join(OUT_DIR, `${fx.name}-timings.csv`));
    console.log(`  wrote ${fx.name} in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
