// ── Session recording & recognition data model ───────────────────────────────
// Tune IDs are TheSession.org tune IDs (same space as Card.externalId "thesession:{id}").

export type ConfidenceBucket = 'high' | 'medium' | 'low';

export interface DetectionEvidence {
  t: number;      // window start, seconds since session start
  tEnd?: number;  // window end — absent on annotations persisted before the end-vote (2026-07)
  score: number;  // top-1 Needleman-Wunsch score [0,1]
  margin: number; // top-1 − top-2 score
}

export interface DetectionAlternate {
  tuneId: string;
  settingId: string;
  displayName: string;
  dance: string;
  meter: string;
  meanScore: number;
}

export interface Detection {
  id: string;
  tuneId: string;      // TheSession tune ID
  settingId: string;
  displayName: string;
  dance: string;       // reel, jig, …
  meter: string;
  /** Seconds since session start covered by the OBSERVATION WINDOWS that led
   *  to this detection (see DetectedTuneSegment's doc in viterbiDetector.ts)
   *  — not necessarily the exact instant the tune actually started/stopped.
   *  Analysis windows overlap each other by design, so this detection's
   *  range can and does legitimately overlap the next detection's — that
   *  overlap is real signal (a transition/uncertainty zone), not a bug to be
   *  trimmed away. */
  start: number;
  end: number | null;  // null = still open (live)
  confidence: number;  // [0,1] — consistency-weighted (win rate over the detection's span), NOT comparable to alternates' meanScore below
  bucket: ConfidenceBucket;
  /** Mean raw match score whenever this tune appeared as a window candidate —
   *  same metric as `alternates[].meanScore`, so the two are directly comparable
   *  in the detection-options panel (unlike `confidence`, which only this tune has). */
  meanScore: number;
  evidence: DetectionEvidence[];
  /** Up to detectionTemporalConfig.ts's maxAlternates other tunes seen as
   *  window candidates over this detection's span, ranked by mean score —
   *  EXCLUDES viterbiPick's own tuneId (computeAlternates never scores the
   *  segment against itself). Together with viterbiPick, this is the full
   *  set of choices the "explore alternatives" picker offers (DetectionCard.tsx). */
  alternates: DetectionAlternate[];
  /** Snapshot of what the Viterbi decoder itself currently picks for this
   *  segment — same shape as an entry in `alternates` (and directly
   *  comparable by meanScore), captured fresh on every segmenter-driven
   *  update (viterbiSegmenter.ts's toDetection), so it keeps tracking the
   *  algorithm's actual live answer even after the user has overridden the
   *  DISPLAYED identity below via selectAlternate() (tuneId/settingId/
   *  displayName/dance/meter, gated the same way as userConfirmed). Always
   *  favored over any alternate with a higher meanScore when nothing has
   *  been overridden — "Viterbi decides" takes transition costs/hysteresis
   *  into account, not just this one span's raw mean score. */
  viterbiPick: DetectionAlternate;
  /** True once the user has explicitly vouched for this detection's identity
   *  via selectAlternate() — freezes tuneId/settingId/displayName/dance/meter
   *  across future segmenter updates and protects the detection from ever
   *  being retracted (see viterbiSegmenter.ts's vanish-cleanup and
   *  DetectionEvent's 'retract' doc).
   *
   *  Confirming the algorithm's OWN pick counts (2026-09-04): "this detection
   *  is right" is a statement about the result, not about disagreeing with it,
   *  and it earns the same freeze — the whole point is that the decoder stops
   *  moving it. Until then the card shows the confidence badge; once set, a
   *  green check. Un-confirming (picking the selected tune again) is what
   *  hands it back to the algorithm. */
  userConfirmed: boolean;
  /** User marker: "I liked this tune when I heard it" — has no bearing on
   *  recognition or on any card, purely a personal reminder. */
  liked: boolean;
  /** false while the Viterbi detector could still revise this detection's
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
 *  into their detection map. */
export type DetectionEvent =
  | { type: 'open'; detection: Detection }
  | { type: 'update'; detection: Detection }
  | { type: 'close'; detection: Detection }
  /** A provisional detection that was shown (opened) while it was still the
   *  live tail (see minSegmentWindows in detectionTemporalConfig.ts) but
   *  never actually reached the confirmation threshold before being
   *  superseded — remove it from the detection list entirely, as if it had
   *  never appeared (2026-08-15: `close` with `finalized:false` still left a
   *  permanent, if unconfirmed, entry sitting in the UI — the user explicitly
   *  wants it gone, not just marked unreliable). Orchestrators should ignore
   *  this for an id the user has already `userConfirmed` — an explicit user
   *  choice must never be silently erased. */
  | { type: 'retract'; id: string };

export interface Analysis {
  id: string;
  name: string;
  /** ISO timestamp of the session's t=0. Live recordings set it to the
   *  recording start; file imports start with null (file mtime is unreliable).
   *  Editable and erasable in the summary screen — review logging requires it. */
  date: string | null;
  duration: number;    // seconds
  mimeType: string;
  /** 'live' = mic recording; 'import' = user-provided audio file (stored as-is). */
  /** How the audio was obtained. 'live' and 'device' are both live recordings —
   *  a microphone and a captured browser tab / system output respectively — and
   *  they are told apart here only so a session can be NAMED for what it is
   *  (see sessionNaming.ts); nothing in the recognition path reads this.
   *  Sessions saved before 'device' existed read as 'live', which is what they
   *  were. */
  source: 'live' | 'device' | 'import';
  /** 'recording' = draft written while a live recording is still in progress
   *  (crash/refresh recovery); absent once the session is finalized. */
  status?: 'recording' | 'done';
  /** ⚠️ NAME FROZEN. The 2026-09-09 vocabulary pass renamed the TYPE
   *  (SessionAnnotation → Detection) but deliberately NOT this field, because
   *  it is serialized: it sits in every user's IndexedDB and in the Drive blob
   *  their other devices read. Renaming it needs a migration AND would break
   *  across versions in the meantime — a device still on the old bundle keeps
   *  writing `annotations` into the shared Drive copy, which is exactly the
   *  shape of the 2026-08-31 data loss. Same reasoning as
   *  TuneAnalyserModuleData.sessions below. Not worth it for a name — the full
   *  argument, including why an IndexedDB migration is a different and easier
   *  question than this one, is in session/db.ts's header. */
  annotations: Detection[];
  // The audio Blob (+ in-progress crash-recovery scratch data) lives in a
  // local-only, non-Drive-synced IndexedDB under the session id — see
  // session/db.ts. This record itself is small (no audio), so it's kept
  // directly on the user's synced AppState instead (see TuneAnalyserModuleData).
}

/** `AppState.modules['tune-analyser']` (see types.ts's User.modules) — the
 *  tune-analyser/Sessions feature's own slice of the synced-via-Drive user
 *  blob (2026-08-26). Deliberately holds only small, meaningful-to-sync data
 *  (session metadata + annotations); audio and crash-recovery scratch data
 *  (raw per-window results, MediaRecorder chunks) are local-only and never
 *  touch this — see session/db.ts's local database. */
export interface TuneAnalyserModuleData {
  /** ⚠️ NAME FROZEN, same reason as Analysis.annotations above: this key is in
   *  every user's synced blob. The UI says "analyse"/"analysis" everywhere
   *  since 2026-09-09 and the types followed; the STORAGE keys deliberately
   *  did not. That divergence is the price of not migrating user data for a
   *  rename, and it is intentional — do not "finish the job" here. The reasoning
   *  in full is in session/db.ts's header. */
  sessions: Record<string, Analysis>;
  /** Show the "detected in" panel on tune cards. Absent = yes: whoever records
   *  sessions is the only one who ever sees it, and for them the cross-
   *  reference is the point. Written only to turn it OFF, from the sessions
   *  library — a flag on this module's own slice rather than on User, which
   *  knows nothing about panels. */
  detectionsOnCards?: boolean;
  /** Copy the recording to Drive for sessions saved from now on, so they can be
   *  played on the user's other devices — and so the device is not holding the
   *  only copy of them.
   *
   *  ⚠️ Absent = YES since 2026-09-09, unlike every other optional flag here.
   *  Read it through `SYNC_AUDIO_BY_DEFAULT` / `syncAudioByDefault()` in
   *  session/db.ts, never as a bare truthiness check: `!!flag` reads an
   *  untouched install as off, which is the opposite of what happens. Both
   *  values are written now, precisely so a deliberate "no" survives. */
  syncAudioByDefault?: boolean;
  /** Session id → the Drive file holding its recording, for the sessions where
   *  that was chosen. A sibling map rather than a field on Analysis,
   *  purely so this stays one obvious place to look. */
  syncedAudio?: Record<string, SyncedAudio>;
}

/** A recording copied to the user's Drive as a file of its own — the one way to
 *  hear a session on a device other than the one that recorded it.
 *
 *  A separate file rather than base64 inside this blob (which is what the first
 *  implementation did, 2026-09-08). The blob is re-serialised and re-uploaded on
 *  every push, so carrying recordings in it meant re-uploading tens of megabytes
 *  after every unrelated edit, and needed an arbitrary cap to stay bearable. A
 *  companion file is uploaded once, costs nothing afterwards, and is limited
 *  only by the user's own Drive quota — see driveService.ts's companion files.
 *
 *  Recordings are write-once, so there is deliberately no version or checksum
 *  here: the bytes behind `fileId` cannot change, and nothing can disagree
 *  about them. */
export interface SyncedAudio {
  /** Drive file id. The local database may hold the same recording as well —
   *  uploading never removes the local copy, and downloading caches it. */
  fileId: string;
  mimeType: string;
  /** Size of the recording, so the settings screen can total what is on Drive
   *  and a download can say how big it will be before starting. */
  bytes: number;
}

export const TUNE_ANALYSER_MODULE_KEY = 'tune-analyser';

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
  /** EXPERIMENTAL (2026-08-18) — note/tempo/quantization features + full
   *  (untruncated) candidate list, populated ONLY by the offline noise-study
   *  harness (experiments/noise-study/), NEVER by the live production
   *  ffWorker.ts path. Absent on every real session recorded through the app.
   *  See experiments/noise-study/README.md. */
  debug?: WindowDebugFeatures;
}

// Field names are snake_case verbatim from Rust's `serde_json` output
// (decode::ContourDebugFeatures / TempoCandidateScore in folkfriend-src) —
// deliberately NOT renamed, so this stays a direct passthrough of
// FolkFriend's own computed values (per the noise-study spec: expose,
// don't reimplement).
export interface TempoCandidateScore {
  bpm: number;
  quant_score: number;
  rhythm_score: number;
  combined_score: number;
}

export interface NoteAndTempoFeatures {
  note_count_raw: number;
  note_count_filtered: number;
  note_count_rejected: number;
  note_duration_mean: number;
  note_duration_median: number;
  note_power_mean: number;
  note_power_max: number;
  note_power_median: number;
  tempo_candidates: TempoCandidateScore[];
  best_bpm: number;
  best_quant_score: number;
  best_rhythm_score: number;
  best_combined_score: number;
  contour_length: number;
}

export interface WindowDebugFeatures {
  contour: string | null;
  octaveShiftApplied: number;
  /** null when FolkFriend found too few notes to build a contour at all
   *  (the same case that makes `WindowResult.empty` true) — distinguished
   *  from "not collected" so a noise-study export can tell them apart.
   *
   *  Deliberately NO separate candidate list here (2026-08-18) — an earlier
   *  version carried an untruncated ~100-candidate `fullCandidates` array,
   *  which roughly doubled per-window IndexedDB storage for no feature the
   *  noise study actually needed; every candidate-based feature used there
   *  (margin, candidatesAboveX, sum-of-top-N) only ever looks at the top 10,
   *  i.e. exactly `WindowResult.candidates` already. Read that instead. */
  features: NoteAndTempoFeatures | null;
}

// ── Choosing an identity for a detection ───────────────────────────────────
// Both engines and the finished-session summary write the user's choice, and
// all three wrote the same five assignments by hand before this — which is how
// one of them ends up disagreeing with the others about what confirming means.

/** `viterbiPick` (2026-08-25) is absent on every session recorded before this
 *  feature shipped — no migration, same "no UI path/no migration" convention
 *  already established for `finalized`. A live/import detection is always
 *  freshly built by the segmenter, which has populated this field from day one
 *  of its own existence, so this fallback only ever matters for a
 *  Analysis loaded from IndexedDB (SessionSummary.tsx) — for that case,
 *  the current identity IS effectively what the algorithm originally picked
 *  (there was no override mechanism yet when it was recorded). */
export function viterbiPickOf(ann: Detection): DetectionAlternate {
  return ann.viterbiPick ?? {
    tuneId: ann.tuneId, settingId: ann.settingId, displayName: ann.displayName,
    dance: ann.dance, meter: ann.meter, meanScore: ann.meanScore,
  };
}

/** What choosing an identity writes onto a detection.
 *
 *  A tune — ANY of them, the algorithm's own current pick included — means the
 *  user has looked at this detection and vouched for it: the identity freezes
 *  and the detection can no longer be retracted. Confirming what the
 *  algorithm already said is the common case, not a no-op: it is the whole
 *  point of being able to confirm a result.
 *
 *  `null` is the way back: the detection returns to displaying whatever the
 *  decoder currently picks, and to being the decoder's to revise. */
export function alternatePickFields(
  ann: Detection,
  pick: DetectionAlternate | null,
): Pick<Detection, 'tuneId' | 'settingId' | 'displayName' | 'dance' | 'meter' | 'userConfirmed'> {
  const chosen = pick ?? viterbiPickOf(ann);
  return {
    tuneId: chosen.tuneId,
    settingId: chosen.settingId,
    displayName: chosen.displayName,
    dance: chosen.dance,
    meter: chosen.meter,
    userConfirmed: pick !== null,
  };
}
