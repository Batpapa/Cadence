// ── Where this page's code lives ──────────────────────────────────────────────
// Imported FIRST by main.tsx, so it runs before any module that builds a URL.
//
// The app's public path is '' in production: every chunk, the recognition
// worker and the WASM resolve against the document, which sits next to them at
// the root of the site. This page sits two folders down
// (TuneAnalyser/thesession-embed/), so against the document they would all
// 404. Pointing the runtime at the folder its own script came from works
// wherever the page is served from — GitHub Pages under /Cadence/, the dev
// server at /, a local copy of dist.
//
// document.currentScript is set for classic scripts, deferred ones included,
// which is how html-webpack-plugin loads the bundle.

const script = document.currentScript as HTMLScriptElement | null;
if (script?.src) __webpack_public_path__ = new URL('.', script.src).href;
