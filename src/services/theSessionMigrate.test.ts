import { describe, it, expect } from 'vitest';
import { applyTheSessionMigration, type TuneResult } from './theSessionService';
import type { Card } from '../types';

const tune: TuneResult = {
  id: 1197,
  name: 'The Butterfly',
  type: 'slip jig',
  url: 'https://thesession.org/tunes/1197',
  tunebooks: 412,
  topKey: 'Eminor',
  settings: [{
    id: 41297,
    url: 'https://thesession.org/tunes/1197#setting41297',
    key: 'Eminor',
    abc: 'B2 B B2 A|',
    member: { id: 1, name: 'Jeremy', url: 'https://thesession.org/members/1' },
    date: '2004-01-01',
  }],
};

/** An IrishTuneInfo card as it exists before migration, carrying the things a
 *  user accumulates on a card and would hate to see reappear afterwards. */
function itiCard(): Card {
  return {
    id: 'card-1',
    guid: 'guid-1',
    name: 'Butterfly, The',
    defaultImportance: 3,
    tags: ['IrishTuneInfo', 'slip jig'],
    type: 'tune',
    externalId: 'irishtuneinfo:1234',
    content: { notes: 'my own notes', attachments: [] },
  };
}

describe('migrating a card to TheSession', () => {
  it('keeps the identity, so decks and review history stay attached', () => {
    const card = itiCard();
    applyTheSessionMigration(card, tune);
    expect(card.id).toBe('card-1');
    expect(card.guid).toBe('guid-1');
  });

  it('takes everything else from TheSession', () => {
    const card = itiCard();
    applyTheSessionMigration(card, tune);
    expect(card.name).toBe('The Butterfly');
    expect(card.externalId).toBe('thesession:1197');
    expect(card.type).toBe('tune');
    expect(card.tags).toContain('TheSession');
    expect(card.content.notes).toBe('');
    expect(card.content.attachments.length).toBe(1);
  });

  it('leaves nothing of the old source behind', () => {
    // The whole point of wiping before assigning: a field the old source set
    // and the new one does not would otherwise survive as debris on a card
    // that no longer has that source at all.
    const card = { ...itiCard(), itiOnlyField: 'debris' } as Card & { itiOnlyField?: string };
    applyTheSessionMigration(card, tune);
    expect(card.itiOnlyField).toBeUndefined();
    expect(card.tags).not.toContain('IrishTuneInfo');
  });
});
