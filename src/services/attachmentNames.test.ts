import { describe, it, expect } from 'vitest';
import { splitFileName, renamedFileName, copyFileName, legacyClipTag, migrateClipTags } from './attachmentNames';

describe('splitFileName', () => {
  it('splits on the last dot', () => {
    expect(splitFileName('The Silver Spear.abc')).toEqual({ base: 'The Silver Spear', ext: '.abc' });
    expect(splitFileName('Mr. Smith.v2.pdf')).toEqual({ base: 'Mr. Smith.v2', ext: '.pdf' });
  });

  it('gives no extension to a name without a dot, or with only a leading one', () => {
    expect(splitFileName('README')).toEqual({ base: 'README', ext: '' });
    expect(splitFileName('.gitignore')).toEqual({ base: '.gitignore', ext: '' });
  });
});

describe('renamedFileName', () => {
  it('keeps the extension whatever is typed', () => {
    expect(renamedFileName('Reel.abc', 'My reel')).toBe('My reel.abc');
    expect(renamedFileName('Reel.abc', 'My reel.txt')).toBe('My reel.txt.abc');
  });

  it('trims, and refuses an empty or unchanged name', () => {
    expect(renamedFileName('Reel.abc', '  Jig  ')).toBe('Jig.abc');
    expect(renamedFileName('Reel.abc', '   ')).toBeNull();
    expect(renamedFileName('Reel.abc', 'Reel')).toBeNull();
  });
});

describe('copyFileName', () => {
  it('numbers from 1', () => {
    expect(copyFileName('The Silver Spear.abc', ['The Silver Spear.abc'])).toBe('The Silver Spear (1).abc');
  });

  it('takes the smallest free number, so a deleted copy frees its number', () => {
    const names = ['Reel.abc', 'Reel (1).abc', 'Reel (2).abc'];
    expect(copyFileName('Reel.abc', names)).toBe('Reel (3).abc');
    expect(copyFileName('Reel.abc', ['Reel.abc', 'Reel (2).abc'])).toBe('Reel (1).abc');
  });
});

describe('legacyClipTag', () => {
  it('reads the tag before the extension and removes it from the name', () => {
    expect(legacyClipTag('The Silver Spear — Jeudi (12m30–15m04) [3f9a2c1b·750].mp3'))
      .toEqual({ key: '3f9a2c1b·750', name: 'The Silver Spear — Jeudi (12m30–15m04).mp3' });
  });

  it('ignores brackets that are not a clip tag, or not at the end', () => {
    expect(legacyClipTag('Reel [live].mp3')).toBeNull();
    expect(legacyClipTag('[3f9a2c1b·750] then more.mp3')).toBeNull();
  });
});

describe('migrateClipTags', () => {
  const cardWith = (...attachments: unknown[]) => ({ content: { notes: '', attachments } });

  it('moves the tag of an audio clip into clipOf', () => {
    const c = cardWith({ type: 'file', name: 'Reel — S (0m00–1m00) [abcd1234·12].webm', mimeType: 'audio/webm', data: '' });
    migrateClipTags(c);
    expect(c.content.attachments[0]).toMatchObject({ name: 'Reel — S (0m00–1m00).webm', clipOf: 'abcd1234·12' });
  });

  it('leaves non-audio files, embeds and untagged clips alone', () => {
    const pdf = { type: 'file', name: 'Notes [abcd1234·12].pdf', mimeType: 'application/pdf', data: '' };
    const embed = { type: 'embed', id: 'e', url: 'https://x' };
    const plain = { type: 'file', name: 'Reel.mp3', mimeType: 'audio/mpeg', data: '' };
    const c = cardWith(pdf, embed, plain);
    migrateClipTags(c);
    expect(c.content.attachments).toEqual([
      { type: 'file', name: 'Notes [abcd1234·12].pdf', mimeType: 'application/pdf', data: '' },
      { type: 'embed', id: 'e', url: 'https://x' },
      { type: 'file', name: 'Reel.mp3', mimeType: 'audio/mpeg', data: '' },
    ]);
  });

  it('is idempotent and survives a card without attachments', () => {
    const c = cardWith({ type: 'file', name: 'Reel [abcd1234·12].mp3', mimeType: 'audio/mpeg', data: '' });
    migrateClipTags(c); migrateClipTags(c);
    expect(c.content.attachments[0]).toMatchObject({ name: 'Reel.mp3', clipOf: 'abcd1234·12' });
    expect(() => migrateClipTags({})).not.toThrow();
  });
});
