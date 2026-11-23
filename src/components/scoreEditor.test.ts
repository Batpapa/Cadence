import { describe, it, expect } from 'vitest';
import { rangeInSource, posInDrawn } from './scoreEditor';

// The audio sync marks the text it drew — the version without its X: line nor
// its S:, Z:, T:, R: lines — and the viewer's box holds the version without
// its X: line alone. The marks are carried over line by line.

const body = ['T: A Tune', 'S: https://thesession.org/tunes/7#setting100', 'M: 4/4', 'K: Edor', 'EBBA B2 EB|', 'EBBA B2 EB|'].join('\n');
const drawn = ['X: 1', 'M: 4/4', 'K: Edor', 'EBBA B2 EB|', 'EBBA B2 EB|'].join('\n');

const at = (text: string, line: number, col: number) => text.split('\n').slice(0, line).reduce((n, l) => n + l.length + 1, 0) + col;

describe('rangeInSource', () => {
  it('carries a note over to the same place in the box', () => {
    const map = rangeInSource(drawn, body);
    // "B2" on the first bar line, then on the second, identical one.
    expect(map([at(drawn, 3, 5), at(drawn, 3, 7)])).toEqual([at(body, 4, 5), at(body, 4, 7)]);
    expect(map([at(drawn, 4, 5), at(drawn, 4, 7)])).toEqual([at(body, 5, 5), at(body, 5, 7)]);
  });

  it('maps nothing on a line the box does not have', () => {
    expect(rangeInSource(drawn, body)([0, 3])).toBeNull();
    expect(rangeInSource(drawn, body)(null)).toBeNull();
  });

  // The other way: a click in the box, to the note drawn there.
  it('finds a character of the box in the text drawn', () => {
    expect(posInDrawn(drawn, body, at(body, 5, 5))).toBe(at(drawn, 4, 5));
    expect(posInDrawn(drawn, body, at(body, 3, 2))).toBe(at(drawn, 2, 2));
    // On a line taken out to draw (T:, S:): nowhere.
    expect(posInDrawn(drawn, body, at(body, 0, 3))).toBeNull();
    expect(posInDrawn(drawn, body, at(body, 1, 3))).toBeNull();
  });

  it('maps nothing on a line the box no longer has as drawn — typed since', () => {
    const typed = body.replace('EBBA B2 EB|\nEBBA', 'EBBA B2 EB|\nFBBA');
    expect(rangeInSource(drawn, typed)([at(drawn, 4, 0), at(drawn, 4, 1)])).toBeNull();
  });
});
