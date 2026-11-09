import { describe, it, expect } from 'vitest';
import type { AppState, Card } from '../types';
import {
  tagSegments, tagAncestors, tagChipValues, tagLabel, tagDisplay, isUnderTag, tagTree,
  coveredByTagGroups, tagNodeExists, tagNodeHasChildren, renameTagNode, dissolveTagNode,
  typeTag, keyTag, groupImportTags, renameTagNodeChips, dropTagNodeChips,
} from './tagGroups';

const card = (id: string, tags: string[], externalId?: string): Card => ({
  id, guid: `g-${id}`, name: id, defaultImportance: 1, tags,
  ...(externalId ? { externalId } : {}),
  content: { notes: '', attachments: [] },
});
const state = (...cards: Card[]): AppState =>
  ({ cards: Object.fromEntries(cards.map(c => [c.id, c])) }) as unknown as AppState;

describe('paths', () => {
  it('splits on "::"', () => {
    expect(tagSegments('key::A::minor')).toEqual(['key', 'A', 'minor']);
    expect(tagSegments('reel')).toEqual(['reel']);
  });

  it('reads a tag with an empty segment as one piece, not a path', () => {
    for (const tag of ['a::', '::b', 'a::::b']) expect(tagSegments(tag)).toEqual([tag]);
    expect(tagAncestors('a::')).toEqual([]);
  });

  it('lists the groups above a tag, outermost first', () => {
    expect(tagAncestors('key::A::minor')).toEqual(['key', 'key::A']);
    expect(tagAncestors('reel')).toEqual([]);
  });

  it('gives a card every chip it answers to, once', () => {
    expect(tagChipValues(['key::A::minor', 'key::A::dorian', 'fast']).sort())
      .toEqual(['fast', 'key', 'key::A', 'key::A::dorian', 'key::A::minor']);
  });

  it('labels a chip by its last segment, and shows the whole path elsewhere', () => {
    expect(tagLabel('key::A::minor')).toBe('minor');
    expect(tagDisplay('key::A::minor')).toBe('key › A › minor');
    expect(tagDisplay('reel')).toBe('reel');
  });

  it('knows what lies under a group, and nothing that merely starts like it', () => {
    expect(isUnderTag('key::A::minor', 'key')).toBe(true);
    expect(isUnderTag('key', 'key')).toBe(true);
    expect(isUnderTag('keyboard', 'key')).toBe(false);
    expect(isUnderTag('key::', 'key')).toBe(false);
  });
});

describe('tagTree', () => {
  it('nests groups, groups first then values, alphabetically', () => {
    const tree = tagTree(tagChipValues(['fast', 'key::D::major', 'key::A::minor', 'key::A::dorian', 'type::reel']));
    const show = (ns: ReturnType<typeof tagTree>): unknown => ns.map(n => n.children.length ? [n.id, show(n.children)] : n.id);
    expect(show(tree)).toEqual([
      ['key', [['key::A', ['key::A::dorian', 'key::A::minor']], ['key::D', ['key::D::major']]]],
      ['type', ['type::reel']],
      'fast',
    ]);
  });

  it('builds a group from a key alone, so a pinned chip still has its place', () => {
    expect(tagTree(['key::A::minor']).map(n => n.id)).toEqual(['key']);
  });
});

describe('coveredByTagGroups', () => {
  it('covers what lies under an included group, not the group itself', () => {
    const keys = ['key', 'key::A', 'key::A::minor', 'type', 'type::reel'];
    expect([...coveredByTagGroups(keys, ['key'])].sort()).toEqual(['key::A', 'key::A::minor']);
    expect(coveredByTagGroups(keys, []).size).toBe(0);
  });
});

describe('group queries', () => {
  const cards = [card('a', ['key::A::minor']), card('b', ['key'])];
  it('tells a group from a plain tag', () => {
    expect(tagNodeExists(cards, 'key::A')).toBe(true);
    expect(tagNodeHasChildren(cards, 'key')).toBe(true);
    expect(tagNodeHasChildren(cards, 'key::A::minor')).toBe(false);
    expect(tagNodeExists(cards, 'type')).toBe(false);
  });
});

describe('renameTagNode', () => {
  it('renames a group and everything under it, and leaves the rest', () => {
    const s = state(card('a', ['fast', 'key::A::minor', 'key']), card('b', ['keyboard']));
    expect(renameTagNode(s, 'key', 'tonality')).toBe(1);
    expect(s.cards['a']!.tags).toEqual(['fast', 'tonality::A::minor', 'tonality']);
    expect(s.cards['b']!.tags).toEqual(['keyboard']);
  });

  it('renames a plain tag as before, merging into an existing name in its slot', () => {
    const s = state(card('a', ['Eminor', 'jig', 'Em']), card('b', ['Em', 'reel']));
    expect(renameTagNode(s, 'Em', 'Eminor')).toBe(2);
    expect(s.cards['a']!.tags).toEqual(['Eminor', 'jig']);
    expect(s.cards['b']!.tags).toEqual(['Eminor', 'reel']);
  });

  it('moves a tag into a group by renaming it to a path', () => {
    const s = state(card('a', ['Aminor']));
    renameTagNode(s, 'Aminor', 'key::A::minor');
    expect(s.cards['a']!.tags).toEqual(['key::A::minor']);
  });

  it('does nothing for an empty or unchanged name', () => {
    const s = state(card('a', ['jig']));
    expect(renameTagNode(s, 'jig', '')).toBe(0);
    expect(renameTagNode(s, 'jig', 'jig')).toBe(0);
  });
});

describe('dissolveTagNode', () => {
  it('moves what is under a group up one level', () => {
    const s = state(card('a', ['key::A::minor', 'key::A', 'key::D::major']));
    expect(dissolveTagNode(s, 'key::A')).toBe(1);
    expect(s.cards['a']!.tags).toEqual(['key::minor', 'key', 'key::D::major']);
  });

  it('turns a top-level group back into plain tags, dropping the group tag itself', () => {
    const s = state(card('a', ['type::reel', 'type', 'fast']));
    dissolveTagNode(s, 'type');
    expect(s.cards['a']!.tags).toEqual(['reel', 'fast']);
  });

  it('merges values that meet after the move', () => {
    const s = state(card('a', ['key::A::minor', 'key::D::minor']));
    dissolveTagNode(s, 'key::A');
    dissolveTagNode(s, 'key::D');
    expect(s.cards['a']!.tags).toEqual(['key::minor']);
  });
});

describe('what the importers write', () => {
  it('groups types and keys', () => {
    expect(typeTag('slip jig')).toBe('type::slip jig');
    // The key whole, tonic and mode together (2026-11-09).
    expect(keyTag('Aminor')).toBe('key::Aminor');
    expect(keyTag('F#dorian')).toBe('key::F#dorian');
  });
});

describe('groupImportTags', () => {
  it('moves the flat type and key of an imported tune into their groups', () => {
    const c = card('a', ['reel', 'Dmajor', 'fast'], 'thesession:1');
    expect(groupImportTags(c)).toBe(true);
    expect(c.tags).toEqual(['type::reel', 'key::Dmajor', 'fast']);
  });

  it('does it for irishtune.info tunes too', () => {
    const c = card('a', ['slip jig', 'Adorian'], 'irishtuneinfo:5');
    groupImportTags(c);
    expect(c.tags).toEqual(['type::slip jig', 'key::Adorian']);
  });

  it('leaves hand-made cards and sets alone, and anything not in the import formats', () => {
    const hand = card('h', ['reel', 'Dmajor']);
    const set = card('s', ['reel'], 'thesession-set:1-2');
    const odd = card('o', ['Em', 'Reel', 'gmajor'], 'thesession:2');
    expect(groupImportTags(hand)).toBe(false);
    expect(groupImportTags(set)).toBe(false);
    expect(groupImportTags(odd)).toBe(false);
    expect(hand.tags).toEqual(['reel', 'Dmajor']);
  });

  it('is idempotent, and collapses a flat tag into its grouped twin', () => {
    const c = card('a', ['type::reel', 'reel'], 'thesession:1');
    groupImportTags(c);
    expect(c.tags).toEqual(['type::reel']);
    expect(groupImportTags(c)).toBe(false);
  });
});

describe('pinned chips after a rename or a removal', () => {
  const chips = (...e: [string, string][]) => new Map(e);

  it('moves a pinned chip to the new name, in its place and state', () => {
    const c = chips(['jig', 'include'], ['Em', 'exclude'], ['reel', 'include']);
    expect([...renameTagNodeChips(c, 'Em', 'Eminor')]).toEqual([['jig', 'include'], ['Eminor', 'exclude'], ['reel', 'include']]);
  });

  it('lets the new name keep its own state on a merge', () => {
    const c = chips(['Em', 'exclude'], ['Eminor', 'include']);
    expect([...renameTagNodeChips(c, 'Em', 'Eminor')]).toEqual([['Eminor', 'include']]);
  });

  it('moves the chips under a renamed group with it', () => {
    const c = chips(['key::A', 'include'], ['fast', 'exclude']);
    expect([...renameTagNodeChips(c, 'key', 'tonality')]).toEqual([['tonality::A', 'include'], ['fast', 'exclude']]);
  });

  it('drops a removed tag, or a dissolved group with what is under it', () => {
    const c = chips(['key', 'include'], ['key::A::minor', 'exclude'], ['keyboard', 'include']);
    expect([...dropTagNodeChips(c, 'key').keys()]).toEqual(['keyboard']);
  });
});
