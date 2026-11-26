# transcriptor

Cadence's note decoder: it listens to a recording and writes down the notes that are played.
It powers two features:
- the hidden **transcription** (audio to ABC);
- the **recognition** of tunes in recordings, live or imported. FolkFriend's own decoder, which did
  this job before, stays behind a hidden switch so the two can be compared.

Nothing in it is specific to one musical style.

## How it hears

1. **Spectral analysis** (`src/spectrum.ts`, and the same steps in Rust under `rust/`). Two
   short-time Fourier transforms, each with its own job:
   - **for time**: a short window every 5 ms gives the onset function (SuperFlux). From the same
     window, an enhanced autocorrelation also gives pitch evidence;
   - **for pitch**: a long window gives spectral peaks with their instantaneous frequencies. Each
     peak is kept only where the harmonic/percussive separation calls it harmonic.
2. **Salience** (`src/salience.ts`): every peak votes for the fundamentals it could be a harmonic
   of. The votes are folded into the 12 pitch classes, so instruments playing the tune in
   different registers add up instead of competing. A sustained background (drone,
   accompaniment) is subtracted, note by note.
3. **Segmental decoding** (`src/decoder.ts`). The onset peaks propose dense candidate note
   boundaries. A dynamic programme then chooses which candidates are real boundaries, and what
   each segment is: one of the 12 classes, or a rest. It scores:
   - each segment by the salience of its class over the whole note;
   - each boundary by the strength of the onset there;
   - a repeated class only when it has a real attack.

   Each note keeps the energy of its class at every octave, which the caller uses to place it in
   its register.
4. **Optional extra view.** The decoder can read one more per-frame view of the 12 classes
   (`ClassView`). In Cadence this is FolkFriend's cleaned energies, folded by
   `src/folkfriendView.ts`. The decoder itself knows nothing of FolkFriend.

`src/recognition.ts` turns a 10-second window's notes into FolkFriend's query: one pitch class
per quaver, with the tempo chosen per window. It also decodes the same analysis in other ways,
which give other opinions on the window.

## Layout

| | |
|---|---|
| `src/fft.ts`, `src/spectrum.ts` | FFT and the two analyses (peaks, onset function, autocorrelation, tuning) |
| `src/salience.ts`, `src/onsets.ts` | harmonic summation into pitch classes; onset helpers |
| `src/decoder.ts` | `analyseAudio`, `decode`, `hear`, `transcribeNotes`, `resample` |
| `src/recognition.ts` | `recognitionContour`: a window as the recogniser's query, and its other opinions |
| `src/folkfriendView.ts` | FolkFriend's cleaned energies folded into a class view (`classView`, `CLEAN_VIEW`) |
| `src/*.test.ts`, `src/golden.ts` | tests, run with Cadence's (`npm test`); `golden.test.ts` freezes what a reference signal is heard as |
| `rust/` | `spectrum.ts`'s analysis in Rust, built to WebAssembly (scalar and SIMD) |
| `bench/` | measurement scripts (see below) |

## Using it from Cadence

Cadence imports `src/` as it is. Imports here carry their `.ts` extension, so that Node can run
the files directly. TypeScript rewrites them to `.js` (`rewriteRelativeImportExtensions` in
Cadence's `tsconfig.json`), and webpack resolves them back to the `.ts` files (`extensionAlias`
in `webpack.config.js`). `ts-prune` cannot follow these imports, so it skips this folder
(`.ts-prunerc`).

In Cadence:
- `src/session/recognition/transcriptorEngine.ts` is the recognition engine built on this
  decoder (`windowEngine.ts` describes both engines);
- `src/session/recognition/folkfriendView.ts` runs FolkFriend for the extra view;
- `src/session/recognition/scoreFollowWorker.ts` writes the hidden transcription.

The WebAssembly analysis is loaded by `src/session/recognition/transcriptorInit.ts`. It uses the
SIMD build where the browser supports it, then the scalar build, then the TypeScript analysis if
neither loads. Results are the same within float rounding.

## Building the WebAssembly analysis

You need Rust and `wasm-pack`. From `transcriptor/rust`:

```
wasm-pack build --target web --release --out-dir pkg-web
RUSTFLAGS="-C target-feature=+simd128" wasm-pack build --target web --release --out-dir pkg-web-simd
```

Then copy into `vendor/cadence-transcriptor/`:
- from `pkg-web`: `cadence_transcriptor.js`, `cadence_transcriptor.d.ts`,
  `cadence_transcriptor_bg.wasm` and `cadence_transcriptor_bg.wasm.d.ts`;
- from `pkg-web-simd`: `cadence_transcriptor_bg.wasm`, renamed `cadence_transcriptor_bg_simd.wasm`.

The JavaScript glue is the same for both builds.

The benches use a Node build:

```
RUSTFLAGS="-C target-feature=+simd128" wasm-pack build --target nodejs --release --out-dir pkg-node-simd
```

`rust/target/` and every `rust/pkg-*/` folder are build outputs, ignored by git.

## Running it in Node

The sources run as they are under Node 23.6 or later, which strips types itself (22.6 needs
`--experimental-strip-types`). `src/package.json` declares ES modules, and imports carry their
`.ts` extension. For example:

```js
const D = await import('./transcriptor/src/decoder.ts');
const notes = D.transcribeNotes(pcm48k, 48000);
```

## Benches

The scripts in `bench/` measure the decoder against annotated recordings, transcriptions and
FolkFriend. They need audio, ground truth and FolkFriend's fork, which live outside this repository, in
the folder around it (`bench/paths.js`: `transcription-bench/`, `folkfriend-src/`). They
do not run from a fresh clone alone. Their caches go to `out/`, which git ignores.

## Licence

AGPL-3.0, like the rest of Cadence (see `LICENSE` at the root of the repository). Two pieces come
from FolkFriend (GPL-3.0, github.com/TomWyllie/folkfriend):
- the interval model in `decoder.ts`;
- the tempo choice of `recognition.ts`, ported from its `contour.rs`.
