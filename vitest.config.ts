import { defineConfig, configDefaults } from 'vitest/config';

// The only reason this file exists: keep experiments/ out of the normal test
// run. experiments/threshold-sweep is a real vitest file (it drives the actual
// detector against the annotated fixtures) but it decodes 7 sessions at 16
// thresholds and takes ~20 minutes — a measurement, not a test. Run it on
// demand with `npm run sweep`.
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, 'experiments/**'],
  },
});
