import { describe, it, expect } from 'vitest';
import type { AppState, Card } from '../../types';
import { applyOps, parseAnswer, prepare, type ApplyContext } from './ops';
import { smartEditInstructions } from './instructions';

// ── The examples in the instructions actually work ───────────────────────────
// Written for people as much as for AI assistants (2026-11-22, asked by
// Antione: a minimal working JSON says more than the rules). An example that
// the checks refuse would teach the wrong thing to exactly the reader who
// copies it, so each one is run here as Cadence runs a pasted answer: read,
// prepared, applied — against a library holding the ids the examples quote,
// shortened as they are there ("7c1e9a20-…").

const card = (id: string, name: string, extra: Partial<Card> = {}): Card => ({
  id, guid: `g-${id}`, name, defaultImportance: 1, tags: [], content: { notes: '', attachments: [] }, ...extra,
});

function library(): AppState {
  return {
    id: 'u', name: 'Test', language: 'en', availabilityThreshold: 0.8, weightByImportance: true, forgettingRate: 1,
    profileIds: ['9b2e…'], currentProfileId: '9b2e…',
    profiles: { '9b2e…': { id: '9b2e…', name: 'Default' } },
    cards: { '7c1e9a20-…': card('7c1e9a20-…', 'The French Revolution', { tags: ['history'] }) },
    decks: {
      '4b8d0f13-…': { id: '4b8d0f13-…', name: 'To learn', entries: [{ cardId: '7c1e9a20-…' }] },
      'e52a7c94-…': { id: 'e52a7c94-…', name: 'Learnt', entries: [] },
    },
    cardWorks: {},
    folders: { 'f3a1c2d4-…': { id: 'f3a1c2d4-…', name: 'Irish', folderIds: [], deckIds: ['4b8d0f13-…', 'e52a7c94-…'] } },
    rootFolderIds: ['f3a1c2d4-…'],
    rootDeckIds: [],
  } as AppState;
}

/** Every fenced ```json block of the instructions. */
function examples(): string[] {
  return [...smartEditInstructions().matchAll(/```json\n([\s\S]*?)\n```/g)].map(m => m[1]!);
}

describe('the examples in the smart edit instructions', () => {
  it('are there', () => {
    expect(examples().length).toBeGreaterThanOrEqual(8);
  });

  it.each(examples().map((json, i) => [i + 1, json] as const))('example %i is read, checked and applied without an error', (_n, json) => {
    const read = parseAnswer(json);
    if ('error' in read) throw new Error(`not read: ${JSON.stringify(read.error)}`);
    const prep = prepare(read.ops);
    const ctx: ApplyContext = { newIds: prep.newIds, fetched: new Map(), now: Date.parse('2026-11-22T12:00:00.000Z') };
    const result = applyOps(library(), read.ops, ctx);
    expect([...prep.errors, ...result.errors]).toEqual([]);
  });
});
