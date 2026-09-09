// @vitest-environment jsdom
// The exports write a Blob through an <a download> click, so they need a DOM.
// The bytes are read by subclassing Blob and keeping the string it was handed:
// jsdom exposes no synchronous way back out of a Blob, and the exports are
// synchronous, so intercepting the construction is the only place the content
// is still a string.
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { exportAnalysisCSV, exportAnalysisTXT, analysisTextReport } from './analysisExport';
import type { Analysis, Detection } from '../session/model';

// ── Why this file exists ─────────────────────────────────────────────────────
// Both files are read by people and by spreadsheets, and neither is re-imported
// — so nothing else in the app would notice if a column moved, a timestamp lost
// its hours, or a name containing a comma split a row in two. These assertions
// are the only thing standing between that and a user's file.
//
// The two formats deliberately carry the SAME fields (2026-09-09). The last
// test here is what keeps that true as fields are added.

let captured: string[];

beforeEach(() => {
  captured = [];
  const RealBlob = globalThis.Blob;
  vi.stubGlobal('Blob', class extends RealBlob {
    constructor(parts: BlobPart[] = [], opts?: BlobPropertyBag) {
      super(parts, opts);
      captured.push(parts.map(String).join(''));
    }
  });
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:stub');
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function det(over: Partial<Detection>): Detection {
  return {
    id: 'd', tuneId: '55', settingId: 's', displayName: 'The Maid Behind the Bar',
    dance: 'reel', meter: '4/4', start: 0, end: 87, confidence: 0.92, bucket: 'high',
    meanScore: 0.8, evidence: [], alternates: [],
    viterbiPick: { tuneId: '55', settingId: 's', displayName: 'x', dance: 'reel', meter: '4/4', meanScore: 0.8 },
    userConfirmed: false, liked: false, finalized: true,
    ...over,
  } as Detection;
}

function analysis(dets: Detection[]): Analysis {
  return {
    id: 'a', name: 'Tocane', date: '2024-07-21T20:00:00.000Z', duration: 3600,
    mimeType: 'audio/mp4', source: 'live', annotations: dets,
  } as Analysis;
}

const csvRows = () => captured[0]!.replace('\ufeff', '').split('\r\n');

describe('analysis CSV export', () => {
  it('pads every timestamp to HH:MM:SS so the column sorts', () => {
    exportAnalysisCSV(analysis([det({ start: 5, end: 12 }), det({ start: 3700, end: 3800 })]));
    const rows = csvRows();
    expect(rows[1]!.startsWith('00:00:05,00:00:12,')).toBe(true);
    expect(rows[2]!.startsWith('01:01:40,01:03:20,')).toBe(true);
  });

  it('sorts chronologically rather than trusting the stored order', () => {
    exportAnalysisCSV(analysis([det({ start: 600, end: 700 }), det({ start: 10, end: 20 })]));
    const rows = csvRows();
    expect(rows[1]!.startsWith('00:00:10')).toBe(true);
    expect(rows[2]!.startsWith('00:10:00')).toBe(true);
  });

  it('quotes a tune name containing a comma instead of splitting the row', () => {
    exportAnalysisCSV(analysis([det({ displayName: 'Cooley\u2019s, The' })]));
    const rows = csvRows();
    expect(rows[1]).toContain('"Cooley\u2019s, The"');
    expect(rows[0]!.split(',')).toHaveLength(8);
  });

  it('falls back to the recording duration for a detection left open', () => {
    exportAnalysisCSV(analysis([det({ start: 30, end: null })]));
    expect(csvRows()[1]!.split(',')[1]).toBe('01:00:00');
  });

  it('leads with a BOM, without which Excel mangles accented tune names', () => {
    exportAnalysisCSV(analysis([det({})]));
    expect(captured[0]!.startsWith('\ufeff')).toBe(true);
  });

  // Regression: a rewrite of this escape lost one backslash, turning the
  // flatten-newlines replacement into an insert-a-real-newline one. Every
  // type check and every other test stayed green while a card with two-line
  // notes silently split into two CSV rows.
  it('flattens a newline inside a field instead of breaking the row', () => {
    exportAnalysisCSV(analysis([det({ displayName: 'Two\nLines' })]));
    const rows = csvRows();
    expect(rows).toHaveLength(2);
    expect(rows[1]).toContain(String.fromCharCode(92) + 'nLines');
  });
});

describe('analysis TXT export', () => {
  it('writes a header and one line per detection, in time order', () => {
    exportAnalysisTXT(analysis([det({ start: 90, end: 120, displayName: 'B' }), det({ start: 0, end: 90, displayName: 'A' })]));
    const lines = captured[0]!.split('\r\n');
    expect(lines[0]).toBe('Tocane');
    expect(lines.some(l => l.startsWith('Detections: 2'))).toBe(true);
    const body = lines.filter(l => /^\d\d:/.test(l));
    expect(body).toHaveLength(2);
    expect(body[0]).toContain('A');
    expect(body[1]).toContain('B');
  });

  it('shows "confirmed" instead of a percentage once the user has vouched for it', () => {
    exportAnalysisTXT(analysis([det({ userConfirmed: true, liked: true })]));
    const line = captured[0]!.split('\r\n').find(l => /^\d\d:/.test(l))!;
    expect(line).toContain('confirmed');
    expect(line).toContain('liked');
    expect(line).not.toContain('92%');
  });

  it('omits the date line when the analysis has none', () => {
    const a = analysis([det({})]);
    a.date = null;
    exportAnalysisTXT(a);
    expect(captured[0]!).not.toContain('Date:');
  });
});

describe('the two formats stay in step', () => {
  // Added because they drifted the first time: the TXT carried a Links field
  // the CSV did not, and the CSV carried a review list the TXT summarised away.
  // A shared reader now feeds both, and this checks the rendering agrees.
  it('puts every CSV value for a detection somewhere in the TXT line', () => {
    const d = det({ start: 61, end: 125, displayName: 'The Butterfly', dance: 'slip jig', meter: '9/8', liked: true });
    exportAnalysisCSV(analysis([d]));
    exportAnalysisTXT(analysis([d]));
    const [start, end, tune, dance, meter, confidence, , liked] = csvRows()[1]!.split(',');
    const line = captured[1]!.split('\r\n').find(l => /^\d\d:/.test(l))!;
    for (const v of [start, end, tune, dance, meter, `${confidence}%`]) expect(line).toContain(v!);
    expect(liked).toBe('yes');
    expect(line).toContain('liked');
  });
});


describe('the clipboard and the file carry the same text', () => {
  // The report builder was split out of the download so the copy button and
  // the saved file cannot drift. If someone re-inlines the building, this is
  // what notices.
  it('writes exactly what analysisTextReport returns', () => {
    const a = analysis([det({}), det({ start: 200, end: 260, displayName: 'B' })]);
    exportAnalysisTXT(a);
    expect(captured[0]).toBe(analysisTextReport(a));
  });
});