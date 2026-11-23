import init from '../../../vendor/folkfriend/folkfriend.js';

// ── Loading FolkFriend's module, SIMD where the browser has it ──────────────
// Two builds of the same engine, bit-identical in their results (vendor/folkfriend/README.md):
// the SIMD one scores four index candidates per vector instruction, and takes the medians of
// the harmonic/percussive separation four at a time. Shared by the recognition worker
// (ffWorker.ts, ~1.7x faster overall) and the score following worker (scoreFollowWorker.ts,
// 2026-11-23): there the transcription of 6 minutes took 2.8 s with the scalar build and
// 1.1 s with SIMD in Node, its notes and ABC identical, and the score following's cleaned
// features came out identical bit for bit.

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

/** Instantiates the module — the SIMD build when the browser takes it, the scalar one
 *  otherwise. True when SIMD was loaded. */
export async function initFolkFriend(): Promise<boolean> {
  // Both URLs are written out literally so the bundler emits both files; only the chosen
  // one is ever fetched.
  const scalarUrl = new URL('../../../vendor/folkfriend/folkfriend_bg.wasm', import.meta.url);
  const simdUrl = new URL('../../../vendor/folkfriend/folkfriend_bg_simd.wasm', import.meta.url);
  if (supportsSimd()) {
    try {
      await init(simdUrl);
      return true;
    } catch {
      // Belt and braces: if the probe is ever wrong, or a browser validates
      // SIMD but refuses this particular module, fall back rather than leave
      // the feature dead. Safe to retry — the glue only latches its instance
      // on success, so a failed init leaves nothing behind.
    }
  }
  await init(scalarUrl);
  return false;
}
