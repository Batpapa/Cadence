// ── Session recording & recognition data model ───────────────────────────────
// Tune IDs are TheSession.org tune IDs (same space as Card.externalId "thesession:{id}").

export type ConfidenceBucket = 'high' | 'medium' | 'low';

export interface AnnotationEvidence {
  t: number;      // window start, seconds since session start
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
  start: number;       // seconds since session start
  end: number | null;  // null = still open (live)
  confidence: number;  // [0,1]
  bucket: ConfidenceBucket;
  evidence: AnnotationEvidence[];
  alternates: AnnotationAlternate[];
  userConfirmed: boolean;
}

export interface RecordedSession {
  id: string;
  name: string;
  date: string;        // ISO
  duration: number;    // seconds
  mimeType: string;
  /** 'live' = mic recording; 'import' = user-provided audio file (stored as-is). */
  source: 'live' | 'import';
  annotations: SessionAnnotation[];
  // The audio Blob lives in IndexedDB under the session id (see session db).
}

// Clip references attached to cards live in types.ts (SessionClipAttachment).

// ── Recognition window results (worker → aggregator) ─────────────────────────

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
