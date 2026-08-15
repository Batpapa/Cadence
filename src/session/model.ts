// ── Session recording & recognition data model ───────────────────────────────
// Tune IDs are TheSession.org tune IDs (same space as Card.externalId "thesession:{id}").

export type ConfidenceBucket = 'high' | 'medium' | 'low';

export interface AnnotationEvidence {
  t: number;      // window start, seconds since session start
  tEnd?: number;  // window end — absent on annotations persisted before the end-vote (2026-07)
  score: number;  // top-1 Needleman-Wunsch score [0,1]
  margin: number; // top-1 − top-2 score
}

export interface AnnotationAlternate {
  tuneId: string;
  settingId: string;
  displayName: string;
  meanScore: number;
}

export interface SessionAnnotation {
  id: string;
  tuneId: string;      // TheSession tune ID
  settingId: string;
  displayName: string;
  dance: string;       // reel, jig, …
  meter: string;
  /** Seconds since session start covered by the OBSERVATION WINDOWS that led
   *  to this detection (see DetectedTuneSegment's doc in viterbiDetector.ts)
   *  — not necessarily the exact instant the tune actually started/stopped.
   *  Analysis windows overlap each other by design, so this annotation's
   *  range can and does legitimately overlap the next annotation's — that
   *  overlap is real signal (a transition/uncertainty zone), not a bug to be
   *  trimmed away. */
  start: number;
  end: number | null;  // null = still open (live)
  confidence: number;  // [0,1] — consistency-weighted (win rate over the annotation's span), NOT comparable to alternates' meanScore below
  bucket: ConfidenceBucket;
  /** Mean raw match score whenever this tune appeared as a window candidate —
   *  same metric as `alternates[].meanScore`, so the two are directly comparable
   *  in the detection-options panel (unlike `confidence`, which only this tune has). */
  meanScore: number;
  evidence: AnnotationEvidence[];
  alternates: AnnotationAlternate[];
  userConfirmed: boolean;
  /** User marker: "I liked this tune when I heard it" — has no bearing on
   *  recognition or on any card, purely a personal reminder. */
  liked: boolean;
  /** false while the Viterbi detector could still revise this annotation's
   *  bounds or existence as more windows arrive (see viterbiSegmenter.ts) —
   *  the UI gates destructive/committing actions (delete, merge, attach, SRS
   *  logging) on this. Always true for file imports (all windows are known
   *  upfront) and for annotations persisted before this field existed
   *  (read as `ann.finalized ?? true`, no migration). */
  finalized: boolean;
}

/** Emitted by the recognition pipeline (viterbiSegmenter.ts's
 *  IncrementalViterbiSegmenter) as annotations are created/revised/settled —
 *  the session orchestrators (liveSession.ts, importSession.ts) merge these
 *  into their annotation map. */
export type AnnotationEvent =
  | { type: 'open'; annotation: SessionAnnotation }
  | { type: 'update'; annotation: SessionAnnotation }
  | { type: 'close'; annotation: SessionAnnotation }
  /** A provisional annotation that was shown (opened) while it was still the
   *  live tail (see minSegmentWindows in detectionTemporalConfig.ts) but
   *  never actually reached the confirmation threshold before being
   *  superseded — remove it from the annotation list entirely, as if it had
   *  never appeared (2026-08-15: `close` with `finalized:false` still left a
   *  permanent, if unconfirmed, entry sitting in the UI — the user explicitly
   *  wants it gone, not just marked unreliable). Orchestrators should ignore
   *  this for an id the user has already `userConfirmed` — an explicit user
   *  choice must never be silently erased. */
  | { type: 'retract'; id: string };

export interface RecordedSession {
  id: string;
  name: string;
  /** ISO timestamp of the session's t=0. Live recordings set it to the
   *  recording start; file imports start with null (file mtime is unreliable).
   *  Editable and erasable in the summary screen — review logging requires it. */
  date: string | null;
  duration: number;    // seconds
  mimeType: string;
  /** 'live' = mic recording; 'import' = user-provided audio file (stored as-is). */
  source: 'live' | 'import';
  /** 'recording' = draft written while a live recording is still in progress
   *  (crash/refresh recovery); absent once the session is finalized. */
  status?: 'recording' | 'done';
  annotations: SessionAnnotation[];
  // The audio Blob lives in IndexedDB under the session id (see session db).
}

// ── Recognition window results (worker → Viterbi detector) ─────────────────────

export interface WindowCandidate {
  tuneId: string;
  settingId: string;
  displayName: string;
  dance: string;
  meter: string;
  score: number;
}

export interface WindowResult {
  tWindowStart: number; // seconds since session start
  tWindowEnd: number;
  empty: boolean;       // no notes detected, or nothing above SCORE_FLOOR
  candidates: WindowCandidate[]; // sorted desc by score, deduplicated by tuneId
}
