import { defineConfig, configDefaults } from 'vitest/config';

// Node 25+ puts its own `localStorage` on globalThis, and without
// --localstorage-file it reads `undefined`. Vitest's jsdom environment copies
// the window onto the global but skips any name the global already has (bar a
// fixed list that does not include localStorage), so jsdom's storage never
// lands and the code under test reads Node's empty one. Measured 2026-09-17 on
// Node 26.8.2 with vitest 4.1.10: the three jsdom files that import the store —
// driveService reads localStorage at module evaluation — failed before a single
// test ran.
//
// Turning Node's Web Storage off in the workers leaves the name free for jsdom.
// Only when this Node actually defines it: the flag does not exist before Node
// 22.4, where passing it would stop every worker from starting.
const nodeDefinesLocalStorage = 'localStorage' in globalThis;

// The other reason this file exists: keep experiments/ out of the normal test
// run. experiments/threshold-sweep is a real vitest file (it drives the actual
// detector against the annotated fixtures) but it decodes 7 sessions at 16
// thresholds and takes ~20 minutes — a measurement, not a test. Run it on
// demand with `npm run sweep`.
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, 'experiments/**'],
    execArgv: nodeDefinesLocalStorage ? ['--no-experimental-webstorage'] : [],
  },
});
