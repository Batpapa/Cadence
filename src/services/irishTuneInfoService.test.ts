import { describe, it, expect, afterEach, vi } from 'vitest';
import { fetchTuneById, tuneToCard } from './irishTuneInfoService';

// What the scraper answers for tune 1022, before and after it learned to take
// the editorial notes out of the titles block (2026-09-17).
const base = {
  id: 1022, title: 'Kesh Jig', rhythm: 'Double jig', bars: 32, structure: 'AABB', mode: 'G Major',
  featuredAudioUrl: null, discography: [], sourceUrl: 'https://www.irishtune.info/tune/1022/',
};
const oldScraper = {
  ...base,
  titles: ['Kesh Jig, The', 'Kesh Jig', 'The Kesh', "The Mountaineer's March (for 3rd figure of The West Kerry Set on JRSLCB 2) (also in A or C or D)"],
};
const newScraper = {
  ...base,
  titles: ['Kesh Jig, The', 'Kesh Jig', 'The Kesh', "The Mountaineer's March"],
  titleNotes: ['for 3rd figure of The West Kerry Set on JRSLCB 2', 'also in A or C or D'],
};

function answer(body: unknown): void {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })));
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('irishtune.info names and aliases', () => {
  it('names the card after the first title, article moved back, and keeps the rest as aliases', async () => {
    answer(newScraper);
    const tune = await fetchTuneById(1022);
    expect(tune.name).toBe('The Kesh Jig');
    expect(tune.aliases).toEqual(['Kesh Jig', 'The Kesh', "The Mountaineer's March"]);
    const card = tuneToCard(tune);
    expect(card.name).toBe('The Kesh Jig');
    expect(card.aliases).toEqual(tune.aliases);
  });

  it('reads no titles from a scraper that still glues the notes to them', async () => {
    // Its last "title" carries the notes; it must not become an alias.
    answer(oldScraper);
    const tune = await fetchTuneById(1022);
    expect(tune.name).toBe('Kesh Jig');
    expect(tune.aliases).toEqual([]);
    expect('aliases' in tuneToCard(tune)).toBe(false);
  });

  it('falls back to the page heading when the list is empty', async () => {
    answer({ ...newScraper, titles: [], titleNotes: [] });
    const tune = await fetchTuneById(1022);
    expect(tune.name).toBe('Kesh Jig');
    expect(tune.aliases).toEqual([]);
  });
});
