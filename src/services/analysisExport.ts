import type { Analysis, Detection } from '../session/model';
import { downloadBlob, downloadTextFile } from '../utils';
import { withChains } from '../session/ui/timelineModel';
import { buildZip, type ZipEntry } from './zip';
import { safeFileName } from './attachmentNames';

// ── Read-only exports of an analysis ─────────────────────────────────────────
// The .cds package (sessionShareService.ts) exists to travel BACK into Cadence:
// it carries evidence arrays, alternates, the Viterbi snapshot, optionally the
// audio. The text and the CSV carry the answer only — the setlist — for
// reading, for a spreadsheet, or for handing to someone who does not run
// Cadence; the clips zip, the sound of each answer. Nothing here re-imports, so
// nothing here has to stay stable across schema versions.
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

/** What a detection is called in an export. The detection's own name is the
 *  recogniser's, all in lower case ("the silver spear"); the screens look the
 *  proper spelling up (session/ui's tuneName), and pass that lookup here so a
 *  file reads like the screen it came from. */
export type NameOf = (d: Detection) => string;
const rawName: NameOf = d => d.displayName;

/** Whether a blank line goes before each detection: where one set ends and
 *  the next begins, as the screen draws them (timelineModel's withChains) —
 *  the user's cuts and links included (2026-10-20). */
function breaksBefore(dets: Detection[], session: Analysis): boolean[] {
  const opens = new Set<Detection>();
  for (const x of withChains(dets, session.duration)) {
    if (x.kind === 'ann') opens.add(x.ann);
    else if (x.kind === 'chain') opens.add(x.members[0]!.ann);
  }
  return dets.map((d, i) => i > 0 && opens.has(d));
}

export interface TextReportOptions {
  /** The full report — times, confidence, meter, marks. Without it, the short
   *  setlist people paste into a chat: "- Morrison's (jig)", one line per tune
   *  played, a tune played twice listed twice (2026-10-08, group feedback: the
   *  full report read as noise there). */
  detailed?: boolean;
  nameOf?: NameOf;
  /** A blank line between sets — only with the experimental sets on. */
  setBreaks?: boolean;
}

export function analysisTextReport(session: Analysis, { detailed = false, nameOf = rawName, setBreaks = false }: TextReportOptions = {}): string {
  const dets = ordered(session);
  const brk = setBreaks ? breaksBefore(dets, session) : dets.map(() => false);
  if (!detailed) {
    const head = session.name || 'Analysis';
    return [
      session.date ? `${head} (${session.date.slice(0, 10)})` : head,
      '',
      ...dets.flatMap((d, i) => [...(brk[i] ? [''] : []), `- ${nameOf(d)}${d.dance ? ` (${d.dance})` : ''}`]),
    ].join('\r\n');
  }
  const out: string[] = [
    session.name || 'Analysis',
    ...(session.date ? [`Date:       ${session.date.slice(0, 10)}`] : []),
    `Duration:   ${hms(session.duration)}`,
    `Detections: ${dets.length}`,
    '',
  ];

  // Widest label in THIS file, so the marker column lines up without a fixed
  // width that a long tune title would blow through anyway.
  const label = (d: Detection) => `${nameOf(d)}${d.dance || d.meter ? ` (${[d.dance, d.meter].filter(Boolean).join(', ')})` : ''}`;
  const width = Math.min(56, Math.max(0, ...dets.map(d => label(d).length)));

  dets.forEach((d, i) => {
    if (brk[i]) out.push('');
    const marks = [
      d.userConfirmed ? 'confirmed' : `${Math.round(d.confidence * 100)}%`,
      d.liked ? 'liked' : '',
    ].filter(Boolean).join('  ');
    out.push(`${hms(d.start)} - ${hms(endOf(d, session))}  ${label(d).padEnd(width + 2)}${marks}`.trimEnd());
  });

  return out.join('\r\n');
}

/** The same report, as a downloaded file. */
export function exportAnalysisTXT(session: Analysis, opts: TextReportOptions = {}): void {
  downloadTextFile(analysisTextReport(session, opts),
    `${safeName(session)}-detections.txt`, 'text/plain;charset=utf-8');
}

/** RFC 4180-ish: quote only when needed, double the quotes inside, and flatten
 *  newlines rather than emitting a multi-line field. Same rule the card CSV
 *  export uses — kept identical on purpose so the two files behave the same in
 *  a spreadsheet. */
function escape(v: string): string {
  const s = v.replace(/\n|\r\n?/g, '\\n');
  return s.includes(',') || s.includes('"') ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Same fields as the detailed TXT, one row per detection. */
export function exportAnalysisCSV(session: Analysis, nameOf: NameOf = rawName, { setBreaks = false }: { setBreaks?: boolean } = {}): void {
  // BOM: without it Excel reads the file as the system codepage and mangles
  // every accented tune name. Same prefix the card CSV export carries.
  downloadTextFile('﻿' + analysisCsv(session, nameOf, setBreaks), `${safeName(session)}-detections.csv`, 'text/csv;charset=utf-8');
}

/** The CSV's text — with an empty row between sets when asked, which a
 *  spreadsheet shows as the gap it is. */
export function analysisCsv(session: Analysis, nameOf: NameOf = rawName, setBreaks = false): string {
  const rows: string[][] = [
    ['Start', 'End', 'Tune', 'Dance', 'Meter', 'Confidence %', 'Confirmed', 'Liked'],
  ];

  const dets = ordered(session);
  const brk = setBreaks ? breaksBefore(dets, session) : dets.map(() => false);
  dets.forEach((d, i) => {
    if (brk[i]) rows.push([]);
    rows.push([
      hms(d.start),
      hms(endOf(d, session)),
      nameOf(d),
      d.dance,
      d.meter,
      String(Math.round(d.confidence * 100)),
      d.userConfirmed ? 'yes' : '',
      d.liked ? 'yes' : '',
    ]);
  });

  return rows.map(r => r.map(escape).join(',')).join('\r\n');
}

/** A clip's name inside a clips zip: "{index} - {tune}" and nothing else —
 *  the analysis is already the zip's name (user's choice, 2026-10-25). Shared
 *  with the TheSession widget's zip (thesessionEmbed/exports.ts), so the two
 *  archives read alike.
 *
 *  The index is zero-padded to the count, so a file manager sorting by name
 *  keeps the playing order past 9; it also keeps a tune played twice in two
 *  distinct files. Cleaned as downloadBlob cleans the zip's own name: a tune
 *  title is not a file name, and a "/" left in a zip path makes a folder. */
export function clipEntryName(index: number, total: number, tune: string, extension: string): string {
  const n = String(index + 1).padStart(String(total).length, '0');
  return safeFileName(`${n} - ${tune}.${extension}`);
}

/** Every detection's clip, in playing order, in one zip (2026-10-25). The same
 *  clip the card's "attach" cuts (clipExtract.ts): the recording's own
 *  container, no re-encoding, the same padding. STORE zip: the entries are
 *  compressed audio already.
 *
 *  All or nothing: a clip that cannot be cut fails the whole export rather
 *  than leaving a zip that is quietly one tune short. */
export async function exportAnalysisClipsZip(
  session: Analysis,
  audio: Blob,
  nameOf: NameOf = rawName,
  onProgress?: (done: number, total: number) => void,
): Promise<void> {
  // Lazy, as everywhere a clip is cut: mediabunny stays out of the main bundle.
  const { extractClip } = await import('../session/audio/clipExtract');
  const dets = ordered(session);
  const entries: ZipEntry[] = [];
  for (const [i, d] of dets.entries()) {
    onProgress?.(i, dets.length);
    const clip = await extractClip(audio, d.start, endOf(d, session));
    entries.push({ name: clipEntryName(i, dets.length, nameOf(d), clip.extension), data: new Uint8Array(await clip.blob.arrayBuffer()) });
  }
  onProgress?.(dets.length, dets.length);
  downloadBlob(new Blob([buildZip(entries)], { type: 'application/zip' }), `${safeName(session)}-clips.zip`);
}
