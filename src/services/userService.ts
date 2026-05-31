import type { User } from '../types';
import type { Lang } from './i18nService';
import { generateId } from '../utils';

const SUPPORTED_LANGS: Lang[] = ['en', 'fr'];

export function detectLanguage(): Lang {
  const code = (navigator.language ?? 'en').split('-')[0]!.toLowerCase();
  return (SUPPORTED_LANGS.includes(code as Lang) ? code : 'en') as Lang;
}

/** Ensure all required fields are present on the user. Mutates in place. */
export function ensureCurrentUser(user: User): void {
  if (!user.id)       user.id       = generateId();
  if (!user.name)     user.name     = 'Default';
  if (!user.language) user.language = detectLanguage();
  if (user.availabilityThreshold === undefined) user.availabilityThreshold = 0.9;
  if (user.weightByImportance    === undefined) user.weightByImportance    = true;
  if (!user.profileIds)   user.profileIds   = [];
  if (!user.profiles)     user.profiles     = {};
  if (!user.cards)        user.cards        = {};
  if (!user.decks)        user.decks        = {};
  if (!user.cardWorks)    user.cardWorks    = {};
  if (!user.folders)      user.folders      = {};
  if (!user.rootFolderIds) user.rootFolderIds = [];
  if (!user.rootDeckIds)   user.rootDeckIds   = [];
}

/** Ensure the user has at least one profile and a valid currentProfileId. */
export function ensureCurrentProfile(user: User): void {
  if (!user.profiles)   user.profiles   = {};
  if (!user.profileIds) user.profileIds = [];

  if (user.profileIds.length === 0) {
    const profileId = `${user.id}-default`;
    user.profiles[profileId] = { id: profileId, name: 'Default' };
    user.profileIds          = [profileId];
    user.currentProfileId    = profileId;
  } else if (!user.currentProfileId || !user.profiles[user.currentProfileId]) {
    user.currentProfileId = user.profileIds[0]!;
  }
}

export function updateUser(user: User, patch: Partial<Omit<User, 'id'>>): void {
  Object.assign(user, patch);
}
