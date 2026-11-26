import type { FolkFriendWASM } from '../../../vendor/folkfriend/folkfriend.js';
import type { TuneQuery } from './folkfriendQuery';
import type { WindowEngine } from './windowEngine';
import type { DetectionEvent, WindowResult, WindowDebugFeatures, NoteAndTempoFeatures } from '../model';
import { FF_PCM_WINDOW } from '../sessionConfig';

// ── FolkFriend's own decoder (to compare with) ────────────────────────────────
// How Cadence recognised until 2026-11-26: FolkFriend transcribes the window
// into its contour (pitch classes, see ffWorker.ts's header) and the same
// instance queries it. Kept behind the hidden switch (services/recognitionEngine.ts)
// to compare the default engine (transcriptorEngine.ts) with.

/** Debug transcribe response (2026-08-18): `transcribe_pcm_buffer_debug()`
 *  replaces `transcribe_pcm_buffer()` — same underlying computation (see
 *  folkfriend-src's contour_from_notes, which always builds this data
 *  internally regardless of which wrapper is called), just not discarded
 *  before crossing the WASM boundary. Zero extra engine cost. */
type RawTranscribeDebug = { contour: string; features: NoteAndTempoFeatures } | { error: string; features: null };

export class FolkFriendEngine implements WindowEngine {
  private readonly pcmPtr: number;

  /** `f`: the instance that holds the index (set to the worker's rate), `query` over it. */
  constructor(private readonly f: FolkFriendWASM, private readonly query: TuneQuery) {
    this.pcmPtr = f.alloc_single_pcm_window();
  }

  /** Feed a PCM signal into FolkFriend and return the analysis of it. */
  analyze(pcm: Float32Array, tStart: number, tEnd: number): { result: WindowResult; abc: string | null } {
    const f = this.f;
    // transcribe_pcm_buffer_debug consumes the internal buffer, so every
    // analysis re-feeds its full window; flush first for safety.
    f.flush_pcm_buffer();
    const frames = Math.floor(pcm.length / FF_PCM_WINDOW);
    for (let i = 0; i < frames; i++) {
      // Re-acquire the view before EVERY write: it goes stale if WASM memory grows.
      const view = f.get_allocated_pcm_window(this.pcmPtr);
      view.set(pcm.subarray(i * FF_PCM_WINDOW, (i + 1) * FF_PCM_WINDOW));
      f.feed_single_pcm_window(this.pcmPtr);
    }

    const rawDebug = JSON.parse(f.transcribe_pcm_buffer_debug()) as RawTranscribeDebug;
    if ('error' in rawDebug) {
      return { result: { tWindowStart: tStart, tWindowEnd: tEnd, empty: true, candidates: [] }, abc: null };
    }
    const contour = rawDebug.contour;
    const features = rawDebug.features;

    // No score filtering here: the Viterbi detector applies its own candidate
    // floor (minCandidateProbability), and the calibration dump needs the
    // sub-floor scores to be tunable at all.
    const candidates = this.query.query(contour, features?.tuning);
    const abc = this.query.abcOf(contour);

    // "Enriched top-10" (2026-08-18): candidates stay capped at TOP_N_CANDIDATES
    // as always — debug only adds note/tempo/contour telemetry, no extra
    // candidates, keeping the per-window storage growth to just this struct
    // (a few hundred bytes) instead of duplicating (part of) the candidate list.
    const debug: WindowDebugFeatures = { contour, octaveShiftApplied: 0, features };

    return {
      result: { tWindowStart: tStart, tWindowEnd: tEnd, empty: candidates.length === 0, candidates, debug },
      abc,
    };
  }

  stepped(_events: DetectionEvent[]): void { /* reads nothing of the segmenter */ }

  reset(): void { /* keeps nothing between windows */ }
}
