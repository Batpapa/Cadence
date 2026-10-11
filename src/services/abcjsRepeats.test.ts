import { describe, it, expect } from 'vitest';
import abcjs from 'abcjs';

/** Guards patches/abcjs+6.7.0.patch. abcjs 6 took the 1st and 2nd endings of
 *  a part that never opens with `|:` as more endings of the PREVIOUS part's
 *  repeat, and the part itself was never played: TheSession's tune 217,
 *  setting 12899, went silent from its tenth bar on while the cursor carried
 *  on (reported 2026-10-11). Over TheSession's whole dump the patch changed
 *  2598 settings of 55532, and the cursor's timing agreed with the sound on
 *  2440 of them instead of 85. If an upgrade of abcjs drops the patch, this
 *  fails. */

function playedBars(music: string): string[] {
  const abc = `X: 1\nT: t\nM: 6/8\nL: 1/8\nK: Emin\nQ: 3/8=120\n${music}`;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tune = abcjs.parseOnly(abc)[0] as any;
  const notes = tune.setUpAudio({}).tracks.flat().filter((e: { cmd: string }) => e.cmd === 'note');
  const bars: number[][] = [];
  for (const n of notes) (bars[Math.floor(n.start / 0.75 + 1e-6)] ??= []).push(n.pitch);
  return bars.map(b => b.join(' '));
}

describe('abcjs repeats (patched)', () => {
  it('plays a second part whose |: was left out, with its own endings', () => {
    const bars = playedBars(
      '|:EFG ABc|1 BAG FED:|2 BAG E3||\n' +
      'efg abc|1 bag fed:|2 bag e3||');
    const A = '64 66 67 69 71 72', a1 = '71 69 67 66 64 62', a2 = '71 69 67 64';
    const B = '76 78 79 81 83 72', b1 = '83 81 79 78 76 74', b2 = '83 81 79 76';
    expect(bars).toEqual([A, a1, A, a2, B, b1, B, b2]);
  });

  it('repeats a varied part from the last || rather than from the :| before it', () => {
    const bars = playedBars('|:EFG ABc:|\nefg abc||\nGAB cde:|');
    expect(bars).toEqual([
      '64 66 67 69 71 72', '64 66 67 69 71 72',
      '76 78 79 81 83 72',
      '67 69 71 72 74 76', '67 69 71 72 74 76',
    ]);
  });

  it('still plays three endings of one repeat', () => {
    const bars = playedBars('|:EFG ABc|1 E3 E3:|2 F3 F3:|3 G3 G3||');
    const A = '64 66 67 69 71 72';
    expect(bars).toEqual([A, '64 64', A, '66 66', A, '67 67']);
  });
});
