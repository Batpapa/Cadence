import type { AppState } from '../types';

export const SCHEMA_VERSION = 2;

// Each entry migrates from version N to N+1.
// Use `Record<string, unknown>` to handle partially-typed legacy shapes.
const migrations: Array<(s: Record<string, unknown>) => void> = [
  // V0 → V1: baseline schema, no structural changes needed.
  () => {},
  // V1 → V2: merge files[] + embeds[] into attachments[] on each card.
  (s) => {
    const cards = s['cards'] as Record<string, Record<string, unknown>>;
    for (const card of Object.values(cards ?? {})) {
      const content = card['content'] as Record<string, unknown>;
      if (!content) continue;
      const files  = (content['files']  as Array<Record<string, unknown>>) ?? [];
      const embeds = (content['embeds'] as Array<Record<string, unknown>>) ?? [];
      content['attachments'] = [
        ...files.map(f  => ({ type: 'file',  ...f })),
        ...embeds.map(e => ({ type: 'embed', ...e })),
      ];
      delete content['files'];
      delete content['embeds'];
    }
  },
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
