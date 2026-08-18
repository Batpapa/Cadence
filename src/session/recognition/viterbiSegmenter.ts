import type { WindowResult, SessionAnnotation, AnnotationAlternate, AnnotationEvidence, AnnotationEvent } from '../model';
import { runViterbiDetection, filterShortSegments, mergeNearbySameTune, countTop1Windows, type DetectedTuneSegment } from './viterbiDetector';
import { buildTemporalTimeline, filterFlatWindows, filterByTempoSpread, UNKNOWN_STATE } from './temporalObservationBuilder';
import { DETECTION_TEMPORAL_CONFIG, type DetectionTemporalConfig } from './detectionTemporalConfig';

// ── Incremental adapter over the Viterbi detector ───────────────────────────
// runViterbiDetection() is a stateless global decode over the WHOLE recording;
// this wraps it for the worker's window-by-window feed (both live and import
// go through the exact same maybeAnalyzeLive() loop in ffWorker.ts — import is
// just "faster than real time", not a different code path). Re-runs the full
// decode over the FULL window history on every step — same "recompute is
// cheap enough, don't bound it" call the segmenter.ts-era IncrementalSegmenter
// this replaces made (2026-08-11 design discussion); see the 2026-08-14/15
// O(T×S) benchmark (T=5000, S=150 stays under 300ms per call) for why summing
// that across every step of even a multi-hour session is nowhere near a
// performance concern.
//
// UNKNOWN_STATE segments never become annotations — they represent silence,
// talk, or noise, not a tune.
//
// Segment identity across recomputes is re-derived every call (tuneId + time
// overlap against the previous pass) rather than tracked structurally, since
// Viterbi's own global re-optimization can nudge a segment's bounds slightly
// from one recompute to the next as more windows arrive — same reasoning as
// the old segmenter, which had the identical problem for a different reason
// (its 1-window smoothing lookahead).

function overlapsTime(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd;
}

function segEqual(a: DetectedTuneSegment, b: DetectedTuneSegment): boolean {
  return a.tuneId === b.tuneId && a.settingId === b.settingId
    && a.startTime === b.startTime && a.endTime === b.endTime
    && Math.abs(a.confidence - b.confidence) < 1e-9;
}

interface Tracked {
  id: string;
  seg: DetectedTuneSegment;
  finalized: boolean;
}

function computeAlternates(
  windows: WindowResult[],
  tuneId: string,
  start: number,
  end: number,
  cfg: DetectionTemporalConfig,
): AnnotationAlternate[] {
  const stats = new Map<string, { settingId: string; displayName: string; sum: number; count: number }>();
  for (const w of windows) {
    if (w.tWindowStart < start || w.tWindowStart >= end) continue;
    for (const c of w.candidates) {
      if (c.tuneId === tuneId) continue;
      const s = stats.get(c.tuneId);
      if (s) { s.sum += c.score; s.count++; }
      else stats.set(c.tuneId, { settingId: c.settingId, displayName: c.displayName, sum: c.score, count: 1 });
    }
  }
  return [...stats.entries()]
    .map(([id, s]) => ({ tuneId: id, settingId: s.settingId, displayName: s.displayName, meanScore: s.sum / s.count }))
    .sort((a, b) => b.meanScore - a.meanScore)
    .slice(0, cfg.maxAlternates);
}

function bucketOf(confidence: number, cfg: DetectionTemporalConfig): SessionAnnotation['bucket'] {
  if (confidence >= cfg.bucketHighConfidence) return 'high';
  if (confidence >= cfg.bucketMediumConfidence) return 'medium';
  return 'low';
}

export class IncrementalViterbiSegmenter {
  private windows: WindowResult[] = [];
  private tracked: Tracked[] = [];
  private readonly cfg: DetectionTemporalConfig;
  private readonly hopS: number;

  constructor(hopS: number, cfg: DetectionTemporalConfig = DETECTION_TEMPORAL_CONFIG) {
    this.hopS = hopS;
    this.cfg = cfg;
  }

  step(win: WindowResult): AnnotationEvent[] {
    this.windows.push(win);
    return this.recompute(false);
  }

  /** No more windows will ever arrive — everything still standing is final. */
  finalize(): AnnotationEvent[] {
    return this.recompute(true);
  }

  /** Feed many windows at once, recomputing only once at the end — for a
   *  one-shot replay (crash recovery, see recovery.ts) that only needs the
   *  FINAL result, not a live incremental event stream. Calling step() once
   *  per window instead would re-run the full recompute() T times (T growing
   *  each call) purely to produce intermediate events nobody reads — each
   *  individual call is cheap (see this class's header comment), but summed
   *  over a multi-thousand-window session that's O(T²) done back-to-back on
   *  the main thread, easily minutes of synchronous blocking instead of the
   *  one recompute() this actually needs. Produces byte-identical results to
   *  step()-ing through the same windows one at a time, since recompute() is
   *  a pure function of `this.windows` (fully present either way by the time
   *  finalize() is called) — `this.tracked` only affects which AnnotationEvent
   *  TYPE gets emitted (open/update vs close/retract), never which segments
   *  are detected. */
  feedAll(wins: WindowResult[]): AnnotationEvent[] {
    this.windows.push(...wins);
    return this.recompute(false);
  }

  private toAnnotation(id: string, seg: DetectedTuneSegment, openEnded: boolean, finalized: boolean): SessionAnnotation {
    const alternates = computeAlternates(this.windows, seg.tuneId, seg.startTime, seg.endTime, this.cfg);
    const evidence: AnnotationEvidence[] = [];
    for (const w of this.windows) {
      if (w.tWindowStart < seg.startTime || w.tWindowStart >= seg.endTime) continue;
      const c = w.candidates.find(cand => cand.tuneId === seg.tuneId);
      evidence.push({ t: w.tWindowStart, tEnd: w.tWindowStart + this.hopS, score: c?.score ?? 0, margin: 0 });
    }
    return {
      id,
      tuneId: seg.tuneId,
      settingId: seg.settingId,
      displayName: seg.displayName,
      dance: seg.dance,
      meter: seg.meter,
      start: seg.startTime,
      // Still the last thing Viterbi decided AND we might still hear more of
      // it — keep the "..." live-growing display. Once finalized (whether by
      // the lag heuristic or by session end) there's always a concrete end,
      // even for a segment that never technically closed.
      end: openEnded && !finalized ? null : seg.endTime,
      confidence: seg.confidence,
      bucket: bucketOf(seg.confidence, this.cfg),
      meanScore: seg.averageProbability,
      evidence,
      alternates,
      userConfirmed: false,
      liked: false,
      finalized,
    };
  }

  private recompute(forceFinalizeAll: boolean): AnnotationEvent[] {
    if (this.windows.length === 0) return [];
    const latestT = this.windows[this.windows.length - 1]!.tWindowEnd;

    // filterFlatWindows/filterByTempoSpread only shape what Viterbi sees as
    // evidence — evidence/alternates displayed to the user
    // (toAnnotation/computeAlternates below) still read from this.windows
    // unfiltered, since a flattened window's real raw scores are still
    // legitimate to show, just not to detect from. Order matters: the tempo
    // filter was A/B tested STACKED on top of the margin filter, not in
    // isolation — always margin first, then tempo.
    const marginFiltered = filterFlatWindows(this.windows, this.cfg.flatWindowTopN, this.cfg.flatWindowMarginThreshold);
    const detectionWindows = filterByTempoSpread(marginFiltered, this.cfg.tempoSpreadThreshold);
    const timeline = buildTemporalTimeline(detectionWindows, this.cfg);
    const result = runViterbiDetection(timeline, this.cfg);
    // exemptLastSegment = !forceFinalizeAll: while a session (live or
    // import) is still streaming windows in, the most recent segment is
    // shown even if still short (user call: fine if it later disappears) —
    // only once finalize() confirms no more windows are coming does a short
    // last segment get filtered like any other.
    const filteredSegments = filterShortSegments(result.segments, timeline, this.cfg.minSegmentWindows, !forceFinalizeAll);
    // Bridges a brief UNKNOWN drop between two occurrences of the same tune
    // (e.g. a couple of quiet/noisy windows mid-performance) into one
    // continuous segment, instead of reporting two separate detections.
    const segments = mergeNearbySameTune(filteredSegments, timeline, this.cfg.sameTuneMergeGapWindows);
    const lastSegment = segments[segments.length - 1] ?? null;
    const newSegments = segments.filter(s => s.tuneId !== UNKNOWN_STATE);

    const claimed = new Set<number>();
    const nextTracked: Tracked[] = [];
    const events: AnnotationEvent[] = [];

    for (const seg of newSegments) {
      let matchIdx = -1;
      for (let i = 0; i < this.tracked.length; i++) {
        if (claimed.has(i)) continue;
        const prev = this.tracked[i]!;
        if (prev.seg.tuneId === seg.tuneId && overlapsTime(prev.seg.startTime, prev.seg.endTime, seg.startTime, seg.endTime)) {
          matchIdx = i;
          break;
        }
      }
      // seg === lastSegment: reference equality is valid here — newSegments
      // is a filter() of result.segments, so surviving elements are the exact
      // same object references, not copies.
      const openEnded = seg === lastSegment;
      const finalized = forceFinalizeAll || (latestT - seg.endTime > this.cfg.finalizationLagSeconds);

      if (matchIdx < 0) {
        const annotation = this.toAnnotation(crypto.randomUUID(), seg, openEnded, finalized);
        events.push({ type: 'open', annotation });
        nextTracked.push({ id: annotation.id, seg, finalized });
        continue;
      }

      claimed.add(matchIdx);
      const prev = this.tracked[matchIdx]!;
      const justFinalized = finalized && !prev.finalized;
      if (prev.finalized || (segEqual(prev.seg, seg) && !justFinalized)) {
        // Nothing worth telling the UI about — carry the tracking forward
        // under the same id without rebuilding an annotation (skips the
        // alternates/evidence scan for the common "unchanged history" case).
        nextTracked.push({ id: prev.id, seg, finalized });
        continue;
      }

      const annotation = this.toAnnotation(prev.id, seg, openEnded, finalized);
      events.push({ type: justFinalized ? 'close' : 'update', annotation });
      nextTracked.push({ id: prev.id, seg, finalized });
    }

    // Previously-tracked, still-provisional segments that vanished entirely
    // this pass. A finalized entry is permanent and always reappears above;
    // this only ever concerns the non-finalized ones. Two different reasons
    // this can happen:
    // (a) Viterbi's own global re-optimization absorbed a REAL (>=
    // minSegmentWindows) segment into a neighbour — close it at its last
    // known bounds, finalized: the evidence backing it was genuine while it
    // stood, so it stays in the list rather than leaving a dangling open
    // annotation.
    // (b) it was only ever shown because it was the live tail (exempt from
    // minSegmentWindows in filterShortSegments) and never actually reached
    // the threshold before being superseded — RETRACT it entirely (2026-08-15,
    // explicit user call): a `close` still left a permanent, if unconfirmed,
    // stub sitting in the UI, which isn't good enough — a guess that never
    // got confirmed should disappear as if it had never been shown, not
    // linger looking like a real (if untrustworthy) result. Never retract an
    // id the orchestrator says the user has already confirmed, though — see
    // AnnotationEvent's doc.
    for (let i = 0; i < this.tracked.length; i++) {
      if (claimed.has(i)) continue;
      const prev = this.tracked[i]!;
      if (prev.finalized) continue;
      // timeline here is this call's (current, possibly larger) timeline —
      // safe to use for a segment captured on an earlier recompute's smaller
      // one: TemporalTimeline.ranks for a given window index is computed
      // purely from that window's own candidates, never affected by how many
      // other windows are in the array.
      const wasConfirmed = countTop1Windows(prev.seg.tuneId, prev.seg.firstWindowIndex, prev.seg.windowCount, timeline) >= this.cfg.minSegmentWindows;
      if (wasConfirmed) {
        events.push({ type: 'close', annotation: this.toAnnotation(prev.id, prev.seg, false, true) });
      } else {
        events.push({ type: 'retract', id: prev.id });
      }
    }

    this.tracked = nextTracked;
    return events;
  }
}
