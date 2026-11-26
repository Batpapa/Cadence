import init, { Analyzer } from '../../../vendor/cadence-transcriptor/cadence_transcriptor.js';
import { useAnalysis } from '../../../transcriptor/src/decoder.ts';
import type { AnalysisOptions, Peaks } from '../../../transcriptor/src/spectrum.ts';
import { supportsSimd } from './folkfriendInit';

// ── The transcription's spectral analysis in WebAssembly ─────────────────────
// transcriptor/src/spectrum.ts's analysis, the same steps compiled from Rust (transcriptor/rust,
// built with wasm-pack --target web, a SIMD build and a scalar one, as FolkFriend's): twice
// as fast, the notes it leads to 99.7 % the same as the TypeScript one's on session
// recordings (within float rounding; transcriptor/bench/native-parity.js). Loaded
// once, SIMD where the browser has it; if neither build loads, the TypeScript analysis stays.

let ready: Promise<boolean> | null = null;

/** True when the WebAssembly analysis is in use. */
export function initTranscriptor(): Promise<boolean> {
  ready ??= (async () => {
    // Both URLs written out literally so the bundler emits both files; only one is fetched.
    const scalarUrl = new URL('../../../vendor/cadence-transcriptor/cadence_transcriptor_bg.wasm', import.meta.url);
    const simdUrl = new URL('../../../vendor/cadence-transcriptor/cadence_transcriptor_bg_simd.wasm', import.meta.url);
    try {
      if (supportsSimd()) {
        try { await init(simdUrl); } catch { await init(scalarUrl); }
      } else await init(scalarUrl);
    } catch {
      return false;
    }
    useAnalysis(nativeAnalyse);
    return true;
  })();
  return ready;
}

/** Samples handed to the module at a time: the recording is never copied into it whole (its
 *  memory never shrinks: 6 minutes whole took 225 MB more). */
const CHUNK_SECONDS = 10;

/** spectrum.ts's analyse, run by the module: the same options, the same result. */
export function nativeAnalyse(pcm: Float32Array, rate: number, o: AnalysisOptions): Peaks {
  const a = new Analyzer(rate, o.size ?? 2048, o.hop ?? 256, o.floorDb ?? 50, o.fmin ?? 60, o.fmax ?? 8000,
    o.hpssTime ?? 0, o.hpssFreq ?? 9, o.acf ?? false, o.acfEvery ?? 1, o.peaks ?? true, o.fluxLag ?? 1, o.maxPeaks ?? 0);
  const chunk = Math.round(CHUNK_SECONDS * rate);
  for (let i = 0; i < pcm.length; i += chunk) {
    a.push(pcm.subarray(i, i + chunk));
    o.progress?.(Math.min(1, (i + chunk) / pcm.length));
  }
  const s = a.finish();
  try {
    const p: Peaks = {
      rate, hop: o.hop ?? 256, frames: s.frames(), start: s.start(), freq: s.freq(), mag: s.mag(),
      energy: s.energy(), flux: s.flux(),
      ...(o.acf ? { acf: s.acf(), acfLow: 40, acfNotes: 61 } : {}),
    };
    o.progress?.(1);
    return p;
  } finally {
    s.free();
  }
}
