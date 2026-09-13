'use strict';
// Paired cost of the shortlist size (num_repass) on one engine instance.
// Same windows, settings interleaved window by window (2000, 4000, 8000 in a
// rotating order), so machine contention weighs equally on all three.
// Times the QUERY only (the contour is decoded once per window), which is what
// num_repass changes; the octave fallback's second query is included, as in ffWorker.
//   node experiments/ranking-study/v3/bench-repass.js [nWindows]
const path = require('node:path');
const CADENCE = path.resolve(__dirname, '../../..');
const NOISE_LIB = path.join(CADENCE, 'experiments/noise-study/lib');
const { decodeToFloat32Mono48k, SAMPLE_RATE } = require(path.join(NOISE_LIB, 'decodeAudio'));
const { loadTuneIndex } = require(path.join(NOISE_LIB, 'tuneIndex'));
const { shiftContour } = require(path.join(NOISE_LIB, 'shiftContour'));
const { FolkFriendWASM } = require(path.join(CADENCE, '../folkfriend-src/rust/pkg-node-knobs2/folkfriend.js'));

const N = Number(process.argv[2] ?? 60);
const SIZES = [2000, 4000, 8000];
const FF_PCM_WINDOW = 1024;

(async () => {
  const ff = new FolkFriendWASM();
  ff.set_sample_rate(48000);
  const ptr = ff.alloc_single_pcm_window();
  ff.load_index_from_json_obj(await loadTuneIndex());
  const pcm = decodeToFloat32Mono48k(path.join(CADENCE, 'test-fixtures/audio/20260523_2_aprem_tabac.m4a'));
  const win = 10 * SAMPLE_RATE, hop = 5 * SAMPLE_RATE;
  const times = new Map(SIZES.map(s => [s, []]));
  let used = 0;
  for (let k = 0; used < N && (k * hop + win) <= pcm.length; k += 7) {
    ff.flush_pcm_buffer();
    const seg = pcm.subarray(k * hop, k * hop + win);
    for (let i = 0; i < Math.floor(seg.length / FF_PCM_WINDOW); i++) {
      ff.get_allocated_pcm_window(ptr).set(seg.subarray(i * FF_PCM_WINDOW, (i + 1) * FF_PCM_WINDOW));
      ff.feed_single_pcm_window(ptr);
    }
    const raw = JSON.parse(ff.transcribe_pcm_buffer_debug());
    if (raw.error) continue;
    used++;
    const order = [...SIZES.slice(used % 3), ...SIZES.slice(0, used % 3)];
    for (const s of order) {
      ff.set_num_repass(s);
      const t0 = process.hrtime.bigint();
      const a = JSON.parse(ff.run_transcription_query_debug(raw.contour));
      if ((a[0]?.score ?? 0) < 0.40) {
        const lifted = shiftContour(raw.contour, 12);
        if (lifted.length) JSON.parse(ff.run_transcription_query_debug(lifted));
      }
      times.get(s).push(Number(process.hrtime.bigint() - t0) / 1e6);
    }
  }
  ff.set_num_repass(2000);
  const med = a => { const b = [...a].sort((x, y) => x - y); return b[Math.floor(b.length / 2)]; };
  const base = med(times.get(2000));
  console.log(`${used} fenetres (tabac, 1 sur 7), requete(s) seulement, en contention`);
  for (const s of SIZES) {
    const m = med(times.get(s));
    console.log(`  num_repass ${String(s).padStart(4)} : mediane ${m.toFixed(1)} ms  (x${(m / base).toFixed(2)})  moyenne ${(times.get(s).reduce((x, y) => x + y, 0) / times.get(s).length).toFixed(1)} ms`);
  }
})().catch(e => { console.error(e); process.exit(1); });
