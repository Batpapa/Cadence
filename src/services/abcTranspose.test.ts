// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { transposeAbcText } from './abcTranspose';

const REEL = 'X: 1\nT: Test\nR: reel\nM: 4/4\nL: 1/8\nK: Dmaj\n|:dAFA dAFA|BEED E2FE|"G"dB^cd e2 fe:|\nK: Edor\nB2EB ^cBAc|';

describe('transposeAbcText', () => {
  it('leaves the text alone when nothing moves', async () => {
    expect(await transposeAbcText(REEL, 0)).toBe(REEL);
  });

  it('writes the tune out in the new key: key lines, notes, chords, accidentals', async () => {
    const up = await transposeAbcText(REEL, 2);
    expect(up).toContain('K: Emaj');
    expect(up).toContain('K: F#dor');
    expect(up).toContain('|:eBGB eBGB|');
    expect(up).toContain('"A"ec^de');
  });

  it('goes down too, across the octave line', async () => {
    const down = await transposeAbcText(REEL, -3);
    expect(down).toContain('K: Bmaj');
    expect(down).toContain('|GCCB, C2DC|');
  });
});
