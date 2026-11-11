// The UI charter's guard (review of 2026-11-11): flags, in src/, what drifts
// from the rules written at the top of the component layer in styles.css.
//
//   npm run ui:check            the findings, by rule then by file
//   npm run ui:check -- --strict   the same, and a failing exit code if any
//
// A line that must break a rule on purpose carries `ui-ok` in a comment, with
// its reason beside it. Whole files are exempt where the rule does not apply:
// the TheSession embed is a separate product with its own styles; icons.tsx
// and the score's paper colours ARE the drawings the rules point to.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('../src/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const strict = process.argv.includes('--strict');

const EXEMPT_FILES = [
  /^thesessionEmbed\//,          // its own product, its own styles
  /^components\/icons\.tsx$/,    // the drawings themselves
  /^components\/playbackIcons\.ts$/,
  /^services\/abcService\.ts$/,  // the score's paper and ink colours
  /\.test\.tsx?$/,
];

const ICON_SIZES = new Set([12, 14, 16, 18, 20, 24, 32]);

/** Each rule: a name, what to look for, and an optional filter on the match. */
const RULES = [
  { name: 'arbitrary text size (use the scale; floor text-2xs = 11 px)', re: /\btext-\[\d+(?:\.\d+)?px\]/g },
  { name: 'arbitrary radius (rounded / -md / -lg / -xl / -full)', re: /\brounded(?:-[a-z]+)?-\[[^\]]+\]/g },
  { name: 'raw Tailwind palette colour (use a token)', re: /\b(?:bg|text|border|ring|fill|stroke|from|to|via)-(?:red|blue|green|yellow|amber|orange|purple|violet|gray|zinc|slate|neutral|emerald|sky|indigo|pink|rose|teal|cyan|lime)-\d{2,3}\b/g },
  { name: 'icon size off the scale (12 14 16 18 20 24)', re: /<\w*Icon\b[^>]*?\bsize=\{(\d+)\}|iconElement\(\s*\w+\s*,\s*(\d+)\s*\)/g,
    keep: m => !ICON_SIZES.has(Number(m[1] ?? m[2])) },
  { name: 'glyph used as an icon (use an icon component)', re: />\s*[✕✖⋯⋮▶▸◂▾▴⏸⏹★☆✓✔✗●○◉⌕↺↻⟲⛓⇤⇥𝄞♫▣≣¶◈↙↗]\s*</gu },
  { name: 'glyph in a string drawn as a control', re: /(?:textContent\s*=|label:\s*|innerHTML\s*=)\s*['"`][✕⋯⋮▶★✓●○⌕↺⟲]['"`]/gu },
  { name: 'hand-rolled overlay (use showModal or MODAL_BACKDROP)', re: /fixed inset-0[^"'`]*bg-black\/(?!70\b)\d+/g },
  { name: 'native dialog (alert/confirm/prompt)', re: /(?<![\w.])(?:window\.)?(?:alert|confirm|prompt)\(\s*[t'"`]/g },
];

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(tsx?|css)$/.test(name)) out.push(p);
  }
  return out;
}

const findings = new Map(RULES.map(r => [r.name, []]));
for (const file of walk(ROOT)) {
  const rel = relative(ROOT, file).replace(/\\/g, '/');
  if (EXEMPT_FILES.some(re => re.test(rel))) continue;
  const lines = readFileSync(file, 'utf8').split(/\r?\n/);
  lines.forEach((line, i) => {
    if (line.includes('ui-ok')) return;
    // Comments explain the rules and quote what they replaced: not markup.
    const trimmed = line.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return;
    for (const rule of RULES) {
      for (const m of line.matchAll(rule.re)) {
        if (rule.keep && !rule.keep(m)) continue;
        findings.get(rule.name).push(`${rel}:${i + 1}  ${m[0].slice(0, 60)}`);
      }
    }
  });
}

let total = 0;
for (const [name, list] of findings) {
  if (!list.length) continue;
  total += list.length;
  console.log(`\n── ${name} (${list.length})`);
  for (const f of list) console.log('  ' + f);
}
console.log(total ? `\n${total} finding(s).` : 'UI charter: nothing to report.');
if (strict && total) process.exit(1);
