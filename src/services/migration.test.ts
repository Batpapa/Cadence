import { describe, it, expect } from 'vitest';
import { migrateState, stampTuneType, SCHEMA_VERSION } from './migration';
import { parseCardPackageFromText } from './importExport';
import type { AppState } from '../types';

function card(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: 'c1', guid: 'g1', name: 'Cooley\'s', defaultImportance: 1, tags: [], content: { notes: '', attachments: [] }, ...over };
}
function stateWith(...cards: Array<Record<string, unknown>>): AppState {
  const byId: Record<string, unknown> = {};
  cards.forEach((c, i) => { byId[String(c['id'] ?? `c${i}`)] = c; });
  return { schemaVersion: 6, cards: byId } as unknown as AppState;
}

describe('stampTuneType', () => {
  it('types a TheSession card as a tune', () => {
    const c = card({ externalId: 'thesession:1197' });
    stampTuneType(c);
    expect(c['type']).toBe('tune');
  });

  it('types an IrishTuneInfo card as a tune', () => {
    const c = card({ externalId: 'irishtuneinfo:42' });
    stampTuneType(c);
    expect(c['type']).toBe('tune');
  });

  it('leaves a card with no external id untyped — a hand-made tune is unprovable', () => {
    const c = card();
    stampTuneType(c);
    expect('type' in c).toBe(false);
  });

  it('leaves an unknown source untyped', () => {
    const c = card({ externalId: 'spotify:xyz' });
    stampTuneType(c);
    expect('type' in c).toBe(false);
  });

  it('NEVER overwrites a type the user already chose', () => {
    const c = card({ externalId: 'thesession:1197', type: 'tuneset' });
    stampTuneType(c);
    expect(c['type']).toBe('tuneset');
  });

  it('is idempotent', () => {
    const c = card({ externalId: 'thesession:1197' });
    stampTuneType(c); stampTuneType(c);
    expect(c['type']).toBe('tune');
  });

  it('tolerates a non-string external id without throwing', () => {
    const c = card({ externalId: 1197 });
    expect(() => stampTuneType(c)).not.toThrow();
    expect('type' in c).toBe(false);
  });
});

describe('migrateState V6 → V7', () => {
  it('stamps the library and bumps the version', () => {
    const s = stateWith(
      card({ id: 'a', externalId: 'thesession:1' }),
      card({ id: 'b' }),
    );
    migrateState(s);
    expect(s.cards['a']!.type).toBe('tune');
    expect(s.cards['b']!.type).toBeUndefined();
    expect(s.schemaVersion).toBe(SCHEMA_VERSION);
  });

  it('touches nothing else on the card', () => {
    const s = stateWith(card({ id: 'a', externalId: 'thesession:1', tags: ['reel'] }));
    migrateState(s);
    const c = s.cards['a']!;
    expect(c.name).toBe('Cooley\'s');
    expect(c.tags).toEqual(['reel']);
    expect(c.defaultImportance).toBe(1);
    expect(c.content).toEqual({ notes: '', attachments: [] });
  });

  it('runs on a state that has never been migrated', () => {
    const s = { cards: { a: card({ id: 'a', externalId: 'thesession:1' }) } } as unknown as AppState;
    migrateState(s);
    expect(s.cards['a']!.type).toBe('tune');
  });

  it('survives a state with no cards at all', () => {
    const s = { schemaVersion: 6 } as unknown as AppState;
    expect(() => migrateState(s)).not.toThrow();
    expect(s.schemaVersion).toBe(SCHEMA_VERSION);
  });
});

describe('the .cdc path stamps identically', () => {
  // The trap this guards: importExport.ts carries its OWN partial migration
  // mirror, so a package exported before V7 would arrive untyped — and its
  // tunes would be invisible to the tuneset editor on the receiving device.
  it('types a pre-V7 package on import', () => {
    const text = JSON.stringify({
      schemaVersion: 6,
      cards: [card({ id: 'a', externalId: 'thesession:1' }), card({ id: 'b' })],
    });
    const [a, b] = parseCardPackageFromText(text);
    expect(a!.type).toBe('tune');
    expect(b!.type).toBeUndefined();
  });

  it('leaves a package already at the current version alone', () => {
    const text = JSON.stringify({
      schemaVersion: SCHEMA_VERSION,
      cards: [card({ id: 'a', externalId: 'thesession:1', type: 'tuneset' })],
    });
    expect(parseCardPackageFromText(text)[0]!.type).toBe('tuneset');
  });
});

describe('card package carries type and tunes', () => {
  it('keeps a tuneset and its tune list through a round trip', () => {
    const text = JSON.stringify({
      schemaVersion: SCHEMA_VERSION,
      cards: [card({
        id: 's', type: 'tuneset',
        tunes: [{ id: 'a', guid: 'ga', title: 'Cooley\'s' }, { id: 'b', guid: 'gb', title: 'The Wise Maid' }],
      })],
    });
    const set = parseCardPackageFromText(text)[0]!;
    expect(set.type).toBe('tuneset');
    expect(set.tunes?.map(r => r.title)).toEqual(['Cooley\'s', 'The Wise Maid']);
  });

  it('remaps placeholder ids inside tunes, not only inside attachments', () => {
    const text = JSON.stringify({
      schemaVersion: SCHEMA_VERSION,
      cards: [
        card({ id: -1, name: 'Cooley\'s' }),
        card({ id: 's', type: 'tuneset', tunes: [{ id: -1, guid: '', title: 'Cooley\'s' }] }),
      ],
    });
    const [tune, set] = parseCardPackageFromText(text);
    expect(set!.tunes![0]!.id).toBe(tune!.id);
    expect(set!.tunes![0]!.guid).toBe(tune!.guid);
    expect(tune!.id).not.toBe('-1');
  });

  it('falls back to matching a tune by name when no id was given', () => {
    const text = JSON.stringify({
      schemaVersion: SCHEMA_VERSION,
      cards: [
        card({ id: 'a', name: 'The Wise Maid' }),
        card({ id: 's', type: 'tuneset', tunes: [{ id: '', guid: '', title: 'The Wise Maid' }] }),
      ],
    });
    const [, set] = parseCardPackageFromText(text);
    expect(set!.tunes![0]!.id).toBe('a');
  });

  it('defends against a malformed tunes list rather than trusting it', () => {
    const text = JSON.stringify({
      schemaVersion: SCHEMA_VERSION,
      cards: [card({ id: 's', type: 'tuneset', tunes: 'not a list' })],
    });
    expect(parseCardPackageFromText(text)[0]!.tunes).toEqual([]);
  });

  it('fills the missing fields of a half-written reference', () => {
    const text = JSON.stringify({
      schemaVersion: SCHEMA_VERSION,
      cards: [card({ id: 's', type: 'tuneset', tunes: [{ title: 'Orphan' }] })],
    });
    expect(parseCardPackageFromText(text)[0]!.tunes).toEqual([{ id: '', guid: '', title: 'Orphan' }]);
  });

  it('drops a type that is not a string', () => {
    const text = JSON.stringify({
      schemaVersion: SCHEMA_VERSION,
      cards: [card({ id: 'a', type: 42 })],
    });
    expect(parseCardPackageFromText(text)[0]!.type).toBeUndefined();
  });
});

describe('a set imported without typed members is repaired, not trusted', () => {
  // An AI package that forgets `"type": "tune"` would otherwise import a set
  // whose members can never be edited back in — the picker only offers tunes.
  it('types the cards a tuneset lists as its tunes', () => {
    const text = JSON.stringify({
      schemaVersion: SCHEMA_VERSION,
      cards: [
        card({ id: -1, name: 'Cooley\'s' }),
        card({ id: 's', type: 'tuneset', tunes: [{ id: -1, guid: '', title: 'Cooley\'s' }] }),
      ],
    });
    const [tune] = parseCardPackageFromText(text);
    expect(tune!.type).toBe('tune');
  });

  it('never overwrites a type the package states explicitly', () => {
    const text = JSON.stringify({
      schemaVersion: SCHEMA_VERSION,
      cards: [
        card({ id: -1, name: 'Inner set', type: 'tuneset' }),
        card({ id: 's', type: 'tuneset', tunes: [{ id: -1, guid: '', title: 'Inner set' }] }),
      ],
    });
    // A set wrongly listed inside another set stays a set: repairing it into a
    // tune would silently destroy its own tune list.
    expect(parseCardPackageFromText(text)[0]!.type).toBe('tuneset');
  });

  it('leaves cards no set refers to untyped', () => {
    const text = JSON.stringify({
      schemaVersion: SCHEMA_VERSION,
      cards: [card({ id: 'lonely', name: 'A note to self' })],
    });
    expect(parseCardPackageFromText(text)[0]!.type).toBeUndefined();
  });
});
