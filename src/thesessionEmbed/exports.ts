import { titleCaseTuneName, downloadBlob, downloadTextFile } from '../utils';
import { analysisTextReport } from '../services/analysisExport';
import { exportSessionFile } from '../services/sessionShareService';
import { buildZip, audioExtension, type ZipEntry } from '../services/zip';
import { provisionalEnd } from '../session/detectionState';
import type { Analysis, Detection } from '../session/model';
import type { Run } from './tuneFinder';

// ── What a run exports as — the analyser's own formats ────────────────────────
// The text is the analyser's report (analysisExport.ts): the short setlist, or,
// with the timings shown, the detailed one that carries them. The package is
// its .cds (sessionShareService.ts), which Cadence imports back as an analysis.
// Clips are its clips (clipExtract.ts): cut out of the recording without
// re-encoding, a few seconds of margin either side, in the recording's own
// container. Several at once go into one STORE zip (services/zip.ts) — they are
// compressed audio already.

/** How far a run reaches: its last detection's end, an open one's last window. */
export const runDuration = (run: Run) => run.detections.reduce((m, d) => Math.max(m, provisionalEnd(d)), 0);

/** The tune as the widget writes it — the recogniser's lower-case name re-cased. */
export const nameOf = (d: { displayName: string }) => titleCaseTuneName(d.displayName);

/** The run as an analysis of Cadence's: what its report reads, and what its
 *  package carries — a finished one, which Cadence files like any other. */
function runAnalysis(run: Run, title: string, mimeType: string): Analysis {
  return {
    id: `run-${run.index}`,
    name: title,
    date: new Date(run.startedAt).toISOString(),
    duration: runDuration(run),
    mimeType,
    source: run.kind === 'mic' ? 'live' : run.kind === 'device' ? 'device' : 'import',
    status: 'done',
    annotations: run.detections,
  };
}

const fileSafe = (s: string) => s.replace(/[^\p{L}\p{N}_ -]+/gu, '_').trim() || 'tunes';

export function runText(run: Run, title: string, opts: { sets: boolean; timings: boolean }): string {
  return analysisTextReport(runAnalysis(run, title, ''), { nameOf, setBreaks: opts.sets, detailed: opts.timings });
}

export function downloadRunText(run: Run, title: string, opts: { sets: boolean; timings: boolean }): void {
  downloadTextFile(runText(run, title, opts), `${fileSafe(title)} - tunes.txt`, 'text/plain;charset=utf-8');
}

/** The .cds, with the sound when there is one: imported into Cadence, the
 *  analysis then plays and cuts clips like one made there. */
export async function downloadRunPackage(run: Run, title: string, sound: Blob | null): Promise<void> {
  await exportSessionFile(runAnalysis(run, title, sound?.type ?? ''), sound);
}

/** The recording itself: a file keeps its own name, a live run gets the title. */
export function downloadRunAudio(title: string, sound: Blob): void {
  const name = sound instanceof File ? sound.name : `${fileSafe(title)}.${audioExtension(sound.type)}`;
  downloadBlob(sound, name);
}

function mmss(s: number): string {
  s = Math.max(0, Math.round(s));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}m${String(m).padStart(2, '0')}m${ss}` : `${m}m${ss}`;
}

/** The analyser's clip name (sessionUiShared.tsx's clipFileName), which this
 *  page cannot import — it reaches for the user's cards. Same shape: tune,
 *  analysis, range, with no colon for the file systems that refuse one. */
function clipName(d: Detection, title: string, duration: number, extension: string): string {
  return `${nameOf(d)} — ${title} (${mmss(d.start)}–${mmss(d.end ?? duration)}).${extension}`;
}

async function cutClip(sound: Blob, d: Detection, duration: number) {
  const { extractClip } = await import('../session/audio/clipExtract');
  return extractClip(sound, d.start, d.end ?? duration);
}

export async function downloadClip(run: Run, title: string, d: Detection, sound: Blob): Promise<void> {
  const duration = runDuration(run);
  const clip = await cutClip(sound, d, duration);
  downloadBlob(clip.blob, clipName(d, title, duration, clip.extension));
}

/** A set's clip, as the analyser's set card cuts it: from its first tune's
 *  start to its last one's end, named after the set ("A / B / C"). */
export async function downloadSetClip(run: Run, title: string, members: Detection[], setName: string, sound: Blob): Promise<void> {
  const duration = runDuration(run);
  const first = members[0]!;
  const last = members[members.length - 1]!;
  const span: Detection = { ...first, displayName: setName, end: last.end ?? duration };
  const clip = await cutClip(sound, span, duration);
  // The name is already the screen's, re-cased tune by tune: not re-cased again.
  downloadBlob(clip.blob, `${setName} — ${title} (${mmss(first.start)}–${mmss(span.end!)}).${clip.extension}`);
}

/** Every detection's clip, in playing order, in one zip. */
export async function downloadAllClips(run: Run, title: string, sound: Blob, onProgress?: (done: number, total: number) => void): Promise<void> {
  const duration = runDuration(run);
  const entries: ZipEntry[] = [];
  const total = run.detections.length;
  for (const [i, d] of run.detections.entries()) {
    onProgress?.(i, total);
    const clip = await cutClip(sound, d, duration);
    // Numbered, so the archive lists them in the order they were played.
    const n = String(i + 1).padStart(String(total).length, '0');
    entries.push({ name: `${n} ${clipName(d, title, duration, clip.extension)}`, data: new Uint8Array(await clip.blob.arrayBuffer()) });
  }
  onProgress?.(total, total);
  downloadBlob(new Blob([buildZip(entries)], { type: 'application/zip' }), `${fileSafe(title)} - clips.zip`);
}
