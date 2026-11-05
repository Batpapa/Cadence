import type { Analysis } from '../session/model';
import { arrayBufferToBase64, base64ToBlob, generateId, downloadCadenceFile } from '../utils';
import { uploadShare, downloadShare, type ShareUploadResult } from './shareService';
import { saveSessionMeta, saveSessionAudio } from '../session/db';
import { keepRecordings } from '../session/keepRecordings';

// ── Session sharing ────────────────────────────────────────────────────────────
// Two ways in, two ways out — same choice the card package (.cdc) flow already
// offers: a downloaded file (no size limit beyond the user's own disk) or a
// short-lived share key (shareService.ts: 6-char key, 10 min TTL, 100 MB cap).
// Both read/write the same JSON envelope, audio base64-embedded when included.

const SCHEMA_VERSION = 1;

interface SessionPackage {
  schemaVersion: number;
  session: Omit<Analysis, 'id'>;
  audioBase64: string | null;
  audioMimeType: string | null;
}

function isSessionPackage(data: unknown): data is SessionPackage {
  return typeof data === 'object' && data !== null && 'session' in data;
}

async function buildPackageText(session: Analysis, audioBlob: Blob | null): Promise<string> {
  const { id: _id, ...rest } = session;
  let audioBase64: string | null = null;
  let audioMimeType: string | null = null;
  if (audioBlob) {
    audioBase64 = arrayBufferToBase64(await audioBlob.arrayBuffer());
    audioMimeType = audioBlob.type || session.mimeType;
  }
  const pkg: SessionPackage = { schemaVersion: SCHEMA_VERSION, session: rest, audioBase64, audioMimeType };
  return JSON.stringify(pkg);
}

function parsePackageText(text: string): SessionPackage {
  let data: unknown;
  try { data = JSON.parse(text); } catch { throw new Error('Invalid session package'); }
  if (!isSessionPackage(data)) throw new Error('Not a valid session package');
  return data;
}

/** Saves the package as a new session — a fresh id is always generated (the
 *  original's id has no meaning on this device). `withAudio`: the import
 *  window's box (2026-11-04); unticked, the audio it carries is not even
 *  decoded. */
async function applyPackage(pkg: SessionPackage, withAudio: boolean): Promise<Analysis> {
  const audio = withAudio && pkg.audioBase64 ? base64ToBlob(pkg.audioBase64, pkg.audioMimeType ?? pkg.session.mimeType) : null;
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

export async function shareSession(session: Analysis, audioBlob: Blob | null): Promise<ShareUploadResult> {
  return uploadShare(await buildPackageText(session, audioBlob));
}

/** Downloads a `.cds` file — no size limit beyond the browser/disk. */
export async function exportSessionFile(session: Analysis, audioBlob: Blob | null): Promise<void> {
  const text = await buildPackageText(session, audioBlob);
  // Named as the library names it; downloadBlob makes it a valid file name.
  downloadCadenceFile(text, `${session.name || 'session'}.cds`);
}

// ── In ────────────────────────────────────────────────────────────────────────

export async function importSharedSession(key: string, withAudio: boolean): Promise<Analysis> {
  return applyPackage(parsePackageText(await downloadShare(key)), withAudio);
}

export async function importSessionFile(file: File, withAudio: boolean): Promise<Analysis> {
  if (!file.name.endsWith('.cds')) throw new Error('Expected a .cds file');
  return applyPackage(parsePackageText(await file.text()), withAudio);
}
