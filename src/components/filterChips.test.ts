import { describe, it, expect } from 'vitest';
import { folderChipKey, folderIdOfChip, knownChips, coveredByFolders, folderChipLabels } from './filterChips';
import type { FilterState } from '../types';

const chips = (...e: [string, FilterState][]) => new Map(e);

describe('folder chip keys', () => {
  it('round-trips a folder id, and names no folder for any other chip', () => {
    expect(folderIdOfChip(folderChipKey('abc'))).toBe('abc');
    expect(folderIdOfChip('abc')).toBeNull();
    expect(folderIdOfChip('__no_deck__')).toBeNull();
  });
});

describe('knownChips', () => {
  it('ignores a chip whose target no longer exists', () => {
    const c = chips(['d1', 'include'], ['gone', 'exclude'], [folderChipKey('f-gone'), 'include']);
    expect([...knownChips(c, k => k === 'd1')]).toEqual([['d1', 'include']]);
  });

  it('hands back the very same map when every chip is known', () => {
    const c = chips(['d1', 'include']);
    expect(knownChips(c, () => true)).toBe(c);
  });

  it('never touches the map it reads', () => {
    const c = chips(['d1', 'include'], ['gone', 'include']);
    knownChips(c, k => k === 'd1');
    expect(c.size).toBe(2);
  });
});

describe('coveredByFolders', () => {
  // Hiver ⊃ Mardis ⊃ s1 ; Hiver ⊃ s2 ; s3 at the root.
  const above: Record<string, string[]> = {
    s1: [folderChipKey('hiver'), folderChipKey('mardis')],
    s2: [folderChipKey('hiver')],
    s3: [],
    [folderChipKey('hiver')]: [],
    [folderChipKey('mardis')]: [folderChipKey('hiver')],
  };
  const keys = Object.keys(above);
  const covered = (c: Map<string, FilterState>) => [...coveredByFolders(keys, k => above[k] ?? [], c)].sort();

  it('covers everything below an included folder, sub-folders and their contents too', () => {
    expect(covered(chips([folderChipKey('hiver'), 'include']))).toEqual([folderChipKey('mardis'), 's1', 's2'].sort());
  });

  it('covers only what is below, never the folder itself nor what sits beside it', () => {
    expect(covered(chips([folderChipKey('mardis'), 'include']))).toEqual(['s1']);
  });

  it('covers nothing for an excluded folder, or for an included chip that is not a folder', () => {
    expect(covered(chips([folderChipKey('hiver'), 'exclude']))).toEqual([]);
    expect(covered(chips(['s3', 'include']))).toEqual([]);
  });
});

describe('folderChipLabels', () => {
  const names: Record<string, string> = { a: 'Mardis', b: 'Mardis', c: 'Été' };
  const paths: Record<string, string> = { a: 'Hiver / Mardis', b: 'Été / Mardis', c: 'Été' };

  it('uses the name, and the path only where two names collide', () => {
    const labels = folderChipLabels(['a', 'b', 'c'], id => names[id]!, id => paths[id]!);
    expect(labels.get('a')).toBe('Hiver / Mardis');
    expect(labels.get('b')).toBe('Été / Mardis');
    expect(labels.get('c')).toBe('Été');
  });
});
