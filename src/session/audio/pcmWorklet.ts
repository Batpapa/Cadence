import { WORKLET_CHUNK_SAMPLES, DEBUG_LIVE_AUDIO } from '../sessionConfig';

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
    this.debug = options.processorOptions.debug;
    this.buf = new Float32Array(this.chunkSize);
    this.fill = 0;
    this.out = this.port;
    // Pausing gates HERE rather than suspending the AudioContext - see
    // LiveStreamSource.suspend() for why that had to change.
    this.paused = false;
    this.calls = 0;
    this.posts = 0;
    this.hadInput = null;
    this.port.onmessage = (e) => {
      if (!e.data) return;
      if (e.data.port) this.out = e.data.port;
      if (typeof e.data.paused === 'boolean') {
        this.paused = e.data.paused;
        if (this.debug) console.log('[live] worklet paused=' + this.paused + ' t=' + currentTime.toFixed(2));
      }
    };
  }
  process(inputs) {
    this.calls++;
    const ch = inputs[0] && inputs[0][0];
    if (this.debug) {
      const has = !!ch;
      if (has !== this.hadInput) {
        this.hadInput = has;
        console.log('[live] worklet input ' + (has ? 'PRESENT' : 'ABSENT')
          + ' chans=' + (inputs[0] ? inputs[0].length : 'noInput')
          + ' calls=' + this.calls + ' posts=' + this.posts + ' t=' + currentTime.toFixed(2));
      }
      if (this.calls % 750 === 0) {
        console.log('[live] worklet alive calls=' + this.calls + ' posts=' + this.posts
          + ' paused=' + this.paused + ' fill=' + this.fill + ' t=' + currentTime.toFixed(2));
      }
    }
    if (!ch || this.paused) return true;
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
        this.posts++;
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
    // The processor reads inputs[0][0] — channel 0 and nothing else. Left to
    // its defaults ('max'/2) a stereo stream would therefore be analysed as
    // its LEFT CHANNEL ONLY. 'explicit' + channelCount 1 makes Web Audio
    // downmix to mono before the processor sees anything. No-op for the
    // microphone (it already asks for channelCount: 1), load-bearing for a
    // captured tab, which is stereo whether we like it or not.
    channelCount: 1,
    channelCountMode: 'explicit',
    channelInterpretation: 'speakers',
    processorOptions: { chunkSize: WORKLET_CHUNK_SAMPLES, debug: DEBUG_LIVE_AUDIO },
  });
  node.port.postMessage({ port: workerPort }, [workerPort]);
  source.connect(node);
  return node;
}
