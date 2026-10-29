import { describe, it, expect } from 'vitest';
import type { Card } from '../types';
import type { Analysis, Detection, TunesetRecord } from './model';
import {
  reconcileTunesets, sameTunesets, recordOf, setCardFor, findSetHearings, isSettled, chainSpan,
} from './tunesets';
import { buildTunesetCard } from '../services/tunesetCard';
import { withChains, chainsOf } from './ui/timelineModel';
import { DetectionTracker } from './detectionState';

function ann(id: string, start: number, end: number | null, tuneId = id, finalized = true): Detection {
  return {
    id, tuneId, settingId: `${tuneId}0`, displayName: tuneId, dance: 'reel', meter: '4/4',
    start, end, confidence: 0.9, bucket: 'high', meanScore: 0.5, evidence: [], alternates: [],
    viterbiPick: { tuneId, settingId: `${tuneId}0`, displayName: tuneId, dance: 'reel', meter: '4/4', meanScore: 0.5 },
    userConfirmed: false, liked: false, finalized,
  };
}

let n = 0;
const newId = () => `new${++n}`;

describe('withChains', () => {
  it('chains detections whose hole is under 15 s, and a silence row ends a chain', () => {
    const anns = [ann('a', 0, 100), ann('b', 105, 200), ann('c', 260, 300), ann('d', 300, 400)];
    const kinds = withChains(anns, 400).map(x => x.kind === 'chain' ? `chain(${x.members.map(m => m.ann.id).join('')})` : x.kind);
    expect(kinds).toEqual(['chain(ab)', 'gap', 'chain(cd)']);
  });

  it('a hole of exactly 15 s is a silence, so it breaks the chain', () => {
    const items = withChains([ann('a', 0, 100), ann('b', 115, 200)], 200);
    expect(items.map(x => x.kind)).toEqual(['ann', 'gap', 'ann']);
  });

  it('a tune played alone stays a plain detection, with its index', () => {
    const items = withChains([ann('a', 0, 100), ann('b', 300, 400), ann('c', 400, 500)], 500);
    expect(items[0]).toMatchObject({ kind: 'ann', i: 0 });
    expect(items[2]).toMatchObject({ kind: 'chain' });
  });

  it('overlapping detections are one chain', () => {
    expect(chainsOf([ann('a', 0, 100), ann('b', 90, 200)], 200).map(c => c.map(d => d.id))).toEqual([['a', 'b']]);
  });
});

describe('withChains — the user\'s marks', () => {
  const shape = (items: ReturnType<typeof withChains>) => items.map(x =>
    x.kind === 'chain' ? `${x.cut ? '✂' : ''}chain(${x.rows.map(r => r.kind === 'gap' ? '_' : r.ann.id).join('')})`
      : x.kind === 'ann' ? `${x.cut ? '✂' : ''}${x.ann.id}` : `gap${x.nextId ? `>${x.nextId}` : ''}`);

  it('a cut opens a set where nothing stopped, and says so', () => {
    const anns = [ann('a', 0, 100), { ...ann('b', 105, 200), opensSet: true }, ann('c', 200, 300)];
    expect(shape(withChains(anns, 300))).toEqual(['a', '✂chain(bc)']);
  });

  it('a link carries a set on across a silence, which shows inside it', () => {
    const anns = [ann('a', 0, 100), ann('b', 100, 200), { ...ann('c', 260, 300), opensSet: false }, ann('d', 400, 500)];
    expect(shape(withChains(anns, 500))).toEqual(['chain(ab_c)', 'gap>d', 'd']);
    expect(chainsOf(anns, 500).map(c => c.map(d => d.id))).toEqual([['a', 'b', 'c']]);
  });

  it('a mark that agrees with the rule changes nothing, and the first detection always opens', () => {
    const anns = [{ ...ann('a', 0, 100), opensSet: false }, { ...ann('b', 200, 300), opensSet: true }, { ...ann('c', 300, 400), opensSet: false }];
    expect(shape(withChains(anns, 400))).toEqual(['a', 'gap>b', 'chain(bc)']);
  });

  it('no silence row before the first detection or after the last offers a link', () => {
    expect(shape(withChains([ann('a', 30, 100)], 200))).toEqual(['gap', 'a', 'gap']);
  });
});

describe('reconcileTunesets', () => {
  it('gives every settled chain an entry, and keeps ids and hearts across a recomputation', () => {
    const chains = [[ann('a', 0, 1), ann('b', 1, 2)], [ann('c', 9, 10), ann('d', 10, 11)]];
    const first = reconcileTunesets(undefined, chains, newId);
    expect(first.map(r => r.detectionIds)).toEqual([['a', 'b'], ['c', 'd']]);
    const liked = first.map((r, i) => (i === 1 ? { ...r, liked: true } : r));
    const again = reconcileTunesets(liked, chains, newId);
    expect(again).toEqual(liked);
    expect(sameTunesets(liked, again)).toBe(true);
  });

  it('leaves out a chain still being decoded', () => {
    const chains = [[ann('a', 0, 1), ann('b', 1, null)], [ann('c', 9, 10), ann('d', 10, 11, 'd', false)]];
    expect(reconcileTunesets(undefined, chains, newId)).toEqual([]);
    expect(isSettled(chains[0]!)).toBe(false);
  });

  it('a set that grows a tune keeps its identity', () => {
    const prev: TunesetRecord[] = [{ id: 'S', detectionIds: ['a', 'b'], liked: true }];
    const next = reconcileTunesets(prev, [[ann('a', 0, 1), ann('b', 1, 2), ann('c', 2, 3)]], newId);
    expect(next).toEqual([{ id: 'S', detectionIds: ['a', 'b', 'c'], liked: true }]);
  });

  it('a set split in two keeps its identity on the larger half', () => {
    const prev: TunesetRecord[] = [{ id: 'S', detectionIds: ['a', 'b', 'c', 'd', 'e'], liked: true }];
    const next = reconcileTunesets(prev, [[ann('a', 0, 1), ann('b', 1, 2)], [ann('c', 20, 21), ann('d', 21, 22), ann('e', 22, 23)]], () => 'fresh');
    expect(next).toEqual([
      { id: 'fresh', detectionIds: ['a', 'b'] },
      { id: 'S', detectionIds: ['c', 'd', 'e'], liked: true },
    ]);
  });

  it('two sets merged keep the one that brought the most tunes', () => {
    const prev: TunesetRecord[] = [{ id: 'S1', detectionIds: ['a', 'b'] }, { id: 'S2', detectionIds: ['c', 'd', 'e'] }];
    const next = reconcileTunesets(prev, [[ann('a', 0, 1), ann('b', 1, 2), ann('c', 2, 3), ann('d', 3, 4), ann('e', 4, 5)]], newId);
    expect(next.map(r => r.id)).toEqual(['S2']);
  });

  it('an entry nothing matches any more is dropped', () => {
    const prev: TunesetRecord[] = [{ id: 'S', detectionIds: ['x', 'y'] }];
    expect(reconcileTunesets(prev, [], newId)).toEqual([]);
  });

  it('recordOf finds the entry of exactly that chain', () => {
    const chain = [ann('a', 0, 1), ann('b', 1, 2)];
    const recs: TunesetRecord[] = [{ id: 'S', detectionIds: ['a', 'b'] }];
    expect(recordOf(recs, chain)?.id).toBe('S');
    expect(recordOf(recs, [chain[0]!])).toBeUndefined();
  });
});

function tuneCard(id: string, tuneId: string): Card {
  return { id, guid: id, name: id.toUpperCase(), defaultImportance: 1, tags: [], type: 'tune', externalId: `thesession:${tuneId}`, content: { notes: '', attachments: [] } };
}

describe('set cards', () => {
  const cards: Record<string, Card> = {
    ta: tuneCard('ta', '1'), tb: tuneCard('tb', '2'), tc: tuneCard('tc', '3'),
  };
  const set = buildTunesetCard([cards.ta!, cards.tb!], { defaultRepeat: 3, attachments: [], newId: () => 'set' });
  cards.set = set;

  it('builds a set named after its tunes, with the usual repeats', () => {
    expect(set).toMatchObject({ type: 'tuneset', computedName: true, name: 'TA / TB' });
    expect(set.tunes!.map(r => [r.id, r.repeat])).toEqual([['ta', 3], ['tb', 3]]);
  });

  it('writes a single pass by absence, as the card page does', () => {
    const once = buildTunesetCard([cards.ta!, cards.tb!], { defaultRepeat: 1, attachments: [], newId: () => 'once' });
    expect(once.tunes!.every(r => !('repeat' in r))).toBe(true);
  });

  it('matches the same tunes in the same order only', () => {
    expect(setCardFor(['1', '2'], cards)?.id).toBe('set');
    expect(setCardFor(['2', '1'], cards)).toBeUndefined();
    expect(setCardFor(['1', '2', '3'], cards)).toBeUndefined();
  });

  it('finds where a set was heard, newest analysis first', () => {
    const s = (id: string, date: string | null, annotations: Detection[]): Analysis => ({
      id, name: id, date, duration: 1000, mimeType: 'audio/webm', source: 'import', annotations,
    });
    const sessions = {
      old: s('old', '2026-01-01T10:00:00Z', [ann('a', 0, 100, '1'), ann('b', 100, 200, '2')]),
      neu: s('neu', '2026-06-01T10:00:00Z', [ann('c', 0, 100, '1'), ann('d', 100, 200, '2'), ann('e', 400, 500, '1'), ann('f', 505, 600, '2')]),
      rev: s('rev', '2026-07-01T10:00:00Z', [ann('g', 0, 100, '2'), ann('h', 100, 200, '1')]),
    };
    const found = findSetHearings(set, cards, sessions);
    expect(found.map(f => `${f.session.id}:${f.chain.map(d => d.id).join('')}`)).toEqual(['neu:cd', 'neu:ef', 'old:ab']);
    expect(chainSpan(found[1]!.chain, 1000)).toEqual({ start: 400, end: 600 });
  });
});

describe('the table kept while recording or importing', () => {
  const ev = (d: Detection) => ({ type: 'close' as const, detection: d });

  it('saves nothing when the table was never asked for (the sets off)', () => {
    const t = new DetectionTracker();
    t.apply([ev(ann('a', 0, 100)), ev(ann('b', 100, 200))]);
    expect(t.finalSets(newId)).toBeUndefined();
  });

  it('a heart given while the set is still playing reaches the saved analysis, under the same id', () => {
    const t = new DetectionTracker();
    // B still open: the set is not settled, but already has an entry.
    t.apply([ev(ann('a', 0, 100)), { type: 'open', detection: ann('b', 100, null, 'b', false) }]);
    const [rec] = t.setTable(newId);
    expect(rec?.detectionIds).toEqual(['a', 'b']);
    t.toggleSetLike(rec!.id);
    // B closes, and C joins without a silence: the set grows, and keeps its id.
    t.finish([ev(ann('b', 100, 200)), ev(ann('c', 205, 300))]);
    const saved = t.finalSets(newId);
    expect(saved).toEqual([{ id: rec!.id, detectionIds: ['a', 'b', 'c'], liked: true }]);
  });

  it('a cut given while recording survives the decoder re-iding the tune and moving its start', () => {
    const t = new DetectionTracker();
    t.apply([ev(ann('a', 0, 100)), { type: 'open', detection: ann('b', 100, null, 'b', false) }]);
    t.setOpensSet('b', true);
    expect(t.get('b')?.opensSet).toBe(true);
    // The decoder hands the stretch to a new detection, starting a hop later.
    t.apply([{ type: 'retract', id: 'b' }, { type: 'open', detection: ann('b2', 105, null, 'x', false) }]);
    expect(t.get('b2')?.opensSet).toBe(true);
    t.finish([ev(ann('b2', 105, 200, 'x'))]);
    expect(t.finalSets(newId)).toBeUndefined();
    expect(t.list().map(d => d.opensSet)).toEqual([undefined, true]);
    // Handed back to the rule: the set is whole again.
    t.setOpensSet('b2', undefined);
    expect(t.list().map(d => d.opensSet)).toEqual([undefined, undefined]);
  });
});
