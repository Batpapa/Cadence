import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Card } from '../../types';

// The links' fetch and this device's key-value store, stood in for: what is
// tested is what the gathering does with them.
const kv = new Map<string, unknown>();
vi.mock('../db', () => ({
  kvGet: async (key: string) => kv.get(key),
  kvSet: async (key: string, value: unknown) => { kv.set(key, value); },
}));
const online = new Map<string, string>();
vi.mock('../../services/abcLink', () => ({
  fetchAbcLink: async (link: { url: string }) => {
    const text = online.get(link.url);
    if (text === undefined) throw new Error('offline');
    return { type: 'file', name: 'x.abc', mimeType: 'text/vnd.abc', data: btoa(text) };
  },
  peekAbcLink: () => undefined,
}));

const { cardIndexTunes, installCardRecognition } = await import('./cardIndexSource');
const { getSettingAbcMetaSync } = await import('./indexStore');
const { abcVersionHash } = await import('./cardIndex');
const { TUNE_ANALYSER_MODULE_KEY } = await import('../model');

const TUNE = (n: string) => `X:1\nT:${n}\nM:4/4\nL:1/8\nK:D\nDEFG ABcd|`;
const link = (url: string) => ({ type: 'embed' as const, id: url, url, title: 'score', embedUrl: url });
const tuneCard = (guid: string, attachments: Card['content']['attachments'], type = 'tune'): Card =>
  ({ id: guid, guid, name: guid, defaultImportance: 1, tags: [], type, content: { notes: '', attachments } });
const file = (text: string) => ({ type: 'file' as const, name: 'a.abc', mimeType: 'text/vnd.abc', data: btoa(text) });

beforeEach(() => { kv.clear(); online.clear(); });

describe('cardIndexTunes', () => {
  it('reads attached and linked scores of tune cards only', async () => {
    online.set('https://x.org/b.abc', TUNE('B'));
    const tunes = await cardIndexTunes({
      a: tuneCard('a', [file(TUNE('A'))]),
      b: tuneCard('b', [link('https://x.org/b.abc')]),
      n: tuneCard('n', [file(TUNE('N'))], 'tuneset'),
    });
    expect(tunes.map(t => t.guid).sort()).toEqual(['a', 'b']);
    expect(tunes.find(t => t.guid === 'b')!.versions[0]!.abc).toContain('T:B');
  });

  // Offline, the last text a link gave on this device stands in for it.
  it('keeps what a link gave, and uses it when the link cannot be had', async () => {
    const cards = { b: tuneCard('b', [link('https://x.org/b.abc')]) };
    online.set('https://x.org/b.abc', TUNE('B1'));
    await cardIndexTunes(cards);
    online.clear();
    const offline = await cardIndexTunes(cards);
    expect(offline[0]!.versions[0]!.abc).toContain('T:B1');
    online.set('https://x.org/b.abc', TUNE('B2'));
    expect((await cardIndexTunes(cards))[0]!.versions[0]!.abc).toContain('T:B2');
  });

  it('forgets the links no tune card holds any more', async () => {
    online.set('https://x.org/b.abc', TUNE('B'));
    await cardIndexTunes({ b: tuneCard('b', [link('https://x.org/b.abc')]) });
    await cardIndexTunes({ a: tuneCard('a', [file(TUNE('A'))]) });
    expect(kv.get('cardLinkAbc')).toEqual({});
  });
});

// A shared analysis carries the card versions it names (Analysis.cardVersions):
// the receiver reads them where its own cards cannot answer.
describe('a card version, read back', () => {
  const v1 = TUNE('V1'), v2 = TUNE('V2');
  const id = `card:g:${abcVersionHash(v1)}`;
  const state = (cards: Record<string, Card>) => ({
    cards,
    modules: { [TUNE_ANALYSER_MODULE_KEY]: { sessions: { s: { id: 's', annotations: [], cardVersions: { [id]: v1 } } } } },
  }) as unknown as import('../../types').AppState;

  it('comes from the received analysis when this device has not got the card', () => {
    installCardRecognition(() => state({}));
    expect(getSettingAbcMetaSync(id)?.abc).toBe(v1);
  });

  it('comes from the received analysis before the card\'s other score', () => {
    installCardRecognition(() => state({ g: tuneCard('g', [file(v2)]) }));
    expect(getSettingAbcMetaSync(id)?.abc).toBe(v1);
  });

  it('comes from the card itself when the card holds it', () => {
    const own = TUNE('V1');
    installCardRecognition(() => state({ g: tuneCard('g', [file(own)]) }));
    expect(getSettingAbcMetaSync(id)?.abc).toBe(own);
  });
});
