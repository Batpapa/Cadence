import { describe, expect, it } from 'vitest';
import { abcVersionHash, buildCardIndex, cardGuidOf, cardScoreSettingId, cardSettingId, cardTuneId, cardVersionHashOf, isCardId, type CardIndexTune } from './cardIndex';
import { abcKeyToMode } from './cardIndexSource';

const version = (abc: string) => ({ abc, meter: '4/4', mode: 'Dmajor', dance: 'reel' });

describe('card ids', () => {
  it('names a card tune, a version and a score, and reads them back', () => {
    expect(cardTuneId('g1')).toBe('card:g1');
    expect(cardSettingId('g1', 'h')).toBe('card:g1:h');
    expect(cardScoreSettingId('g1')).toBe('card:g1');
    expect(cardGuidOf('card:g1')).toBe('g1');
    expect(cardGuidOf('card:g1:h')).toBe('g1');
    expect(cardVersionHashOf('card:g1:h')).toBe('h');
    expect(cardVersionHashOf('card:g1')).toBeNull();
    expect(cardGuidOf('1197')).toBeNull();
    expect(isCardId('1197')).toBe(false);
  });

  // A version is named by its text: the same text on another device, or
  // after a reload, must give the same id.
  it('hashes a version by its text alone', () => {
    expect(abcVersionHash('X:1\nK:D\nabc|')).toBe(abcVersionHash('X:1\nK:D\nabc|'));
    expect(abcVersionHash('X:1\nK:D\nabc|')).not.toBe(abcVersionHash('X:1\nK:D\nabd|'));
  });
});

describe('buildCardIndex', () => {
  const tunes: CardIndexTune[] = [
    { guid: 'own', theSessionTuneId: null, name: 'My Reel', versions: [version('A'), version('B')] },
    { guid: 'ts', theSessionTuneId: '7', name: 'The Kesh', versions: [version('C')] },
  ];
  const contourOf = (abc: string) => (abc === 'B' ? null : `contour-${abc}`);

  it('makes one setting per version that gives notes, under the card\'s tune', () => {
    const { settings, aliases } = buildCardIndex(tunes, {}, contourOf);
    expect(Object.keys(settings).sort()).toEqual([cardSettingId('own', abcVersionHash('A')), cardSettingId('ts', abcVersionHash('C'))].sort());
    expect(settings[cardSettingId('own', abcVersionHash('A'))]!.tune_id).toBe('card:own');
    expect(settings[cardSettingId('ts', abcVersionHash('C'))]!.tune_id).toBe('7');
    expect(aliases).toEqual({ 'card:own': ['my reel'], 7: ['the kesh'] });
  });

  // The difference: only versions not converted before go through abc2midi,
  // and the cache keeps exactly the versions still on the cards.
  it('converts only what the cache lacks, and keeps only what is still there', () => {
    const seen: string[] = [];
    const counting = (abc: string) => { seen.push(abc); return contourOf(abc); };
    const cached = { [abcVersionHash('A')]: 'old-A', [abcVersionHash('B')]: '', gone: 'x' };
    const { settings, contours } = buildCardIndex(tunes, cached, counting);
    expect(seen).toEqual(['C']);
    expect(settings[cardSettingId('own', abcVersionHash('A'))]!.contour).toBe('old-A');
    expect(Object.keys(contours).sort()).toEqual([abcVersionHash('A'), abcVersionHash('B'), abcVersionHash('C')].sort());
  });

  it('names no tune whose versions all gave nothing', () => {
    const { settings, aliases } = buildCardIndex([{ guid: 'x', theSessionTuneId: null, name: 'X', versions: [version('B')] }], {}, contourOf);
    expect(settings).toEqual({});
    expect(aliases).toEqual({});
  });
});

describe('abcKeyToMode', () => {
  it('spells an ABC key as the index spells modes', () => {
    expect(abcKeyToMode('D')).toBe('Dmajor');
    expect(abcKeyToMode('Dmaj')).toBe('Dmajor');
    expect(abcKeyToMode('Am')).toBe('Aminor');
    expect(abcKeyToMode('Edor')).toBe('Edorian');
    expect(abcKeyToMode('G Mixolydian')).toBe('Gmixolydian');
    expect(abcKeyToMode('F#m')).toBe('F#minor');
    expect(abcKeyToMode('Bb')).toBe('Bbmajor');
    expect(abcKeyToMode('HP')).toBe('HP');
  });
});
