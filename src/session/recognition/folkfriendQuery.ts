import { FolkFriendWASM } from '../../../vendor/folkfriend/folkfriend.js';
import type { PlayedPitch } from './playedPitch';
import { pitchClassesForDisplay } from './contourShift';
import { normalizeDisplayName } from '../../services/tuneDisplayName';
import { signedKeyOffset, type WindowCandidate } from '../model';
import { FF_TEMPO_MIN_BPM, FF_TEMPO_MAX_BPM, FF_QUERY_REPASS_SIZE, FF_MIN_QUERY_LENGTH } from '../sessionConfig';

// ── Querying the tune index ───────────────────────────────────────────────────
// FolkFriend's query engine, whichever decoder wrote the contour (windowEngine.ts):
// one pitch class a quaver, searched in every key against the index folded to
// pitch classes. Moved out of ffWorker.ts (2026-11-26) so that both engines ask
// it the same way.

export interface RawQueryRecord {
  setting_id: string;
  setting: { tune_id: string; meter: string; mode: string; abc: string; dance: string; contour: string };
  display_name: string;
  score: number;
  /** The key it was found in: semitones above the written key, 0-11. */
  transpose?: number;
  /** The tune's other aligned (setting, transposition 0-11, score), best first
   *  (2026-11-08) — read by PlayedPitch. */
  other_keys?: [string, number, number][];
}

/** Query the tune index with a contour; empty list when the query errors out. */
// The Viterbi detector builds a per-tune score timeline across the whole
// recording, so it needs more headroom than a single online winner would.
// Started at 20 (2026-08-11); dropped to 10 the same day once a real dump
// showed a noisy window can put 8 different tuneIds above threshold at once —
// more candidates just means more of them clear the floor, not more signal
// (minCandidateProbability + the Viterbi decode itself handle whatever gets
// through regardless, but there's no reason to feed either more noise than
// needed).
export const TOP_N_CANDIDATES = 10;

/** An instance set up to query as Cadence does: the tuned search (sessionConfig.ts,
 *  with the measurements), pitch classes, every key. Before its index is loaded:
 *  the index is folded as it arrives. */
export function configureForQuery(f: FolkFriendWASM): void {
  // The engine ships upstream defaults; Cadence's tuned values live in
  // sessionConfig.ts, with the measurements behind them.
  f.set_tempo_range(FF_TEMPO_MIN_BPM, FF_TEMPO_MAX_BPM);
  f.set_num_repass(FF_QUERY_REPASS_SIZE);
  f.set_min_query_length(FF_MIN_QUERY_LENGTH);
  f.set_pitch_class_mode();
  f.set_any_pitch(true);
}

/** The loaded index, asked for windows' candidates. */
export class TuneQuery {
  constructor(private readonly f: FolkFriendWASM, private readonly playedPitch: PlayedPitch) {}

  private candidates(raw: RawQueryRecord[], tuning: number | undefined): WindowCandidate[] {
    return raw.map(r => {
      const c: WindowCandidate = {
        tuneId: r.setting.tune_id,
        settingId: r.setting_id,
        displayName: normalizeDisplayName(r.display_name),
        dance: r.setting.dance,
        meter: r.setting.meter,
        score: r.score,
      };
      // Stored only when off the written key: most windows are not, and every
      // window of an analysis is kept.
      const transpose = signedKeyOffset(r.transpose ?? 0);
      if (transpose !== 0) c.transpose = transpose;
      this.playedPitch.annotate(c, r, tuning);
      return c;
    });
  }

  /** Candidate query (2026-08-18): plain `run_transcription_query()` — NOT the
   *  `_debug` variant. Same call as before this whole debug-instrumentation
   *  change: WASM-side truncation to 20 (lib.rs), then sliced to TOP_N_CANDIDATES
   *  below. The untruncated ~100-candidate `_debug` query was tried first and
   *  dropped (explicit user call, "c'est un peu beaucoup") — it roughly
   *  doubled per-window IndexedDB storage for no feature the 2026-08-17/18
   *  noise study actually needed (every feature there — margin,
   *  candidatesAbove20/30/40/50, sum_top5/10 — only ever looks at the top 10). */
  query(contour: string, tuning: number | undefined): WindowCandidate[] {
    const raw = JSON.parse(this.f.run_transcription_query(contour)) as RawQueryRecord[] | { error: string };
    if (!Array.isArray(raw)) return [];
    // cut before mapping: the played pitch reads the engine's settings of each tune
    return this.candidates(raw.slice(0, TOP_N_CANDIDATES), tuning);
  }

  /** `contour` queried against an index of these tunes alone (their settings and
   *  names read back from the loaded index, already folded to pitch classes —
   *  folding them again changes nothing), one candidate a tune. A short-lived
   *  instance: a few settings load in a few milliseconds. */
  shortlist(contour: string, tuneIds: string[], tuning: number | undefined): WindowCandidate[] {
    const settings: Record<string, unknown> = {}, aliases: Record<string, string[]> = {};
    for (const t of tuneIds) {
      const s = JSON.parse(this.f.settings_from_tune_id(t)) as Array<[string, unknown]> | { error: string };
      if (!Array.isArray(s)) continue;
      for (const [id, setting] of s) settings[id] = setting;
      const names = JSON.parse(this.f.aliases_from_tune_id(t)) as string[] | { error: string };
      aliases[t] = Array.isArray(names) && names.length ? names : [t];
    }
    if (!Object.keys(settings).length) return [];
    const mini = new FolkFriendWASM();
    try {
      configureForQuery(mini);
      mini.load_index_from_json_obj({ settings, aliases });
      const raw = JSON.parse(mini.run_transcription_query(contour)) as RawQueryRecord[] | { error: string };
      if (!Array.isArray(raw)) return [];
      const seen = new Set<string>();
      return this.candidates(raw.filter(r => !seen.has(r.setting.tune_id) && !!seen.add(r.setting.tune_id)), tuning);
    } finally {
      mini.free();
    }
  }

  /** The contour written as ABC, for display; null when it cannot be. */
  abcOf(contour: string): string | null {
    try { return this.f.contour_to_abc(pitchClassesForDisplay(contour)); } catch { return null; }
  }
}
