import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import * as nodePath from 'path';
import { parseHeif, hevcVuiColour, hevcCodecString } from './heifContainer';

// test-fixtures/heic/orientation-*.heic: heic.fyi's sample files
// (https://heic.fyi/heic-sample-files), CC0 1.0 — no attribution required.
// Each is a 1200 × 800 chart stored so that its transformations bring it back
// upright: orientation-4 mirrored top to bottom (imir axis 0), orientation-5
// stored 800 × 1200, rotated 270° anti-clockwise then mirrored left to right.
const fixture = (name: string) =>
  new Uint8Array(readFileSync(nodePath.resolve(__dirname, '../../test-fixtures/heic', name)));

/** The `hvcC` of a 12-megapixel iPhone photo (the record only, no pixels):
 *  an SPS with one short-term reference picture set before its VUI, full
 *  range and no colour description. */
const IPHONE_HVCC = new Uint8Array(
  '010160000000b000000000005af000fcfdf8f800000f03a00001001740010c01ffff016000000300b0000003000003005a2c09a100010021420101016000000300b0000003000003005aa00402008059cb9244892e26d48040a2000100084401c061124c14c9'
    .match(/../g)!.map((h) => parseInt(h, 16)));

describe('parseHeif', () => {
  it('reads imir axis 0 as top-bottom, as libheif and the 2022 standard do', () => {
    const p = parseHeif(fixture('orientation-4.heic'));
    expect([p.width, p.height]).toEqual([1200, 800]);
    expect(p.transforms).toEqual([{ type: 'mirror', flip: 'top-bottom' }]);
  });

  it('keeps the transformations in association order', () => {
    const p = parseHeif(fixture('orientation-5.heic'));
    expect([p.width, p.height]).toEqual([800, 1200]);
    expect(p.transforms).toEqual([
      { type: 'rotate', angle: 270 },
      { type: 'mirror', flip: 'left-right' },
    ]);
  });

  it('takes the container colour first, and hands over one 4:2:0 tile', () => {
    const p = parseHeif(fixture('orientation-5.heic'));
    expect(p.colour).toEqual({ primaries: 1, transfer: 13, matrix: 6, fullRange: true });
    expect(p.tiles).toHaveLength(1);
    expect(p.tiles[0]).toMatchObject({ x: 0, y: 0 });
    expect(p.tiles[0]!.data.length).toBeGreaterThan(1000);
    expect(p.hvcC[16]! & 3).toBe(1);
  });

  it('refuses what is not a HEIF', () => {
    expect(() => parseHeif(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1]))).toThrow(/HEIF/);
    expect(() => parseHeif(fixture('orientation-4.heic').subarray(0, 300))).toThrow(/HEIF/);
  });
});

describe('hevcVuiColour', () => {
  it('walks a reference picture set to reach the range flag', () => {
    expect(hevcVuiColour(IPHONE_HVCC)).toEqual({ primaries: 2, transfer: 2, matrix: 2, fullRange: true });
  });

  it('gives up on a record too short to hold an SPS', () => {
    expect(hevcVuiColour(IPHONE_HVCC.subarray(0, 20))).toBeNull();
  });
});

describe('hevcCodecString', () => {
  it('spells the profile, compatibility, tier, level and constraints', () => {
    expect(hevcCodecString(IPHONE_HVCC)).toBe('hvc1.1.6.L90.B0');
  });
});
