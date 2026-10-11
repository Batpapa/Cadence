import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import fr from '../../i18n/fr.json';
import en from '../../i18n/en.json';

// The assistant's window builds three families of keys at run time — an error
// code, a summary line, a field name — which the general i18n test cannot
// follow. Every value they can take is checked here instead, read off the
// sources so that a new code cannot be added without its words.

const here = path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1');
const source = (f: string) => readFileSync(path.join(here, f), 'utf8');

function codes(): string[] {
  const text = source('ops.ts') + source('fetchExternal.ts');
  const found = new Set<string>();
  for (const m of text.matchAll(/new Fail\('([a-zA-Z]+)'/g)) found.add(m[1]!);
  for (const m of text.matchAll(/code: '([a-zA-Z]+)'/g)) found.add(m[1]!);
  return [...found];
}

function fields(): string[] {
  const text = source('ops.ts');
  const found = new Set<string>();
  for (const m of text.matchAll(/fields\.push\('([a-zA-Z]+)'\)/g)) found.add(m[1]!);
  for (const m of text.matchAll(/this\.note\([^)]*\['([a-zA-Z]+)'\]\)/g)) found.add(m[1]!); // this.note(…, ['cards'])
  return [...found];
}

const has = (key: string) => key in (fr as Record<string, string>) && key in (en as Record<string, string>);

describe('the assistant\'s dynamic keys', () => {
  it('has words for every error code, in both languages', () => {
    const all = codes();
    expect(all.length).toBeGreaterThanOrEqual(30);
    expect(all.filter(c => !has(`aiAssistant.error.${c}`))).toEqual([]);
  });

  it('has words for every summary line and field', () => {
    const lines = ['card', 'deck', 'folder', 'profile'].flatMap(k => ['create', 'update', 'delete'].map(a => `aiAssistant.change.${k}.${a}`));
    expect(lines.filter(k => !has(k))).toEqual([]);
    const f = fields();
    expect(f).toContain('tags');
    expect(f.filter(x => !has(`aiAssistant.field.${x}`))).toEqual([]);
  });
});
