import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// ── The text colours must stay readable ──────────────────────────────────────
// `text-dim` shipped at 2,41–2,66:1 for months — a failure of WCAG AA (4,5:1
// for normal text) and even of the 3,0 large-text floor — on a token used
// nearly 200 times. Nothing caught it because a colour is not a behaviour: no
// test opens a screen and looks at it, and each theme was tuned by eye against
// whichever background happened to be on screen at the time.
//
// So this reads the real stylesheet and does the arithmetic. It is the only
// thing standing between a plausible-looking hex tweak and shipping grey on
// grey to someone who cannot read it.

const CSS = readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'styles.css'),
  'utf-8',
);

/** The `:root` block and each `[data-theme="…"]` block, as name → declarations. */
function themeBlocks(css: string): Record<string, string> {
  const blocks: Record<string, string> = {};
  const root = /:root\s*\{([\s\S]*?)\}/.exec(css);
  if (root) blocks.dark = root[1]!;
  for (const m of css.matchAll(/\[data-theme="([a-z]+)"\]\s*\{([\s\S]*?)\}/g)) {
    blocks[m[1]!] = m[2]!;
  }
  return blocks;
}

function token(block: string, name: string): string {
  const m = new RegExp(`--color-${name}:\\s*(#[0-9a-fA-F]{6})`).exec(block);
  if (!m) throw new Error(`--color-${name} introuvable`);
  return m[1]!;
}

/** The same channel triple, which Tailwind reads for its opacity modifiers.
 *  Kept in sync by hand in the stylesheet, so it is worth checking: a hex
 *  changed without its channels means the `text-dim/70` of the world quietly
 *  keep the old colour. */
function channels(block: string, name: string): [number, number, number] {
  const m = new RegExp(`--color-${name}-ch:\\s*(\\d+)\\s+(\\d+)\\s+(\\d+)`).exec(block);
  if (!m) throw new Error(`--color-${name}-ch introuvable`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

const linear = (c: number) => {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
};
const rgb = (hex: string): [number, number, number] =>
  [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
const luminance = ([r, g, b]: [number, number, number]) =>
  0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);

function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(rgb(a)), luminance(rgb(b))].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

const AA_NORMAL_TEXT = 4.5;
/** Every surface a piece of text can sit on. A token has to clear the bar on
 *  the WORST of them, not on the one the designer had open. */
const BACKGROUNDS = ['bg', 'surface', 'elevated'] as const;
const TEXT_TOKENS = ['dim', 'muted', 'primary'] as const;

const themes = themeBlocks(CSS);

describe('contraste des couleurs de texte', () => {
  it('trouve les trois themes dans la feuille de style', () => {
    // Guards the parsing itself: a renamed block would otherwise make every
    // assertion below vacuously pass.
    expect(Object.keys(themes).sort()).toEqual(['dark', 'green', 'light']);
  });

  for (const theme of ['dark', 'green', 'light'] as const) {
    for (const text of TEXT_TOKENS) {
      for (const bg of BACKGROUNDS) {
        it(`${theme} — ${text} sur ${bg} passe AA`, () => {
          const block = themes[theme]!;
          const ratio = contrastRatio(token(block, text), token(block, bg));
          expect(ratio).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
        });
      }
    }

    it(`${theme} — dim et muted restent deux niveaux distincts`, () => {
      // Raising `dim` to AA without touching `muted` would have landed the two
      // on the same colour (exactly, in the light theme). Compliance is not
      // supposed to cost the hierarchy.
      const block = themes[theme]!;
      expect(contrastRatio(token(block, 'dim'), token(block, 'muted'))).toBeGreaterThanOrEqual(1.3);
    });

    for (const name of TEXT_TOKENS) {
      it(`${theme} — les canaux de ${name} suivent son hex`, () => {
        const block = themes[theme]!;
        expect(channels(block, name)).toEqual(rgb(token(block, name)));
      });
    }
  }
});
