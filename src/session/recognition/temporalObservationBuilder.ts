import type { WindowResult } from '../model';
import type { DetectionTemporalConfig } from './detectionTemporalConfig';

// ── Temporal observation builder ────────────────────────────────────────────
// RecognitionResult (WindowResult[]) -> TemporalTimeline. Pure, no DP here —
// just reshapes "N windows, each with up to N candidates" into "one row per
// candidate tuneId", which is what viterbiDetector.ts's Viterbi sweep needs. A
// tune absent from a window reads as probability 0 there — see the 2026-08-13
// spec's section 2 ("un morceau absent du top 100 doit être considéré comme
// ayant une probabilité de 0" — NOT simply ignored). Stored SPARSE since
// 2026-09-13: see SparseRow.

export const UNKNOWN_STATE = '__UNKNOWN__';

export interface TuneMeta {
  settingId: string;
  displayName: string;
  dance: string;
  meter: string;
}

/** One admitted tune's history: the windows it was a candidate in, ascending,
 *  as parallel arrays — `t[k]` is a window index, `score[k]` its probability
 *  there, `rank[k]` its 1-based position in that window's candidate list.
 *
 *  Sparse since 2026-09-13. The dense form held one probability AND one rank
 *  per (window × admitted tune): 42,4 M cells over the ranking-study corpus,
 *  662 MB retained, to record about ten candidates per window — 0,27% of the
 *  cells. The measured throughput ceiling of the study (6 processes on 20
 *  cores, saturated on memory bandwidth) came from exactly that. Readers go
 *  through `observationAt` and `rowStartAt`, which give the dense reading
 *  back: 0 wherever the tune was not a candidate, and no rank there.
 *
 *  At most one entry per window. Should a window ever list the same tune twice
 *  — FolkFriend's output is deduplicated by tuneId, and three real fixtures
 *  show no duplicate — the LATER entry replaces the earlier one, which is what
 *  the dense writer did by overwriting its cell. */
export interface SparseRow {
  t: number[];
  score: number[];
  rank: number[];
}

export interface TemporalTimeline {
  windows: WindowResult[];
  /** The filtered global candidate set — every real tuneId Viterbi will
   *  consider as a state, across the WHOLE recording (not per-window). */
  tuneIds: string[];
  /** Best-scoring incarnation's metadata seen for each tuneId (settingId can
   *  drift between settings of the same tune window to window). */
  meta: Map<string, TuneMeta>;
  /** One row per admitted tune — exactly the tuneIds, no more. `rows.has` is
   *  therefore the "was this tune ever admitted" test the dense maps' `has`
   *  used to be. */
  rows: Map<string, SparseRow>;
  /** Window index at which each tune entered the state space — its first
   *  candidate score at or above minCandidateProbability. OPTIONAL: when absent,
   *  the decoder derives it from `rows` with the config's own threshold, which
   *  is exactly what both builders here admit on. Only a caller whose rows no
   *  longer hold raw scores (the ranking-study harness rewrites them) needs to
   *  pass it explicitly. See viterbiDetector.ts's admissionIndex for why the
   *  decoder needs it at all. */
  admittedAt?: Map<string, number>;
}

/** Index of the first entry at or after window `t` (`row.t.length` if none). */
export function rowStartAt(row: SparseRow, t: number): number {
  let lo = 0, hi = row.t.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (row.t[mid]! < t) lo = mid + 1; else hi = mid;
  }
  return lo;
}

/** Probability of `tuneId` at window `t`: 0 where it was not a candidate, as
 *  the dense array read. An unadmitted tune also reads 0; a caller that must
 *  tell "never admitted" from "absent this window" checks `rows.has` first. */
export function observationAt(tl: TemporalTimeline, tuneId: string, t: number): number {
  const row = tl.rows.get(tuneId);
  if (!row) return 0;
  const k = rowStartAt(row, t);
  return k < row.t.length && row.t[k] === t ? row.score[k]! : 0;
}

/** Appends window `t`'s entry — or replaces it, if the row already ends at `t`
 *  (the duplicate-in-window case described on SparseRow). Rows are only ever
 *  written in ascending window order, which keeps them sorted. */
function pushRowEntry(row: SparseRow, t: number, score: number, rank: number): void {
  const n = row.t.length;
  if (n > 0 && row.t[n - 1] === t) { row.score[n - 1] = score; row.rank[n - 1] = rank; return; }
  row.t.push(t); row.score.push(score); row.rank.push(rank);
}

// ── Pre-Viterbi flat-window filter (2026-08-17, wired into production 2026-08-18) ──
// Applied to raw WindowResult[] BEFORE buildTemporalTimeline sees them: a
// window whose top-1 candidate doesn't beat its own topN-th candidate by at
// least marginThreshold is "flat" — FolkFriend has no clear opinion this
// window (many stylistically unrelated tunes near-tied, the hallmark of
// noise found in the 2026-08-17 signature analysis, see project memory).
// A flat window is stripped of all candidates so it contributes NO evidence
// for or against any tune — same effect as FolkFriend reporting nothing that
// window. Windows with fewer than topN candidates are left untouched (not
// enough data to judge flatness). Pure, does not mutate input.
// Called from viterbiSegmenter.ts::recompute() with
// cfg.flatWindowTopN/cfg.flatWindowMarginThreshold — see
// detectionTemporalConfig.ts for the A/B-tested values and why topN=3 (not
// the initially-tried topN=2).
export function filterFlatWindows(windows: WindowResult[], topN: number, marginThreshold: number): WindowResult[] {
  return windows.map(w => {
    if (w.candidates.length < topN) return w;
    const gap = w.candidates[0].score - w.candidates[topN - 1].score;
    if (gap >= marginThreshold) return w;
    return { ...w, candidates: [], empty: true };
  });
}

// ── Pre-Viterbi tempo-spread filter (2026-08-18, wired into production same day) ──
// Applied AFTER filterFlatWindows, same idea, different signal: the noise
// study found that known recurring false-positive attractors (romanian
// fantasy, michael's lament, ...) match almost EQUALLY well regardless of
// which of the 36 tempo candidates (60-240 BPM) is tried — a "tempo-agnostic"
// contour, which real tunes essentially never are. `tempo_score_std` (std dev
// of combined_score across all 36 tempo candidates, from
// WindowResult.debug.features.tempo_candidates) captures exactly this. A
// window whose spread is below threshold is stripped of all candidates, same
// "contributes no evidence" effect as filterFlatWindows. Windows without
// debug tempo data (any window from before the WASM was updated to export
// it, or any window where FolkFriend found too few notes to try tempos at
// all) are left untouched — NOT flattened just because the data is missing.
// Called from viterbiSegmenter.ts::recompute() with cfg.tempoSpreadThreshold
// — see detectionTemporalConfig.ts for the A/B-tested value.
export function filterByTempoSpread(windows: WindowResult[], threshold: number): WindowResult[] {
  return windows.map(w => {
    const tempoCandidates = w.debug?.features?.tempo_candidates;
    if (!tempoCandidates || tempoCandidates.length === 0) return w;
    const scores = tempoCandidates.map(t => t.combined_score);
    const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
    const variance = scores.reduce((a, b) => a + (b - mean) ** 2, 0) / scores.length;
    const std = Math.sqrt(variance);
    if (std >= threshold) return w;
    return { ...w, candidates: [], empty: true };
  });
}

// ── Incremental timeline builder (2026-08-24) ───────────────────────────────
// buildTemporalTimeline above is O(T·S) PER CALL — fine once, but
// viterbiSegmenter.ts's recompute() used to call it (plus the two filters)
// on the WHOLE window history on every single new window, i.e. O(T²·S)
// summed over a session — and since S (distinct tuneIds ever seen) grows
// ~linearly with T in practice (measured: 1476 states/955 windows, 1960/1059
// — S > T), the real cost trends toward O(T³). Measured before/after on a
// real 955→1059-window fixture: recompute() cost 9.6s→20.75s, i.e. far
// steeper than quadratic. IncrementalTimelineBuilder produces a
// byte-identical TemporalTimeline to buildTemporalTimeline(sameWindows, cfg)
// at every step, amortized O(T·S) over a whole session — see
// temporalTimelineStreamingEquivalence.test.ts for the equivalence oracle
// that proves this (same role as viterbiStreamingEquivalence.test.ts for
// StreamingViterbiDecoder — no dev-only shadow-assert here either, on the
// same 2026-08-25 precedent: an always-on from-scratch comparison this cheap
// per call is still O(t·S) per call, i.e. exactly the quadratic blowup this
// class exists to eliminate, just moved into dev mode instead of removed).
//
// Correctness rests on properties buildTemporalTimeline already has:
//  1. filterFlatWindows/filterByTempoSpread are pure per-window (window t's
//     filtered form depends only on window t) — so a window's filtered shape
//     is fixed forever the instant it's produced; filtering one new raw
//     window in isolation (via a length-1 array) is provably identical to
//     filtering it as part of the full array, since neither filter looks at
//     neighbours.
//  2. tuneIds must be in FIRST-APPEARANCE order (buildTemporalTimeline's
//     maxProbSeen is a Map, whose insertion order IS first-appearance order,
//     independent of when a tuneId's score happens to clear
//     minCandidateProbability) — NOT the order in which tuneIds cross the
//     threshold. Getting this wrong reorders tuneIds, which changes the
//     Viterbi decoder's tie-break order (pickBest/stateIndex) and breaks
//     equivalence even though every individual score is still correct. Kept
//     straight here via `firstSeenOrder` (append-only, on first sight
//     regardless of score) separately from `cleared` (append-only, on
//     crossing minCandidateProbability) — tuneIds is always
//     firstSeenOrder ∩ cleared, in firstSeenOrder's order.
//  3. maxProbSeen only ever increases (best-ever, not "current"), so a tuneId
//     that scores weak early and strong later must NOT be dropped, and its
//     row must contain its REAL pre-crossing history (buildTemporalTimeline
//     reconstructs this for free by scanning the whole recording at once; the
//     incremental builder must reconstruct it explicitly, since by the time a
//     tuneId crosses, its earlier appearances already happened and can't be
//     "replayed" from the current window alone). `appearances` (a sparse,
//     append-only, per-tuneId log of every window it was ever a candidate in)
//     exists exactly for this: when a tuneId crosses at window t, its row is
//     built from this log, not by rescanning `filteredWindows`. Each tuneId is
//     backfilled at most once (the moment it crosses), so the total backfill
//     cost across a session is bounded by the number of appearances.
//
// Since 2026-09-13 both builders are sparse (see SparseRow): a from-scratch
// build costs O(total candidates), a push O(candidates in that window). The
// O(T·S) figures above describe the dense form this replaced, and stay as the
// record of why this class exists.
export class IncrementalTimelineBuilder {
  private readonly cfg: DetectionTemporalConfig;
  private readonly filteredWindows: WindowResult[] = [];
  private readonly maxProbSeen = new Map<string, number>();
  private readonly meta = new Map<string, TuneMeta>();
  private readonly firstSeenOrder: string[] = [];
  private readonly firstSeenSet = new Set<string>();
  private readonly cleared = new Set<string>();
  private readonly appearances = new Map<string, { t: number; score: number; rank: number }[]>();
  /** Rows of the CLEARED tunes only, one per entry of tuneIds — see SparseRow. */
  private readonly rows = new Map<string, SparseRow>();
  private tuneIds: string[] = [];

  constructor(cfg: DetectionTemporalConfig) {
    this.cfg = cfg;
  }

  /** Number of raw windows fed so far — lets a caller catch up a builder that
   *  may have already processed a prefix (e.g. viterbiSegmenter.ts's
   *  recompute(), called again with no new windows by finalize()). */
  get length(): number {
    return this.filteredWindows.length;
  }

  /** The current TemporalTimeline view, without processing anything new —
   *  same object identity as the last push()'s return value. */
  current(): TemporalTimeline {
    return { windows: this.filteredWindows, tuneIds: this.tuneIds, meta: this.meta, rows: this.rows };
  }

  /** Feeds ONE new raw window (must be the NEXT one after every window fed so
   *  far — this class has no notion of out-of-order or repeated windows) and
   *  returns the up-to-date TemporalTimeline. */
  push(rawWindow: WindowResult): TemporalTimeline {
    const [afterMargin] = filterFlatWindows([rawWindow], this.cfg.flatWindowTopN, this.cfg.flatWindowMarginThreshold);
    const [fw] = filterByTempoSpread([afterMargin!], this.cfg.tempoSpreadThreshold);
    const t = this.filteredWindows.length;
    this.filteredWindows.push(fw!);

    // No per-window growth any more: a row records only the windows its tune
    // was a candidate in, so a cleared tune absent from this window costs
    // nothing here. (The dense form appended a 0 and a null to every cleared
    // tune on every push — O(|cleared|) per window, O(T·S) over a session.)

    const newlyCleared: string[] = [];
    fw!.candidates.forEach((c, idx) => {
      const rank = idx + 1;
      if (!this.firstSeenSet.has(c.tuneId)) {
        this.firstSeenSet.add(c.tuneId);
        this.firstSeenOrder.push(c.tuneId);
      }
      let log = this.appearances.get(c.tuneId);
      if (!log) { log = []; this.appearances.set(c.tuneId, log); }
      log.push({ t, score: c.score, rank });

      const prevMax = this.maxProbSeen.get(c.tuneId) ?? -Infinity;
      if (c.score > prevMax) {
        this.maxProbSeen.set(c.tuneId, c.score);
        this.meta.set(c.tuneId, { settingId: c.settingId, displayName: c.displayName, dance: c.dance, meter: c.meter });
      }

      if (this.cleared.has(c.tuneId)) {
        // Already cleared before this window — this window joins its row.
        pushRowEntry(this.rows.get(c.tuneId)!, t, c.score, rank);
      } else if (this.maxProbSeen.get(c.tuneId)! >= this.cfg.minCandidateProbability) {
        // Crosses the threshold for the first time THIS window — maxProbSeen
        // only ever increases, so this is the only place a crossing can ever
        // be detected (never missed, never a duplicate detection later).
        newlyCleared.push(c.tuneId);
      }
    });

    // Build each newly-cleared tuneId's row from its appearance log — which
    // includes THIS window, logged above. Replayed through pushRowEntry, so a
    // window logged twice keeps its later entry, exactly as the dense
    // backfill's `obsArr[a.t] = a.score` overwrite did.
    for (const id of newlyCleared) {
      const row: SparseRow = { t: [], score: [], rank: [] };
      for (const a of this.appearances.get(id)!) pushRowEntry(row, a.t, a.score, a.rank);
      this.rows.set(id, row);
      this.cleared.add(id);
    }

    this.tuneIds = this.firstSeenOrder.filter(id => this.cleared.has(id));

    return this.current();
  }
}

/** Dev/test-only helper (not used on any hot path): first mismatch between
 *  two TemporalTimelines built over the SAME windows, or null if they agree
 *  — tuneIds (values AND order — see IncrementalTimelineBuilder's doc on why
 *  order matters), meta, the window count, and every tuneId's sparse row (all
 *  three arrays). Used by temporalTimelineStreamingEquivalence.test.ts, the
 *  same role describeViterbiDivergence plays for the streaming Viterbi
 *  decoder. */
export function describeTimelineDivergence(a: TemporalTimeline, b: TemporalTimeline): string | null {
  // The dense rows carried T in their length, so comparing them compared the
  // window count too. A sparse row does not, so it is checked on its own.
  if (a.windows.length !== b.windows.length) {
    return `windows: a=${a.windows.length} b=${b.windows.length}`;
  }
  if (a.tuneIds.length !== b.tuneIds.length || a.tuneIds.some((id, i) => id !== b.tuneIds[i])) {
    return `tuneIds: a=${JSON.stringify(a.tuneIds)} b=${JSON.stringify(b.tuneIds)}`;
  }
  for (const id of a.tuneIds) {
    const am = a.meta.get(id), bm = b.meta.get(id);
    if (JSON.stringify(am) !== JSON.stringify(bm)) {
      return `meta[${id}]: a=${JSON.stringify(am)} b=${JSON.stringify(bm)}`;
    }
    // Equal sparse rows <=> equal dense arrays: an absent window is 0/null on
    // both sides, and a present window always carries a rank — so a candidate
    // scoring exactly 0 is still told apart from an absent one.
    const ar = a.rows.get(id), br = b.rows.get(id);
    if (!ar || !br || !sameNumbers(ar.t, br.t) || !sameNumbers(ar.score, br.score) || !sameNumbers(ar.rank, br.rank)) {
      return `rows[${id}]: a=${JSON.stringify(ar)} b=${JSON.stringify(br)}`;
    }
  }
  return null;
}

function sameNumbers(x: number[], y: number[]): boolean {
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

export function buildTemporalTimeline(windows: WindowResult[], cfg: DetectionTemporalConfig): TemporalTimeline {

  // Pass 1: global candidate set = every tuneId whose best-ever probability
  // in this recording clears minCandidateProbability. A tune that's
  // sometimes weak but later strong must NOT be dropped — hence "best-ever",
  // not "first window" or "average".
  const maxProbSeen = new Map<string, number>();
  const meta = new Map<string, TuneMeta>();
  for (const w of windows) {
    for (const c of w.candidates) {
      if ((maxProbSeen.get(c.tuneId) ?? -Infinity) < c.score) {
        maxProbSeen.set(c.tuneId, c.score);
        meta.set(c.tuneId, { settingId: c.settingId, displayName: c.displayName, dance: c.dance, meter: c.meter });
      }
    }
  }
  const tuneIds = [...maxProbSeen.entries()]
    .filter(([, p]) => p >= cfg.minCandidateProbability)
    .map(([id]) => id);

  // Pass 2: one sparse row per admitted tune, written in window order.
  const rows = new Map<string, SparseRow>();
  for (const id of tuneIds) rows.set(id, { t: [], score: [], rank: [] });
  windows.forEach((w, t) => {
    w.candidates.forEach((c, idx) => {
      const row = rows.get(c.tuneId);
      if (!row) return; // filtered out of the global candidate set
      pushRowEntry(row, t, c.score, idx + 1);
    });
  });

  return { windows, tuneIds, meta, rows };
}
