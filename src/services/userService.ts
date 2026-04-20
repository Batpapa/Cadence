import type { AppState, Profile, User } from '../types';
import type { Lang } from './i18nService';
import { generateId } from '../utils';

const SUPPORTED_LANGS: Lang[] = ['en', 'fr'];

function detectLanguage(): Lang {
  const code = (navigator.language ?? 'en').split('-')[0]!.toLowerCase();
  return (SUPPORTED_LANGS.includes(code as Lang) ? code : 'en') as Lang;
}

const DEFAULT_USER: Omit<User, 'id' | 'language'> = {
  availabilityThreshold: 0.9,
  weightByImportance: true,
  profileIds: [],
};

/** Ensure at least one user exists; set currentUserId if missing. Mutates state in place. */
export function ensureCurrentUser(state: AppState): void {
  const ids = Object.keys(state.users);
  if (ids.length === 0) {
    const id = generateId();
    state.users[id] = { id, ...DEFAULT_USER, language: detectLanguage() };
    state.currentUserId = id;
  } else if (!state.currentUserId || !state.users[state.currentUserId]) {
    state.currentUserId = ids[0]!;
  }
}

/** Ensure the current user has at least one profile; set currentProfileId if missing. */
export function ensureCurrentProfile(state: AppState): void {
  if (!state.profiles) state.profiles = {};
  const user = state.users[state.currentUserId];
  if (!user) return;
  if (!user.profileIds) user.profileIds = [];

  if (user.profileIds.length === 0) {
    const profileId = `${state.currentUserId}-default`;
    const profile: Profile = { id: profileId, name: 'Default' };
    state.profiles[profileId] = profile;
    user.profileIds = [profileId];
    state.currentProfileId = profileId;
  } else if (!state.currentProfileId || !state.profiles[state.currentProfileId]) {
    state.currentProfileId = user.profileIds[0]!;
  }
}

export function getCurrentUser(state: AppState): User {
  const user = state.users[state.currentUserId];
  if (!user) throw new Error('No current user');
  return user;
}


export function updateUser(state: AppState, patch: Partial<Omit<User, 'id'>>): void {
  const user = state.users[state.currentUserId];
  if (!user) return;
  Object.assign(user, patch);
}
