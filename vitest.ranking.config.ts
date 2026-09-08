import { defineConfig } from 'vitest/config';

// The ranking study decodes six sessions across many transforms and floors —
// minutes, not seconds. Kept out of the normal run for the same reason as the
// threshold sweep: it is a measurement, not a test.
export default defineConfig({
  test: {
    include: ['experiments/ranking-study/*.test.ts'],
    testTimeout: 3_600_000,
    hookTimeout: 3_600_000,
    disableConsoleIntercept: true,
  },
});
