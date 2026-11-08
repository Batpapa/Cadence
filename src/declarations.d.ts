declare module '*.css';

/** A file's text (webpack `asset/source`, Vite's `?raw`). */
declare module '*?raw' {
  const source: string;
  export default source;
}

/** libheif-js's WASM bundle (services/heicWorker.ts): only what is used of
 *  its JS wrapper (libheif's post.js), which its own typings do not cover. */
interface HeifImage {
  is_primary(): boolean;
  get_width(): number;
  get_height(): number;
  display(target: ImageData, done: (filled: ImageData | null) => void): void;
  free(): void;
}
interface HeifDecoder {
  decode(bytes: Uint8Array): HeifImage[];
}
declare module 'libheif-js/libheif-wasm/libheif-bundle.mjs' {
  const factory: () => { HeifDecoder: new () => HeifDecoder };
  export default factory;
}

/** Injected at build time by webpack's DefinePlugin (see buildInfo() in
 *  webpack.config.js), and by vitest's `define` under test. */
declare const __APP_VERSION__: { version: string; commit: string; dirty: boolean; build: string };

/** Webpack's runtime base URL for chunks, the worker and the WASM — assigned
 *  only by thesessionEmbed/publicPath.ts. */
declare let __webpack_public_path__: string;
