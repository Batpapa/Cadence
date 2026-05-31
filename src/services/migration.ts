import type { AppState, User } from '../types';
import { ensureCurrentUser, ensureCurrentProfile } from './userService';

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
export function migrateState(user: AppState): void {
  const from = user.schemaVersion ?? 0;
  for (let v = from; v < SCHEMA_VERSION; v++) {
    migrations[v]?.(user as unknown as Record<string, unknown>);
  }
  user.schemaVersion = SCHEMA_VERSION;
}

/**
 * Applies external data (Drive or file import) onto the current user.
 * Handles both old AppState format and new User format.
 * Always preserves the current user's id.
 */
export function applyExternalData(raw: Record<string, unknown>, currentId: string): User {
  let user: User;
  if ('users' in raw && 'currentUserId' in raw) {
    // Old multi-user AppState format
    migrateState(raw as unknown as AppState);
    user = migrateLegacyToUser(raw);
  } else {
    // New User format
    migrateState(raw as unknown as AppState);
    user = raw as unknown as User;
  }
  const result = { ...user, id: currentId };
  ensureCurrentUser(result);
  ensureCurrentProfile(result);
  return result;
}

/**
 * Converts the old AppState format (multi-user blob) to the new User format.
 * Run migrateState on the raw old state before calling this.
 */
export function migrateLegacyToUser(raw: Record<string, unknown>): User {
  const currentUserId = raw['currentUserId'] as string ?? '';
  const oldUsers = raw['users'] as Record<string, Record<string, unknown>> ?? {};
  const oldUser  = oldUsers[currentUserId] ?? {};

  // Strip legacy userId field from folders
  const rawFolders = (raw['folders'] as Record<string, Record<string, unknown>>) ?? {};
  const folders: User['folders'] = {};
  for (const [fid, f] of Object.entries(rawFolders)) {
    const { userId: _userId, ...rest } = f as Record<string, unknown> & { userId?: unknown };
    folders[fid] = rest as unknown as User['folders'][string];
  }

  return {
    id:                   currentUserId,
    name:                 'Default',
    language:             (oldUser['language'] as User['language']) ?? 'en',
    availabilityThreshold:(oldUser['availabilityThreshold'] as number) ?? 0.9,
    weightByImportance:   (oldUser['weightByImportance'] as boolean) ?? true,
    profileIds:           (oldUser['profileIds'] as string[]) ?? [],
    currentProfileId:     raw['currentProfileId'] as string ?? '',
    profiles:             (raw['profiles'] as User['profiles']) ?? {},
    cards:                (raw['cards']   as User['cards'])    ?? {},
    decks:                (raw['decks']   as User['decks'])    ?? {},
    cardWorks:            (raw['cardWorks'] as User['cardWorks']) ?? {},
    folders,
    rootFolderIds:        (raw['rootFolderIds'] as string[]) ?? [],
    rootDeckIds:          (raw['rootDeckIds']   as string[]) ?? [],
    schemaVersion:        raw['schemaVersion'] as number | undefined,
  };
}
