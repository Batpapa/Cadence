// ── Session feature configuration ─────────────────────────────────────────────

/** FolkFriend tune index (~34 MB JSON, maps directly to TheSession.org tune IDs).
 *  Self-hostable later: point these at your own mirror. */
export const TUNE_INDEX_URL      = 'https://raw.githubusercontent.com/TomWyllie/folkfriend-app-data/master/public/folkfriend-non-user-data.json';
export const TUNE_INDEX_META_URL = 'https://raw.githubusercontent.com/TomWyllie/folkfriend-app-data/master/public/nud-meta.json';

/** Re-download the index when the remote version is this much newer (days). */
export const INDEX_MAX_AGE_DAYS = 28;

/** Recognition analysis: hop and window, in seconds. The very first analysis
 *  also waits for a full ANALYSIS_WINDOW_S of signal (2026-08-15) — no
 *  separate "minimum" below the window size, so every window (including the
 *  first) has the same true span.
 *
 *  THE HOP DECIDES EVERYTHING; THE WINDOW ONLY PAYS (2026-09-01 study).
 *  A window costs about 8ms + 29.5ms per second of window, so the total cost of
 *  analysing a recording is proportional to the overlap ratio WINDOW/HOP and to
 *  nothing else. What each of the two buys is completely different:
 *
 *   - The HOP sets boundary precision (half a hop) and how much evidence the
 *     decode gets. It is already at the knee of its curve at 5s: raising it to
 *     10s costs 11 real detections out of 284 at an equal false-positive
 *     budget, and LOWERING it to 2.5s buys none for twice the windows. Leave it
 *     alone. Rescale the per-transition costs and sameTuneMergeGapWindows in
 *     detectionTemporalConfig.ts if you ever do change it — both are durations
 *     in disguise.
 *   - The WINDOW buys neither detection nor precision. Measured at hop 5s with
 *     the operating point chosen on three sessions and scored on a fourth it
 *     never saw: 15s -> 92/117 recall, 12s -> 97, 10s -> 96, 8s -> 96. Shorter
 *     is simply cheaper, until the boundaries give (8s drops to 18/23 within
 *     +/-5s where 10s, 12s and 15s all hold 22/24 — a shorter window flips
 *     between tunes more nervously, so the flip point jitters).
 *
 *  15 -> 10 is therefore x1.49 with slightly better detection, identical
 *  boundaries and identical coverage. 8s would be x1.84 but breaks the +/-5s
 *  requirement. Full report: the 2026-09-01 study in project memory. */
export const ANALYSIS_HOP_S = 5;
/** Import-mode hop — same default as live, tunable separately to speed up imports later. */
export const HOP_S_IMPORT = 5;
export const ANALYSIS_WINDOW_S = 10;

/** Sample rate for imported-file analysis (FolkFriend accepts 3952–66974 Hz).
 *  A/B tested 2026-07 on a real pub recording: 22050 (which would halve memory
 *  on long files) degrades transcription badly — about a third of the set
 *  drops below SCORE_FLOOR and whole tunes vanish. Keep 48000; the RAM cost
 *  (~700 MB/h decoded) is what IMPORT_WARN_MINUTES guards against. */
export const ANALYSIS_SAMPLE_RATE = 48000;

/** Warn before decoding files longer than this (duration × rate × 4 bytes in RAM). */
export const IMPORT_WARN_MINUTES = 90;

/** Reject imported files shorter than this. Deliberately left at 20s when the
 *  window shrank to 10s (2026-09-01): it now admits two full windows rather
 *  than one, and nothing was gained by letting even shorter files through. */
export const IMPORT_MIN_S = 20;

/** Signal seconds per chunk streamed from FileSource to the worker. */
export const FILE_CHUNK_S = 1;

/** PCM windows fed to FolkFriend (SPEC_WINDOW_SIZE in ff_config.rs). */
export const FF_PCM_WINDOW = 1024;

/** Samples per chunk posted from the audio worklet to the recognition worker (~340 ms @48kHz). */
export const WORKLET_CHUNK_SAMPLES = 16384;

/** MediaRecorder timeslice (ms) — one chunk every 5 s appended to IndexedDB. */
export const RECORDER_TIMESLICE_MS = 5000;

/** Session sharing: base64 inflates the audio blob ~33%, and the JSON envelope
 *  adds a little more on top — stay safely under the backend's 100 MB share cap. */
export const SHARE_MAX_AUDIO_BYTES = 70 * 1024 * 1024;
