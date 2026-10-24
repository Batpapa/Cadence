import { describe, it, expect } from 'vitest';
import abcjs from 'abcjs';
import { sourceMeasures, scoreLineBreaks, type MeasuredSection } from './abcLineBreaks';

// Muireann's, setting 1902 on TheSession — the tune of the report (2026-10-23).
const MUIREANNS = `X:1
T:Muireann's
R:jig
M:6/8
L:1/8
K:Bm
|:dBA ~B3|def ede|f2e ede|faf efe|
dBA ~B3|def ede|fba fed|fee edB:|
|:BAB e3|BAB fef|Bba fed|fee edB|
BAB e3|BAB fef|baf aba|fee edB:|
|:BAF E2F|FDE FDA|DAA DBB|Ddd edB|
BAF E2F|FDE FDE|FAB def|1 fed edB:|2 fed e3||
|:fef b2B|fef ~a3|fba fed|fee ede|
fef b2B|fef ~a3|baf aba|1 fee ede:|2 fee edB||`;

// What abcjs 6.7 measured for it in Chromium (`tune.explanation`, 2026-10-24).
const MEASURED: MeasuredSection[] = [{
  left: 75,
  measureWidths: [
    26, 81, 81, 70, 81, 60, 89, 89, 89, 0, 83, 84, 84, 84, 60, 90, 90, 90, 0,
    96, 81, 81, 81, 65, 81, 81, 99, 98, 0, 115, 89, 109, 109, 64, 66, 81, 100, 113,
  ],
}];

const structure = sourceMeasures(abcjs.parseOnly(MUIREANNS)[0]!);

describe('the bar structure of an ABC', () => {
  it('reads its lines as written, one section', () => {
    expect(structure).toHaveLength(1);
    expect(structure[0]!.map(l => l.length)).toEqual([5, 4, 5, 4, 5, 5, 5, 5]);
  });

  it('marks the segments that hold no music: before an opening |:, and between :| and |:', () => {
    const [l1, l2, l3, , , l6] = structure[0]!;
    expect(l1).toEqual([false, true, true, true, true]);
    expect(l2).toEqual([true, true, true, true]);
    expect(l3).toEqual([false, true, true, true, true]);
    // Both endings are bars of their own.
    expect(l6).toEqual([true, true, true, true, true]);
  });

  it('starts a new section at a line of text', () => {
    const s = sourceMeasures(abcjs.parseOnly('X:1\nL:1/8\nK:D\nABcd|efga|\n%%text Second part\nbagf|edcB|\n')[0]!);
    expect(s).toEqual([[[true, true]], [[true, true]]]);
  });
});

describe('where the lines end', () => {
  it('follows the ABC when its lines fit: four bars, each part on a line of its own', () => {
    // Desktop width — abcjs's "4 per line" gave 3 / 4 / 3 / 4 here.
    expect(scoreLineBreaks(structure, MEASURED, 970, 1.3)).toEqual([[4, 8, 13, 17, 22, 27, 32]]);
  });

  it('cuts a line that does not fit into equal shares, never one bar alone if two fit', () => {
    // A 360 px phone. abcjs gave lines of a single bar here.
    expect(scoreLineBreaks(structure, MEASURED, 327, 1.3)).toEqual([[
      2, 4, 6, 8, 11, 13, 15, 17, 20, 22,
      24, 26, 27, // four bars and two endings: 2 + 2 + 1
      30, 32, // two bars that do not quite fit: squeezed, not split further
      34, 36, // the last line ends with the section, no break
    ]]);
  });

  it('never draws a line of a single bar out of a line of four', () => {
    // So narrow that not even two bars fit at the readable spacing.
    const breaks = scoreLineBreaks(structure, MEASURED, 150, 1.3)![0]!;
    expect(breaks.slice(0, 2)).toEqual([2, 4]);
  });

  it('lets a line with no music in it join the next', () => {
    const s = [[[false], [true, true]]];
    const m = [{ left: 0, measureWidths: [10, 50, 50] }];
    expect(scoreLineBreaks(s, m, 1000, 1)).toEqual([[]]);
  });

  it('gives up when the widths do not match the structure', () => {
    expect(scoreLineBreaks(structure, [{ left: 75, measureWidths: [80, 80] }], 970, 1.3)).toBeNull();
    expect(scoreLineBreaks(structure, [], 970, 1.3)).toBeNull();
  });
});
