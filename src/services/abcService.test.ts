import { describe, it, expect } from 'vitest';
import { buildTunesetAbc, splitAbcTunes, parseAbcBlock, encodeAbc, MAX_REPEAT, DEFAULT_TUNE_REPEAT, defaultTuneRepeat } from './abcService';
import type { Card, CardRef } from '../types';

function abcBlock(x: number, title: string, rhythm: string, meter: string, key: string, music: string): string {
  return `X: ${x}\nT: ${title}\nR: ${rhythm}\nM: ${meter}\nL: 1/8\nK: ${key}\n${music}`;
}

function tune(id: string, name: string, blocks: string[], preferredIndex?: number): Card {
  return {
    id, guid: `guid-${id}`, name, defaultImportance: 1, tags: [], type: 'tune',
    content: {
      notes: '',
      attachments: blocks.length === 0 ? [] : [{
        type: 'file', name: `${name}.abc`, mimeType: 'text/vnd.abc',
        data: encodeAbc(blocks.join('\n\n')),
        ...(preferredIndex !== undefined ? { preferredIndex } : {}),
      }],
    },
  };
}

const ref = (c: Card): CardRef => ({ id: c.id, guid: c.guid, title: c.name });

function set(name: string, refs: CardRef[]): Card {
  return {
    id: 's', guid: 'guid-s', name, defaultImportance: 1, tags: [], type: 'tuneset',
    tunes: refs, content: { notes: '', attachments: [] },
  };
}
const lib = (...cs: Card[]) => Object.fromEntries(cs.map(c => [c.id, c]));

const cooleys = tune('a', "Cooley's", [abcBlock(1, "Cooley's", 'reel', '4/4', 'Edor', 'EBBA B2 EB|')]);
const wiseMaid = tune('b', 'The Wise Maid', [abcBlock(1, 'The Wise Maid', 'reel', '4/4', 'Dmaj', 'FAAB AFED|')]);
const kesh = tune('c', 'The Kesh', [abcBlock(1, 'The Kesh', 'jig', '6/8', 'Gmaj', 'G3 GAB|')]);

describe('buildTunesetAbc — one block, tunes in sequence', () => {
  it('produces a SINGLE X: block whatever the number of tunes', () => {
    const abc = buildTunesetAbc(set('Set', [ref(cooleys), ref(wiseMaid), ref(kesh)]), lib(cooleys, wiseMaid, kesh))!;
    expect(splitAbcTunes(abc)).toHaveLength(1);
    expect((abc.match(/^X:/gm) ?? [])).toHaveLength(1);
  });

  it('titles the block with the set and labels each tune as a part', () => {
    const abc = buildTunesetAbc(set("Cooley's / The Wise Maid", [ref(cooleys), ref(wiseMaid)]), lib(cooleys, wiseMaid))!;
    expect(abc).toContain("T: Cooley's / The Wise Maid");
    expect(abc).toContain("[P:Cooley's]");
    expect(abc).toContain('[P:The Wise Maid]');
  });

  it('keeps the music of every tune, in order', () => {
    const abc = buildTunesetAbc(set('Set', [ref(kesh), ref(cooleys)]), lib(cooleys, kesh))!;
    expect(abc.indexOf('G3 GAB|')).toBeLessThan(abc.indexOf('EBBA B2 EB|'));
  });
});

describe('buildTunesetAbc — inline changes', () => {
  it('carries key, meter and tempo INLINE when they change', () => {
    // Reel in Edor 4/4 → jig in Gmaj 6/8: everything changes at the seam.
    const abc = buildTunesetAbc(set('Set', [ref(cooleys), ref(kesh)]), lib(cooleys, kesh))!;
    expect(abc).toContain('[M:6/8]');
    expect(abc).toContain('[K:Gmaj]');
    expect(abc).toContain('[Q:3/8=120]');
  });

  it('does NOT restate what the header already says', () => {
    const abc = buildTunesetAbc(set('Set', [ref(cooleys)]), lib(cooleys))!;
    expect(abc).toContain('M: 4/4');
    expect(abc).toContain('K: Edor');
    expect(abc).not.toContain('[M:');
    expect(abc).not.toContain('[K:');
  });

  it('does not restate an unchanged signature between two like tunes', () => {
    // Both reels in 4/4; only the key differs.
    const abc = buildTunesetAbc(set('Set', [ref(cooleys), ref(wiseMaid)]), lib(cooleys, wiseMaid))!;
    expect(abc).not.toContain('[M:');
    expect(abc).toContain('[K:Dmaj]');
  });

  it('gives each tune type its own tempo, which is what a fused set needs', () => {
    const abc = buildTunesetAbc(set('Set', [ref(cooleys), ref(kesh)]), lib(cooleys, kesh))!;
    expect(abc).toContain('Q: 1/4=190');   // header, the reel
    expect(abc).toContain('[Q:3/8=120]');  // inline, the jig
  });
});

describe('buildTunesetAbc — which version of each tune', () => {
  it('takes the starred setting, not the first', () => {
    const twoSettings = tune('m', 'Multi', [
      abcBlock(1, 'Multi', 'reel', '4/4', 'Ador', 'first version|'),
      abcBlock(2, 'Multi', 'reel', '4/4', 'Gmaj', 'second version|'),
    ], 1);
    const abc = buildTunesetAbc(set('Set', [ref(twoSettings)]), lib(twoSettings))!;
    expect(abc).toContain('second version|');
    expect(abc).not.toContain('first version|');
  });

  it('falls back to the first setting when none is starred', () => {
    const twoSettings = tune('m', 'Multi', [
      abcBlock(1, 'Multi', 'reel', '4/4', 'Ador', 'first version|'),
      abcBlock(2, 'Multi', 'reel', '4/4', 'Gmaj', 'second version|'),
    ]);
    const abc = buildTunesetAbc(set('Set', [ref(twoSettings)]), lib(twoSettings))!;
    expect(abc).toContain('first version|');
  });

  it('clamps a starred index that no longer exists', () => {
    const one = tune('m', 'Multi', [abcBlock(1, 'Multi', 'reel', '4/4', 'Ador', 'only|')], 5);
    expect(buildTunesetAbc(set('Set', [ref(one)]), lib(one))).toContain('only|');
  });
});

describe('buildTunesetAbc — a tune with no score', () => {
  it('KEEPS ITS PLACE as a labelled bar of silence', () => {
    const scoreless = tune('n', 'No Score Tune', []);
    const abc = buildTunesetAbc(set('Set', [ref(cooleys), ref(scoreless), ref(wiseMaid)]), lib(cooleys, scoreless, wiseMaid))!;
    expect(abc).toContain('[P:No Score Tune] "^no score" Z4 |');
    // Between the two, not appended at the end — the set keeps its order.
    expect(abc.indexOf('[P:No Score Tune]')).toBeGreaterThan(abc.indexOf("[P:Cooley's]"));
    expect(abc.indexOf('[P:No Score Tune]')).toBeLessThan(abc.indexOf('[P:The Wise Maid]'));
  });

  it('does the same for a tune that no longer exists, naming it from the reference', () => {
    const gone: CardRef = { id: 'gone', guid: 'gone', title: 'Deleted Tune' };
    const abc = buildTunesetAbc(set('Set', [ref(cooleys), gone]), lib(cooleys))!;
    expect(abc).toContain('[P:Deleted Tune] "^no score" Z4 |');
  });

  it('returns null when NOTHING in the set has a score', () => {
    const scoreless = tune('n', 'No Score', []);
    expect(buildTunesetAbc(set('Set', [ref(scoreless)]), lib(scoreless))).toBeNull();
  });

  it('returns null for an empty set', () => {
    expect(buildTunesetAbc(set('Set', []), lib())).toBeNull();
  });
});

describe('buildTunesetAbc — hostile input', () => {
  it('strips brackets and quotes from a label, which would end a field early', () => {
    const nasty = tune('x', 'Bad] "Name"', [abcBlock(1, 'x', 'reel', '4/4', 'Dmaj', 'ABC|')]);
    const abc = buildTunesetAbc(set('Set', [ref(nasty)]), lib(nasty))!;
    expect(abc).toContain('[P:Bad Name]');
  });

  it('survives an attachment whose base64 is not decodable', () => {
    const broken = tune('x', 'Broken', [abcBlock(1, 'x', 'reel', '4/4', 'Dmaj', 'ABC|')]);
    (broken.content.attachments[0] as { data: string }).data = 'not!base64!';
    const abc = buildTunesetAbc(set('Set', [ref(broken), ref(cooleys)]), lib(broken, cooleys))!;
    expect(abc).toContain('[P:Broken] "^no score" Z4 |');
    expect(abc).toContain("EBBA B2 EB|");
  });

  it('ignores a non-ABC attachment when looking for the score', () => {
    const withAudio = tune('x', 'Audio', []);
    withAudio.content.attachments = [
      { type: 'file', name: 'rec.mp3', mimeType: 'audio/mpeg', data: encodeAbc('x') },
    ];
    expect(buildTunesetAbc(set('Set', [ref(withAudio)]), lib(withAudio))).toBeNull();
  });
});

describe('parseAbcBlock', () => {
  it('splits the header from the music at the K: line', () => {
    const b = parseAbcBlock(abcBlock(1, 'T', 'reel', '4/4', 'Edor', 'notes here|\nmore|'));
    expect(b.title).toBe('T');
    expect(b.rhythm).toBe('reel');
    expect(b.meter).toBe('4/4');
    expect(b.key).toBe('Edor');
    expect(b.music).toBe('notes here|\nmore|');
  });

  it('returns empty music when there is no K: line at all', () => {
    expect(parseAbcBlock('X: 1\nT: Headerless').music).toBe('');
  });
});

describe('buildTunesetAbc — repeats', () => {
  it('writes the music out once per pass, because nothing else is audible', () => {
    const s = set('Set', [{ ...ref(cooleys), repeat: 3 }]);
    const abc = buildTunesetAbc(s, lib(cooleys))!;
    expect(abc.split('EBBA B2 EB|').length - 1).toBe(3);
  });

  it('numbers the passes so a reader knows where they are', () => {
    const abc = buildTunesetAbc(set('Set', [{ ...ref(cooleys), repeat: 3 }]), lib(cooleys))!;
    expect(abc).toContain("[P:Cooley's 1/3]");
    expect(abc).toContain("[P:Cooley's 2/3]");
    expect(abc).toContain("[P:Cooley's 3/3]");
  });

  it('leaves a single pass unnumbered', () => {
    const abc = buildTunesetAbc(set('Set', [ref(cooleys)]), lib(cooleys))!;
    expect(abc).toContain("[P:Cooley's]");
    expect(abc).not.toContain('1/1');
  });

  it('restates a changed signature on the FIRST pass only', () => {
    const abc = buildTunesetAbc(set('Set', [ref(cooleys), { ...ref(kesh), repeat: 2 }]), lib(cooleys, kesh))!;
    expect(abc.split('[K:Gmaj]').length - 1).toBe(1);
    expect(abc.split('[M:6/8]').length - 1).toBe(1);
    expect(abc.split('[Q:3/8=120]').length - 1).toBe(1);
    expect(abc.split('G3 GAB|').length - 1).toBe(2);
  });

  it('treats an absent, zero or negative count as one pass', () => {
    for (const repeat of [undefined, 0, -4]) {
      const abc = buildTunesetAbc(set('Set', [{ ...ref(cooleys), repeat }]), lib(cooleys))!;
      expect(abc.split('EBBA B2 EB|').length - 1).toBe(1);
    }
  });

  it('caps an absurd count rather than generating an unusable score', () => {
    const abc = buildTunesetAbc(set('Set', [{ ...ref(cooleys), repeat: 999 }]), lib(cooleys))!;
    expect(abc.split('EBBA B2 EB|').length - 1).toBe(MAX_REPEAT);
  });

  it('does not repeat a tune that has no score — one silence is enough', () => {
    const scoreless = tune('n', 'No Score', []);
    const abc = buildTunesetAbc(
      set('Set', [ref(cooleys), { ...ref(scoreless), repeat: 4 }]),
      lib(cooleys, scoreless),
    )!;
    expect(abc.split('"^no score"').length - 1).toBe(1);
  });
});

describe('the default number of repeats', () => {
  it('is three — the Irish convention — when the user has not said otherwise', () => {
    expect(defaultTuneRepeat({})).toBe(DEFAULT_TUNE_REPEAT);
    expect(DEFAULT_TUNE_REPEAT).toBe(3);
  });

  it('is whatever number the user has set instead', () => {
    expect(defaultTuneRepeat({ defaultTuneRepeat: 2 })).toBe(2);
    expect(defaultTuneRepeat({ defaultTuneRepeat: 1 })).toBe(1);
  });

  it('never yields a count the score builder would refuse', () => {
    // The setting and the per-tune field share one ceiling; a stored value
    // from a build with a different one must not slip past it.
    expect(defaultTuneRepeat({ defaultTuneRepeat: 999 })).toBe(MAX_REPEAT);
    expect(defaultTuneRepeat({ defaultTuneRepeat: 0 })).toBe(1);
    expect(defaultTuneRepeat({ defaultTuneRepeat: NaN })).toBe(1);
  });
});
