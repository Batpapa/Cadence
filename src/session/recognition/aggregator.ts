import type { SessionAnnotation, WindowResult, WindowCandidate, ConfidenceBucket } from '../model';
import { AGG_CONFIG, type AggConfig } from './aggregatorConfig';

// ── Recognition aggregator ────────────────────────────────────────────────────
// Pure state machine: window results in, annotation events out.
// No DOM, no WASM, no I/O — unit-tested in isolation.

export type AnnotationEvent =
  | { type: 'open'; annotation: SessionAnnotation }
  | { type: 'update'; annotation: SessionAnnotation }
  | { type: 'close'; annotation: SessionAnnotation };

interface Evidence { t: number; tEnd: number; score: number; margin: number }

/** Span of an analysis window that did NOT go to the elected tune (empty or rival). */
interface Span { t0: number; t1: number }

/** Overlap vote for the end bound of a closing annotation. Every analysis
 *  window covering an instant is one voter; returns the latest instant where
 *  windows won by the elected tune are not outnumbered — with a 5 s hop each
 *  instant is covered by ~3 windows, so one junk window at the tail cannot
 *  truncate the annotation on its own. Never returns less than `floor` (the
 *  legacy bound: start of the closing empty/rival run), so sparse pub
 *  recognition keeps its calibrated behaviour. */
function voteEnd(wins: Evidence[], nonWins: Span[], floor: number, cap?: number): number {
  const bounds = new Set<number>();
  for (const w of wins) { bounds.add(w.t); bounds.add(w.tEnd); }
  for (const s of nonWins) { bounds.add(s.t0); bounds.add(s.t1); }
  const sorted = [...bounds].sort((a, b) => a - b);

  let best = floor;
  for (let i = sorted.length - 2; i >= 0; i--) {
    const mid = (sorted[i]! + sorted[i + 1]!) / 2;
    const won = wins.filter(e => e.t <= mid && mid < e.tEnd).length;
    if (won === 0) continue;
    const lost = nonWins.filter(s => s.t0 <= mid && mid < s.t1).length;
    if (won >= lost) { best = sorted[i + 1]!; break; }
  }
  const capped = cap === undefined ? best : Math.min(best, cap);
  return Math.max(floor, capped);
}

/** Per-tune stats accumulated over the lifetime of an annotation, for alternates. */
interface AltStats { settingId: string; displayName: string; sum: number; count: number }

interface CandidateState {
  kind: 'candidate';
  tune: WindowCandidate;
  hits: number;
  firstSeen: number;
  emptyStreak: number;
  evidence: Evidence[];
}

interface ConfirmedState {
  kind: 'confirmed';
  tune: WindowCandidate;       // best-scoring incarnation seen so far (settingId may improve)
  annotationId: string;
  start: number;
  evidence: Evidence[];        // windows won by the elected tune
  windowsCovered: number;      // non-empty windows since open
  nonWins: Span[];             // empty/rival windows since open — end-vote input
  altStats: Map<string, AltStats>;
  emptyStreak: number;
  /** First moment after the last elected win (start of empties/rival evidence):
   *  the floor of the end vote whenever the annotation closes. The vote may
   *  extend past it while overlapping wins hold parity, never regress below —
   *  keeps end timestamps sane even with large close-hysteresis values. */
  endCandidate: number | null;
  rival: { tune: WindowCandidate; streak: number; firstSeen: number; evidence: Evidence[] } | null;
}

type AggState = { kind: 'idle' } | CandidateState | ConfirmedState;

export class RecognitionAggregator {
  private state: AggState = { kind: 'idle' };
  private readonly cfg: AggConfig;

  constructor(cfg: AggConfig = AGG_CONFIG) {
    this.cfg = cfg;
  }

  /** Feed one analysis window; returns the annotation events it triggered. */
  step(win: WindowResult): AnnotationEvent[] {
    const top = win.candidates[0];
    const isEmpty = win.empty || !top || top.score < this.cfg.SCORE_FLOOR;
    if (isEmpty) return this.onEmpty(win);
    return this.onWin(win, top!);
  }

  /** Close any open annotation at end of session. Unconfirmed candidates are dropped. */
  finalize(tEnd: number): AnnotationEvent[] {
    if (this.state.kind !== 'confirmed') { this.state = { kind: 'idle' }; return []; }
    const s = this.state;
    const annotation = this.buildAnnotation(s, voteEnd(s.evidence, s.nonWins, s.endCandidate ?? tEnd, tEnd));
    this.state = { kind: 'idle' };
    return [{ type: 'close', annotation }];
  }

  // ── Transitions ─────────────────────────────────────────────────────────────

  private onEmpty(win: WindowResult): AnnotationEvent[] {
    const s = this.state;
    if (s.kind === 'idle') return [];

    if (s.kind === 'candidate') {
      s.emptyStreak++;
      if (s.emptyStreak >= this.cfg.K_EMPTY_CANDIDATE_RESET) this.state = { kind: 'idle' };
      return [];
    }

    // confirmed
    s.endCandidate ??= win.tWindowStart;
    s.nonWins.push({ t0: win.tWindowStart, t1: win.tWindowEnd });
    s.emptyStreak++;
    if (s.emptyStreak >= this.cfg.K_EMPTY_CLOSE) {
      const annotation = this.buildAnnotation(s, voteEnd(s.evidence, s.nonWins, s.endCandidate));
      this.state = { kind: 'idle' };
      return [{ type: 'close', annotation }];
    }
    return [];
  }

  private onWin(win: WindowResult, top: WindowCandidate): AnnotationEvent[] {
    const margin = top.score - (win.candidates[1]?.score ?? 0);
    const s = this.state;

    if (s.kind === 'idle') {
      this.state = {
        kind: 'candidate',
        tune: top,
        hits: 1,
        firstSeen: win.tWindowStart,
        emptyStreak: 0,
        evidence: [{ t: win.tWindowStart, tEnd: win.tWindowEnd, score: top.score, margin }],
      };
      return [];
    }

    if (s.kind === 'candidate') {
      s.emptyStreak = 0;
      if (top.tuneId === s.tune.tuneId) {
        s.hits++;
        s.evidence.push({ t: win.tWindowStart, tEnd: win.tWindowEnd, score: top.score, margin });
        if (top.score > s.tune.score) s.tune = top;
        if (s.hits >= this.cfg.K_CONFIRM) {
          const confirmed: ConfirmedState = {
            kind: 'confirmed',
            tune: s.tune,
            annotationId: crypto.randomUUID(),
            start: s.firstSeen,
            evidence: s.evidence,
            windowsCovered: s.hits,
            nonWins: [],
            altStats: new Map(),
            emptyStreak: 0,
            endCandidate: null,
            rival: null,
          };
          this.accumulateAlternates(confirmed, win.candidates);
          this.state = confirmed;
          return [{ type: 'open', annotation: this.buildAnnotation(confirmed, null) }];
        }
        return [];
      }
      // different winner: restart candidacy on the new tune
      this.state = {
        kind: 'candidate',
        tune: top,
        hits: 1,
        firstSeen: win.tWindowStart,
        emptyStreak: 0,
        evidence: [{ t: win.tWindowStart, tEnd: win.tWindowEnd, score: top.score, margin }],
      };
      return [];
    }

    // confirmed
    s.emptyStreak = 0;
    s.windowsCovered++;
    this.accumulateAlternates(s, win.candidates);

    // Ambiguity guard: if the elected tune sits within MARGIN_MIN of the top-1
    // score, treat the window as a win for the elected tune (anti-flapping on
    // reel families that share phrases).
    const elected = win.candidates.find(c => c.tuneId === s.tune.tuneId);
    const effectiveWinner = (top.tuneId !== s.tune.tuneId && elected && top.score - elected.score < this.cfg.MARGIN_MIN)
      ? elected : top;

    if (effectiveWinner.tuneId === s.tune.tuneId) {
      s.evidence.push({ t: win.tWindowStart, tEnd: win.tWindowEnd, score: effectiveWinner.score, margin });
      if (effectiveWinner.score > s.tune.score) s.tune = effectiveWinner;
      s.rival = null;
      s.endCandidate = null; // the elected tune is still playing
      return [{ type: 'update', annotation: this.buildAnnotation(s, null) }];
    }

    // A rival won this window
    s.endCandidate ??= win.tWindowStart;
    s.nonWins.push({ t0: win.tWindowStart, t1: win.tWindowEnd });
    if (s.rival && s.rival.tune.tuneId === effectiveWinner.tuneId) {
      s.rival.streak++;
      s.rival.evidence.push({ t: win.tWindowStart, tEnd: win.tWindowEnd, score: effectiveWinner.score, margin });
      if (effectiveWinner.score > s.rival.tune.score) s.rival.tune = effectiveWinner;
    } else {
      s.rival = {
        tune: effectiveWinner,
        streak: 1,
        firstSeen: win.tWindowStart,
        evidence: [{ t: win.tWindowStart, tEnd: win.tWindowEnd, score: effectiveWinner.score, margin }],
      };
    }

    if (s.rival.streak >= this.cfg.K_SWITCH) {
      // Set segmentation: close the current tune (at the start of the lull
      // that preceded the rival, when there was one), open the rival confirmed.
      const closed = this.buildAnnotation(s, voteEnd(s.evidence, s.nonWins, s.endCandidate ?? s.rival.firstSeen, s.rival.firstSeen));
      const next: ConfirmedState = {
        kind: 'confirmed',
        tune: s.rival.tune,
        annotationId: crypto.randomUUID(),
        start: s.rival.firstSeen,
        evidence: s.rival.evidence,
        windowsCovered: s.rival.evidence.length,
        nonWins: [],
        altStats: new Map(),
        emptyStreak: 0,
        endCandidate: null,
        rival: null,
      };
      this.accumulateAlternates(next, win.candidates);
      this.state = next;
      return [
        { type: 'close', annotation: closed },
        { type: 'open', annotation: this.buildAnnotation(next, null) },
      ];
    }
    return [];
  }

  // ── Annotation construction ─────────────────────────────────────────────────

  private accumulateAlternates(s: ConfirmedState, candidates: WindowCandidate[]): void {
    for (const c of candidates) {
      const existing = s.altStats.get(c.tuneId);
      if (existing) {
        existing.sum += c.score;
        existing.count++;
      } else {
        s.altStats.set(c.tuneId, { settingId: c.settingId, displayName: c.displayName, sum: c.score, count: 1 });
      }
    }
  }

  private buildAnnotation(s: ConfirmedState, end: number | null): SessionAnnotation {
    const scores  = s.evidence.map(e => e.score);
    const margins = s.evidence.map(e => e.margin);
    const mean = (xs: number[]) => xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;

    const winRatio     = s.windowsCovered === 0 ? 0 : Math.min(1, s.evidence.length / s.windowsCovered);
    const marginFactor = Math.min(1, Math.max(0.5, 0.5 + 2 * mean(margins)));
    const confidence   = winRatio * mean(scores) * marginFactor;

    const alternates = [...s.altStats.entries()]
      .filter(([tuneId]) => tuneId !== s.tune.tuneId)
      .map(([tuneId, st]) => ({ tuneId, settingId: st.settingId, displayName: st.displayName, meanScore: st.sum / st.count }))
      .sort((a, b) => b.meanScore - a.meanScore)
      .slice(0, this.cfg.MAX_ALTERNATES);

    return {
      id: s.annotationId,
      tuneId: s.tune.tuneId,
      settingId: s.tune.settingId,
      displayName: s.tune.displayName,
      dance: s.tune.dance,
      meter: s.tune.meter,
      start: s.start,
      end,
      confidence,
      bucket: this.bucketOf(confidence),
      evidence: [...s.evidence],
      alternates,
      userConfirmed: false,
    };
  }

  private bucketOf(confidence: number): ConfidenceBucket {
    if (confidence >= this.cfg.BUCKET_HIGH) return 'high';
    if (confidence >= this.cfg.BUCKET_MEDIUM) return 'medium';
    return 'low';
  }
}
