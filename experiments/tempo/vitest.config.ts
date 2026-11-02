import * as path from 'node:path';
import { defineConfig } from 'vitest/config';

// The tempo of the detections (detections.test.ts) — a measurement, kept out
// of the normal suite like the threshold sweep (see vitest.config.ts).
export default defineConfig({
  root: path.resolve(__dirname, '../..'),
  define: {
    __APP_VERSION__: JSON.stringify({ version: '0000.00.00', commit: 'test', dirty: false, build: 'test' }),
  },
  test: {
    include: ['experiments/tempo/*.test.ts'],
    testTimeout: 3_600_000,
    disableConsoleIntercept: true,
  },
});
