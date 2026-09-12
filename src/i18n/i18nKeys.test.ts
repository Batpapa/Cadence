import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fr from './fr.json';
import en from './en.json';

// ── The keys actually asked for must actually exist ──────────────────────────
// Born from a near miss (2026-09-09): a mechanical rename across the codebase
// rewrote a key INSIDE a t() call — `sessions.annotation.delete.*` became
// `sessions.detection.delete.*` in the source while the JSON still held the old
// name. Nothing caught it: tsc sees a string, the tests never opened that
// dialog, and the build is happy. It would have surfaced as a raw key printed
// at a user, in one modal, on one screen.
//
// So this walks the source, pulls every literal key out of t('...'), and checks
// both locales have it. Cheap enough to run with everything else.

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Shipped source only. Test files are skipped: they legitimately pass made-up
 *  keys to assert failure paths — and this very file would otherwise flag the
 *  examples in its own comments. */
function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(p, out);
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(p);
  }
  return out;
}

/** `t('some.key'` — single-quoted only, which is the codebase's own style.
 *  A key built from a template literal cannot be resolved statically; those are
 *  reported separately below rather than silently ignored. */
const LITERAL_KEY = /\bt\(\s*'([^']+)'/g;
const TEMPLATE_KEY = /\bt\(\s*`[^`]*\$\{/g;

interface Use { key: string; where: string }

function collect(): { used: Use[]; dynamic: string[] } {
  const used: Use[] = [];
  const dynamic: string[] = [];
  for (const file of sourceFiles(SRC)) {
    const text = readFileSync(file, 'utf8');
    const where = path.relative(SRC, file).replace(/\\/g, '/');
    for (const m of text.matchAll(LITERAL_KEY)) {
      used.push({ key: m[1]!, where: `${where}:${text.slice(0, m.index).split('\n').length}` });
    }
    for (const m of text.matchAll(TEMPLATE_KEY)) {
      dynamic.push(`${where}:${text.slice(0, m.index).split('\n').length}`);
    }
  }
  return collect.cache ??= { used, dynamic };
}
collect.cache = undefined as { used: Use[]; dynamic: string[] } | undefined;

const frKeys = fr as Record<string, string>;
const enKeys = en as Record<string, string>;

describe('i18n keys', () => {
  it('every t(\'…\') key exists in both locales', () => {
    const { used } = collect();
    expect(used.length).toBeGreaterThan(500); // the walk found the source, not an empty tree
    const missing = used
      .filter(u => !(u.key in frKeys) || !(u.key in enKeys))
      .map(u => `${u.where}  ${u.key}${u.key in frKeys ? '' : ' [fr]'}${u.key in enKeys ? '' : ' [en]'}`);
    expect(missing).toEqual([]);
  });

  it('fr and en define exactly the same keys', () => {
    expect(Object.keys(frKeys).filter(k => !(k in enKeys))).toEqual([]);
    expect(Object.keys(enKeys).filter(k => !(k in frKeys))).toEqual([]);
  });

  // Not a failure — a reminder of what the check above cannot see. Keep the
  // count honest so a new dynamic key is a deliberate act rather than a way to
  // slip past the test.
  it('lists the keys built dynamically, which nothing here can verify', () => {
    const { dynamic } = collect();
    // 13 since 2026-09-12: the tune ranking's sort menu builds
    // `sessions.ranking.sort.${mode}`, the same shape the card library's own
    // sort menu already contributes. Raised deliberately, which is the point
    // of the ceiling — the three keys it can produce were checked in both
    // locales by hand, because nothing here can.
    expect(dynamic.length).toBeLessThanOrEqual(13);
  });
});
