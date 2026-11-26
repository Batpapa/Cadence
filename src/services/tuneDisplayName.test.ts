import { describe, it, expect } from 'vitest';
import { normalizeDisplayName, titleCaseTuneName } from './tuneDisplayName';

describe('normalizeDisplayName', () => {
  it('moves a trailing ", The" to the front', () => {
    expect(normalizeDisplayName('Kesh, The')).toBe('The Kesh');
  });

  it('moves a trailing ", A" to the front', () => {
    expect(normalizeDisplayName('Silver Spear, A')).toBe('A Silver Spear');
  });

  it('moves a trailing ", An" to the front', () => {
    expect(normalizeDisplayName('Old Bush, An')).toBe('An Old Bush');
  });

  it('leaves a name with no trailing article unchanged', () => {
    expect(normalizeDisplayName('Drowsy Maggie')).toBe('Drowsy Maggie');
  });

  it('leaves a name ending in something that only looks like an article unchanged (no comma)', () => {
    expect(normalizeDisplayName('Behind The Haystack')).toBe('Behind The Haystack');
  });

  it('does not touch a comma NOT immediately followed by a bare article (nothing else may trail)', () => {
    expect(normalizeDisplayName('Kesh, The (reel)')).toBe('Kesh, The (reel)');
  });

  it('preserves the source casing of the moved article', () => {
    expect(normalizeDisplayName('kesh, the')).toBe('the kesh');
  });

  it('only strips the LAST trailing article, keeping an earlier comma-joined part intact', () => {
    expect(normalizeDisplayName('Rakes of Kildare, The')).toBe('The Rakes of Kildare');
  });
});

describe('titleCaseTuneName — le repli, en attendant le vrai nom', () => {
  // Only ever shown while TheSession's name index is downloading (see
  // tuneNames.ts's tuneName): the card's name and the index both win over
  // it. Rules are acceptable here because nothing is stored from them and the
  // index corrects whatever they get wrong.
  it('capitalise un nom ordinaire', () => {
    expect(titleCaseTuneName('the kesh')).toBe('The Kesh');
    expect(titleCaseTuneName("cooley's")).toBe("Cooley's");
  });

  it('laisse les petits mots en bas de casse A L INTERIEUR du titre', () => {
    // What CSS `capitalize` could not do: it produced "The Bucks Of Oranmore".
    expect(titleCaseTuneName('the bucks of oranmore')).toBe('The Bucks of Oranmore');
    expect(titleCaseTuneName('the boys on the hilltop')).toBe('The Boys on the Hilltop');
  });

  it('reconstruit la majuscule interne des noms en Mc et O', () => {
    // The other thing CSS could not do: it produced "Mcgoldrick's".
    expect(titleCaseTuneName("mcgoldrick's")).toBe("McGoldrick's");
    expect(titleCaseTuneName("o'neill's march")).toBe("O'Neill's March");
    expect(titleCaseTuneName("'ma' mcnulty's favourite")).toBe("'ma' McNulty's Favourite");
  });

  it('ne touche pas a Mac, ou la regle se tromperait', () => {
    expect(titleCaseTuneName('macklin')).toBe('Macklin');
  });

  it('traite chaque morceau d une suite comme un titre a part', () => {
    expect(titleCaseTuneName('the wise maid / the bucks of oranmore'))
      .toBe('The Wise Maid / The Bucks of Oranmore');
  });

  it('capitalise les deux moities d un mot compose', () => {
    expect(titleCaseTuneName('sean-nós')).toBe('Sean-Nós');
  });

  it('ne retouche pas un nom qui a deja des majuscules', () => {
    // It came from a source that kept them — TheSession, or a person typing.
    expect(titleCaseTuneName("McGoldrick's")).toBe("McGoldrick's");
    expect(titleCaseTuneName('The Kesh')).toBe('The Kesh');
  });

  it('survit a un nom vide', () => {
    expect(titleCaseTuneName('')).toBe('');
  });
});
