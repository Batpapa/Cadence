import type { FFWorkerRequest, FFWorkerResponse } from './recognition/ffWorker';
import { noteTuneIndexCached, type IndexProgress } from './recognition/indexStore';
import type { WindowResult, DetectionEvent } from './model';
import type { TempoReading } from './liveTempo';
import type { RecognitionSink } from './audio/sources';
import { DEBUG_LIVE_AUDIO } from './sessionConfig';
import type { CardIndexTune } from './recognition/cardIndex';
import type { RecognitionEngineId } from './recognition/windowEngine';
import { recognitionEngine } from '../services/recognitionEngine';

// ── Main-thread wrapper around the FolkFriend recognition worker ──────────────
// Implements RecognitionSink: PCM sources (mic worklet, decoded file) feed it
// interchangeably — the worker only ever sees a stream of chunks.

// The indexes a recognition searches (recognitionIndexes.ts): TheSession's and
// the user's tune cards (cardIndex.ts), on or off, in the user's order.
// Installed by the app (cardIndexSource.ts's installCardRecognition); a page
// without cards — the standalone analyser, the TheSession widget — never
// installs it and recognises from TheSession's index alone, as before.
export interface RecognitionSources {
  cards: boolean;
  theSession: boolean;
  /** The indexes' sources in the order that wins ties among equal scores
   *  (set_source_order). */
  sourceOrder: string[];
  /** The tune cards' versions — called only when `cards` is on. `onRead`:
   *  after each file or link read, `done` of `total`. */
  gatherCards: (onRead?: (done: number, total: number) => void) => Promise<CardIndexTune[]>;
}

let recognitionSources: (() => RecognitionSources) | null = null;

/** The count of cards read, said at most this often. */
const CARDS_READ_EVERY_MS = 150;

export function setRecognitionSources(sources: () => RecognitionSources): void {
  recognitionSources = sources;
}

export interface RecognitionCallbacks {
  /** What the start is doing, one step per thing under way at once: the
   *  worker's (engine, index), and beside it the page reading the cards. */
  onIndexProgress?: (steps: IndexProgress[]) => void;
  onWindow?: (result: WindowResult, abc: string | null) => void;
  onDetections?: (events: DetectionEvent[]) => void;
  onError?: (message: string) => void;
  /** #17: a real live-capture gap was caught up on (worklet path only) — how
   *  many seconds of silence got padded in to keep pace with wall-clock time. */
  onLiveGap?: (seconds: number) => void;
  /** About once a second, with `tempo` on (liveTempo.ts). */
  /** `novelty`: the curve since the last reading, from frame `at` on. */
  onTempo?: (reading: TempoReading, novelty: Float32Array, at: number) => void;
}

export interface RecognitionOptions {
  /** Analysis hop in seconds — HOP_S_IMPORT for file imports, default for live. */
  hopS?: number;
  /** Follow the tempo of the audio too (liveTempo.ts): a reading a second of
   *  signal, through `onTempo`. */
  tempo?: boolean;
  /** What hears the windows (recognition/windowEngine.ts); by default this
   *  device's choice (services/recognitionEngine.ts: the transcriptor's decoder,
   *  or FolkFriend's behind the hidden switch). */
  engine?: RecognitionEngineId;
}

export class RecognitionClient implements RecognitionSink {
  private worker: Worker;
  private cb: RecognitionCallbacks;
  /** Resolves with the FolkFriend version once WASM + index are loaded. */
  readonly ready: Promise<string>;
  private ackQueue: (() => void)[] = [];
  private stopDone: ((r: { events: DetectionEvent[]; tFinal: number }) => void) | null = null;
  /** The worker's step, null while it only waits for the cards. */
  private workerStep: IndexProgress | null = { phase: 'engine' };
  /** The page's reading of the cards, null before it starts or once it is
   *  over and the worker has moved on. */
  private cardsStep: IndexProgress | null = null;
  private cardsRead = false;

  constructor(sampleRate: number, callbacks: RecognitionCallbacks = {}, options: RecognitionOptions = {}) {
    this.cb = callbacks;
    this.worker = new Worker(new URL('./recognition/ffWorker.ts', import.meta.url), { type: 'module' });

    let resolveReady!: (v: string) => void;
    let rejectReady!: (e: Error) => void;
    this.ready = new Promise<string>((res, rej) => { resolveReady = res; rejectReady = rej; });

    // A worker that fails to load or crashes outside a message handler never
    // posts anything — surface it instead of hanging on `ready` forever.
    this.worker.onerror = (e: ErrorEvent) => {
      // Handled: not to go on up to the page as uncaught — a worker's error
      // not cancelled is reported again in the page's scope (2026-11-02, a
      // WASM "unreachable" over the whole screen in development).
      e.preventDefault();
      const msg = `Recognition worker error: ${e.message || 'failed to load'}`;
      this.cb.onError?.(msg);
      rejectReady(new Error(msg));
    };
    this.worker.onmessageerror = () => {
      const msg = 'Recognition worker message deserialization failed';
      this.cb.onError?.(msg);
      rejectReady(new Error(msg));
    };

    this.worker.onmessage = (e: MessageEvent<FFWorkerResponse>) => {
      const msg = e.data;
      switch (msg.type) {
        case 'init-progress':
          this.workerStep = msg.progress;
          if (this.cardsRead) this.cardsStep = null;
          this.sayInit();
          break;
        case 'cards-wait':    this.workerStep = null; this.sayInit(); break;
        case 'ready':         noteTuneIndexCached(); resolveReady(msg.version); break;
        case 'window':        this.cb.onWindow?.(msg.result, msg.abc); break;
        case 'annotations':   this.cb.onDetections?.(msg.events); break;
        case 'pcm-ack':       this.ackQueue.shift()?.(); break;
        case 'stopped':       this.stopDone?.({ events: msg.events, tFinal: msg.tFinal }); this.stopDone = null; break;
        case 'live-gap':      if (DEBUG_LIVE_AUDIO) console.log(`[live] gap comble par le worker : ${msg.seconds.toFixed(1)}s de silence`);
          this.cb.onLiveGap?.(msg.seconds); break;
        case 'tempo':         this.cb.onTempo?.(msg.reading, msg.novelty, msg.at); break;
        // The worker cannot write to the page console usefully on its own (its
        // lines land in a separate context), so it ships them here.
        case 'debug':         console.log(`[live] worker: ${msg.line}`); break;
        case 'error':         this.cb.onError?.(msg.message); rejectReady(new Error(msg.message)); break;
      }
    };

    // `init` goes at once, so that it is the worker's first message whatever
    // the caller sends next; the cards follow when gathered (some ABC may come
    // off this device's database), and the worker waits for them before it
    // loads the index. A failure to gather sends none rather than stalling.
    const sources = recognitionSources?.() ?? null;
    this.send({
      type: 'init', sampleRate, hopS: options.hopS, tempo: options.tempo, engine: options.engine ?? recognitionEngine(),
      cards: sources?.cards ?? false, theSession: sources?.theSession ?? true, sourceOrder: sources?.sourceOrder ?? [],
    });
    if (sources?.cards) {
      // On a line of its own beside the worker's step (the user, 2026-11-16):
      // both go on at once. Once read, the count stays only while the worker
      // waits for the cards — until it says its next step.
      let saidAt = 0;
      const onRead = (done: number, total: number) => {
        this.cardsStep = { phase: 'cards', done, total };
        if (done === total) {
          this.cardsRead = true;
          if (this.workerStep) this.cardsStep = null;
        } else if (Date.now() - saidAt < CARDS_READ_EVERY_MS) return;
        saidAt = Date.now();
        this.sayInit();
      };
      void sources.gatherCards(onRead).catch((e: unknown) => { console.warn('[recognition] cards not gathered', e); return []; })
        .then(tunes => this.send({ type: 'cards', tunes }));
    }
  }

  /** Nothing when there is nothing to say: the worker waits, and the cards'
   *  first count has not come yet — the line keeps what it said. */
  private sayInit(): void {
    const steps = [this.workerStep, this.cardsStep].filter((s): s is IndexProgress => s !== null);
    if (steps.length) this.cb.onIndexProgress?.(steps);
  }

  private send(msg: FFWorkerRequest, transfer?: Transferable[]): void {
    this.worker.postMessage(msg, transfer ?? []);
  }

  /** Hand the audio worklet's MessagePort to the worker (live pipeline hot path). */
  connectWorkletPort(port: MessagePort): void {
    this.send({ type: 'worklet-port', port }, [port]);
  }

  /** Tells the worker a manual pause just ended, so its wall-clock drift
   *  correction (#16) doesn't mistake the pause itself for lost audio. */
  notifyLiveResume(): void {
    this.send({ type: 'live-resume' });
  }

  /** Feed a PCM chunk; resolves once the worker has absorbed it (backpressure). */
  feedPcmWithAck(chunk: Float32Array): Promise<void> {
    return new Promise(resolve => {
      this.ackQueue.push(resolve);
      const buffer = chunk.buffer as ArrayBuffer;
      this.send({ type: 'pcm', buffer, ack: true }, [buffer]);
    });
  }

  /** End the stream: flushes the aggregator, returns closing events. */
  stop(): Promise<{ events: DetectionEvent[]; tFinal: number }> {
    return new Promise(resolve => {
      this.stopDone = resolve;
      this.send({ type: 'stop' });
    });
  }

  dispose(): void {
    this.worker.terminate();
    // Unblock any source still awaiting an ack.
    this.ackQueue.forEach(fn => fn());
    this.ackQueue = [];
  }
}
