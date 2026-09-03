import { describe, it, expect } from 'vitest';
import { setExternalId, parseSetExternalId } from './theSessionService';
import { externalSourceLink } from '../utils';

describe('a set is identified by (member, set), not by set alone', () => {
  it('round-trips', () => {
    expect(parseSetExternalId(setExternalId(1, 147730))).toEqual({ memberId: 1, setId: 147730 });
  });

  it('uses a DASH, never a second colon', () => {
    // Load-bearing: several places test startsWith('thesession:') and then
    // parseInt the rest. "thesession:set:147730" would pass that test and hand
    // them NaN; the dash form is correctly excluded from those tune-only paths.
    const id = setExternalId(1, 147730);
    expect(id).toBe('thesession-set:1-147730');
    expect(id.startsWith('thesession:')).toBe(false);
  });

  it('refuses anything that is not a set id', () => {
    expect(parseSetExternalId('thesession:1197')).toBeNull();
    expect(parseSetExternalId('irishtuneinfo:42')).toBeNull();
    expect(parseSetExternalId(undefined)).toBeNull();
    expect(parseSetExternalId('thesession-set:nonsense')).toBeNull();
    expect(parseSetExternalId('thesession-set:1')).toBeNull();
  });
});

describe('the set pin', () => {
  it('links to the member-scoped URL, the only one that resolves', () => {
    // thesession.org/sets/147730 is a 404 — the member is part of the address.
    const link = externalSourceLink(setExternalId(1, 147730));
    expect(link?.url).toBe('https://thesession.org/members/1/sets/147730');
  });

  it('shows the set number alone, the member being plumbing', () => {
    const link = externalSourceLink(setExternalId(1, 147730));
    expect(link?.id).toBe('147730');
    expect(link?.label).toBe('TheSession:147730');
  });

  it('leaves a tune link exactly as it was', () => {
    const link = externalSourceLink('thesession:1197');
    expect(link?.url).toBe('https://thesession.org/tunes/1197');
    expect(link?.id).toBe('1197');
  });
});
