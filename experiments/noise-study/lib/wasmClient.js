'use strict';
const path = require('node:path');
const { FolkFriendWASM } = require(path.resolve(__dirname, '../wasm-node/folkfriend.js'));
const { shiftContour } = require('./shiftContour');

const FF_PCM_WINDOW = 1024; // must match Cadence's sessionConfig.ts FF_PCM_WINDOW / Rust's ff_config::SPEC_WINDOW_SIZE
const OCTAVE_FALLBACK_THRESHOLD = 0.40; // must match ffWorker.ts

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

class WasmClient {
  constructor() {
    this.ff = new FolkFriendWASM();
    this.ff.set_sample_rate(48000);
    this.pcmPtr = this.ff.alloc_single_pcm_window();
  }

  loadIndex(indexData) {
    this.ff.load_index_from_json_obj(indexData);
  }

  queryContourFull(contour) {
    const raw = JSON.parse(this.ff.run_transcription_query_debug(contour));
    return Array.isArray(raw) ? raw : [];
  }

  /** Mirrors ffWorker.ts's analyzeSignal() exactly (debug variant), including
   *  the octave fallback. `pcm` is a Float32Array of exactly one analysis
   *  window's samples (15s @ 48kHz in production, same here). */
  analyzeWindow(pcm, tStart, tEnd) {
    const f = this.ff;
    f.flush_pcm_buffer();
    const frames = Math.floor(pcm.length / FF_PCM_WINDOW);
    for (let i = 0; i < frames; i++) {
      const view = f.get_allocated_pcm_window(this.pcmPtr);
      view.set(pcm.subarray(i * FF_PCM_WINDOW, (i + 1) * FF_PCM_WINDOW));
      f.feed_single_pcm_window(this.pcmPtr);
    }

    const raw = JSON.parse(f.transcribe_pcm_buffer_debug());
    if (raw.error) {
      return {
        tWindowStart: tStart,
        tWindowEnd: tEnd,
        empty: true,
        candidates: [],
        debug: { contour: null, octaveShiftApplied: 0, features: null, fullCandidates: [] },
      };
    }

    const contour = raw.contour;
    const features = raw.features;

    let fullCandidates = this.queryContourFull(contour);
    let usedContour = contour;
    let octaveShiftApplied = 0;

    const top1 = fullCandidates[0]?.score ?? 0;
    if (top1 < OCTAVE_FALLBACK_THRESHOLD) {
      const lifted = shiftContour(contour, 12);
      const liftedCandidates = lifted.length > 0 ? this.queryContourFull(lifted) : [];
      const liftedTop1 = liftedCandidates[0]?.score ?? 0;
      if (liftedTop1 > top1) {
        fullCandidates = liftedCandidates;
        usedContour = lifted;
        octaveShiftApplied = 12;
      }
    }

    const mapped = mapCandidates(fullCandidates);
    const candidates = mapped.slice(0, 10); // matches ffWorker.ts's TOP_N_CANDIDATES=10, production-shaped

    return {
      tWindowStart: tStart,
      tWindowEnd: tEnd,
      empty: candidates.length === 0,
      candidates,
      debug: {
        contour: usedContour,
        octaveShiftApplied,
        features,
        fullCandidates: mapped, // untruncated (up to ~100), for candidatesAboveX / sum-of-top-N stats
      },
    };
  }
}

module.exports = { WasmClient, FF_PCM_WINDOW };
