import { describe, it, expect } from 'vitest';
import { embedAutoTitle } from './embedService';

describe('embedAutoTitle', () => {
  it('reads the stored platform name, not the label typed over it', () => {
    expect(embedAutoTitle({
      id: 'e', url: 'https://youtu.be/x', mode: 'embed',
      title: 'Nightride - Brian Finnegan', autoTitle: 'Nightride',
    })).toBe('Nightride');
  });

  it('takes the title of an embed stored before autoTitle existed', () => {
    expect(embedAutoTitle({ id: 'e', url: 'https://youtu.be/x', title: 'Nightride' })).toBe('Nightride');
    expect(embedAutoTitle({ id: 'e', url: 'https://youtu.be/x', title: 'Nightride', mode: 'embed' })).toBe('Nightride');
  });

  it('gives none for an external link, whose title was always typed', () => {
    expect(embedAutoTitle({ id: 'e', url: 'https://thesession.org', title: 'Forum', mode: 'link' })).toBeUndefined();
  });
});
