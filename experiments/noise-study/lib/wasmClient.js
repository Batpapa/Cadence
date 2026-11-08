'use strict';
const path = require('node:path');
const { FolkFriendWASM } = require(path.resolve(__dirname, '../wasm-node/folkfriend.js'));

const FF_PCM_WINDOW = 1024; // must match Cadence's sessionConfig.ts FF_PCM_WINDOW / Rust's ff_config::SPEC_WINDOW_SIZE

function mapCandidates(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map(r => {
    const c = {
      tuneId: r.setting.tune_id,
      settingId: r.setting_id,
      displayName: r.display_name,
      dance: r.setting.dance,
      meter: r.setting.meter,
      score: r.score,
    };
    // The key it was found in, as ffWorker.ts stores it: signed, -5..+6, only off 0.
    const k = (((r.transpose ?? 0) % 12) + 12) % 12;
    const transpose = k > 6 ? k - 12 : k;
    if (transpose !== 0) c.transpose = transpose;
    return c;
  });
}

/** Reads a numeric `export const NAME = value` straight out of the app's
 *  sessionConfig.ts (this is CommonJS, the config is TypeScript) — the same
 *  approach regenerate-fixtures.js uses for the window geometry, so the
 *  fixtures can never run with engine parameters the app does not. */
function engineConst(name) {
  const fs = require('node:fs');
  const src = fs.readFileSync(path.resolve(__dirname, '../../../src/session/sessionConfig.ts'), 'utf8');
  const m = new RegExp(`export const ${name}\\s*=\\s*([0-9.]+)`).exec(src);
  if (!m) throw new Error(`${name} not found in sessionConfig.ts`);
  return Number(m[1]);
}

class WasmClient {
  constructor() {
    this.ff = new FolkFriendWASM();
    this.ff.set_sample_rate(48000);
    // Same calls, same values as ffWorker.ts's handleInit.
    this.ff.set_tempo_range(engineConst('FF_TEMPO_MIN_BPM'), engineConst('FF_TEMPO_MAX_BPM'));
    this.ff.set_num_repass(engineConst('FF_QUERY_REPASS_SIZE'));
    this.ff.set_min_query_length(engineConst('FF_MIN_QUERY_LENGTH'));
    // Pitch classes, whatever the key (2026-11-07): as ffWorker.ts, switched on
    // before the index is loaded.
    this.ff.set_pitch_class_mode();
    this.ff.set_any_pitch(true);
    this.pcmPtr = this.ff.alloc_single_pcm_window();
  }

  loadIndex(indexData) {
    this.ff.load_index_from_json_obj(indexData);
  }

  queryContourFull(contour) {
    const raw = JSON.parse(this.ff.run_transcription_query_debug(contour));
    return Array.isArray(raw) ? raw : [];
  }

  /** Mirrors ffWorker.ts's analyzeSignal() exactly (debug variant). `pcm` is a Float32Array of exactly one analysis
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

    const fullCandidates = this.queryContourFull(contour);
    const mapped = mapCandidates(fullCandidates);
    const candidates = mapped.slice(0, 10); // matches ffWorker.ts's TOP_N_CANDIDATES=10, production-shaped

    return {
      tWindowStart: tStart,
      tWindowEnd: tEnd,
      empty: candidates.length === 0,
      candidates,
      debug: {
        contour,
        octaveShiftApplied: 0,
        features,
        fullCandidates: mapped, // untruncated (up to ~100), for candidatesAboveX / sum-of-top-N stats
      },
    };
  }
}

module.exports = { WasmClient, FF_PCM_WINDOW };
