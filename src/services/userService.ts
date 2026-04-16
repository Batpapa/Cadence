import type { AppState, User } from '../types';
import { generateId } from '../utils';

const DEFAULT_USER: Omit<User, 'id'> = {
  name: 'Moi',
  masteryThreshold: 0.9,
  weightByImportance: true,
};

/** Ensure at least one user exists; set currentUserId if missing. Mutates state in place. */
export function ensureCurrentUser(state: AppState): void {
  const ids = Object.keys(state.users);
  if (ids.length === 0) {
    const id = generateId();
    state.users[id] = { id, ...DEFAULT_USER };
    state.currentUserId = id;
  } else if (!state.currentUserId || !state.users[state.currentUserId]) {
    state.currentUserId = ids[0]!;
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
