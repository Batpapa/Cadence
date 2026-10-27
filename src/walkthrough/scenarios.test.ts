// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fr from '../i18n/fr.json';
import en from '../i18n/en.json';
import { SCENARIOS } from './scenarios';

// A scenario names its texts and its elements as plain strings, out of reach
// of tsc and of the i18n test (which reads t('…') calls). A step that lost its
// text shows a raw key; one that lost its element sits in the middle of the
// screen asking to press nothing — and a new user is who would find out.

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function sourceText(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) sourceText(p, out);
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(readFileSync(p, 'utf8'));
  }
  return out;
}

const steps = SCENARIOS.flatMap(s => s.steps());

describe('walkthrough scenarios', () => {
  it('every text they name exists in both locales', () => {
    const keys = [
      ...SCENARIOS.flatMap(s => [s.titleKey, s.descKey, ...(s.requires ? [s.requires.hintKey] : [])]),
      ...steps.flatMap(st => [st.titleKey, st.textKey, ...(st.extras ?? []).map(x => x.textKey)]),
    ];
    const missing = keys.filter(k => !(k in fr) || !(k in en));
    expect(missing).toEqual([]);
  });

  it('every element they point at is marked somewhere', () => {
    const source = sourceText(SRC).join('\n');
    // data-tour="x" on an element, tour="x" on a component passing it on,
    // tour: 'x' on a dialog's button, dataset.tour = 'x' on a node built by
    // hand.
    const marked = new Set([
      ...[...source.matchAll(/\b(?:data-)?tour="([^"]+)"/g)].map(m => m[1]!),
      ...[...source.matchAll(/\btour: '([^']+)'/g)].map(m => m[1]!),
      ...[...source.matchAll(/\bdataset\.tour = '([^']+)'/g)].map(m => m[1]!),
      // data-tour={cond ? 'x' : undefined}: every name quoted in the expression.
      ...[...source.matchAll(/\bdata-tour=\{([^}`]*)\}/g)].flatMap(m => [...m[1]!.matchAll(/'([^']+)'/g)].map(q => q[1]!)),
    ]);
    // Or a name built from an id — data-tour={`study-${id}`} — which covers
    // whatever starts that way.
    const prefixes = [...source.matchAll(/\bdata-tour=\{`([^`$]+)\$\{/g)].map(m => m[1]!);
    expect(prefixes).toContain('deck-');
    // A target computed during the run (the deck just made) cannot be checked
    // here; the template that names it is, just above.
    const targets = steps.flatMap(st => [
      ...(st.target === undefined || typeof st.target === 'function' ? [] : Array.isArray(st.target) ? st.target : [st.target]),
      ...(st.extras ?? []).map(x => x.when),
      ...(st.deny ?? []),
    ]);
    expect(targets.filter(name => !marked.has(name) && !prefixes.some(p => name.startsWith(p)))).toEqual([]);
  });
});
