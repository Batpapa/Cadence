import { describe, it, expect } from 'vitest';
import {
  CARD_TYPE_TUNE, CARD_TYPE_TUNESET, CARD_TYPES,
  isTune, isTuneset, tunesOf, cardTypeLabelKey, canBeTuneOf, isTypeLocked, applyCardType,
} from './cardTypeService';
import type { Card } from '../types';

function card(id: string, over: Partial<Card> = {}): Card {
  return {
    id, guid: `guid-${id}`, name: id, defaultImportance: 1, tags: [],
    content: { notes: '', attachments: [] },
    ...over,
  };
}
const ref = (id: string) => ({ id, guid: `guid-${id}`, title: id });

describe('type predicates', () => {
  it('recognises the two known types', () => {
    expect(isTune(card('a', { type: CARD_TYPE_TUNE }))).toBe(true);
    expect(isTuneset(card('a', { type: CARD_TYPE_TUNESET }))).toBe(true);
  });

  it('treats an untyped card as neither', () => {
    expect(isTune(card('a'))).toBe(false);
    expect(isTuneset(card('a'))).toBe(false);
  });

  it('DEGRADES an unknown type instead of throwing — the field is open', () => {
    const fromTheFuture = card('a', { type: 'chord-chart' });
    expect(isTune(fromTheFuture)).toBe(false);
    expect(isTuneset(fromTheFuture)).toBe(false);
    expect(cardTypeLabelKey('chord-chart')).toBe('card.type.none');
  });

  it('tolerates a missing card', () => {
    expect(isTune(undefined)).toBe(false);
    expect(isTuneset(undefined)).toBe(false);
    expect(tunesOf(undefined)).toEqual([]);
  });
});

describe('tunesOf', () => {
  it('returns the list of a set, in order', () => {
    const set = card('s', { type: CARD_TYPE_TUNESET, tunes: [ref('a'), ref('b')] });
    expect(tunesOf(set)!.map(r => r.id)).toEqual(['a', 'b']);
  });

  it('reads an absent list on a set as an EMPTY set, not as "not a set"', () => {
    expect(tunesOf(card('s', { type: CARD_TYPE_TUNESET }))).toEqual([]);
  });

  it('IGNORES a leftover list on a card that is no longer a set', () => {
    // Reachable through an import, not through the UI: applyCardType drops the
    // list when a card stops being a set. Reading it here would be wrong either
    // way — type is the truth, the list is only its payload.
    const demoted = card('s', { type: CARD_TYPE_TUNE, tunes: [ref('a')] });
    expect(tunesOf(demoted)).toEqual([]);
    expect(demoted.tunes).toHaveLength(1);
  });
});

describe('cardTypeLabelKey', () => {
  it('names each type, and shares one label for absent and unknown', () => {
    expect(cardTypeLabelKey(CARD_TYPE_TUNE)).toBe('card.type.tune');
    expect(cardTypeLabelKey(CARD_TYPE_TUNESET)).toBe('card.type.tuneset');
    expect(cardTypeLabelKey(undefined)).toBe('card.type.none');
  });

  it('has a label key for every type the selector offers', () => {
    for (const type of CARD_TYPES) expect(cardTypeLabelKey(type)).not.toBe('card.type.none');
  });
});

describe('canBeTuneOf', () => {
  const set = card('s', { type: CARD_TYPE_TUNESET });

  it('accepts a typed tune', () => {
    expect(canBeTuneOf(card('a', { type: CARD_TYPE_TUNE }), set)).toBe(true);
  });

  it('REFUSES an untyped card — a set contains tunes and nothing else', () => {
    expect(canBeTuneOf(card('a'), set)).toBe(false);
  });

  it('refuses a card of some other type', () => {
    expect(canBeTuneOf(card('a', { type: 'chord-chart' }), set)).toBe(false);
  });

  it('refuses another set, which is what makes a reference cycle impossible', () => {
    expect(canBeTuneOf(card('other', { type: CARD_TYPE_TUNESET }), set)).toBe(false);
  });

  it('refuses the set itself, even though a set is not a tune anyway', () => {
    expect(canBeTuneOf(set, set)).toBe(false);
  });
});

describe('isTypeLocked', () => {
  // The other half of the invariant: canBeTuneOf guards the way in, this
  // guards the way out. Without it a user could add a tune to a set, then
  // retype it, leaving a non-tune inside a set.
  it('locks a card that plays in at least one set', () => {
    expect(isTypeLocked(1)).toBe(true);
    expect(isTypeLocked(3)).toBe(true);
  });

  it('leaves a card that plays in no set free to be retyped', () => {
    expect(isTypeLocked(0)).toBe(false);
  });
});

describe('applyCardType', () => {
  const set = () => card('s', { type: CARD_TYPE_TUNESET, tunes: [ref('a'), ref('b')] });

  it('sets a type', () => {
    const c = card('a');
    applyCardType(c, CARD_TYPE_TUNE);
    expect(c.type).toBe(CARD_TYPE_TUNE);
  });

  it('clears the type on an empty string, leaving the field absent', () => {
    const c = card('a', { type: CARD_TYPE_TUNE });
    applyCardType(c, '');
    expect('type' in c).toBe(false);
  });

  it('DISCARDS the tune list when a set stops being a set', () => {
    const c = set();
    applyCardType(c, CARD_TYPE_TUNE);
    expect('tunes' in c).toBe(false);
  });

  it('discards it when the type is cleared entirely too', () => {
    const c = set();
    applyCardType(c, '');
    expect('tunes' in c).toBe(false);
  });

  it('keeps the list when a set stays a set', () => {
    const c = set();
    applyCardType(c, CARD_TYPE_TUNESET);
    expect(c.tunes).toHaveLength(2);
  });

  it('strips a stray list off a card that was never a set', () => {
    // The rule is stated on the resulting type, not on the transition, so an
    // imported card carrying both cannot keep the list by arriving sideways.
    const c = card('a', { type: CARD_TYPE_TUNE, tunes: [ref('x')] });
    applyCardType(c, CARD_TYPE_TUNE);
    expect('tunes' in c).toBe(false);
  });

  it('touches nothing else', () => {
    const c = card('a', { name: 'Cooley', tags: ['reel'], defaultImportance: 7 });
    applyCardType(c, CARD_TYPE_TUNESET);
    expect(c.name).toBe('Cooley');
    expect(c.tags).toEqual(['reel']);
    expect(c.defaultImportance).toBe(7);
  });
});

describe('applyCardType — the automatic name flag', () => {
  it('a card BECOMING a set names itself automatically by default', () => {
    const c = card('a');
    applyCardType(c, CARD_TYPE_TUNESET);
    expect(c.computedName).toBe(true);
  });

  it('does NOT re-arm it when the card was already a set', () => {
    // Re-picking the type a card already has must not silently undo a user
    // who deliberately took the name back.
    const c = card('s', { type: CARD_TYPE_TUNESET });
    delete c.computedName;
    applyCardType(c, CARD_TYPE_TUNESET);
    expect(c.computedName).toBeUndefined();
  });

  it('drops the flag when the card stops being a set', () => {
    const c = card('s', { type: CARD_TYPE_TUNESET, computedName: true, tunes: [ref('a')] });
    applyCardType(c, CARD_TYPE_TUNE);
    expect('computedName' in c).toBe(false);
    expect('tunes' in c).toBe(false);
  });

  it('drops it when the type is cleared entirely', () => {
    const c = card('s', { type: CARD_TYPE_TUNESET, computedName: true });
    applyCardType(c, '');
    expect('computedName' in c).toBe(false);
  });
});
