// @vitest-environment jsdom
// DOMPurify needs a real DOM to parse into; without one it degrades to a
// pass-through, which would make every assertion below succeed for the wrong
// reason. The jsdom environment is what keeps these tests honest.
import { describe, expect, it } from 'vitest';
import { renderMarkdown } from './markdown';

const parse = (src: string) => renderMarkdown(src);

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

// ── Sanitisation ──────────────────────────────────────────────────────────────
// `marked` passes raw HTML through untouched by design, and every caller writes
// the result into innerHTML. Notes are not always written by the person reading
// them: importing a shared card package brings in someone else's markdown, so a
// payload here would run with full access to this origin — including the Drive
// access token in localStorage. These tests pin the boundary.
describe('renderMarkdown sanitises embedded HTML', () => {
  it('strips inline event handlers', async () => {
    const html = await parse('Notes\n\n<img src=x onerror="steal()">');
    expect(html).not.toContain('onerror');
    expect(html).not.toContain('steal');
  });

  it('removes script tags', async () => {
    const html = await parse('<script>steal()</script>');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('steal');
  });

  it('neutralises javascript: links', async () => {
    const html = await parse('[clic](javascript:steal())');
    expect(html).not.toContain('javascript:');
  });

  it('strips svg onload payloads', async () => {
    const html = await parse('<svg><svg onload="steal()"></svg>');
    expect(html).not.toContain('onload');
    expect(html).not.toContain('steal');
  });

  it('drops injected iframes', async () => {
    const html = await parse('<iframe src="https://evil.example"></iframe>');
    expect(html).not.toContain('<iframe');
  });

  it('strips handlers hidden behind uppercase and whitespace', async () => {
    const html = await parse('<IMG SRC=x OnErRoR = "steal()">');
    expect(html.toLowerCase()).not.toContain('onerror');
    expect(html).not.toContain('steal');
  });

  it('keeps the formatting real notes rely on', async () => {
    const html = await parse(
      '## Titre\n\n**gras** et [lien](https://x.y)\n\n- [x] fait\n\n`code`\n\n> citation\n\n![img](https://x.y/a.png)'
    );
    expect(html).toContain('<h2');
    expect(html).toContain('<strong>gras</strong>');
    expect(html).toContain('<a href="https://x.y"');
    expect(html).toContain('<code>code</code>');
    expect(html).toContain('<blockquote>');
    expect(html).toContain('<img src="https://x.y/a.png"');
  });
});
