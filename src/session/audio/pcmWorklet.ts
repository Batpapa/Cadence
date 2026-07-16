import { WORKLET_CHUNK_SAMPLES } from '../sessionConfig';

// ── PCM forwarding AudioWorklet ───────────────────────────────────────────────
// The processor does NO computation: it accumulates 128-sample render quanta
// and posts transferable Float32Array chunks straight to the recognition
// worker through a dedicated MessagePort — the main thread stays out of the
// hot loop. The processor source is inlined as a Blob URL so no extra webpack
// entry/asset configuration is needed.

const PROCESSOR_NAME = 'cadence-pcm-forwarder';

const PROCESSOR_SOURCE = `
class PcmForwarder extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.chunkSize = options.processorOptions.chunkSize;
    this.buf = new Float32Array(this.chunkSize);
    this.fill = 0;
    this.out = this.port;
    this.port.onmessage = (e) => {
      if (e.data && e.data.port) this.out = e.data.port;
    };
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    let i = 0;
    while (i < ch.length) {
      const n = Math.min(ch.length - i, this.chunkSize - this.fill);
      this.buf.set(ch.subarray(i, i + n), this.fill);
      this.fill += n;
      i += n;
      if (this.fill === this.chunkSize) {
        const copy = this.buf.slice(0);
        this.out.postMessage(copy.buffer, [copy.buffer]);
        this.fill = 0;
      }
    }
    return true;
  }
}
registerProcessor('${PROCESSOR_NAME}', PcmForwarder);
`;

let moduleUrl: string | null = null;

/**
 * Attaches a PCM-forwarding worklet to the stream and wires its output port.
 * Returns the node and the AudioContext (caller owns both lifecycles).
 * `workerPort` should be one end of a MessageChannel whose other end went to
 * the recognition worker.
 */
export async function attachPcmWorklet(
  audioContext: AudioContext,
  stream: MediaStream,
  workerPort: MessagePort,
): Promise<AudioWorkletNode> {
  if (!moduleUrl) {
    moduleUrl = URL.createObjectURL(new Blob([PROCESSOR_SOURCE], { type: 'application/javascript' }));
  }
  await audioContext.audioWorklet.addModule(moduleUrl);

  const source = audioContext.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(audioContext, PROCESSOR_NAME, {
    numberOfInputs: 1,
    numberOfOutputs: 0,
    processorOptions: { chunkSize: WORKLET_CHUNK_SAMPLES },
  });
  node.port.postMessage({ port: workerPort }, [workerPort]);
  source.connect(node);
  return node;
}
