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

```sh
git clone https://github.com/TomWyllie/folkfriend
cd folkfriend/rust

# The committed Cargo.lock pins wasm-bindgen 0.2.81, which modern rustc refuses
# to compile. Bump it to the oldest compatible non-yanked version:
cargo update -p wasm-bindgen --precise 0.2.92

wasm-pack build --target web --release

cp pkg/folkfriend.js pkg/folkfriend.d.ts pkg/folkfriend_bg.wasm pkg/folkfriend_bg.wasm.d.ts \
   <cadence>/vendor/folkfriend/
```

Built 2026-07-15 from master (folkfriend v1.3.0, rustc 1.97.0, wasm-pack 0.15.0).

## Tune index

The recognition index (~34 MB JSON, mapping directly to TheSession.org tune IDs) is
**not** vendored; it is downloaded at runtime and cached in IndexedDB. See
`src/session/recognition/indexStore.ts`. Source:
`https://raw.githubusercontent.com/TomWyllie/folkfriend-app-data/master/public/folkfriend-non-user-data.json`
(version metadata in `nud-meta.json` next to it).
