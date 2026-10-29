// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { ensureCurrentProfile, navLabels, NAV_LABELS_BY_DEFAULT } from './userService';
import type { User } from '../types';

// The first profile is named in the user's language (2026-09-17): a French user
// used to find "Default" in the header from the very first screen.

const bare = (language: 'en' | 'fr'): User => ({ id: 'u1', language } as User);

describe('ensureCurrentProfile', () => {
  it('names the first profile in the user language', () => {
    const fr = bare('fr');
    ensureCurrentProfile(fr);
    expect(fr.profiles[fr.currentProfileId]?.name).toBe('Défaut');

    const en = bare('en');
    ensureCurrentProfile(en);
    expect(en.profiles[en.currentProfileId]?.name).toBe('Default');
  });

  it('leaves an existing profile name alone, whatever it is', () => {
    const user = { ...bare('fr'), profileIds: ['p1'], profiles: { p1: { id: 'p1', name: 'Default' } }, currentProfileId: 'p1' } as User;
    ensureCurrentProfile(user);
    expect(user.profiles.p1?.name).toBe('Default');
  });
});

describe('navLabels', () => {
  it('shows the labels when nothing is stored', () => {
    expect(NAV_LABELS_BY_DEFAULT).toBe(true);
    expect(navLabels({})).toBe(true);
  });
  it('reads a stored choice either way', () => {
    expect(navLabels({ navLabels: false })).toBe(false);
    expect(navLabels({ navLabels: true })).toBe(true);
  });
});
