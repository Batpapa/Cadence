import init, { FolkFriendWASM } from '../../../vendor/folkfriend/folkfriend.js';
import { loadTuneIndex, type IndexProgress } from './indexStore';
import { IncrementalViterbiSegmenter } from './viterbiSegmenter';
import { pitchClassesForDisplay } from './contourShift';
import { normalizeDisplayName } from '../../utils';
import { signedKeyOffset, type WindowResult, type WindowCandidate, type WindowDebugFeatures, type NoteAndTempoFeatures, type DetectionEvent } from '../model';
import { TempoTracker, type TempoReading } from '../liveTempo';
import { FEATURE_PITCHES } from '../scoreFollow';
import {
  ANALYSIS_HOP_S, ANALYSIS_WINDOW_S, FF_PCM_WINDOW, DEBUG_LIVE_AUDIO,
  FF_TEMPO_MIN_BPM, FF_TEMPO_MAX_BPM, FF_QUERY_REPASS_SIZE, FF_MIN_QUERY_LENGTH,
} from '../sessionConfig';

// ── FolkFriend recognition worker ─────────────────────────────────────────────
// Owns the WASM instance, the tune index, the PCM ring buffer and the
// incremental Viterbi detector (viterbiSegmenter.ts). PCM chunks arrive (from
// the audio worklet's MessagePort or the main thread); every ANALYSIS_HOP_S of
// new signal, the last ANALYSIS_WINDOW_S are transcribed and queried.
//
// ── The engine: pitch classes, whatever the key (2026-11-07) ──
// The recognition instance transcribes and compares PITCH CLASSES, octave
// forgotten (folkfriend-src feature/pitch_class.rs): each window's spectra lose
// their percussive part (harmonic/percussive separation) and their constant
// background (drone removal), octaves are summed into 12 classes before the
// melody is followed, and the index is folded the same way. Two instruments
// playing the tune in different registers (whistle + banjo, fiddle + low
// whistle) then add up instead of competing for the note, and octave errors
// cannot happen. Measured on the 17 annotated sessions of test-fixtures (415 +
// 283 tunes), live replay window by window, the detector's floor chosen on one
// half and scored on the other: 675/698 tunes found for 16 false positives,
// against 645/698 for 27 with the previous engine (48 notes + an octave
// fallback); names shown wrongly for more than 30 s in live: 62 -> 16.
//
// And whatever the key and the tuning (set_any_pitch): each window's tuning is
// estimated and read off, and the tune is looked for in all twelve keys — the
// written key's candidates exactly as before, plus the best 1000 transposed
// (setting, key) pairs. A session a quarter-tone sharp went from 8/96 tunes to
// 91/96; at written pitch the same list (675/698 for 14 false positives, against
// 674 for 15), a few more wrong names shown for a moment (39 against 30 in
// ~13 h). It replaced the manual "instruments' pitch" setting (whole semitones),
// which nobody could set right without knowing the session was off. It cost
// 112 ms a window against 65 (SIMD build) when first built; the query has been
// made about twice as fast since, results unchanged (vendor/folkfriend/README.md). Full record: the research journal (outside
// the repo) and experiments/session-bench. Score following and the tempo
// tracker run their own instances in the default mode.

interface RawQueryRecord {
  setting_id: string;
  setting: { tune_id: string; meter: string; mode: string; abc: string; dance: string; contour: string };
  display_name: string;
  score: number;
  /** The key it was found in: semitones above the written key, 0-11. */
  transpose?: number;
}

export type FFWorkerRequest =
  /** `tempo`: follow the tempo of the audio too (liveTempo.ts) — every
   *  analysis, live or file; not the TheSession widget's finder. */
  | { type: 'init'; sampleRate: number; hopS?: number; tempo?: boolean }
  | { type: 'worklet-port'; port: MessagePort }
  | { type: 'pcm'; buffer: ArrayBuffer; ack?: boolean }
  | { type: 'live-resume' }
  | { type: 'stop' };

export type FFWorkerResponse =
  | { type: 'init-progress'; progress: IndexProgress }
  | { type: 'ready'; version: string }
  | { type: 'window'; result: WindowResult; abc: string | null }
  | { type: 'annotations'; events: DetectionEvent[] }
  | { type: 'pcm-ack' }
  | { type: 'stopped'; events: DetectionEvent[]; tFinal: number }
  | { type: 'live-gap'; seconds: number }
  /** `novelty`: the curve's values since the last reading, from frame `at`
   *  of the recording on. */
  | { type: 'tempo'; reading: TempoReading; novelty: Float32Array; at: number }
  | { type: 'debug'; line: string }
  | { type: 'error'; message: string };

const ctx = self as unknown as {
  postMessage(msg: FFWorkerResponse, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent<FFWorkerRequest>) => void) | null;
};

let ff: FolkFriendWASM | null = null;
let pcmPtr = 0;
let sampleRate = 48000;
let hopS = ANALYSIS_HOP_S;
let segmenter = new IncrementalViterbiSegmenter(hopS);

// Ring buffer holding the last ANALYSIS_WINDOW_S seconds (plus slack).
let ring: Float32Array = new Float32Array(0);
let ringWrite = 0;        // next write position
let totalSamples = 0;     // global sample counter since start (time source of truth)
let lastAnalysisAt = 0;   // totalSamples value at last analysis

// #16: same class of bug as the file-import decode deficit (see
// streamingFileSource.ts) but via a different mechanism — on a long live
// session (phone, hours, real CPU contention), the browser can skip audio
// worklet render quanta entirely (a well-known glitch under load); those
// samples never arrive here at all, so totalSamples silently falls behind
// real elapsed time with nothing to signal it happened. Only ever relevant
// to the worklet (live) path — file import feeds PCM via the `pcm` message
// instead, with its own PTS-based catch-up upstream. `null` = not anchored yet;
// the first worklet chunk sets it. A live-resume does not null it, it
// re-anchors directly — and LiveSession.resume() sends that BEFORE restarting
// the audio, because a chunk arriving first would have the whole pause padded
// as silence. See the comment there.
let liveWallClockAnchorMs: number | null = null;
const LIVE_DEFICIT_SAFETY_MARGIN_S = 1;

// The tempo (liveTempo.ts), when asked for at init. Its own engine, with
// no index: the features of the analysis windows cannot be borrowed —
// `take_features` empties the buffer the transcription reads, and a window is
// fed again whole every hop anyway. Features only, about a third more of what
// the live analysis already extracts.
let tempoFf: FolkFriendWASM | null = null;
let tempoPtr = 0;
let tempoTracker: TempoTracker | null = null;
/** Samples of the last chunk short of a whole frame, for the next one. */
let tempoRest = new Float32Array(0);
/** Tracker frames at which the next reading is due: one a second. */
let tempoNextRead = 0;

function resetTempo(): void {
  tempoTracker?.reset();
  tempoRest = new Float32Array(0);
  tempoNextRead = 0;
  tempoPending = [];
}

/** The novelty since the last reading (TempoTracker.push), sent with the
 *  next — the engines keep the whole curve (NoveltyStore), and read each
 *  detection's own tempo in it. `tempoPendingAt`: the frame of its first. */
let tempoPending: Float32Array[] = [];
let tempoPendingAt = 0;

/** Feeds a chunk to the tempo tracker — after it has been counted in
 *  totalSamples, whose clock the readings are stamped with. A file's chunks
 *  come as fast as they are analysed: a reading per second of SIGNAL. */
function feedTempo(chunk: Float32Array): void {
  if (!tempoFf || !tempoTracker) return;
  let all = chunk;
  if (tempoRest.length) {
    all = new Float32Array(tempoRest.length + chunk.length);
    all.set(tempoRest);
    all.set(chunk, tempoRest.length);
  }
  const frames = Math.floor(all.length / FF_PCM_WINDOW);
  for (let i = 0; i < frames; i++) {
    // Re-acquired every time, as in analyzeSignal: memory growth stales it.
    tempoFf.get_allocated_pcm_window(tempoPtr).set(all.subarray(i * FF_PCM_WINDOW, (i + 1) * FF_PCM_WINDOW));
    tempoFf.feed_single_pcm_window(tempoPtr);
  }
  tempoRest = all.slice(frames * FF_PCM_WINDOW);
  if (frames === 0) return;
  // A reading at every second of signal INSIDE the chunk, stamped with its
  // own time: a file's chunks are five seconds long, and one reading per
  // chunk gave the agreement rule (TEMPO_OPTIONS) 25 s to agree over — the
  // first tune of the import test had no tempo (2026-11-01).
  const features = tempoFf.take_features();
  const n = Math.floor(features.length / FEATURE_PITCHES);
  // The recording's frame the first of these is, for the novelty sent along.
  const firstFrame = Math.round((totalSamples - tempoRest.length - n * FF_PCM_WINDOW) / FF_PCM_WINDOW);
  for (let i = 0; i < n;) {
    const take = Math.min(n - i, Math.max(1, tempoNextRead - tempoTracker.frames));
    if (!tempoPending.length) tempoPendingAt = firstFrame + i;
    tempoPending.push(tempoTracker.push(features.subarray(i * FEATURE_PITCHES, (i + take) * FEATURE_PITCHES)));
    i += take;
    if (tempoTracker.frames < tempoNextRead) continue;
    tempoNextRead = tempoTracker.frames + Math.round(tempoTracker.fps);
    const t = (totalSamples - tempoRest.length - (n - i) * FF_PCM_WINDOW) / sampleRate;
    const novelty = new Float32Array(tempoPending.reduce((k, p) => k + p.length, 0));
    tempoPending.reduce((at, p) => { novelty.set(p, at); return at + p.length; }, 0);
    tempoPending = [];
    ctx.postMessage({ type: 'tempo', reading: tempoTracker.read(t).reading, novelty, at: tempoPendingAt }, [novelty.buffer]);
  }
}

/** Pads the ring with silence if totalSamples has fallen behind real wall-clock
 *  time since the anchor — called once per worklet message, before the new
 *  chunk is appended, never for file-import PCM. */
function padToWallClock(): void {
  if (liveWallClockAnchorMs === null) {
    liveWallClockAnchorMs = Date.now() - (totalSamples / sampleRate) * 1000;
    return;
  }
  const expectedSamples = Math.round(((Date.now() - liveWallClockAnchorMs) / 1000) * sampleRate);
  const deficit = expectedSamples - totalSamples - Math.round(LIVE_DEFICIT_SAFETY_MARGIN_S * sampleRate);
  if (deficit > 0) {
    appendToRing(new Float32Array(deficit));
    // Not fed as silence: the tempo starts again after the hole.
    resetTempo();
    // #17: tells the UI a real gap was caught up on (and how much), instead
    // of the old unconditional "may have been interrupted" guess on every
    // visibility change regardless of whether anything actually happened.
    post({ type: 'live-gap', seconds: deficit / sampleRate });
  }
}

function post(msg: FFWorkerResponse): void {
  ctx.postMessage(msg);
}

/** A minimal module — one function `[] -> []` whose body is
 *  `i32.const 0; i8x16.splat; drop; end` — that only validates where
 *  WebAssembly SIMD is supported, because `i8x16.splat` (opcode 0xfd 0x0f) is
 *  an unknown instruction otherwise. Detection must happen BEFORE
 *  instantiating: a module containing SIMD fails to validate outright on a
 *  browser without it, so there is no graceful degradation to fall back on,
 *  only a dead Sessions feature. Safari shipped SIMD in 16.4 (March 2023).
 *
 *  Do not "simplify" these bytes. The snippet widely copied around for this
 *  declares the function as returning a v128 and then drops it, which leaves
 *  the stack empty at `end` — malformed regardless of SIMD support, so it
 *  answers false everywhere and silently sends every browser to the slow path.
 *  Verified here: this module validates on a runtime where the real SIMD
 *  binary also validates. */
const WASM_SIMD_TEST = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0,   // magic + version
  1, 4, 1, 96, 0, 0,             // type:     () -> ()
  3, 2, 1, 0,                    // function: one, of that type
  10, 9, 1, 7, 0, 65, 0, 253, 15, 26, 11, // code: i32.const 0; i8x16.splat; drop; end
]);

function supportsSimd(): boolean {
  try {
    return WebAssembly.validate(WASM_SIMD_TEST);
  } catch {
    return false;
  }
}

async function handleInit(sr: number, hop?: number, tempo?: boolean): Promise<void> {
  sampleRate = sr;
  hopS = hop ?? ANALYSIS_HOP_S;
  // Two builds of the same engine, bit-identical in their results — the SIMD
  // one scores four index candidates per vector instruction and is ~1.7x
  // faster overall. Both URLs are written out literally so the bundler emits
  // both files; only the chosen one is ever fetched.
  const scalarUrl = new URL('../../../vendor/folkfriend/folkfriend_bg.wasm', import.meta.url);
  const simdUrl = new URL('../../../vendor/folkfriend/folkfriend_bg_simd.wasm', import.meta.url);
  let usingSimd = supportsSimd();
  if (usingSimd) {
    try {
      await init(simdUrl);
    } catch {
      // Belt and braces: if the probe is ever wrong, or a browser validates
      // SIMD but refuses this particular module, fall back rather than leave
      // the feature dead. Safe to retry — the glue only latches its instance
      // on success, so a failed init leaves nothing behind.
      usingSimd = false;
      await init(scalarUrl);
    }
  } else {
    await init(scalarUrl);
  }
  // Which build loaded is otherwise invisible: the bundler hashes both
  // filenames and they are within 2 KB of each other, so the network tab
  // cannot tell them apart. Results are identical either way — this is purely
  // about speed.
  console.info(`[folkfriend] moteur ${usingSimd ? 'SIMD (rapide)' : 'scalaire (repli — navigateur sans SIMD)'}`);
  ff = new FolkFriendWASM();
  ff.set_sample_rate(sampleRate);
  // The engine ships upstream defaults; Cadence's tuned values live in
  // sessionConfig.ts, with the measurements behind them.
  ff.set_tempo_range(FF_TEMPO_MIN_BPM, FF_TEMPO_MAX_BPM);
  ff.set_num_repass(FF_QUERY_REPASS_SIZE);
  ff.set_min_query_length(FF_MIN_QUERY_LENGTH);
  // Before the index is loaded: it is then folded as it arrives (see the top
  // of this file). Only this instance — tempoFf below must keep serving
  // 48-note take_features.
  ff.set_pitch_class_mode();
  ff.set_any_pitch(true);
  pcmPtr = ff.alloc_single_pcm_window();
  if (tempo) {
    tempoFf = new FolkFriendWASM();
    tempoFf.set_sample_rate(sampleRate);
    tempoPtr = tempoFf.alloc_single_pcm_window();
    tempoTracker = new TempoTracker(sampleRate / FF_PCM_WINDOW);
    resetTempo();
  }

  const index = await loadTuneIndex(progress => post({ type: 'init-progress', progress }));
  ff.load_index_from_json_obj(index.indexData);

  ring = new Float32Array(Math.ceil((ANALYSIS_WINDOW_S + hopS) * sampleRate));
  ringWrite = 0;
  totalSamples = 0;
  lastAnalysisAt = 0;
  liveWallClockAnchorMs = null;
  segmenter = new IncrementalViterbiSegmenter(hopS);

  post({ type: 'ready', version: ff.version() });
}

function appendToRing(chunk: Float32Array): void {
  for (let i = 0; i < chunk.length; i++) {
    ring[ringWrite] = chunk[i]!;
    ringWrite = (ringWrite + 1) % ring.length;
  }
  totalSamples += chunk.length;
}

/** Copy the last `n` samples out of the ring, oldest first. */
function tailOfRing(n: number): Float32Array {
  const out = new Float32Array(n);
  let idx = (ringWrite - n + ring.length * Math.ceil(n / ring.length)) % ring.length;
  for (let i = 0; i < n; i++) {
    out[i] = ring[idx]!;
    idx = (idx + 1) % ring.length;
  }
  return out;
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
const TOP_N_CANDIDATES = 10;

/** Debug transcribe response (2026-08-18): `transcribe_pcm_buffer_debug()`
 *  replaces `transcribe_pcm_buffer()` — same underlying computation (see
 *  folkfriend-src's contour_from_notes, which always builds this data
 *  internally regardless of which wrapper is called), just not discarded
 *  before crossing the WASM boundary. Zero extra engine cost. */
type RawTranscribeDebug = { contour: string; features: NoteAndTempoFeatures } | { error: string; features: null };

function mapCandidates(raw: RawQueryRecord[]): WindowCandidate[] {
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
function queryContour(f: FolkFriendWASM, contour: string): WindowCandidate[] {
  const raw = JSON.parse(f.run_transcription_query(contour)) as RawQueryRecord[] | { error: string };
  if (!Array.isArray(raw)) return [];
  return mapCandidates(raw);
}

/** Feed a PCM signal into FolkFriend and return the analysis of it. */
function analyzeSignal(pcm: Float32Array, tStart: number, tEnd: number): { result: WindowResult; abc: string | null } {
  const f = ff!;
  // transcribe_pcm_buffer_debug consumes the internal buffer, so every
  // analysis re-feeds its full window; flush first for safety.
  f.flush_pcm_buffer();
  const frames = Math.floor(pcm.length / FF_PCM_WINDOW);
  for (let i = 0; i < frames; i++) {
    // Re-acquire the view before EVERY write: it goes stale if WASM memory grows.
    const view = f.get_allocated_pcm_window(pcmPtr);
    view.set(pcm.subarray(i * FF_PCM_WINDOW, (i + 1) * FF_PCM_WINDOW));
    f.feed_single_pcm_window(pcmPtr);
  }

  const rawDebug = JSON.parse(f.transcribe_pcm_buffer_debug()) as RawTranscribeDebug;
  if ('error' in rawDebug) {
    return { result: { tWindowStart: tStart, tWindowEnd: tEnd, empty: true, candidates: [] }, abc: null };
  }
  const contour = rawDebug.contour;
  const features = rawDebug.features;

  // No score filtering here: the Viterbi detector applies its own candidate
  // floor (minCandidateProbability), and the calibration dump needs the
  // sub-floor scores to be tunable at all.
  const candidates = queryContour(f, contour).slice(0, TOP_N_CANDIDATES);

  let abc: string | null = null;
  try { abc = f.contour_to_abc(pitchClassesForDisplay(contour)); } catch { /* cosmetic only */ }

  // "Enriched top-10" (2026-08-18): candidates stay capped at TOP_N_CANDIDATES
  // as always — debug only adds note/tempo/contour telemetry, no extra
  // candidates, keeping the per-window storage growth to just this struct
  // (a few hundred bytes) instead of duplicating (part of) the candidate list.
  const debug: WindowDebugFeatures = { contour, octaveShiftApplied: 0, features };

  return {
    result: { tWindowStart: tStart, tWindowEnd: tEnd, empty: candidates.length === 0, candidates, debug },
    abc,
  };
}

// Analysis triggers on signal time (accumulated samples), never the wall clock —
// the same code path serves live capture and faster-than-real-time file import.
function maybeAnalyzeLive(): void {
  if (!ff) return;
  // Wait for a full ANALYSIS_WINDOW_S before the very first analysis too
  // (2026-08-15) — an earlier version fired early on a shorter first window
  // (produced junk matches: 5s of signal -> confident wrong candidate), which
  // ALSO made that first window narrower than every later one, breaking the
  // "every segment's timestamps are just its windows' own real span" premise
  // (a real detection ended up looking like a near-zero-length sliver). Worth
  // the extra ~10s of latency before the first result.
  if (totalSamples < ANALYSIS_WINDOW_S * sampleRate) return;
  const hopSamples = hopS * sampleRate;
  if (totalSamples - lastAnalysisAt < hopSamples) return;
  lastAnalysisAt = totalSamples;

  const windowSamples = Math.min(totalSamples, ANALYSIS_WINDOW_S * sampleRate);
  const pcm = tailOfRing(windowSamples);
  const tEnd = totalSamples / sampleRate;
  const tStart = tEnd - windowSamples / sampleRate;

  const { result, abc } = analyzeSignal(pcm, tStart, tEnd);
  post({ type: 'window', result, abc });
  const events = segmenter.step(result);
  if (events.length > 0) post({ type: 'annotations', events });
}

function handlePcm(buffer: ArrayBuffer): void {
  const chunk = new Float32Array(buffer);
  appendToRing(chunk);
  maybeAnalyzeLive();
  try {
    feedTempo(chunk);
  } catch (err) {
    // The tempo is a display: whatever fails in it leaves the recognition
    // going, and stops for the rest of the recording — an engine that
    // panicked is not to be fed again. A WASM "unreachable" was seen live
    // (2026-11-02, a tab pulled out of its window while capturing), its cause
    // unknown: the engine's own message is logged just before this one.
    tempoFf = null;
    tempoTracker = null;
    console.error('[tempo] stopped for this recording:', err instanceof Error ? err.stack ?? err.message : err);
  }
}

/** Worklet (live) path only — file import never calls this, see padToWallClock(). */
let workletChunks = 0;
/** The live analysis threw: its engine is not to be fed again. */
let liveFailed = false;
/** Chunks still to be logged individually — set on live-resume so the first
 *  arrivals after a resume are always visible, however rare they are. */
let verboseChunks = 3;

function handleWorkletPcm(buffer: ArrayBuffer): void {
  workletChunks++;
  if (DEBUG_LIVE_AUDIO && (verboseChunks-- > 0 || workletChunks % 20 === 0)) {
    post({
      type: 'debug',
      line: `chunk #${workletChunks} samples=${buffer.byteLength / 4} total=${(totalSamples / sampleRate).toFixed(1)}s `
        + `lastAnalysis=${(lastAnalysisAt / sampleRate).toFixed(1)}s anchor=${liveWallClockAnchorMs === null ? 'null' : 'set'}`,
    });
  }
  padToWallClock();
  handlePcm(buffer);
}

function handleStop(): void {
  // The trailing partial hop, which nothing else ever analyses (2026-09-01):
  // maybeAnalyzeLive only fires on whole hops, so the last few seconds of every
  // recording used to reach no window at all — measured at 0.0 / 2.3 / 2.9 /
  // 4.1s across the four annotated sessions, and always shorter than one hop.
  // One extra window over the final ANALYSIS_WINDOW_S closes it for live and
  // import alike. It legitimately overlaps its predecessor by more than the
  // usual hop; windowRangeToTime reads real window centres, so an uneven last
  // step needs no special handling there.
  let tailEvents: DetectionEvent[] = [];
  // Not on an engine that failed: it would throw again, and 'stopped' never
  // be sent — what was recognised before still is, and gets saved.
  if (!liveFailed && totalSamples >= ANALYSIS_WINDOW_S * sampleRate && totalSamples > lastAnalysisAt) {
    const windowSamples = ANALYSIS_WINDOW_S * sampleRate;
    const tEnd = totalSamples / sampleRate;
    const { result, abc } = analyzeSignal(tailOfRing(windowSamples), tEnd - ANALYSIS_WINDOW_S, tEnd);
    post({ type: 'window', result, abc });
    // Kept and prepended, not dropped: step() may OPEN a detection that
    // finalize() then only closes, and an orchestrator receiving a `close` for
    // an id it never saw opened would have nothing to close.
    tailEvents = segmenter.step(result);
  }
  const tFinal = totalSamples / sampleRate;
  const events = [...tailEvents, ...segmenter.finalize()];
  post({ type: 'stopped', events, tFinal });
  // Reset live state for a potential next run (index + WASM stay loaded).
  ringWrite = 0;
  totalSamples = 0;
  lastAnalysisAt = 0;
  liveWallClockAnchorMs = null;
  segmenter = new IncrementalViterbiSegmenter(hopS);
  resetTempo();
}

function onRequest(e: MessageEvent<FFWorkerRequest>): void {
  const msg = e.data;
  try {
    switch (msg.type) {
      case 'init':
        void handleInit(msg.sampleRate, msg.hopS, msg.tempo).catch(err => post({ type: 'error', message: String(err) }));
        break;
      case 'worklet-port':
        // Out of onRequest's try: an error here went up to the page uncaught,
        // and the live screen said nothing of a recognition gone dead
        // (2026-11-02). Said once — every chunk after would fail the same.
        msg.port.onmessage = (ev: MessageEvent<ArrayBuffer>) => {
          if (liveFailed) return;
          try {
            handleWorkletPcm(ev.data);
          } catch (err) {
            liveFailed = true;
            console.error('[recognition] live analysis stopped:', err instanceof Error ? err.stack ?? err.message : err);
            post({ type: 'error', message: String(err) });
          }
        };
        break;
      case 'pcm':
        handlePcm(msg.buffer);
        // The ack doubles as backpressure: it is sent after any analysis this
        // chunk triggered, so a file import cannot flood the message queue.
        if (msg.ack) post({ type: 'pcm-ack' });
        break;
      case 'live-resume':
        // A deliberate pause/resume must NOT be padded as if it were lost
        // audio — re-anchor so "expected samples" picks up exactly where
        // totalSamples already is, with no gap to catch up on.
        liveWallClockAnchorMs = Date.now() - (totalSamples / sampleRate) * 1000;
        // The music after a pause is not the music before it.
        resetTempo();
        if (DEBUG_LIVE_AUDIO) {
          verboseChunks = 3;   // make the first arrivals after this visible
          post({ type: 'debug', line: `live-resume recu, re-ancre a total=${(totalSamples / sampleRate).toFixed(1)}s` });
        }
        break;
      case 'stop':
        handleStop();
        break;
    }
  } catch (err) {
    post({ type: 'error', message: String(err) });
  }
}

ctx.onmessage = onRequest;
