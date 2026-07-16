import { describe, it, expect } from 'vitest';
import { FileSource, type RecognitionSink } from './sources';
import { FILE_CHUNK_S } from '../sessionConfig';

// ── FileSource emission logic (decoding is browser-only, PCM is injected) ─────

const RATE = 22050;
const CHUNK = Math.round(FILE_CHUNK_S * RATE);

/** PCM where sample i has value i — lets us verify exact sequencing. */
function rampPcm(seconds: number): Float32Array {
  const pcm = new Float32Array(Math.round(seconds * RATE));
  for (let i = 0; i < pcm.length; i++) pcm[i] = i;
  return pcm;
}

class CollectingSink implements RecognitionSink {
  chunks: Float32Array[] = [];
  acksBeforeResolve = 0; // pending microtasks before each ack, to exercise backpressure
  connectWorkletPort(): void { throw new Error('not used by FileSource'); }
  async feedPcmWithAck(chunk: Float32Array): Promise<void> {
    this.chunks.push(chunk);
    for (let i = 0; i < this.acksBeforeResolve; i++) await Promise.resolve();
  }
}

describe('FileSource', () => {
  it('reports duration from sample count', () => {
    const src = new FileSource(rampPcm(25), RATE);
    expect(src.duration).toBeCloseTo(25);
  });

  it('emits sequential chunks covering the whole signal, last one partial', async () => {
    const pcm = rampPcm(2.5); // 2 full chunks + half chunk
    const src = new FileSource(pcm, RATE);
    const sink = new CollectingSink();
    await src.start(sink);

    expect(sink.chunks).toHaveLength(3);
    expect(sink.chunks[0]!.length).toBe(CHUNK);
    expect(sink.chunks[1]!.length).toBe(CHUNK);
    expect(sink.chunks[2]!.length).toBe(pcm.length - 2 * CHUNK);

    // Sample counter continuity: concatenation reproduces the ramp exactly.
    let expected = 0;
    for (const chunk of sink.chunks) {
      for (let i = 0; i < chunk.length; i++) {
        if (chunk[i] !== expected) throw new Error(`sample ${expected} out of order`);
        expected++;
      }
    }
    expect(expected).toBe(pcm.length);
  });

  it('emits copies — chunks survive the source buffer being reused', async () => {
    const pcm = rampPcm(1);
    const src = new FileSource(pcm, RATE);
    const sink = new CollectingSink();
    await src.start(sink);
    pcm.fill(-1);
    expect(sink.chunks[0]![0]).toBe(0); // untouched by the mutation above
  });

  it('awaits each ack before sending the next chunk (backpressure)', async () => {
    const src = new FileSource(rampPcm(3), RATE);
    let inFlight = 0;
    let maxInFlight = 0;
    const sink: RecognitionSink = {
      connectWorkletPort: () => {},
      feedPcmWithAck: async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise(r => setTimeout(r, 1));
        inFlight--;
      },
    };
    await src.start(sink);
    expect(maxInFlight).toBe(1);
  });

  it('stop() halts emission at the next chunk boundary', async () => {
    const src = new FileSource(rampPcm(10), RATE);
    const sink = new CollectingSink();
    const origFeed = sink.feedPcmWithAck.bind(sink);
    sink.feedPcmWithAck = async (chunk) => {
      await origFeed(chunk);
      if (sink.chunks.length === 2) src.stop();
    };
    await src.start(sink);
    expect(sink.chunks).toHaveLength(2); // not 10
  });

  it('a file shorter than one chunk is emitted as a single partial chunk', async () => {
    const pcm = rampPcm(0.4);
    const src = new FileSource(pcm, RATE);
    const sink = new CollectingSink();
    await src.start(sink);
    expect(sink.chunks).toHaveLength(1);
    expect(sink.chunks[0]!.length).toBe(pcm.length);
  });
});
