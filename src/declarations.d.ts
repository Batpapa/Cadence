declare module '*.css';

/** Injected at build time by webpack's DefinePlugin (see buildInfo() in
 *  webpack.config.js), and by vitest's `define` under test. */
declare const __APP_VERSION__: { version: string; commit: string; dirty: boolean; build: string };
