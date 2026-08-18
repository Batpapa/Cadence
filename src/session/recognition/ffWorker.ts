import init, { FolkFriendWASM } from '../../../vendor/folkfriend/folkfriend.js';
import { loadTuneIndex, type IndexProgress } from './indexStore';
import { IncrementalViterbiSegmenter } from './viterbiSegmenter';
import { shiftContour } from './contourShift';
import type { WindowResult, WindowCandidate, WindowDebugFeatures, NoteAndTempoFeatures, AnnotationEvent } from '../model';
import { ANALYSIS_HOP_S, ANALYSIS_WINDOW_S, FF_PCM_WINDOW } from '../sessionConfig';

// ── FolkFriend recognition worker ─────────────────────────────────────────────
// Owns the WASM instance, the tune index, the PCM ring buffer and the
// incremental Viterbi detector (viterbiSegmenter.ts). PCM chunks arrive (from
// the audio worklet's MessagePort or the main thread); every ANALYSIS_HOP_S of
// new signal, the last ANALYSIS_WINDOW_S are transcribed and queried.

interface RawQueryRecord {
  setting_id: string;
  setting: { tune_id: string; meter: string; mode: string; abc: string; dance: string; contour: string };
  display_name: string;
  score: number;
}

export type FFWorkerRequest =
  | { type: 'init'; sampleRate: number; hopS?: number }
  | { type: 'worklet-port'; port: MessagePort }
  | { type: 'pcm'; buffer: ArrayBuffer; ack?: boolean }
  | { type: 'set-pitch-shift'; semitones: number }
  | { type: 'live-resume' }
  | { type: 'stop' };

export type FFWorkerResponse =
  | { type: 'init-progress'; progress: IndexProgress }
  | { type: 'ready'; version: string }
  | { type: 'window'; result: WindowResult; abc: string | null }
  | { type: 'annotations'; events: AnnotationEvent[] }
  | { type: 'pcm-ack' }
  | { type: 'stopped'; events: AnnotationEvent[]; tFinal: number }
  | { type: 'live-gap'; seconds: number }
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
/** User-controlled transposition applied to every transcribed contour before
 *  querying the index (e.g. a session played in Bb) — independent of, and
 *  composes with, the automatic banjo octave fallback below. Live-adjustable
 *  mid-session; a fresh worker per session already resets it to 0. */
let manualShift = 0;

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
// instead, with its own PTS-based catch-up upstream. `null` = not anchored
// yet (first worklet chunk sets it) or a live-resume just reset it.
let liveWallClockAnchorMs: number | null = null;
const LIVE_DEFICIT_SAFETY_MARGIN_S = 1;

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
    // #17: tells the UI a real gap was caught up on (and how much), instead
    // of the old unconditional "may have been interrupted" guess on every
    // visibility change regardless of whether anything actually happened.
    post({ type: 'live-gap', seconds: deficit / sampleRate });
  }
}

function post(msg: FFWorkerResponse): void {
  ctx.postMessage(msg);
}

async function handleInit(sr: number, hop?: number): Promise<void> {
  sampleRate = sr;
  hopS = hop ?? ANALYSIS_HOP_S;
  await init(new URL('../../../vendor/folkfriend/folkfriend_bg.wasm', import.meta.url));
  ff = new FolkFriendWASM();
  ff.set_sample_rate(sampleRate);
  pcmPtr = ff.alloc_single_pcm_window();

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

/** Engine-level "confident enough top match" gate for the octave fallback
 *  below — independent of whichever downstream detection algorithm consumes
 *  the candidates (was segmenterConfig.ts's ENTER_THRESHOLD, reused here
 *  purely as a numeric floor, before segmenter.ts was replaced by the
 *  Viterbi detector). */
const OCTAVE_FALLBACK_THRESHOLD = 0.40;

/** Debug transcribe response (2026-08-18): `transcribe_pcm_buffer_debug()`
 *  replaces `transcribe_pcm_buffer()` — same underlying computation (see
 *  folkfriend-src's contour_from_notes, which always builds this data
 *  internally regardless of which wrapper is called), just not discarded
 *  before crossing the WASM boundary. Zero extra engine cost. */
type RawTranscribeDebug = { contour: string; features: NoteAndTempoFeatures } | { error: string; features: null };

function mapCandidates(raw: RawQueryRecord[]): WindowCandidate[] {
  return raw.map(r => ({
    tuneId: r.setting.tune_id,
    settingId: r.setting_id,
    displayName: r.display_name,
    dance: r.setting.dance,
    meter: r.setting.meter,
    score: r.score,
  }));
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
  const rawContour = rawDebug.contour;
  const features = rawDebug.features;

  // Manual shift first (user-selected, e.g. -2 for a Bb session) — everything
  // below operates on this as the new baseline.
  const contour = manualShift !== 0 ? shiftContour(rawContour, manualShift) : rawContour;
  if (manualShift !== 0 && contour.length === 0) {
    return { result: { tWindowStart: tStart, tWindowEnd: tEnd, empty: true, candidates: [] }, abc: null };
  }

  // No score filtering here: the Viterbi detector applies its own candidate
  // floor (minCandidateProbability), and the calibration dump needs the
  // sub-floor scores to be tunable at all.
  let candidates = queryContour(f, contour).slice(0, TOP_N_CANDIDATES);
  let matchedContour = contour;
  let octaveShiftApplied = 0;

  // Octave fallback: the index query has no transposition invariance and the
  // index contours sit at fiddle register, so low instruments (Irish tenor
  // banjo, an octave below the fiddle) transcribe an octave down and score
  // junk. When the window would fall below OCTAVE_FALLBACK_THRESHOLD anyway,
  // retry with the contour lifted one octave and keep whichever the index
  // scores higher — the decision stays with FolkFriend's own score, never a
  // register guess.
  if ((candidates[0]?.score ?? 0) < OCTAVE_FALLBACK_THRESHOLD) {
    const lifted = shiftContour(contour, 12);
    const liftedCandidates = lifted.length > 0 ? queryContour(f, lifted).slice(0, TOP_N_CANDIDATES) : [];
    if ((liftedCandidates[0]?.score ?? 0) > (candidates[0]?.score ?? 0)) {
      candidates = liftedCandidates;
      matchedContour = lifted;
      octaveShiftApplied = 12;
    }
  }

  let abc: string | null = null;
  try { abc = f.contour_to_abc(matchedContour); } catch { /* cosmetic only */ }

  // "Enriched top-10" (2026-08-18): candidates stay capped at TOP_N_CANDIDATES
  // as always — debug only adds note/tempo/contour telemetry, no extra
  // candidates, keeping the per-window storage growth to just this struct
  // (a few hundred bytes) instead of duplicating (part of) the candidate list.
  const debug: WindowDebugFeatures = { contour: matchedContour, octaveShiftApplied, features };

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
  appendToRing(new Float32Array(buffer));
  maybeAnalyzeLive();
}

/** Worklet (live) path only — file import never calls this, see padToWallClock(). */
function handleWorkletPcm(buffer: ArrayBuffer): void {
  padToWallClock();
  handlePcm(buffer);
}

function handleStop(): void {
  const tFinal = totalSamples / sampleRate;
  const events = segmenter.finalize();
  post({ type: 'stopped', events, tFinal });
  // Reset live state for a potential next run (index + WASM stay loaded).
  ringWrite = 0;
  totalSamples = 0;
  lastAnalysisAt = 0;
  liveWallClockAnchorMs = null;
  segmenter = new IncrementalViterbiSegmenter(hopS);
}

function onRequest(e: MessageEvent<FFWorkerRequest>): void {
  const msg = e.data;
  try {
    switch (msg.type) {
      case 'init':
        void handleInit(msg.sampleRate, msg.hopS).catch(err => post({ type: 'error', message: String(err) }));
        break;
      case 'worklet-port':
        msg.port.onmessage = (ev: MessageEvent<ArrayBuffer>) => handleWorkletPcm(ev.data);
        break;
      case 'pcm':
        handlePcm(msg.buffer);
        // The ack doubles as backpressure: it is sent after any analysis this
        // chunk triggered, so a file import cannot flood the message queue.
        if (msg.ack) post({ type: 'pcm-ack' });
        break;
      case 'set-pitch-shift':
        manualShift = msg.semitones;
        break;
      case 'live-resume':
        // A deliberate pause/resume must NOT be padded as if it were lost
        // audio — re-anchor so "expected samples" picks up exactly where
        // totalSamples already is, with no gap to catch up on.
        liveWallClockAnchorMs = Date.now() - (totalSamples / sampleRate) * 1000;
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
