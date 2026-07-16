import type { FFWorkerRequest, FFWorkerResponse } from './recognition/ffWorker';
import type { AnnotationEvent } from './recognition/aggregator';
import type { IndexProgress } from './recognition/indexStore';
import type { WindowResult } from './model';
import type { RecognitionSink } from './audio/sources';

// ── Main-thread wrapper around the FolkFriend recognition worker ──────────────
// Implements RecognitionSink: PCM sources (mic worklet, decoded file) feed it
// interchangeably — the worker only ever sees a stream of chunks.

export interface RecognitionCallbacks {
  onIndexProgress?: (p: IndexProgress) => void;
  onWindow?: (result: WindowResult, abc: string | null) => void;
  onAnnotations?: (events: AnnotationEvent[]) => void;
  onError?: (message: string) => void;
}

export interface RecognitionOptions {
  /** Analysis hop in seconds — HOP_S_IMPORT for file imports, default for live. */
  hopS?: number;
}

export class RecognitionClient implements RecognitionSink {
  private worker: Worker;
  private cb: RecognitionCallbacks;
  /** Resolves with the FolkFriend version once WASM + index are loaded. */
  readonly ready: Promise<string>;
  private ackQueue: (() => void)[] = [];
  private stopDone: ((r: { events: AnnotationEvent[]; tFinal: number }) => void) | null = null;

  constructor(sampleRate: number, callbacks: RecognitionCallbacks = {}, options: RecognitionOptions = {}) {
    this.cb = callbacks;
    this.worker = new Worker(new URL('./recognition/ffWorker.ts', import.meta.url), { type: 'module' });

    let resolveReady!: (v: string) => void;
    let rejectReady!: (e: Error) => void;
    this.ready = new Promise<string>((res, rej) => { resolveReady = res; rejectReady = rej; });

    // A worker that fails to load or crashes outside a message handler never
    // posts anything — surface it instead of hanging on `ready` forever.
    this.worker.onerror = (e: ErrorEvent) => {
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
        case 'init-progress': this.cb.onIndexProgress?.(msg.progress); break;
        case 'ready':         resolveReady(msg.version); break;
        case 'window':        this.cb.onWindow?.(msg.result, msg.abc); break;
        case 'annotations':   this.cb.onAnnotations?.(msg.events); break;
        case 'pcm-ack':       this.ackQueue.shift()?.(); break;
        case 'stopped':       this.stopDone?.({ events: msg.events, tFinal: msg.tFinal }); this.stopDone = null; break;
        case 'error':         this.cb.onError?.(msg.message); rejectReady(new Error(msg.message)); break;
      }
    };

    this.send({ type: 'init', sampleRate, hopS: options.hopS });
  }

  private send(msg: FFWorkerRequest, transfer?: Transferable[]): void {
    this.worker.postMessage(msg, transfer ?? []);
  }

  /** Hand the audio worklet's MessagePort to the worker (live pipeline hot path). */
  connectWorkletPort(port: MessagePort): void {
    this.send({ type: 'worklet-port', port }, [port]);
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
  stop(): Promise<{ events: AnnotationEvent[]; tFinal: number }> {
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
