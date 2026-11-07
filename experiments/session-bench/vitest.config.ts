import { defineConfig } from 'vitest/config';
import * as nodePath from 'node:path';

// npx vitest run --config experiments/session-bench/vitest.config.ts   (with BENCH_OUT set)
// A measurement, kept out of the normal suite like the sweep.
export default defineConfig({
  root: nodePath.resolve(__dirname, '../..'),
  test: {
    include: ['experiments/session-bench/*.test.ts'],
    testTimeout: 1_800_000,
    disableConsoleIntercept: true,
  },
});
