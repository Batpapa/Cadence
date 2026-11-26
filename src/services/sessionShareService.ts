import type { Analysis } from '../session/model';
import { generateId } from '../utils';
import { base64ToBlob, downloadCadenceFile } from './fileTransfer';
import { uploadShare, downloadShareBlob, type ShareUploadResult, type UploadShareOptions } from './shareService';
import { saveSessionMeta, saveSessionAudio } from '../session/db';
import { keepRecordings } from '../session/keepRecordings';
import { buildZipBlob, readZipBlob, isZipBlob, zipSize, audioExtension, type ZipBlobEntry } from './zip';
import { isCardId } from '../session/recognition/cardIndex';
import { getSettingAbcMeta } from '../session/recognition/indexStore';

// ── Session sharing ────────────────────────────────────────────────────────────
// Two ways in, two ways out — same choice the card package (.cdc) flow already
// offers: a downloaded file (no size limit beyond the user's own disk) or a
// short-lived share key (shareService.ts: 6-char key, 10 min TTL, as large as
// the share server has room for). Both carry the same bytes.
//
// Since 2026-11-15 a .cds is a zip (zip.ts, STORE): `analysis.json` and, when
// included, `audio.<ext>` — the same container as every other Cadence file.
// Until then it was one JSON text with the audio in base64: a third larger,
// and built in memory as four or five copies of a string that size — a 3 h 30
// recording (99.8 MB) came to 133 MB, over the share server's cap, and past
// roughly 380 MB of audio a JavaScript string cannot hold it at all. The zip
// points at the stored recording instead of copying it.
//
// LEGACY READ — the JSON format is still read, for the files people keep, with
// no deadline: a shared analysis is a file kept for the long term (decided
// 2026-11-26, over the removal planned on 2026-11-15 for 2027-05-15).

const SCHEMA_VERSION = 2;
const DATA_ENTRY = 'analysis.json';
const AUDIO_PREFIX = 'audio.';

interface PackageData {
  schemaVersion: number;
  session: Omit<Analysis, 'id'>;
  audioMimeType: string | null;
}

/** The JSON format, written until 2026-11-16 and still read. */
interface LegacyPackage {
  schemaVersion: number;
  session: Omit<Analysis, 'id'>;
  audioBase64: string | null;
  audioMimeType: string | null;
}

/** What a package holds, the audio read only when asked for. */
interface OpenedPackage {
  session: Omit<Analysis, 'id'>;
  audio: (() => Promise<Blob>) | null;
}

function hasSession(data: unknown): data is { session: Omit<Analysis, 'id'> } {
  return typeof data === 'object' && data !== null && 'session' in data;
}

function dataText(session: Analysis, audioMimeType: string | null): string {
  const { id: _id, ...rest } = session;
  const data: PackageData = { schemaVersion: SCHEMA_VERSION, session: rest, audioMimeType };
  return JSON.stringify(data);
}

function audioEntryName(mime: string): string {
  return AUDIO_PREFIX + audioExtension(mime);
}

async function buildPackage(session: Analysis, audioBlob: Blob | null): Promise<Blob> {
  const mime = audioBlob ? audioBlob.type || session.mimeType : null;
  const entries: ZipBlobEntry[] = [{ name: DATA_ENTRY, data: dataText(session, mime) }];
  if (audioBlob && mime) entries.push({ name: audioEntryName(mime), data: audioBlob });
  return buildZipBlob(entries);
}

/** The size of the package `buildPackage` would make, from the audio's size
 *  alone — the audio may still be on Drive, fetched only at the click. Its
 *  type, unknown until then, changes the size by a few bytes at most. */
export function packageSize(session: Analysis, audioBytes: number | null): number {
  const mime = audioBytes ? session.mimeType : null;
  const entries = [{ name: DATA_ENTRY, bytes: new TextEncoder().encode(dataText(session, mime)).length }];
  if (audioBytes && mime) entries.push({ name: audioEntryName(mime), bytes: audioBytes });
  return zipSize(entries);
}

async function openPackage(pkg: Blob): Promise<OpenedPackage> {
  if (!(await isZipBlob(pkg))) return openLegacyPackage(await pkg.text());
  const items = await readZipBlob(pkg);
  const dataItem = items.find(i => i.name === DATA_ENTRY);
  if (!dataItem) throw new Error('Not a valid session package');
  let data: unknown;
  try { data = JSON.parse(await dataItem.text()); } catch { throw new Error('Invalid session package'); }
  if (!hasSession(data)) throw new Error('Not a valid session package');
  const { session, audioMimeType } = data as PackageData;
  const audioItem = items.find(i => i.name.startsWith(AUDIO_PREFIX));
  return {
    session,
    // A copy, not a slice of the package: it goes into IndexedDB (zip.ts).
    audio: audioItem ? () => audioItem.copy(audioMimeType ?? session.mimeType) : null,
  };
}

/** LEGACY READ — kept with no deadline (a file kept for the long term). */
function openLegacyPackage(text: string): OpenedPackage {
  let data: unknown;
  try { data = JSON.parse(text); } catch { throw new Error('Invalid session package'); }
  if (!hasSession(data)) throw new Error('Not a valid session package');
  const pkg = data as LegacyPackage;
  const base64 = pkg.audioBase64;
  return {
    session: pkg.session,
    audio: base64 ? async () => base64ToBlob(base64, pkg.audioMimeType ?? pkg.session.mimeType) : null,
  };
}

/** Saves the package as a new session — a fresh id is always generated (the
 *  original's id has no meaning on this device). `withAudio`: the import
 *  window's box (2026-11-04); unticked, the audio it carries is not even
 *  read. */
async function applyPackage(pkg: OpenedPackage, withAudio: boolean): Promise<Analysis> {
  const audio = withAudio && pkg.audio ? await pkg.audio() : null;
  return importAnalysis(pkg.session, audio, withAudio);
}

/** An analysis from elsewhere — a package, the standalone analyser
 *  (standaloneHandoff.ts) — saved into the open user's analyser as a new one,
 *  at the root of its list. `keepAudio` defaults to "Keep the recordings" on
 *  this device (keepRecordings.ts): off, the detections come in, the sound
 *  does not. */
export async function importAnalysis(
  from: Omit<Analysis, 'id'>, audio: Blob | null, keepAudio = keepRecordings.peek(),
): Promise<Analysis> {
  const { id: _id, ...rest } = from as Analysis;
  const session: Analysis = { ...rest, id: generateId() };
  await saveSessionMeta(session);
  if (audio && keepAudio) await saveSessionAudio(session.id, audio);
  return session;
}

// ── Out ───────────────────────────────────────────────────────────────────────

/** Every card version the analysis's detections name (cardIndex.ts) — the
 *  identity shown, the decoder's own pick, its alternates, the tunes named by
 *  hand — with its ABC, on a copy of the analysis: whoever receives it has not
 *  got the sender's cards (Analysis.cardVersions). Versions it already carries,
 *  from an analysis received the same way, are passed on. One the sender can
 *  no longer read goes without: that detection then shows no score, as before.
 *  packageSize does not count these few kilobytes. */
async function withCardVersions(session: Analysis): Promise<Analysis> {
  const ids = new Set<string>();
  for (const d of session.annotations ?? []) {
    for (const a of [d, d.viterbiPick, ...d.alternates, ...(d.manualAlternates ?? [])]) {
      if (a?.settingId && isCardId(a.settingId)) ids.add(a.settingId);
    }
  }
  if (ids.size === 0) return session;
  const versions: Record<string, string> = { ...(session.cardVersions ?? {}) };
  for (const id of ids) {
    if (versions[id]) continue;
    const meta = await getSettingAbcMeta(id).catch(() => null);
    if (meta?.abc) versions[id] = meta.abc;
  }
  return Object.keys(versions).length ? { ...session, cardVersions: versions } : session;
}

export async function shareSession(
  session: Analysis, audioBlob: Blob | null, options?: UploadShareOptions,
): Promise<ShareUploadResult> {
  return uploadShare(await buildPackage(await withCardVersions(session), audioBlob), options);
}

/** Downloads a `.cds` file — no size limit beyond the browser/disk. */
export async function exportSessionFile(session: Analysis, audioBlob: Blob | null): Promise<void> {
  // Named as the library names it; downloadBlob makes it a valid file name.
  downloadCadenceFile(await buildPackage(await withCardVersions(session), audioBlob), `${session.name || 'session'}.cds`);
}

// ── In ────────────────────────────────────────────────────────────────────────

export async function importSharedSession(key: string, withAudio: boolean): Promise<Analysis> {
  return applyPackage(await openPackage(await downloadShareBlob(key)), withAudio);
}

export async function importSessionFile(file: File, withAudio: boolean): Promise<Analysis> {
  if (!file.name.endsWith('.cds')) throw new Error('Expected a .cds file');
  return applyPackage(await openPackage(file), withAudio);
}
