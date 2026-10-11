import { describe, it, expect } from 'vitest';
import type { AppState } from '../../types';
import { smartView, viewJson, VIEW_FORMAT } from './view';
import { smartEditInstructions } from './instructions';
import { OPS_FORMAT, parseAnswer } from './ops';

function state(): AppState {
  return {
    id: 'u', name: 'T', language: 'fr', availabilityThreshold: 0.8, weightByImportance: true, forgettingRate: 1,
    profileIds: ['p1'], currentProfileId: 'p1', profiles: { p1: { id: 'p1', name: 'Me' } },
    cards: {
      c1: {
        id: 'c1', guid: 'g1', name: 'Kesh', type: 'tune', defaultImportance: 1, tags: ['jig'],
        content: { notes: 'n', attachments: [
          { type: 'file', name: 'kesh.abc', mimeType: 'text/plain', data: btoa('X:1\nK:G') },
          { type: 'file', name: 'kesh.mp3', mimeType: 'audio/mpeg', data: '', external: { id: 'x1', bytes: 12345 } },
          { type: 'card', id: 'c2', guid: 'g2', title: 'Other' },
        ] },
      },
      c2: { id: 'c2', guid: 'g2', name: 'Other', defaultImportance: 2, tags: [], content: { notes: '', attachments: [] } },
    },
    decks: { d1: { id: 'd1', name: 'Jigs', favorite: true, entries: [{ cardId: 'c1', importance: 2 }] } },
    cardWorks: { 'p1:c1': { profileId: 'p1', cardId: 'c1', history: [
      { ts: Date.parse('2026-01-01T10:00:00.000Z'), rating: 'good' },
      { ts: Date.parse('2026-02-01T10:00:00.000Z'), rating: 'easy', id: 'analysis:s:d' },
    ] } },
    folders: { f1: { id: 'f1', name: 'Irish', folderIds: ['f2'], deckIds: [] }, f2: { id: 'f2', name: 'Sub', folderIds: [], deckIds: ['d1'] } },
    rootFolderIds: ['f1'], rootDeckIds: [],
    modules: { 'tune-analyser': { sessions: {} } },
  } as unknown as AppState;
}

describe('what the AI is shown', () => {
  it('flattens folders in tree order and places decks', () => {
    const v = smartView(state(), false);
    expect(v.folders).toEqual([{ id: 'f1', name: 'Irish', parentId: null }, { id: 'f2', name: 'Sub', parentId: 'f1' }]);
    expect(v.decks).toEqual([{ id: 'd1', name: 'Jigs', folderId: 'f2', favorite: true, cards: [{ cardId: 'c1', importance: 2 }] }]);
    expect(v.profiles).toEqual([{ id: 'p1', name: 'Me', current: true }]);
  });

  it('shows attachments by name and size only, unless content is asked for', () => {
    const without = smartView(state(), false).cards[0]!['attachments'];
    expect(without).toEqual([
      { index: 0, type: 'file', name: 'kesh.abc', mimeType: 'text/plain', bytes: 7 },
      { index: 1, type: 'file', name: 'kesh.mp3', mimeType: 'audio/mpeg', bytes: 12345 },
      { index: 2, type: 'card', cardId: 'c2', title: 'Other' },
    ]);
    const s = state();
    const inlined = structuredClone(s.cards);
    (inlined['c1']!.content.attachments[1] as { data: string }).data = btoa('ID3');
    const withContent = smartView(s, true, inlined).cards[0]!['attachments'] as Array<Record<string, unknown>>;
    expect(withContent[0]!['text']).toBe('X:1\nK:G');
    expect(withContent[1]!['base64']).toBe(btoa('ID3'));
  });

  it('marks reviews that came from the analyser, and leaves the analyses and settings out', () => {
    const v = smartView(state(), false);
    expect(v.reviews).toEqual([{ profileId: 'p1', cardId: 'c1', entries: [
      ['2026-01-01T10:00:00.000Z', 'good'], ['2026-02-01T10:00:00.000Z', 'easy', 'linked'],
    ] }]);
    const json = viewJson(v);
    expect(json).not.toContain('tune-analyser');
    expect(json).not.toContain('availabilityThreshold');
    expect(JSON.parse(json)).toEqual(JSON.parse(JSON.stringify(v)));
  });

  it('shows the analyses to read, newest first, with what links a detection to a card', () => {
    const s = state();
    const det = (id: string, tuneId: string, name: string, start: number, extra: Record<string, unknown> = {}) => ({
      id, tuneId, settingId: '1', displayName: name, dance: 'jig', meter: '6/8', start, end: start + 60.4,
      confidence: 0.8234, bucket: 'high', meanScore: 1, evidence: [], alternates: [], viterbiPick: {}, userConfirmed: false,
      liked: false, finalized: true, ...extra,
    });
    s.modules = { 'tune-analyser': {
      sessions: {
        old: { id: 'old', name: 'Old', date: '2026-01-01T20:00:00.000Z', duration: 3600.4, mimeType: 'audio/webm', source: 'live', status: 'done',
          annotations: [det('d2', '55', 'the kesh', 300), det('d1', '1', "o'neill's", 10.6, { userConfirmed: true, liked: true })] },
        new: { id: 'new', name: 'New', date: '2026-09-01T20:00:00.000Z', duration: 60, mimeType: 'audio/webm', source: 'import', status: 'done', annotations: [] },
      },
      folders: { af: { id: 'af', name: '2026', folderIds: [], sessionIds: ['old'] } }, rootFolderIds: ['af'],
    } } as never;
    s.cardWorks['p1:c1']!.history.push({ ts: Date.parse('2026-01-02T00:00:00.000Z'), rating: 'hard', id: 'analysis:old:d2' });
    const v = smartView(s, false);
    expect(v.analyses.map(a => a.name)).toEqual(['New', 'Old']);
    expect(v.analyses[1]).toMatchObject({ duration: 3600, source: 'live', folder: '2026' });
    expect(v.analyses[1]!.detections).toEqual([
      { tune: "O'neill's", externalId: 'thesession:1', dance: 'jig', start: 11, end: 71, confidence: 0.82, confirmed: true, liked: true },
      { tune: 'The Kesh', externalId: 'thesession:55', dance: 'jig', start: 300, end: 360, confidence: 0.82, rated: 'hard' },
    ]);
  });

  it('is plain JSON that states its format', () => {
    const data = JSON.parse(viewJson(smartView(state(), false)));
    expect(data.format).toBe(VIEW_FORMAT);
    expect(data.cards).toHaveLength(2);
  });

  it('is described by instructions that name both formats', () => {
    const doc = smartEditInstructions();
    expect(doc).toContain(`\`${VIEW_FORMAT}\``);
    expect(doc).toContain(`"format": "${OPS_FORMAT}"`);
  });

  it('gives an example that parses as it stands', () => {
    const doc = smartEditInstructions();
    const example = doc.slice(doc.indexOf('## Example'));
    expect('ops' in parseAnswer(example)).toBe(true);
  });
});
