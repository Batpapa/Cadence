import { describe, it, expect } from 'vitest';
import type { AppState, Card } from '../../types';
import { applyOps, parseAnswer, prepare, hasDeletions, OPS_FORMAT, type ApplyContext } from './ops';

const card = (id: string, name: string, extra: Partial<Card> = {}): Card => ({
  id, guid: `g-${id}`, name, defaultImportance: 1, tags: [], content: { notes: '', attachments: [] }, ...extra,
});

/** Two profiles, a folder holding a deck, three cards (two tunes in a set). */
function state(): AppState {
  return {
    id: 'u', name: 'Test', language: 'fr', availabilityThreshold: 0.8, weightByImportance: true, forgettingRate: 1,
    profileIds: ['p1', 'p2'], currentProfileId: 'p1',
    profiles: { p1: { id: 'p1', name: 'Fiddle' }, p2: { id: 'p2', name: 'Flute' } },
    cards: {
      c1: card('c1', 'Cooley\'s', { type: 'tune' }),
      c2: card('c2', 'The Wise Maid', { type: 'tune', content: { notes: '', attachments: [
        { type: 'file', name: 'wise.abc', mimeType: 'text/plain', data: btoa('X:1') },
        { type: 'embed', id: 'e1', url: 'https://example.org/a' },
      ] } }),
      s1: card('s1', 'Set', { type: 'tuneset', tunes: [{ id: 'c1', guid: 'g-c1', title: 'Cooley\'s' }, { id: 'c2', guid: 'g-c2', title: 'The Wise Maid' }] }),
    },
    decks: { d1: { id: 'd1', name: 'Reels', entries: [{ cardId: 'c1' }, { cardId: 'c2' }] } },
    cardWorks: {
      'p1:c1': { profileId: 'p1', cardId: 'c1', history: [{ ts: Date.parse('2026-01-01T10:00:00.000Z'), rating: 'good' }] },
      'p2:c1': { profileId: 'p2', cardId: 'c1', history: [{ ts: Date.parse('2026-01-02T10:00:00.000Z'), rating: 'hard' }] },
    },
    folders: { f1: { id: 'f1', name: 'Irish', folderIds: [], deckIds: ['d1'] } },
    rootFolderIds: ['f1'],
    rootDeckIds: [],
  } as AppState;
}

const NOW = Date.parse('2026-10-11T12:00:00.000Z');

/** Prepares and runs a batch on a fresh state; returns both. */
function run(ops: unknown[], s = state(), fetched = new Map<string, Card>()) {
  const prep = prepare(ops as never);
  const ctx: ApplyContext = { newIds: prep.newIds, fetched, now: NOW };
  const result = applyOps(s, ops as never, ctx);
  return { s, errors: [...prep.errors, ...result.errors], summary: result.summary, ctx };
}

describe('reading the answer', () => {
  it('takes the fenced block out of a chatty answer', () => {
    const r = parseAnswer('Here you go:\n```json\n{"format": "cadence-smart-ops-1", "operations": [{"op": "deleteDeck", "id": "d1"}]}\n```\nDone.');
    expect('ops' in r && r.ops).toEqual([{ op: 'deleteDeck', id: 'd1' }]);
  });

  it('takes bare JSON too', () => {
    expect('ops' in parseAnswer('{"format": "cadence-smart-ops-1", "operations": []}')).toBe(true);
  });

  it('refuses a list that does not state its format, or states another', () => {
    expect(parseAnswer('{"operations": []}')).toEqual({ error: { op: 0, code: 'noFormat', params: { expected: OPS_FORMAT } } });
    expect(parseAnswer('{"format": "cadence-smart-ops-0", "operations": []}'))
      .toEqual({ error: { op: 0, code: 'badFormat', params: { found: 'cadence-smart-ops-0', expected: OPS_FORMAT } } });
  });

  it('says what is wrong with the rest', () => {
    expect(parseAnswer('no json here')).toEqual({ error: { op: 0, code: 'noJson' } });
    expect('error' in parseAnswer('{"operations": [}') && (parseAnswer('{"operations": [}') as { error: { code: string } }).error.code).toBe('badJson');
    expect(parseAnswer('{"format": "cadence-smart-ops-1", "ops": []}')).toEqual({ error: { op: 0, code: 'noOperations' } });
  });
});

describe('creating and referring', () => {
  it('creates a folder, a deck in it and cards in the deck, with new: ids used in order', () => {
    const { s, errors, summary } = run([
      { op: 'createFolder', id: 'new:f', name: 'Jigs', parentId: 'f1' },
      { op: 'createDeck', id: 'new:d', name: 'Jigs deck', folderId: 'new:f' },
      { op: 'createCard', id: 'new:c', name: 'The Kesh', type: 'tune', tags: ['jig', 'jig'], decks: ['new:d'] },
    ]);
    expect(errors).toEqual([]);
    const folder = Object.values(s.folders).find(f => f.name === 'Jigs')!;
    expect(s.folders['f1']!.folderIds).toEqual([folder.id]);
    const deck = Object.values(s.decks).find(d => d.name === 'Jigs deck')!;
    expect(folder.deckIds).toEqual([deck.id]);
    const kesh = Object.values(s.cards).find(c => c.name === 'The Kesh')!;
    expect(kesh.tags).toEqual(['jig']);
    expect(deck.entries).toEqual([{ cardId: kesh.id }]);
    expect(summary.changes.map(c => `${c.kind}:${c.action}`)).toEqual(['folder:create', 'deck:create', 'card:create']);
  });

  it('refuses a new: id used before the operation that creates it', () => {
    const { errors } = run([
      { op: 'addToDeck', deckId: 'd1', cards: [{ cardId: 'new:c' }] },
      { op: 'createCard', id: 'new:c', name: 'Late' },
    ]);
    expect(errors).toEqual([{ op: 1, name: 'addToDeck', code: 'notCreatedYet', params: { id: 'new:c', kind: 'card' } }]);
  });

  it('refuses a create without a new: id, and a new: id given twice', () => {
    const { errors } = run([
      { op: 'createDeck', id: 'deck-1', name: 'A' },
      { op: 'createDeck', id: 'new:x', name: 'B' },
      { op: 'createDeck', id: 'new:x', name: 'C' },
    ]);
    expect(errors.map(e => `${e.op}:${e.code}`)).toEqual(['3:duplicateNewId', '1:newIdExpected']);
  });

  it('builds a set from tunes, and refuses a non-tune in it', () => {
    const ok = run([{ op: 'createCard', id: 'new:set', name: 'New set', type: 'tuneset', tunes: [{ cardId: 'c2', repeat: 2 }, { cardId: 'c1' }] }]);
    expect(ok.errors).toEqual([]);
    const set = Object.values(ok.s.cards).find(c => c.name === 'New set')!;
    expect(set.tunes).toEqual([{ id: 'c2', guid: 'g-c2', title: 'The Wise Maid', repeat: 2 }, { id: 'c1', guid: 'g-c1', title: 'Cooley\'s' }]);

    const bad = run([{ op: 'createCard', id: 'new:set', name: 'Bad', type: 'tuneset', tunes: [{ cardId: 's1' }] }]);
    expect(bad.errors[0]!.code).toBe('notATune');
    const notSet = run([{ op: 'createCard', id: 'new:x', name: 'X', tunes: [{ cardId: 'c1' }] }]);
    expect(notSet.errors[0]!.code).toBe('tunesNotSet');
  });

  it('merges a fetched tune with what the AI adds, and refuses one already owned', () => {
    const fetched = new Map([['new:t', card('tmp', 'Fetched', { type: 'tune', externalId: 'thesession:1', tags: ['reel'], defaultImportance: 3 })]]);
    const { s, errors } = run([{ op: 'createCard', id: 'new:t', externalId: 'thesession:1', tags: ['mine'], notes: 'n' }], state(), fetched);
    expect(errors).toEqual([]);
    const t = Object.values(s.cards).find(c => c.externalId === 'thesession:1')!;
    expect([t.name, t.tags, t.defaultImportance, t.content.notes]).toEqual(['Fetched', ['reel', 'mine'], 3, 'n']);
    expect(t.id).not.toBe('tmp');

    const s2 = state();
    s2.cards['c1']!.externalId = 'thesession:1';
    expect(run([{ op: 'createCard', id: 'new:t', externalId: 'thesession:1' }], s2, fetched).errors[0]!.code).toBe('duplicateExternal');
  });
});

describe('updating', () => {
  it('replaces the fields given and only those', () => {
    const { s, errors, summary } = run([{ op: 'updateCard', id: 'c1', tags: ['reel'], notes: '||A||' }]);
    expect(errors).toEqual([]);
    expect(s.cards['c1']).toMatchObject({ name: 'Cooley\'s', tags: ['reel'], type: 'tune' });
    expect(s.cards['c1']!.content.notes).toBe('||A||');
    expect(summary.changes[0]).toMatchObject({ kind: 'card', action: 'update', fields: ['tags', 'notes'] });
  });

  it('keeps a tune of a set a tune', () => {
    expect(run([{ op: 'updateCard', id: 'c1', type: null }]).errors[0]!.code).toBe('typeLocked');
  });

  it('removes an attachment only when index and match agree, and adds new ones', () => {
    const ok = run([{ op: 'updateCard', id: 'c2',
      removeAttachments: [{ index: 1, match: 'https://example.org/a' }],
      addAttachments: [{ type: 'file', name: 'b.abc', text: 'X:2' }, { type: 'embed', url: 'https://x.org', mode: 'link', title: 'X' }, { type: 'card', cardId: 'c1' }] }]);
    expect(ok.errors).toEqual([]);
    const atts = ok.s.cards['c2']!.content.attachments;
    expect(atts.map(a => a.type)).toEqual(['file', 'file', 'embed', 'card']);
    expect(atts[1]).toMatchObject({ name: 'b.abc', data: btoa('X:2') });

    expect(run([{ op: 'updateCard', id: 'c2', removeAttachments: [{ index: 0, match: 'other.abc' }] }]).errors[0]!.code).toBe('attachmentMismatch');
    expect(run([{ op: 'updateCard', id: 'c2', addAttachments: [{ type: 'embed', url: 'https://x.org', mode: 'link' }] }]).errors[0]!.code).toBe('linkNeedsTitle');
    expect(run([{ op: 'updateCard', id: 'c2', addAttachments: [{ type: 'file', name: 'x', text: 'a', base64: 'YQ==' }] }]).errors[0]!.code).toBe('textOrBase64');
  });

  it('moves a folder, but not into itself', () => {
    const { s } = run([{ op: 'createFolder', id: 'new:top', name: 'Top' }, { op: 'updateFolder', id: 'f1', parentId: 'new:top' }]);
    const top = Object.values(s.folders).find(f => f.name === 'Top')!;
    expect(top.folderIds).toEqual(['f1']);
    expect(s.rootFolderIds).toEqual([top.id]);
    expect(run([{ op: 'updateFolder', id: 'f1', parentId: 'f1' }]).errors[0]!.code).toBe('folderCycle');
  });

  it('refuses an unknown field, an unknown operation and an unknown id', () => {
    expect(run([{ op: 'updateCard', id: 'c1', title: 'x' }]).errors[0]).toMatchObject({ code: 'unknownField', params: { field: 'title' } });
    expect(run([{ op: 'renameCard', id: 'c1' }]).errors[0]).toMatchObject({ code: 'unknownOp' });
    expect(run([{ op: 'deleteCard', id: 'nope' }]).errors[0]).toMatchObject({ code: 'unknownId' });
  });
});

describe('deleting', () => {
  it('deletes a card with its reviews in every profile, and says how many', () => {
    const { s, summary } = run([{ op: 'deleteCard', id: 'c1' }]);
    expect(s.cards['c1']).toBeUndefined();
    expect(s.cardWorks['p1:c1']).toBeUndefined();
    expect(s.cardWorks['p2:c1']).toBeUndefined();
    expect(s.decks['d1']!.entries).toEqual([{ cardId: 'c2' }]);
    expect(summary.changes[0]).toMatchObject({ action: 'delete', lostReviews: 2 });
    expect(hasDeletions(summary)).toBe(true);
  });

  it('deletes a folder with its decks, keeping the cards', () => {
    const { s, summary } = run([{ op: 'deleteFolder', id: 'f1' }]);
    expect(s.folders['f1']).toBeUndefined();
    expect(s.decks['d1']).toBeUndefined();
    expect(s.rootFolderIds).toEqual([]);
    expect(s.cards['c1']).toBeDefined();
    expect(summary.changes[0]!.lostDecks).toEqual(['Reels']);
  });

  it('deletes a profile with its history, never the last one', () => {
    const { s, summary } = run([{ op: 'deleteProfile', id: 'p1' }]);
    expect(s.profileIds).toEqual(['p2']);
    expect(s.currentProfileId).toBe('p2');
    expect(s.cardWorks['p1:c1']).toBeUndefined();
    expect(summary.changes[0]!.lostReviews).toBe(1);
    expect(run([{ op: 'deleteProfile', id: 'p1' }, { op: 'deleteProfile', id: 'p2' }]).errors[0]).toMatchObject({ op: 2, code: 'lastProfile' });
  });
});

describe('reviews', () => {
  it('adds reviews in date order and refuses the future, a bad rating and a duplicate', () => {
    const { s, summary, errors } = run([{ op: 'addReviews', profileId: 'p1', cardId: 'c1', entries: [['2025-12-01T10:00:00.000Z', 'again']] }]);
    expect(errors).toEqual([]);
    expect(s.cardWorks['p1:c1']!.history.map(h => h.rating)).toEqual(['again', 'good']);
    expect(summary.reviewsAdded).toBe(1);

    const add = (entries: unknown[]) => run([{ op: 'addReviews', profileId: 'p1', cardId: 'c1', entries }]).errors[0]?.code;
    expect(add([['2027-01-01T00:00:00.000Z', 'good']])).toBe('futureDate');
    expect(add([['2025-01-01T00:00:00.000Z', 'great']])).toBe('badRating');
    expect(add([['2026-01-01T10:00:00.000Z', 'easy']])).toBe('reviewExists');
    expect(add([['yesterday', 'easy']])).toBe('badDate');
  });

  it('removes reviews by exact date or all of them', () => {
    const one = run([{ op: 'removeReviews', profileId: 'p1', cardId: 'c1', dates: ['2026-01-01T10:00:00.000Z'] }]);
    expect(one.errors).toEqual([]);
    expect(one.s.cardWorks['p1:c1']).toBeUndefined();
    expect(one.summary.reviewsRemoved).toBe(1);
    expect(run([{ op: 'removeReviews', profileId: 'p1', cardId: 'c1', dates: ['2026-01-01T10:00:01.000Z'] }]).errors[0]!.code).toBe('reviewMissing');
    expect(run([{ op: 'removeReviews', profileId: 'p2', cardId: 'c1', all: true }]).summary.reviewsRemoved).toBe(1);
    expect(run([{ op: 'removeReviews', profileId: 'p2', cardId: 'c1' }]).errors[0]!.code).toBe('datesOrAll');
  });
});

describe('all or nothing, twice the same', () => {
  it('reports every bad operation, and the same ids serve the real run', () => {
    const ops = [
      { op: 'createDeck', id: 'new:d', name: 'Kept id' },
      { op: 'deleteDeck', id: 'missing' },
      { op: 'renameProfile', id: 'p1', name: '  ' },
    ];
    const first = run(ops);
    expect(first.errors.map(e => `${e.op}:${e.code}`)).toEqual(['2:unknownId', '3:emptyName']);

    const ok = [ops[0]!];
    const trial = run(ok);
    const real = state();
    applyOps(real, ok as never, trial.ctx);
    expect(Object.keys(real.decks)).toEqual(Object.keys(trial.s.decks));
  });
});
