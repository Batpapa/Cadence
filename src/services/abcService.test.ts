import { describe, it, expect } from 'vitest';
import {
  buildTunesetAbc, splitAbcTunes, parseAbcBlock, encodeAbc, MAX_REPEAT, DEFAULT_TUNE_REPEAT, defaultTuneRepeat,
  tunesetAbcPlaceholder, addTunesetAbcOnConvert, addTunesetAbcOnBecomingSet, ADD_TUNESET_ABC_BY_DEFAULT,
  musicIncipit, abcDurationUnits, abcIncipit, TUNE_TEMPOS,
  abcOpenMode, ABC_OPEN_MODE_DEFAULT,
} from './abcService';
import { hasTunesetScore } from './cardTypeService';
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

// Repeats are OFF unless asked for. The counts still live on each tune — the
// card view still shows ×N — they are simply not spelled out in the notation,
// because a set of three tunes played three times each is nine written-out
// tunes to read through.
describe('buildTunesetAbc — repeats, off by default', () => {
  it('writes each tune once however many passes it carries', () => {
    const abc = buildTunesetAbc(set('Set', [{ ...ref(cooleys), repeat: 3 }]), lib(cooleys))!;
    expect(abc.split('EBBA B2 EB|').length - 1).toBe(1);
  });

  it('leaves the label unnumbered, since there is one pass to number', () => {
    const abc = buildTunesetAbc(set('Set', [{ ...ref(cooleys), repeat: 3 }]), lib(cooleys))!;
    expect(abc).toContain("[P:Cooley's]");
    expect(abc).not.toContain('1/3');
  });

  it('leaves the stored count alone — this is a rendering choice, not an edit', () => {
    const s = set('Set', [{ ...ref(cooleys), repeat: 3 }]);
    buildTunesetAbc(s, lib(cooleys));
    expect(s.tunes![0]!.repeat).toBe(3);
  });
});

describe('buildTunesetAbc — repeats, when asked for', () => {
  it('writes the music out once per pass, because nothing else is audible', () => {
    const s = set('Set', [{ ...ref(cooleys), repeat: 3 }]);
    const abc = buildTunesetAbc(s, lib(cooleys), { includeRepeats: true })!;
    expect(abc.split('EBBA B2 EB|').length - 1).toBe(3);
  });

  it('numbers the passes so a reader knows where they are', () => {
    const abc = buildTunesetAbc(set('Set', [{ ...ref(cooleys), repeat: 3 }]), lib(cooleys), { includeRepeats: true })!;
    expect(abc).toContain("[P:Cooley's 1/3]");
    expect(abc).toContain("[P:Cooley's 2/3]");
    expect(abc).toContain("[P:Cooley's 3/3]");
  });

  it('leaves a single pass unnumbered', () => {
    const abc = buildTunesetAbc(set('Set', [ref(cooleys)]), lib(cooleys), { includeRepeats: true })!;
    expect(abc).toContain("[P:Cooley's]");
    expect(abc).not.toContain('1/1');
  });

  it('restates a changed signature on the FIRST pass only', () => {
    const abc = buildTunesetAbc(set('Set', [ref(cooleys), { ...ref(kesh), repeat: 2 }]), lib(cooleys, kesh), { includeRepeats: true })!;
    expect(abc.split('[K:Gmaj]').length - 1).toBe(1);
    expect(abc.split('[M:6/8]').length - 1).toBe(1);
    expect(abc.split('[Q:3/8=120]').length - 1).toBe(1);
    expect(abc.split('G3 GAB|').length - 1).toBe(2);
  });

  it('treats an absent, zero or negative count as one pass', () => {
    for (const repeat of [undefined, 0, -4]) {
      const abc = buildTunesetAbc(set('Set', [{ ...ref(cooleys), repeat }]), lib(cooleys), { includeRepeats: true })!;
      expect(abc.split('EBBA B2 EB|').length - 1).toBe(1);
    }
  });

  it('caps an absurd count rather than generating an unusable score', () => {
    const abc = buildTunesetAbc(set('Set', [{ ...ref(cooleys), repeat: 999 }]), lib(cooleys), { includeRepeats: true })!;
    expect(abc.split('EBBA B2 EB|').length - 1).toBe(MAX_REPEAT);
  });

  it('does not repeat a tune that has no score — one silence is enough', () => {
    const scoreless = tune('n', 'No Score', []);
    const abc = buildTunesetAbc(
      set('Set', [ref(cooleys), { ...ref(scoreless), repeat: 4 }]),
      lib(cooleys, scoreless),
      { includeRepeats: true },
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

describe('the score added when a card becomes a set', () => {
  const asSet = (attachments: Card['content']['attachments'] = []): Card => ({
    id: 'x', guid: 'guid-x', name: 'New set', defaultImportance: 1, tags: [],
    type: 'tuneset', content: { notes: '', attachments },
  });

  it('is a placeholder, not a score: empty data, marked as generated', () => {
    const att = tunesetAbcPlaceholder();
    expect(att.type).toBe('file');
    if (att.type !== 'file') return;
    expect(att.data).toBe('');
    expect(att.generatedBy).toBe('tuneset');
  });

  it('is added when the user has said nothing — absence means yes', () => {
    const card = asSet();
    addTunesetAbcOnBecomingSet(card, {});
    expect(hasTunesetScore(card.content.attachments)).toBe(true);
    expect(addTunesetAbcOnConvert({})).toBe(ADD_TUNESET_ABC_BY_DEFAULT);
  });

  it('is NOT added when the user turned the setting off', () => {
    const card = asSet();
    addTunesetAbcOnBecomingSet(card, { addTunesetAbcOnConvert: false });
    expect(card.content.attachments).toHaveLength(0);
  });

  it('never lands twice on the same card', () => {
    const card = asSet();
    addTunesetAbcOnBecomingSet(card, {});
    addTunesetAbcOnBecomingSet(card, {});
    expect(card.content.attachments).toHaveLength(1);
  });

  it('leaves a card that is not a set alone', () => {
    const card = { ...asSet(), type: 'tune' };
    addTunesetAbcOnBecomingSet(card, {});
    expect(card.content.attachments).toHaveLength(0);
  });

  it('keeps the attachments the card already had', () => {
    const own = { type: 'file' as const, name: 'ABC', mimeType: 'text/vnd.abc', data: encodeAbc('X: 1') };
    const card = asSet([own]);
    addTunesetAbcOnBecomingSet(card, {});
    expect(card.content.attachments).toHaveLength(2);
    // A file of the user's own called "ABC" is not the generated one: the
    // marker is `generatedBy`, never the name.
    expect(card.content.attachments[0]).toBe(own);
  });
});

describe('musicIncipit — le rappel de deux mesures', () => {
  // Asked for from the field: "je veux juste un rappel de comment les morceaux
  // commencent". The hard part is not the cut, it is the PICKUP: 37.4% of
  // TheSession's settings start with one (measured over 55 285 settings), and
  // it is exactly the half-bar a player needs to come in on.
  const reel = (m: string) => musicIncipit(m, '4/4', '1/8');

  it('garde deux mesures pleines', () => {
    expect(reel('EBBA B2 EB|B2 AB dBAG|FDAD BDAD|FDAD dAFD|'))
      .toBe('EBBA B2 EB | B2 AB dBAG |');
  });

  it('GARDE la levee, et ne la compte pas comme une mesure', () => {
    // "D2" is two eighths in a 4/4 bar of eight: a pickup, not a bar.
    expect(reel('D2|EBBA B2 EB|B2 AB dBAG|FDAD BDAD|'))
      .toBe('D2 | EBBA B2 EB | B2 AB dBAG |');
  });

  it('compte en unites de L, pas en notes', () => {
    // A jig bar is six eighths; two bars is twelve notes, which is what the
    // request asked for in the first place.
    expect(musicIncipit('G3 GAB|dBA GED|GAB dBA|', '6/8', '1/8'))
      .toBe('G3 GAB | dBA GED |');
  });

  it('laisse tomber les marques de reprise', () => {
    // An incipit stops mid-tune, so a kept `|:` would open a repeat that
    // nothing ever closes.
    expect(reel('|:EBBA B2 EB|B2 AB dBAG:|')).toBe('EBBA B2 EB | B2 AB dBAG |');
  });

  it('reconnait AUSSI les doubles barres de reprise', () => {
    // Found by running this over TheSession's 55 288 settings, not by reading
    // the code: JavaScript alternation takes the FIRST branch that matches,
    // so `||` listed before `||:` ate the bar and left a bare ":" glued to
    // the next note. 46 scores rendered with a stray colon.
    // A 6/8 bar, given its real meter: read as 4/4 it measures short and is
    // taken for a pickup, which is the parser being right and the fixture
    // being wrong — and a reminder that the meter is what decides here.
    expect(musicIncipit('||: efe cAc|dcd BGF|EAA GAB|', '6/8', '1/8')).toBe('efe cAc | dcd BGF |');
    expect(reel('EBBA B2 EB:||B2 AB dBAG|FDAD BDAD|')).toBe('EBBA B2 EB | B2 AB dBAG |');
  });

  it('rend la musique telle quelle quand elle est plus courte que demande', () => {
    expect(reel('EBBA B2 EB|')).toBe('EBBA B2 EB |');
  });

  it('survit a une metrique illisible en comptant les segments', () => {
    // No pickup detection possible, so every segment counts — one half-bar
    // too many at worst, never a broken score.
    expect(musicIncipit('D2|EBBA B2 EB|B2 AB dBAG|', 'zz', '1/8'))
      .toBe('D2 | EBBA B2 EB |');
  });

  it('ne compte pas les ornements comme de la duree', () => {
    // Grace notes, decorations and annotations carry no time; counting them
    // would turn a full bar into a false pickup.
    const withOrnaments = '{g}EBBA !trill!B2 "^cran" EB|B2 AB dBAG|FDAD BDAD|';
    expect(reel(withOrnaments).split('|').length).toBe(3);
  });
});

describe('abcDurationUnits', () => {
  it('compte les longueurs explicites', () => {
    expect(abcDurationUnits('ABCD')).toBe(4);
    expect(abcDurationUnits('A2B2')).toBe(4);
    expect(abcDurationUnits('A/B/')).toBe(1);
    expect(abcDurationUnits('A//')).toBe(0.25);
    expect(abcDurationUnits('A3/2')).toBe(1.5);
  });

  it('compte un accord pour une seule duree', () => {
    expect(abcDurationUnits('[CEG]2')).toBe(2);
  });

  it('compte les silences, qui occupent bien la mesure', () => {
    expect(abcDurationUnits('z4')).toBe(4);
  });

  it('ne compte rien pour ce qu il ne sait pas lire', () => {
    // The lenient direction on purpose: unread music looks SHORTER, which at
    // worst shows half a bar too much.
    expect(abcDurationUnits('')).toBe(0);
    expect(abcDurationUnits('"Am" !fermata!')).toBe(0);
  });
});

describe('abcIncipit — ce que la partition garde', () => {
  const full = [
    'X: 1', "T: Cooley's", 'R: reel',
    'S: https://thesession.org/tunes/17205#setting32977', 'Z: Slaine',
    'M: 4/4', 'L: 1/8', 'K: Edor',
    'D2|EBBA B2 EB|B2 AB dBAG|FDAD BDAD|',
  ].join('\n');

  it('ne garde que ce qui change la LECTURE des notes', () => {
    // What the user saw printed around a two-bar stave and did not want:
    // the type, the source URL, the transcriber. The card says the rest.
    const out = abcIncipit(full);
    expect(out).toContain('M: 4/4');
    expect(out).toContain('L: 1/8');
    expect(out).toContain('K: Edor');
    expect(out).not.toContain('T:');
    expect(out).not.toContain('R:');
    expect(out).not.toContain('thesession.org');
    expect(out).not.toContain('Slaine');
  });

  it('DONNE un tempo au morceau qui n en declare pas', () => {
    // TheSession's scores usually carry no `Q:` — the speed is implied by
    // `R: reel`, and trimming R: away would have left the play button
    // taking a reel at abcjs's default. Restated explicitly instead.
    expect(abcIncipit(full)).toContain(`Q: ${TUNE_TEMPOS['reel']}`);
  });

  it('respecte un tempo ecrit a la main', () => {
    const withTempo = full.replace('M: 4/4', 'Q: 1/4=100\nM: 4/4');
    expect(abcIncipit(withTempo)).toContain('Q: 1/4=100');
    expect(abcIncipit(withTempo)).not.toContain('1/4=190');
  });

  it('place le tempo AVANT la cle, qui ferme l en-tete', () => {
    const out = abcIncipit(full);
    expect(out.indexOf('Q:')).toBeLessThan(out.indexOf('K:'));
  });

  it('coupe bien le corps', () => {
    expect(abcIncipit(full)).toContain('D2 | EBBA B2 EB | B2 AB dBAG |');
    expect(abcIncipit(full)).not.toContain('FDAD BDAD');
  });
});

describe('abcOpenMode', () => {
  it('ouvre sur la partition quand l utilisateur n a rien dit', () => {
    expect(abcOpenMode({})).toBe('sheet');
    expect(abcOpenMode({})).toBe(ABC_OPEN_MODE_DEFAULT);
  });

  it('respecte le choix explicite, dans les deux sens', () => {
    expect(abcOpenMode({ abcOpenMode: 'text' })).toBe('text');
    expect(abcOpenMode({ abcOpenMode: 'sheet' })).toBe('sheet');
  });
});
