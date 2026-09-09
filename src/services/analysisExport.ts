import type { Analysis, Detection } from '../session/model';
import { downloadTextFile } from '../utils';

// ── Read-only exports of an analysis ─────────────────────────────────────────
// The .cds package (sessionShareService.ts) exists to travel BACK into Cadence:
// it carries evidence arrays, alternates, the Viterbi snapshot, optionally the
// audio. These two carry the answer only — the setlist — for reading, for a
// spreadsheet, or for handing to someone who does not run Cadence. Nothing here
// re-imports, so nothing here has to stay stable across schema versions.
//
// Labels are English literals, matching what the card CSV export already does:
// an exported file outlives the session that made it and is usually read
// somewhere other than the exporting device's locale.

/** `HH:MM:SS`, always three fields. The UI's own formatter drops the hours
 *  below one hour, which is right on screen and wrong in a file: a column that
 *  changes width halfway through does not sort, and does not line up. */
function hms(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(Math.floor(s / 3600))}:${p(Math.floor(s / 60) % 60)}:${p(s % 60)}`;
}

function safeName(session: Analysis): string {
  return (session.name || 'analysis').replace(/[^\w-]+/g, '_');
}

/** Chronological, and defensively so: the order detections sit in is an
 *  implementation detail of the segmenter, while a setlist that is not in time
 *  order is simply wrong. */
function ordered(session: Analysis): Detection[] {
  return [...session.annotations].sort((a, b) => a.start - b.start);
}

/** An open detection (live tail) has no end. It cannot happen in a saved
 *  analysis — stopping force-finalises everything — but an export must still
 *  produce a valid row rather than "undefined", so it runs to the recording's
 *  own end. */
const endOf = (d: Detection, session: Analysis): number => d.end ?? session.duration;

export function exportAnalysisTXT(session: Analysis): void {
  const dets = ordered(session);
  const out: string[] = [
    session.name || 'Analysis',
    ...(session.date ? [`Date:       ${session.date.slice(0, 10)}`] : []),
    `Duration:   ${hms(session.duration)}`,
    `Detections: ${dets.length}`,
    '',
  ];

  // Widest label in THIS file, so the marker column lines up without a fixed
  // width that a long tune title would blow through anyway.
  const label = (d: Detection) => `${d.displayName}${d.dance || d.meter ? ` (${[d.dance, d.meter].filter(Boolean).join(', ')})` : ''}`;
  const width = Math.min(56, Math.max(0, ...dets.map(d => label(d).length)));

  for (const d of dets) {
    const marks = [
      d.userConfirmed ? 'confirmed' : `${Math.round(d.confidence * 100)}%`,
      d.liked ? 'liked' : '',
    ].filter(Boolean).join('  ');
    out.push(`${hms(d.start)} - ${hms(endOf(d, session))}  ${label(d).padEnd(width + 2)}${marks}`.trimEnd());
  }

  downloadTextFile(out.join('\r\n'), `${safeName(session)}-detections.txt`, 'text/plain;charset=utf-8');
}

/** RFC 4180-ish: quote only when needed, double the quotes inside, and flatten
 *  newlines rather than emitting a multi-line field. Same rule the card CSV
 *  export uses — kept identical on purpose so the two files behave the same in
 *  a spreadsheet. */
function escape(v: string): string {
  const s = v.replace(/\n|\r\n?/g, '\\n');
  return s.includes(',') || s.includes('"') ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Same fields as the TXT, one row per detection. */
export function exportAnalysisCSV(session: Analysis): void {
  const rows: string[][] = [
    ['Start', 'End', 'Tune', 'Dance', 'Meter', 'Confidence %', 'Confirmed', 'Liked'],
  ];

  for (const d of ordered(session)) {
    rows.push([
      hms(d.start),
      hms(endOf(d, session)),
      d.displayName,
      d.dance,
      d.meter,
      String(Math.round(d.confidence * 100)),
      d.userConfirmed ? 'yes' : '',
      d.liked ? 'yes' : '',
    ]);
  }

  const csv = rows.map(r => r.map(escape).join(',')).join('\r\n');
  // BOM: without it Excel reads the file as the system codepage and mangles
  // every accented tune name. Same prefix the card CSV export carries.
  downloadTextFile('﻿' + csv, `${safeName(session)}-detections.csv`, 'text/csv;charset=utf-8');
}
