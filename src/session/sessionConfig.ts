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

// ── The whole-file decode, and when to warn about it ─────────────────────────
// Only ever reached when StreamingFileSource cannot handle the file: the
// chunked decoder holds a few seconds at a time and does not care how long the
// recording is. The fallback (`FileSource.fromFile` → one decodeAudioData over
// the whole file) is the one that scales with duration, and the one that kills
// a tab.
//
// Reported from the field (2026-09-11): an import died at ~20 minutes on a
// phone, with NO warning at all, because the threshold was a single hand-picked
// 90 minutes — a desktop number. Hence a budget divided by a measured cost,
// rather than a constant: the same formula that yields 15 minutes on a phone
// reproduces the old 90 on a desktop, which is where that number came from.

/** RAM a whole-file decode needs per second of audio.
 *
 *  Two copies exist at once: the mono PCM we keep at the analysis rate, and the
 *  decoder's own copy of the original before it is resampled and mixed down.
 *  The second is assumed to be 44.1 kHz stereo — the common case for anything
 *  recorded on a phone, and the conservative direction. */
export const WHOLE_FILE_BYTES_PER_S = ANALYSIS_SAMPLE_RATE * 4 + 44100 * 2 * 4;   // ≈ 545 kB/s, ≈ 1.9 GB/h

/** What a renderer can allocate before it is killed. Not a measurement of this
 *  device — no API reports it — but the order of magnitude that separates a
 *  phone from a desktop, and the two numbers this app has actually observed
 *  failing and succeeding. */
const MEMORY_BUDGET_SMALL = 500_000_000;     // a phone tab
const MEMORY_BUDGET_LARGE = 3_000_000_000;   // a desktop browser

/** Bytes a whole-file decode of `durationS` is expected to need. Shown to the
 *  user, so it must stay a number they can check against the file they picked. */
export function wholeFileDecodeBytes(durationS: number): number {
  return Math.max(0, durationS) * WHOLE_FILE_BYTES_PER_S;
}

/** Minutes of audio beyond which that decode is expected to fail here.
 *
 *  `smallMemory` is the caller's reading of the device (mobile), kept as a
 *  parameter so this stays a pure function of its inputs. */
export function importWarnMinutes(smallMemory: boolean): number {
  const budget = smallMemory ? MEMORY_BUDGET_SMALL : MEMORY_BUDGET_LARGE;
  return Math.round(budget / WHOLE_FILE_BYTES_PER_S / 60);
}

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

/** Verbose console tracing of the live capture chain: worklet input presence
 *  and forwarding, pause/resume steps, chunk arrivals at the worker, gaps the
 *  worker padded. Every line is prefixed `[live]`, so the whole trace comes out
 *  of a console filtered on that one word.
 *
 *  Left switchable rather than deleted, and it earned that: the chain crosses
 *  three threads (page, audio, worker) and the 2026-09-08 pause bug was only
 *  pinned down by a trace spanning all three — the context said `running` and
 *  the worklet said it was being called, while its input had been empty since
 *  the resume. No single vantage point showed it. */
export const DEBUG_LIVE_AUDIO = false;

/** MediaRecorder timeslice (ms) — one chunk every 5 s appended to IndexedDB. */
export const RECORDER_TIMESLICE_MS = 5000;

/** Session sharing: base64 inflates the audio blob ~33%, and the JSON envelope
 *  adds a little more on top — stay safely under the backend's 100 MB share cap. */
export const SHARE_MAX_AUDIO_BYTES = 70 * 1024 * 1024;
