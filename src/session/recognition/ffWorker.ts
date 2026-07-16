import init, { FolkFriendWASM } from '../../../vendor/folkfriend/folkfriend.js';
import { loadTuneIndex, type IndexProgress } from './indexStore';
import { RecognitionAggregator, type AnnotationEvent } from './aggregator';
import { AGG_CONFIG } from './aggregatorConfig';
import { shiftContour } from './contourShift';
import type { WindowResult, WindowCandidate } from '../model';
import { ANALYSIS_HOP_S, ANALYSIS_WINDOW_S, FF_PCM_WINDOW, MIN_ANALYSIS_S } from '../sessionConfig';

// ── FolkFriend recognition worker ─────────────────────────────────────────────
// Owns the WASM instance, the tune index, the PCM ring buffer and the
// aggregator. PCM chunks arrive (from the audio worklet's MessagePort or the
// main thread); every ANALYSIS_HOP_S of new signal, the last ANALYSIS_WINDOW_S
// are transcribed and queried.

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
  | { type: 'stop' };

export type FFWorkerResponse =
  | { type: 'init-progress'; progress: IndexProgress }
  | { type: 'ready'; version: string }
  | { type: 'window'; result: WindowResult; abc: string | null }
  | { type: 'annotations'; events: AnnotationEvent[] }
  | { type: 'pcm-ack' }
  | { type: 'stopped'; events: AnnotationEvent[]; tFinal: number }
  | { type: 'error'; message: string };

const ctx = self as unknown as {
  postMessage(msg: FFWorkerResponse, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent<FFWorkerRequest>) => void) | null;
};

let ff: FolkFriendWASM | null = null;
let pcmPtr = 0;
let sampleRate = 48000;
let hopS = ANALYSIS_HOP_S;
let aggregator = new RecognitionAggregator();

// Ring buffer holding the last ANALYSIS_WINDOW_S seconds (plus slack).
let ring: Float32Array = new Float32Array(0);
let ringWrite = 0;        // next write position
let totalSamples = 0;     // global sample counter since start (time source of truth)
let lastAnalysisAt = 0;   // totalSamples value at last analysis

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
  aggregator = new RecognitionAggregator();

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
function queryContour(f: FolkFriendWASM, contour: string): WindowCandidate[] {
  const raw = JSON.parse(f.run_transcription_query(contour)) as RawQueryRecord[] | { error: string };
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 5).map(r => ({
    tuneId: r.setting.tune_id,
    settingId: r.setting_id,
    displayName: r.display_name,
    dance: r.setting.dance,
    meter: r.setting.meter,
    score: r.score,
  }));
}

/** Feed a PCM signal into FolkFriend and return the analysis of it. */
function analyzeSignal(pcm: Float32Array, tStart: number, tEnd: number): { result: WindowResult; abc: string | null } {
  const f = ff!;
  // transcribe_pcm_buffer consumes the internal buffer, so every analysis
  // re-feeds its full window; flush first for safety.
  f.flush_pcm_buffer();
  const frames = Math.floor(pcm.length / FF_PCM_WINDOW);
  for (let i = 0; i < frames; i++) {
    // Re-acquire the view before EVERY write: it goes stale if WASM memory grows.
    const view = f.get_allocated_pcm_window(pcmPtr);
    view.set(pcm.subarray(i * FF_PCM_WINDOW, (i + 1) * FF_PCM_WINDOW));
    f.feed_single_pcm_window(pcmPtr);
  }

  const contour = f.transcribe_pcm_buffer();
  // "No notes detected" comes back as a JSON error string, not an exception.
  if (contour.startsWith('{')) {
    console.log(`[ff-window] ${tStart.toFixed(0)}–${tEnd.toFixed(0)}s: no notes detected`);
    return { result: { tWindowStart: tStart, tWindowEnd: tEnd, empty: true, candidates: [] }, abc: null };
  }

  // No score filtering here: the aggregator applies SCORE_FLOOR itself, and
  // the calibration dump needs the sub-floor scores to be tunable at all.
  let candidates = queryContour(f, contour);
  let matchedContour = contour;

  // Octave fallback: the index query has no transposition invariance and the
  // index contours sit at fiddle register, so low instruments (Irish tenor
  // banjo, an octave below the fiddle) transcribe an octave down and score
  // junk. When the window would fall below SCORE_FLOOR anyway, retry with the
  // contour lifted one octave and keep whichever the index scores higher —
  // the decision stays with FolkFriend's own score, never a register guess.
  let octaveLifted = false;
  if ((candidates[0]?.score ?? 0) < AGG_CONFIG.SCORE_FLOOR) {
    const lifted = shiftContour(contour, 12);
    const liftedCandidates = lifted.length > 0 ? queryContour(f, lifted) : [];
    if ((liftedCandidates[0]?.score ?? 0) > (candidates[0]?.score ?? 0)) {
      candidates = liftedCandidates;
      matchedContour = lifted;
      octaveLifted = true;
    }
  }

  let abc: string | null = null;
  try { abc = f.contour_to_abc(matchedContour); } catch { /* cosmetic only */ }

  // TEMP diagnostic (solo-query dropout investigation) — remove when done.
  const top3 = candidates.slice(0, 3).map(c => `${c.displayName} ${c.score.toFixed(2)}`).join(' | ');
  console.log(
    `[ff-window] ${tStart.toFixed(0)}–${tEnd.toFixed(0)}s${octaveLifted ? ' (octave +12)' : ''}` +
    ` top: ${top3 || '(none)'}\n  contour: ${matchedContour}\n  abc: ${abc ?? '(n/a)'}`
  );

  return {
    result: { tWindowStart: tStart, tWindowEnd: tEnd, empty: candidates.length === 0, candidates },
    abc,
  };
}

// Analysis triggers on signal time (accumulated samples), never the wall clock —
// the same code path serves live capture and faster-than-real-time file import.
function maybeAnalyzeLive(): void {
  if (!ff) return;
  // A first window shorter than MIN_ANALYSIS_S produces junk matches
  // (observed: 5 s of signal → confident wrong candidate).
  if (totalSamples < MIN_ANALYSIS_S * sampleRate) return;
  const hopSamples = hopS * sampleRate;
  if (totalSamples - lastAnalysisAt < hopSamples) return;
  lastAnalysisAt = totalSamples;

  const windowSamples = Math.min(totalSamples, ANALYSIS_WINDOW_S * sampleRate);
  const pcm = tailOfRing(windowSamples);
  const tEnd = totalSamples / sampleRate;
  const tStart = tEnd - windowSamples / sampleRate;

  const { result, abc } = analyzeSignal(pcm, tStart, tEnd);
  post({ type: 'window', result, abc });
  const events = aggregator.step(result);
  if (events.length > 0) post({ type: 'annotations', events });
}

function handlePcm(buffer: ArrayBuffer): void {
  appendToRing(new Float32Array(buffer));
  maybeAnalyzeLive();
}

function handleStop(): void {
  const tFinal = totalSamples / sampleRate;
  const events = aggregator.finalize(tFinal);
  post({ type: 'stopped', events, tFinal });
  // Reset live state for a potential next run (index + WASM stay loaded).
  ringWrite = 0;
  totalSamples = 0;
  lastAnalysisAt = 0;
  aggregator = new RecognitionAggregator();
}

function onRequest(e: MessageEvent<FFWorkerRequest>): void {
  const msg = e.data;
  try {
    switch (msg.type) {
      case 'init':
        void handleInit(msg.sampleRate, msg.hopS).catch(err => post({ type: 'error', message: String(err) }));
        break;
      case 'worklet-port':
        msg.port.onmessage = (ev: MessageEvent<ArrayBuffer>) => handlePcm(ev.data);
        break;
      case 'pcm':
        handlePcm(msg.buffer);
        // The ack doubles as backpressure: it is sent after any analysis this
        // chunk triggered, so a file import cannot flood the message queue.
        if (msg.ack) post({ type: 'pcm-ack' });
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
