// ── Session feature configuration ─────────────────────────────────────────────

/** FolkFriend tune index (~34 MB JSON, maps directly to TheSession.org tune IDs).
 *  Self-hostable later: point these at your own mirror. */
export const TUNE_INDEX_URL      = 'https://raw.githubusercontent.com/TomWyllie/folkfriend-app-data/master/public/folkfriend-non-user-data.json';
export const TUNE_INDEX_META_URL = 'https://raw.githubusercontent.com/TomWyllie/folkfriend-app-data/master/public/nud-meta.json';

/** Re-download the index when the remote version is this much newer (days). */
export const INDEX_MAX_AGE_DAYS = 28;

/** Recognition analysis: hop and window, in seconds. */
export const ANALYSIS_HOP_S = 5;
/** Import-mode hop — same default as live, tunable separately to speed up imports later. */
export const HOP_S_IMPORT = 5;
export const ANALYSIS_WINDOW_S = 15;

/** Sample rate for imported-file analysis (FolkFriend accepts 3952–66974 Hz).
 *  22050 halves memory vs 48 kHz on long files; live mode keeps the real
 *  AudioContext rate. Validate once via the calibration dump if scores drop. */
export const ANALYSIS_SAMPLE_RATE = 22050;

/** Warn before decoding files longer than this (duration × rate × 4 bytes in RAM). */
export const IMPORT_WARN_MINUTES = 90;

/** Reject imported files shorter than this (not enough signal for one window). */
export const IMPORT_MIN_S = 20;

/** Signal seconds per chunk streamed from FileSource to the worker. */
export const FILE_CHUNK_S = 1;

/** PCM windows fed to FolkFriend (SPEC_WINDOW_SIZE in ff_config.rs). */
export const FF_PCM_WINDOW = 1024;

/** Samples per chunk posted from the audio worklet to the recognition worker (~340 ms @48kHz). */
export const WORKLET_CHUNK_SAMPLES = 16384;

/** MediaRecorder timeslice (ms) — one chunk every 5 s appended to IndexedDB. */
export const RECORDER_TIMESLICE_MS = 5000;
