import { describe, it, expect } from 'vitest';
import { sniffHeif, viewMimeType, isHeif, isHeifName } from './heic';

/** An ISO-BMFF head: a box size, `ftyp`, then the major brand. */
function ftyp(brand: string): Uint8Array {
  const bytes = [0, 0, 0, 0x1c, ...'ftyp'.split('').map((c) => c.charCodeAt(0)), ...brand.split('').map((c) => c.charCodeAt(0)), 0, 0, 0, 0];
  return new Uint8Array(bytes);
}

describe('sniffHeif', () => {
  it('knows an iPhone photo by its brand', () => {
    expect(sniffHeif(ftyp('heic'))).toBe('image/heic');
    expect(sniffHeif(ftyp('heix'))).toBe('image/heic');
  });

  it('calls the generic HEIF brands heif (libheif\'s own example is mif1)', () => {
    expect(sniffHeif(ftyp('mif1'))).toBe('image/heif');
    expect(sniffHeif(ftyp('msf1'))).toBe('image/heif');
  });

  it('says nothing of an MP4, an AVIF or a short head', () => {
    expect(sniffHeif(ftyp('isom'))).toBeNull();
    expect(sniffHeif(ftyp('M4A '))).toBeNull();
    expect(sniffHeif(ftyp('avif'))).toBeNull();
    expect(sniffHeif(new Uint8Array([0, 0, 0, 0x1c, 0x66]))).toBeNull();
    expect(sniffHeif(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]))).toBeNull();
  });
});

describe('viewMimeType', () => {
  it('opens a HEIC that came without a type as a picture', () => {
    expect(viewMimeType('', 'IMG_0001.HEIC')).toBe('image/heic');
    expect(viewMimeType('application/octet-stream', 'photo.heif')).toBe('image/heif');
  });

  it('leaves every declared type alone', () => {
    expect(viewMimeType('image/heic', 'IMG_0001.HEIC')).toBe('image/heic');
    expect(viewMimeType('image/jpeg', 'photo.heic')).toBe('image/jpeg');
    expect(viewMimeType('', 'notes.txt')).toBe('');
    expect(viewMimeType('audio/mpeg', 'tune.mp3')).toBe('audio/mpeg');
  });
});

describe('isHeif', () => {
  it('by type or by name', () => {
    expect(isHeif('image/heic', 'x')).toBe(true);
    expect(isHeif('image/heif-sequence', 'x')).toBe(true);
    expect(isHeif('', 'IMG.heic')).toBe(true);
    expect(isHeif('image/jpeg', 'photo.jpg')).toBe(false);
    expect(isHeifName('a.HEIF')).toBe(true);
    expect(isHeifName('heic.jpg')).toBe(false);
  });
});
