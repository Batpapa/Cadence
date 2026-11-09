import { describe, it, expect } from 'vitest';
import type { Card } from '../types';
import { cardSource, cardSourceLabel, stripSourceTag } from './cardSourceService';

const card = (externalId: string | undefined, tags: string[]): Card => ({
  id: 'c', guid: 'g', name: 'Tune', defaultImportance: 1, tags,
  ...(externalId ? { externalId } : {}),
  content: { notes: '', attachments: [] },
});

describe('cardSource', () => {
  it('reads the source off the external id', () => {
    expect(cardSource(card('thesession:1', []))).toBe('thesession');
    expect(cardSource(card('irishtuneinfo:12', []))).toBe('irishtuneinfo');
  });

  it('counts a TheSession set as TheSession', () => {
    expect(cardSource(card('thesession-set:1-147730', []))).toBe('thesession');
  });

  it('has no source for a hand-made card or an id this build does not know', () => {
    expect(cardSource(card(undefined, []))).toBeUndefined();
    expect(cardSource(card('someday:9', []))).toBeUndefined();
    expect(cardSource(undefined)).toBeUndefined();
  });

  it('names each source as the site does', () => {
    expect(cardSourceLabel('thesession')).toBe('TheSession');
    expect(cardSourceLabel('irishtuneinfo')).toBe('irishtune.info');
  });
});

describe('stripSourceTag', () => {
  it("removes the tag naming the card's own source, and only that", () => {
    const c = card('thesession:1', ['TheSession', 'reel', 'Dmajor']);
    expect(stripSourceTag(c)).toBe(true);
    expect(c.tags).toEqual(['reel', 'Dmajor']);
  });

  it('does the same for irishtune.info and for a TheSession set', () => {
    const iti = card('irishtuneinfo:3', ['IrishTuneInfo', 'jig']);
    const set = card('thesession-set:1-2', ['TheSession', 'Tuesday']);
    stripSourceTag(iti); stripSourceTag(set);
    expect(iti.tags).toEqual(['jig']);
    expect(set.tags).toEqual(['Tuesday']);
  });

  it('leaves the tag when the id says another source, or none', () => {
    const other = card('irishtuneinfo:3', ['TheSession']);
    const handMade = card(undefined, ['TheSession']);
    expect(stripSourceTag(other)).toBe(false);
    expect(stripSourceTag(handMade)).toBe(false);
    expect(other.tags).toEqual(['TheSession']);
    expect(handMade.tags).toEqual(['TheSession']);
  });

  it('is idempotent', () => {
    const c = card('thesession:1', ['TheSession']);
    stripSourceTag(c);
    expect(stripSourceTag(c)).toBe(false);
    expect(c.tags).toEqual([]);
  });

  it('removes every casing the importers ever wrote, and nothing longer', () => {
    const c = card('thesession:1', ['thesession', 'TheSession', 'thesession session', 'reel']);
    expect(stripSourceTag(c)).toBe(true);
    expect(c.tags).toEqual(['thesession session', 'reel']);
    const iti = card('irishtuneinfo:3', ['irishtuneinfo', 'IrishTuneInfo']);
    stripSourceTag(iti);
    expect(iti.tags).toEqual([]);
  });
});
