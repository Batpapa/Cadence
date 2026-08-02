import type { RecordedSession } from '../session/model';
import { arrayBufferToBase64, generateId } from '../utils';
import { uploadShare, downloadShare, type ShareUploadResult } from './shareService';
import { saveSessionMeta, saveSessionAudio } from '../session/db';

// ── Session sharing ────────────────────────────────────────────────────────────
// Two ways in, two ways out — same choice the card package (.cdc) flow already
// offers: a downloaded file (no size limit beyond the user's own disk) or a
// short-lived share key (shareService.ts: 6-char key, 10 min TTL, 100 MB cap).
// Both read/write the same JSON envelope, audio base64-embedded when included.

const SCHEMA_VERSION = 1;

interface SessionPackage {
  schemaVersion: number;
  session: Omit<RecordedSession, 'id'>;
  audioBase64: string | null;
  audioMimeType: string | null;
}

function isSessionPackage(data: unknown): data is SessionPackage {
  return typeof data === 'object' && data !== null && 'session' in data;
}

function base64ToBlob(base64: string, mimeType: string): Blob {
  const binary = atob(base64);
  const arr = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) arr[i] = binary.charCodeAt(i);
  return new Blob([arr], { type: mimeType });
}

async function buildPackageText(session: RecordedSession, audioBlob: Blob | null): Promise<string> {
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
 *  original's id has no meaning on this device). */
async function applyPackage(pkg: SessionPackage): Promise<RecordedSession> {
  const session: RecordedSession = { ...pkg.session, id: generateId() };
  await saveSessionMeta(session);
  if (pkg.audioBase64) {
    await saveSessionAudio(session.id, base64ToBlob(pkg.audioBase64, pkg.audioMimeType ?? session.mimeType));
  }
  return session;
}

// ── Out ───────────────────────────────────────────────────────────────────────

export async function shareSession(session: RecordedSession, audioBlob: Blob | null): Promise<ShareUploadResult> {
  return uploadShare(await buildPackageText(session, audioBlob));
}

/** Downloads a `.cds` file — no size limit beyond the browser/disk. */
export async function exportSessionFile(session: RecordedSession, audioBlob: Blob | null): Promise<void> {
  const text = await buildPackageText(session, audioBlob);
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${(session.name || 'session').replace(/[^\w-]+/g, '_')}.cds`;
  a.click();
  URL.revokeObjectURL(url);
}

// ── In ────────────────────────────────────────────────────────────────────────

export async function importSharedSession(key: string): Promise<RecordedSession> {
  return applyPackage(parsePackageText(await downloadShare(key)));
}

export async function importSessionFile(file: File): Promise<RecordedSession> {
  if (!file.name.endsWith('.cds')) throw new Error('Expected a .cds file');
  return applyPackage(parsePackageText(await file.text()));
}
