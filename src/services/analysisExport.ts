import type { Analysis, Detection } from '../session/model';
import { downloadBlob, downloadTextFile, toDateStr } from '../utils';
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

// ── The Detections tab, across analyses (2026-10-28) ─────────────────────────
// Asked for by someone tallying 50 months of a session's recordings in a
// spreadsheet, one analysis CSV per tab: the ranking the tab already shows,
// as a file. Same gesture and same formats as the card library's export.
//
// One row per tune or set, exactly as the list reads — never one per pass:
// the per-pass file is what each analysis already exports.

/** One row of the list, everything already decided by the screen: the name as
 *  shown, the counts as filtered. Nothing here looks anything up. */
export interface DetectedTuneLine {
  name: string;
  isSet: boolean;
  dances: string[];
  keys: string[];
  detections: number;
  confirmed: number;
  /** Epoch ms, or null when every analysis it was heard in is undated. */
  lastHeard: number | null;
  liked: boolean;
  hasCard: boolean;
  /** The tune's TheSession id, or a set's, in playing order. */
  tuneIds: string[];
}

const theSessionUrl = (id: string) => `https://thesession.org/tunes/${id}`;
/** The local day it was played: a session at 23:30 is that evening's, which
 *  the UTC date would move to the next morning. */
const lastHeardDay = (line: DetectedTuneLine) => (line.lastHeard === null ? '' : toDateStr(new Date(line.lastHeard)));

export function detectedTunesCsv(lines: readonly DetectedTuneLine[]): string {
  const rows: string[][] = [
    ['Tune', 'Type', 'Dance', 'Key', 'Detections', 'Confirmed', 'Last heard', 'Liked', 'Card', 'TheSession'],
  ];
  for (const l of lines) {
    rows.push([
      l.name,
      l.isSet ? 'set' : 'tune',
      l.dances.join('; '),
      l.keys.join('; '),
      String(l.detections),
      String(l.confirmed),
      lastHeardDay(l),
      l.liked ? 'yes' : '',
      l.hasCard ? 'yes' : '',
      l.tuneIds.map(theSessionUrl).join('; '),
    ]);
  }
  return rows.map(r => r.map(escape).join(',')).join('\r\n');
}

export function exportDetectedTunesCSV(lines: readonly DetectedTuneLine[]): void {
  // BOM: Excel and accented tune names, as for every other CSV here.
  downloadTextFile('﻿' + detectedTunesCsv(lines),
    `cadence-detections-${toDateStr(new Date())}.csv`, 'text/csv;charset=utf-8');
}

/** The list to read or paste — into a mail to the people you play with, say.
 *  The CSV's fields but one: "Card" says what is in the exporter's own
 *  library, which means nothing to whoever reads the text. The link to each
 *  tune goes on its own line, where a mail client turns it into one. */
export function detectedTunesTextReport(lines: readonly DetectedTuneLine[], now: Date = new Date()): string {
  const sets = lines.filter(l => l.isSet).length;
  const tunes = lines.length - sets;
  const counted = [
    `${tunes} tune${tunes === 1 ? '' : 's'}`,
    ...(sets > 0 ? [`${sets} set${sets === 1 ? '' : 's'}`] : []),
  ].join(', ');
  const out: string[] = [`Cadence — detections export — ${toDateStr(now)}`, counted, ''];

  for (const l of lines) {
    const about = [...(l.isSet ? ['set'] : []), ...l.dances, ...l.keys].join(', ');
    // Only what carries something, as in the card report: "0 confirmed" on
    // every line is noise to skim past.
    const parts = [
      `- ${l.name}${about ? ` (${about})` : ''}`,
      `${l.detections} detection${l.detections === 1 ? '' : 's'}${l.confirmed > 0 ? `, ${l.confirmed} confirmed` : ''}`,
      ...(l.lastHeard !== null ? [`last heard ${lastHeardDay(l)}`] : []),
      ...(l.liked ? ['liked'] : []),
    ];
    out.push(parts.join(' — '));
    for (const id of l.tuneIds) out.push(`  ${theSessionUrl(id)}`);
  }

  return out.join('\r\n');
}

export function exportDetectedTunesTXT(lines: readonly DetectedTuneLine[]): void {
  downloadTextFile(detectedTunesTextReport(lines),
    `cadence-detections-${toDateStr(new Date())}.txt`, 'text/plain;charset=utf-8');
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
