import { describe, it, expect } from 'vitest';
import { normaliseState } from './stateNormalise';
import type { AppState, Card, CardRef, CardReferenceAttachment } from '../types';

function card(id: string, over: Partial<Card> = {}): Card {
  return {
    id, guid: `guid-${id}`, name: id, defaultImportance: 1, tags: [],
    content: { notes: '', attachments: [] },
    ...over,
  };
}
const ref = (over: Partial<CardReferenceAttachment> = {}): CardReferenceAttachment =>
  ({ type: 'card', id: 'x', guid: 'guid-x', title: 'x', ...over });
const bare = (over: Partial<CardRef> = {}): CardRef =>
  ({ id: 'x', guid: 'guid-x', title: 'x', ...over });

function state(...cards: Card[]): AppState {
  return { cards: Object.fromEntries(cards.map(c => [c.id, c])) } as unknown as AppState;
}
const withAttachments = (id: string, atts: CardReferenceAttachment[]) =>
  card(id, { content: { notes: '', attachments: atts } });

describe('normaliseState — reference titles', () => {
  it('refreshes a title frozen on the old name', () => {
    const s = state(
      card('t', { name: 'The Wise Maid' }),
      withAttachments('a', [ref({ id: 't', guid: 'guid-t', title: 'Old Name' })]),
    );
    normaliseState(s);
    expect((s.cards['a']!.content.attachments[0] as CardReferenceAttachment).title).toBe('The Wise Maid');
  });

  it('refreshes titles inside a set tune list too', () => {
    const s = state(
      card('t', { name: 'Cooley\'s' }),
      card('s', { type: 'tuneset', tunes: [bare({ id: 't', guid: 'guid-t', title: 'Stale' })] }),
    );
    normaliseState(s);
    expect(s.cards['s']!.tunes![0]!.title).toBe('Cooley\'s');
  });

  it('LEAVES an unresolved reference alone — the last known name is its whole point', () => {
    const s = state(withAttachments('a', [ref({ id: 'gone', guid: 'also-gone', title: 'Deleted Tune' })]));
    normaliseState(s);
    expect((s.cards['a']!.content.attachments[0] as CardReferenceAttachment).title).toBe('Deleted Tune');
  });

  it('follows the resolver, so a reference whose id wins takes THAT card\'s name', () => {
    const s = state(
      card('a', { name: 'By id' }),
      card('b', { name: 'By guid' }),
      withAttachments('src', [ref({ id: 'a', guid: 'guid-b', title: 'Stale' })]),
    );
    normaliseState(s);
    expect((s.cards['src']!.content.attachments[0] as CardReferenceAttachment).title).toBe('By id');
  });

  it('is idempotent', () => {
    const s = state(
      card('t', { name: 'Fresh' }),
      withAttachments('a', [ref({ id: 't', guid: 'guid-t', title: 'Stale' })]),
    );
    normaliseState(s);
    const once = structuredClone(s.cards);
    normaliseState(s);
    expect(s.cards).toEqual(once);
  });

  it('touches nothing but the reference fields', () => {
    const s = state(
      card('t', { name: 'Fresh' }),
      card('a', {
        name: 'Holder', tags: ['x'], defaultImportance: 3,
        content: { notes: 'keep me', attachments: [ref({ id: 't', guid: 'guid-t', title: 'Stale' })] },
      }),
    );
    normaliseState(s);
    const a = s.cards['a']!;
    expect(a.name).toBe('Holder');
    expect(a.tags).toEqual(['x']);
    expect(a.defaultImportance).toBe(3);
    expect(a.content.notes).toBe('keep me');
    expect(s.cards['t']!.name).toBe('Fresh');
  });

  it('ignores attachments that are not card references', () => {
    const s = state(card('a', {
      content: { notes: '', attachments: [{ type: 'file', name: 'x.abc', data: '', mimeType: 'text/plain' }] },
    }));
    expect(() => normaliseState(s)).not.toThrow();
  });

  it('survives a state with no cards at all', () => {
    expect(() => normaliseState({} as unknown as AppState)).not.toThrow();
  });
});

describe('normaliseState — healing the lookup', () => {
  it('writes the resolved id back so the O(n) guid scan happens at most once', () => {
    const s = state(
      card('t', { name: 'Cooley\'s' }),
      withAttachments('a', [ref({ id: 'stale-id', guid: 'guid-t', title: 'Cooley\'s' })]),
    );
    normaliseState(s);
    const healed = s.cards['a']!.content.attachments[0] as CardReferenceAttachment;
    expect(healed.id).toBe('t');
    expect(healed.guid).toBe('guid-t');
  });

  it('heals a guid too, when the id was what resolved', () => {
    const s = state(
      card('t', { name: 'Cooley\'s', guid: 'real-guid' }),
      withAttachments('a', [ref({ id: 't', guid: 'stale-guid', title: 'Cooley\'s' })]),
    );
    normaliseState(s);
    expect((s.cards['a']!.content.attachments[0] as CardReferenceAttachment).guid).toBe('real-guid');
  });

  it('heals a reference that only resolved through its external id', () => {
    const s = state(
      card('t', { name: 'Cooley\'s', externalId: 'thesession:1' }),
      withAttachments('a', [ref({ id: 'gone', guid: 'gone', externalId: 'thesession:1', title: 'x' })]),
    );
    normaliseState(s);
    const healed = s.cards['a']!.content.attachments[0] as CardReferenceAttachment;
    expect(healed.id).toBe('t');
    expect(healed.title).toBe('Cooley\'s');
  });

  it('NEVER repoints a reference at a different card while healing', () => {
    // The id is consulted first, so writing the resolved card's id back can
    // only ever confirm where the reference already went.
    const s = state(
      card('a', { name: 'A' }),
      card('b', { name: 'B' }),
      withAttachments('src', [ref({ id: 'a', guid: 'guid-b', title: 'x' })]),
    );
    normaliseState(s);
    expect((s.cards['src']!.content.attachments[0] as CardReferenceAttachment).id).toBe('a');
  });

  it('leaves an unresolved reference\'s ids untouched', () => {
    const s = state(withAttachments('a', [ref({ id: 'gone', guid: 'also-gone', title: 'x' })]));
    normaliseState(s);
    const untouched = s.cards['a']!.content.attachments[0] as CardReferenceAttachment;
    expect(untouched.id).toBe('gone');
    expect(untouched.guid).toBe('also-gone');
  });
});

describe('normaliseState — automatic set names', () => {
  const set = (tunes: CardRef[], over: Partial<Card> = {}) =>
    card('s', { name: 'Untouched', type: 'tuneset', computedName: true, tunes, ...over });

  it('names a set from its tunes, joined with " / "', () => {
    const s = state(
      card('a', { name: 'Cooley\'s' }),
      card('b', { name: 'The Wise Maid' }),
      set([bare({ id: 'a', guid: 'guid-a' }), bare({ id: 'b', guid: 'guid-b' })]),
    );
    normaliseState(s);
    expect(s.cards['s']!.name).toBe('Cooley\'s / The Wise Maid');
  });

  it('FOLLOWS a rename of one of its tunes', () => {
    const s = state(
      card('a', { name: 'Cooley\'s' }),
      set([bare({ id: 'a', guid: 'guid-a' })]),
    );
    normaliseState(s);
    s.cards['a']!.name = 'Cooley\'s Reel';
    normaliseState(s);
    expect(s.cards['s']!.name).toBe('Cooley\'s Reel');
  });

  it('keeps the tunes in their stored order', () => {
    const s = state(
      card('a', { name: 'A' }), card('b', { name: 'B' }), card('c', { name: 'C' }),
      set([bare({ id: 'c', guid: 'guid-c' }), bare({ id: 'a', guid: 'guid-a' }), bare({ id: 'b', guid: 'guid-b' })]),
    );
    normaliseState(s);
    expect(s.cards['s']!.name).toBe('C / A / B');
  });

  it('leaves a set that has NOT opted in alone', () => {
    const s = state(
      card('a', { name: 'Cooley\'s' }),
      set([bare({ id: 'a', guid: 'guid-a' })], { computedName: undefined }),
    );
    normaliseState(s);
    expect(s.cards['s']!.name).toBe('Untouched');
  });

  it('ignores the flag on a card that is not a set', () => {
    const s = state(
      card('a', { name: 'Cooley\'s' }),
      card('s', { name: 'Untouched', computedName: true, tunes: [bare({ id: 'a', guid: 'guid-a' })] }),
    );
    normaliseState(s);
    expect(s.cards['s']!.name).toBe('Untouched');
  });

  it('NEVER writes an empty name — an empty set keeps what it was called', () => {
    const s = state(set([]));
    normaliseState(s);
    expect(s.cards['s']!.name).toBe('Untouched');
  });

  it('falls back to the stored title so a deleted tune leaves a trace', () => {
    const s = state(
      card('a', { name: 'Cooley\'s' }),
      set([bare({ id: 'a', guid: 'guid-a' }), bare({ id: 'gone', guid: 'gone', title: 'The Wise Maid' })]),
    );
    normaliseState(s);
    expect(s.cards['s']!.name).toBe('Cooley\'s / The Wise Maid');
  });

  it('drops a blank contribution instead of emitting a dangling separator', () => {
    const s = state(
      card('a', { name: 'Cooley\'s' }),
      set([bare({ id: 'a', guid: 'guid-a' }), bare({ id: 'gone', guid: 'gone', title: '' })]),
    );
    normaliseState(s);
    expect(s.cards['s']!.name).toBe('Cooley\'s');
  });

  it('is idempotent', () => {
    const s = state(card('a', { name: 'Cooley\'s' }), set([bare({ id: 'a', guid: 'guid-a' })]));
    normaliseState(s);
    const once = structuredClone(s.cards);
    normaliseState(s);
    expect(s.cards).toEqual(once);
  });

  it('ORDERS the two passes: a reference to a set gets the set\'s fresh name', () => {
    // The whole reason pass one runs before pass two. A card mentioning a set
    // must end up with the name the set was just given, not the one it had.
    const s = state(
      card('a', { name: 'Cooley\'s' }),
      set([bare({ id: 'a', guid: 'guid-a' })]),
      withAttachments('mentions', [ref({ id: 's', guid: 'guid-s', title: 'Stale set name' })]),
    );
    normaliseState(s);
    expect(s.cards['s']!.name).toBe('Cooley\'s');
    expect((s.cards['mentions']!.content.attachments[0] as CardReferenceAttachment).title).toBe('Cooley\'s');
  });
});
