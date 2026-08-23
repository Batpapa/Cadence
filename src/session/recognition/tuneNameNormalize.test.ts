import { describe, it, expect } from 'vitest';
import { normalizeDisplayName } from './tuneNameNormalize';

describe('normalizeDisplayName', () => {
  it('moves a trailing ", The" to the front', () => {
    expect(normalizeDisplayName('Kesh, The')).toBe('The Kesh');
  });

  it('moves a trailing ", A" to the front', () => {
    expect(normalizeDisplayName('Silver Spear, A')).toBe('A Silver Spear');
  });

  it('moves a trailing ", An" to the front', () => {
    expect(normalizeDisplayName('Old Bush, An')).toBe('An Old Bush');
  });

  it('leaves a name with no trailing article unchanged', () => {
    expect(normalizeDisplayName('Drowsy Maggie')).toBe('Drowsy Maggie');
  });

  it('leaves a name ending in something that only looks like an article unchanged (no comma)', () => {
    expect(normalizeDisplayName('Behind The Haystack')).toBe('Behind The Haystack');
  });

  it('does not touch a comma NOT immediately followed by a bare article (nothing else may trail)', () => {
    expect(normalizeDisplayName('Kesh, The (reel)')).toBe('Kesh, The (reel)');
  });

  it('preserves the source casing of the moved article', () => {
    expect(normalizeDisplayName('kesh, the')).toBe('the kesh');
  });

  it('only strips the LAST trailing article, keeping an earlier comma-joined part intact', () => {
    expect(normalizeDisplayName('Rakes of Kildare, The')).toBe('The Rakes of Kildare');
  });
});
