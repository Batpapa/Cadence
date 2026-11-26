'use strict';
// cadence-transcriptor as ONE self-contained TypeScript file for Cadence (like its
// transcription.ts: no imports, loads in the worker and in Node as it is): the modules in
// dependency order, their imports of each other dropped, only the entry points exported.
//   node bench/bundle.js [out file]
const fs = require('node:fs'), path = require('node:path');
const SRC = path.join(__dirname, '../src');
const OUT = process.argv[2] || path.join(__dirname, '../../src/session/recognition/transcriptor.ts');
const ORDER = ['fft.ts', 'spectrum.ts', 'salience.ts', 'onsets.ts', 'decoder.ts', 'recognition.ts'];
const KEEP = new Set(['hear', 'transcribeNotes', 'gridNovelty', 'asClassNotes', 'resample', 'RATE', 'Note', 'Heard', 'useAnalysis', 'Peaks', 'AnalysisOptions', 'recognitionContour', 'RecognitionWindow', 'classView', 'CLEAN_VIEW']);

let body = '';
for (const f of ORDER) {
  let s = fs.readFileSync(path.join(SRC, f), 'utf8').replace(/\r/g, '');
  s = s.replace(/^import [^\n]*from '\.\/[^']+';\n/gm, '');
  s = s.replace(/^export (async function|function|class|const|interface|type) (\w+)/gm, (m, kind, name) => (KEEP.has(name) ? m : `${kind} ${name}`));
  body += `// ── ${f} ${'─'.repeat(Math.max(3, 84 - f.length))}\n\n${s.trim()}\n\n`;
}
const head = `// ── The note decoder of the hidden transcription ────────────────────────────────────────
// GENERATED from cadence-transcriptor (transcriptor/ at the root of this repository,
// bench/bundle.js): edit the modules there, then bundle again. Research record and every
// measurement: its JOURNAL.md.
//
// A recording's notes, decoded for writing them down — and, behind a hidden switch, for the
// recogniser too (recognitionContour, beside FolkFriend's: ffWorker.ts): onsets from a short window every 5 ms, pitch from a long window read over
// whole notes (harmonic summation folded into pitch classes — instruments in different
// registers add up — plus the enhanced autocorrelation), a segmental dynamic programming
// choosing among dense candidate onsets which are note boundaries and what each note is.
// transcription.ts then takes them as it took FolkFriend's (asClassNotes).

`;
fs.writeFileSync(OUT, head + body.trimEnd() + '\n');
console.log(`${OUT}: ${(head + body).split('\n').length} lines`);
