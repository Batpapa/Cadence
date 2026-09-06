import { defineConfig } from 'vitest/config';

// `npm run sweep` — the threshold measurement, deliberately outside the normal
// suite (see vitest.config.ts). Reads SWEEP_POINTS / SWEEP_AUDIT_ONLY; see
// experiments/threshold-sweep/README.md.
export default defineConfig({
  test: {
    include: ['experiments/threshold-sweep/*.test.ts'],
    testTimeout: 1_800_000,
    disableConsoleIntercept: true,
  },
});
