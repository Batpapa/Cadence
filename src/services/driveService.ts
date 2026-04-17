import type { AppState } from '../types';
import { GOOGLE_CLIENT_ID } from '../config';

export type DriveStatus = 'disconnected' | 'connecting' | 'pending' | 'syncing' | 'connected' | 'error';

const FILE_NAME = 'cadence-data.json';
const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const LS_FILE_ID = 'cadence_drive_file_id';
const LS_CONNECTED = 'cadence_drive_connected';
const LS_LOCAL_TS = 'cadence_local_modified';
const LS_HINT = 'cadence_drive_hint';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Gis = any;

let tokenClient: Gis = null;
let driveReady: Promise<void> | null = null;
let accessToken: string | null = null;
let fileId: string | null = localStorage.getItem(LS_FILE_ID);
let status: DriveStatus = localStorage.getItem(LS_CONNECTED) === '1' ? 'connected' : 'disconnected';
const listeners: Array<(s: DriveStatus) => void> = [];
let syncTimer: ReturnType<typeof setTimeout> | null = null;
let pendingState: AppState | null = null;
let flushInProgress = false;

function setStatus(s: DriveStatus): void {
  status = s;
  for (const cb of listeners) cb(s);
}

export function isDriveFeatureEnabled(): boolean {
  return Boolean(GOOGLE_CLIENT_ID);
}

export function isDriveConnected(): boolean {
  return !!localStorage.getItem(LS_FILE_ID);
}

export function hasCachedToken(): boolean {
  return !!accessToken;
}

export function getDriveStatus(): DriveStatus { return status; }

export function onStatusChange(cb: (s: DriveStatus) => void): () => void {
  listeners.push(cb);
  return () => { const i = listeners.indexOf(cb); if (i !== -1) listeners.splice(i, 1); };
}

export function getLocalTimestamp(): number {
  return parseInt(localStorage.getItem(LS_LOCAL_TS) ?? '0');
}

export function initDriveClient(): Promise<void> {
  if (!GOOGLE_CLIENT_ID) return Promise.resolve();
  if (driveReady) return driveReady;
  driveReady = new Promise<void>((resolve) => {
    const poll = () => {
      const g = (window as Gis).google;
      if (g?.accounts?.oauth2) {
        tokenClient = g.accounts.oauth2.initTokenClient({
          client_id: GOOGLE_CLIENT_ID,
          scope: SCOPE,
          callback: '',
        });
        resolve();
      } else {
        setTimeout(poll, 100);
      }
    };
    poll();
  });
  return driveReady;
}

function requestToken(prompt = ''): Promise<string> {
  return new Promise((resolve, reject) => {
    const cleanup = () => { tokenClient.error_callback = null; };
    tokenClient.callback = (resp: Gis) => {
      cleanup();
      if (resp.error) { reject(new Error(resp.error_description ?? resp.error)); return; }
      accessToken = resp.access_token as string;
      resolve(accessToken);
    };
    tokenClient.error_callback = (err: Gis) => {
      cleanup();
      reject(new Error(err.type ?? 'popup_closed'));
    };
    const hint = localStorage.getItem(LS_HINT) ?? undefined;
    tokenClient.requestAccessToken({ prompt, ...(hint ? { hint } : {}) });
  });
}

async function getToken(): Promise<string> {
  if (accessToken) return accessToken;
  await initDriveClient();
  return requestToken('');
}

async function driveRequest(url: string, options: RequestInit = {}): Promise<Response> {
  const doFetch = (tok: string) => fetch(url, {
    ...options,
    headers: { ...(options.headers as Record<string, string> ?? {}), Authorization: `Bearer ${tok}` },
  });
  const resp = await doFetch(await getToken());
  if (resp.status === 401) { accessToken = null; return doFetch(await requestToken('')); }
  return resp;
}

async function findOrCreateFile(): Promise<string> {
  const q = encodeURIComponent(`name='${FILE_NAME}' and trashed=false`);
  const search = await driveRequest(
    `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id)&spaces=drive`
  );
  const data = await search.json() as { files?: Array<{ id: string }> };
  if (data.files?.length) return data.files[0]!.id;
  const create = await driveRequest('https://www.googleapis.com/drive/v3/files', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: FILE_NAME, mimeType: 'application/json' }),
  });
  return ((await create.json()) as { id: string }).id;
}

export async function connectDrive(): Promise<void> {
  await initDriveClient();
  if (!tokenClient) throw new Error('Drive client not ready');
  setStatus('connecting');
  try {
    const token = await requestToken('consent');
    // Store email hint for silent re-auth on future page loads
    void fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${token}` },
    }).then(r => r.json()).then((d: Gis) => {
      if (d.email) localStorage.setItem(LS_HINT, d.email as string);
    }).catch(() => {});
    fileId = await findOrCreateFile();
    localStorage.setItem(LS_FILE_ID, fileId);
    localStorage.setItem(LS_CONNECTED, '1');
    setStatus('connected');
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    setStatus(msg.includes('popup_closed') || msg.includes('access_denied') ? 'disconnected' : 'error');
    throw e;
  }
}

export function disconnectDrive(): void {
  if (accessToken) {
    (window as Gis).google?.accounts?.oauth2?.revoke(accessToken, () => {});
    accessToken = null;
  }
  fileId = null;
  localStorage.removeItem(LS_FILE_ID);
  localStorage.removeItem(LS_CONNECTED);
  localStorage.removeItem(LS_HINT);
  setStatus('disconnected');
}

async function flushSync(): Promise<void> {
  if (!fileId || !pendingState || flushInProgress) return;
  flushInProgress = true;
  const state = pendingState;
  pendingState = null;
  setStatus('syncing');
  try {
    const ts = Date.now();
    const payload = JSON.stringify({ ...state, _lastModified: ts });
    const blob = new Blob([payload], { type: 'application/json' });
    const meta = new Blob(
      [JSON.stringify({ name: FILE_NAME, mimeType: 'application/json' })],
      { type: 'application/json' }
    );
    const form = new FormData();
    form.append('metadata', meta);
    form.append('file', blob);
    await driveRequest(
      `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=multipart`,
      { method: 'PATCH', body: form }
    );
    localStorage.setItem(LS_LOCAL_TS, String(ts));
    setStatus(pendingState ? 'pending' : 'connected');
  } catch {
    setStatus('error');
  } finally {
    flushInProgress = false;
  }
}

export function syncToCloud(state: AppState): void {
  if (!isDriveConnected()) return;
  pendingState = state;
  setStatus('pending');
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(() => { syncTimer = null; void flushSync(); }, 30_000);
}

export async function manualSync(): Promise<void> {
  if (syncTimer) { clearTimeout(syncTimer); syncTimer = null; }
  await flushSync();
}

export function initDriveVisibilitySync(): void {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && pendingState) {
      if (syncTimer) { clearTimeout(syncTimer); syncTimer = null; }
      void flushSync();
    }
  });
}

export async function loadFromCloud(): Promise<(AppState & { _lastModified?: number }) | null> {
  if (!fileId) return null;
  try {
    const resp = await driveRequest(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`);
    if (!resp.ok) return null;
    return resp.json() as Promise<AppState & { _lastModified?: number }>;
  } catch {
    return null;
  }
}
