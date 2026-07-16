import { describe, expect, it } from 'vitest';
import { getMarked } from './markdown';

const parse = async (src: string) => (await getMarked()).parse(src) as string;

describe('spoiler markdown extension (||…||)', () => {
  it('renders ||text|| as a hidden spoiler span', async () => {
    const html = await parse('La capitale est ||Lisbonne||.');
    expect(html).toContain('<span class="spoiler" tabindex="0">Lisbonne</span>');
    expect(html).not.toContain('||');
  });

  it('supports nested inline markdown', async () => {
    const html = await parse('||**Lisbonne** est [belle](https://x.y)||');
    expect(html).toContain('class="spoiler"');
    expect(html).toContain('<strong>Lisbonne</strong>');
    expect(html).toContain('<a href="https://x.y"');
  });

  it('allows single pipes inside', async () => {
    expect(await parse('||a|b||')).toContain('>a|b</span>');
  });

  it('handles several spoilers on one line', async () => {
    const html = await parse('||un|| et ||deux||');
    expect(html.match(/class="spoiler"/g)).toHaveLength(2);
  });

  it('does not span across lines', async () => {
    expect(await parse('a ||foo\nbar|| b')).not.toContain('spoiler');
  });

  it('ignores empty markers (||||)', async () => {
    expect(await parse('a |||| b')).not.toContain('class="spoiler"');
  });

  it('leaves GFM tables intact', async () => {
    const html = await parse('| a | b |\n| --- | --- |\n| 1 | 2 |');
    expect(html).toContain('<table>');
    expect(html).not.toContain('spoiler');
  });
});
