import type { AppState } from '../types';

export const SCHEMA_VERSION = 1;

// Each entry migrates from version N to N+1.
// Use `Record<string, unknown>` to handle partially-typed legacy shapes.
const migrations: Array<(s: Record<string, unknown>) => void> = [
  // V0 → V1: baseline schema, no structural changes needed.
];

/**
 * Runs all pending migrations on `state` in place, then stamps schemaVersion.
 * Safe to call on IndexedDB data, Drive data, and imported JSON files.
 */
export function migrateState(state: AppState): void {
  const from = state.schemaVersion ?? 0;
  for (let v = from; v < SCHEMA_VERSION; v++) {
    migrations[v]?.(state as unknown as Record<string, unknown>);
  }
  state.schemaVersion = SCHEMA_VERSION;
}
