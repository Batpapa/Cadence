# FolkFriend WASM (vendored)

Compiled WebAssembly build of [FolkFriend](https://github.com/TomWyllie/folkfriend)
by Tom Wyllie — transcription and recognition of traditional instrumental folk music.

**License: GPL-3.0-only** (see `LICENSE`). Cadence uses this library for the
Session recording / tune recognition feature; attribution is shown in the app's
About screen.

## Contents

| File | Role |
|---|---|
| `folkfriend.js` | wasm-bindgen JS glue (`--target web`: `import init, { FolkFriendWASM }`) |
| `folkfriend.d.ts` | TypeScript declarations |
| `folkfriend_bg.wasm` | compiled WASM module (~430 KB) |
| `folkfriend_bg.wasm.d.ts` | raw WASM interface declarations |

## How to rebuild

Prerequisites: Rust toolchain (`rustup`, host `x86_64-pc-windows-gnu` works fine,
no Visual Studio needed), target `wasm32-unknown-unknown`, and `wasm-pack`.

**As of 2026-08-18, the source of truth is the locally-patched fork at
`C:\Perso\IrishMusicExperiments\folkfriend-src`, NOT upstream master** — it
carries the `_debug` export additions described above. Diff against upstream
before assuming a fresh `git clone` is equivalent.

```sh
cd C:\Perso\IrishMusicExperiments\folkfriend-src\rust

# The original committed Cargo.lock pinned wasm-bindgen 0.2.81, which modern
# rustc refuses to compile — already bumped to 0.2.92 and committed in this fork.

wasm-pack build --target web --release

cp pkg/folkfriend.js pkg/folkfriend.d.ts pkg/folkfriend_bg.wasm pkg/folkfriend_bg.wasm.d.ts \
   <cadence>/vendor/folkfriend/
```

(A separate `wasm-pack build --target nodejs --release --out-dir pkg-node`
also exists, used only by the offline noise-study harness in
`Cadence/experiments/noise-study/` — not part of the shipped app.)

Built 2026-07-15 from master (folkfriend v1.3.0, rustc 1.97.0, wasm-pack 0.15.0).

**Rebuilt 2026-08-18** from a locally-patched fork (`C:\Perso\IrishMusicExperiments\folkfriend-src`, not upstream master) — adds two new WASM exports, `transcribe_pcm_buffer_debug()` and `run_transcription_query_debug()`, that surface note/tempo/quantization telemetry and the untruncated candidate list (previously computed internally then discarded). Purely additive: every export that existed before (`transcribe_pcm_buffer`, `run_transcription_query`, etc.) is byte-for-byte unchanged in behavior — verified via `cargo check` + the full Cadence test suite before vendoring. See `src/session/recognition/ffWorker.ts` (now calls the `_debug` variants and populates `WindowResult.debug`) and project memory ("noise signature study", 2026-08-17/18) for why.

## Tune index

The recognition index (~34 MB JSON, mapping directly to TheSession.org tune IDs) is
**not** vendored; it is downloaded at runtime and cached in IndexedDB. See
`src/session/recognition/indexStore.ts`. Source:
`https://raw.githubusercontent.com/TomWyllie/folkfriend-app-data/master/public/folkfriend-non-user-data.json`
(version metadata in `nud-meta.json` next to it).
