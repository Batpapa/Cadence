import type { AppState } from '../types';

export const SCHEMA_VERSION = 4;

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
  // V2 → V3: introduce profiles. Each user gets a default profile; cardWorks are re-keyed.
  (s) => {
    const users = s['users'] as Record<string, Record<string, unknown>> ?? {};
    const currentUserId = s['currentUserId'] as string ?? '';
    const profiles: Record<string, Record<string, unknown>> = {};

    for (const [userId, user] of Object.entries(users)) {
      const profileId = `${userId}-default`;
      profiles[profileId] = { id: profileId, name: 'Default' };
      user['profileIds'] = [profileId];
    }

    s['profiles'] = profiles;
    s['currentProfileId'] = currentUserId ? `${currentUserId}-default` : '';

    // Re-key cardWorks: `${userId}:${cardId}` → `${userId}-default:${cardId}`
    const oldWorks = s['cardWorks'] as Record<string, Record<string, unknown>> ?? {};
    const newWorks: Record<string, Record<string, unknown>> = {};
    for (const [key, work] of Object.entries(oldWorks)) {
      const colonIdx = key.indexOf(':');
      if (colonIdx === -1) continue;
      const userId = key.slice(0, colonIdx);
      const cardId = key.slice(colonIdx + 1);
      const profileId = `${userId}-default`;
      const newKey = `${profileId}:${cardId}`;
      newWorks[newKey] = { ...work, profileId };
      delete newWorks[newKey]['userId'];
    }
    s['cardWorks'] = newWorks;
  },
  // V3 → V4: fix TheSession card tags — "thesession" → "TheSession", capitalise key tags,
  //           leave tune-type tags (reel, jig, etc.) untouched.
  (s) => {
    const TUNE_TYPES = new Set([
      'jig', 'reel', 'slip jig', 'hornpipe', 'polka', 'slide',
      'waltz', 'barndance', 'strathspey', 'three-two', 'mazurka', 'march',
    ]);
    const capitalise = (tag: string) => tag.charAt(0).toUpperCase() + tag.slice(1);

    const cards = s['cards'] as Record<string, Record<string, unknown>>;
    for (const card of Object.values(cards ?? {})) {
      const externalId = card['externalId'] as string | undefined;
      if (!externalId?.startsWith('thesession:')) continue;
      const tags = card['tags'] as string[] | undefined;
      if (!Array.isArray(tags)) continue;
      card['tags'] = tags.map(tag => {
        if (tag === 'thesession') return 'TheSession';
        if (TUNE_TYPES.has(tag)) return tag;
        return capitalise(tag);
      });
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
