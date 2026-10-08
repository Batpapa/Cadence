declare module '*.css';

/** A file's text (webpack `asset/source`, Vite's `?raw`). */
declare module '*?raw' {
  const source: string;
  export default source;
}

/** Injected at build time by webpack's DefinePlugin (see buildInfo() in
 *  webpack.config.js), and by vitest's `define` under test. */
declare const __APP_VERSION__: { version: string; commit: string; dirty: boolean; build: string };
