import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// ── Old formats come out on their date ───────────────────────────────────────
// The rule (2026-11-26), in two halves:
//  - A MIGRATION of data stored for the long term (schema steps, old storage
//    shapes, device bookkeeping) stays, with no deadline: such data can sleep
//    for as long as it likes, and converting it once at the border costs
//    nothing anywhere else. Those carry no marker.
//  - Everything else that only exists for an old format of Cadence's own —
//    compatibility with older bundles, APKs or servers, and fallbacks spread
//    through the app — is removed six months after the format stopped being
//    written. Each such place carries a marker, on one line:
//
//   LEGACY until YYYY-MM-DD — <the old format>, not written since YYYY-MM-DD (<commit>): <what goes>.
//
// and this test fails from that date on, naming what is due — so the date is
// kept by the build rather than by anyone's memory. A due item is removed, or,
// when something real still depends on it, its date is moved WITH the reason
// written beside it.
//
// Not markers either: frozen names (Analysis.annotations…), which are
// permanent, and the .cdc readers kept for packages written by hand or by an AI.

const SRC = path.dirname(fileURLToPath(import.meta.url));

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(p, out);
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(p);
  }
  return out;
}

const MARKER = /LEGACY until (\d{4}-\d{2}-\d{2})\b(.*)$/;

interface Marker { until: string; where: string; text: string }

function markers(): Marker[] {
  const out: Marker[] = [];
  for (const file of sourceFiles(SRC)) {
    readFileSync(file, 'utf8').split(/\r?\n/).forEach((line, i) => {
      const m = MARKER.exec(line);
      if (m) out.push({ until: m[1]!, where: `${path.relative(SRC, file)}:${i + 1}`, text: m[2]!.trim() });
    });
  }
  return out;
}

/** Today, as the marker dates are written: the calendar day, local time. */
function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

describe('old formats', () => {
  const found = markers();

  it('are marked (the scan sees them)', () => {
    expect(found.length).toBeGreaterThan(0);
  });

  it('carry real dates', () => {
    const bad = found.filter(m => Number.isNaN(Date.parse(m.until)));
    expect(bad.map(m => m.where)).toEqual([]);
  });

  it('are removed once their date has come', () => {
    const now = today();
    const due = found
      .filter(m => m.until <= now)
      .map(m => `${m.where} — due ${m.until} ${m.text}`);
    expect(due, `old-format support past its removal date:\n${due.join('\n')}`).toEqual([]);
  });
});
