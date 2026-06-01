import type { AppState } from '../types';
import { GOOGLE_CLIENT_ID } from '../config';

export type DriveStatus = 'disconnected' | 'connecting' | 'pending' | 'syncing' | 'connected' | 'error';

export type ConnectResult =
  | { action: 'none' }
  | { action: 'apply';         state: AppState }
  | { action: 'conflict';      state: AppState }
  | { action: 'wrong_account'; existingEmail: string; newEmail: string };

const FILE_NAME    = 'cadence-data.json';
const SCOPE        = 'https://www.googleapis.com/auth/drive.file';
const LS_DEVICE_ID = 'cadence_device_id';
const SS_TOKEN     = 'cadence_access_token';

// Per-user localStorage keys — set via initDriveForUser()
let _userId = '';
const lsFileId    = () => `cadence_drive_file_id_${_userId}`;
const lsConnected = () => `cadence_drive_connected_${_userId}`;
const lsLocalTs   = () => `cadence_local_modified_${_userId}`;
const lsHint      = () => `cadence_drive_hint_${_userId}`;
const lsOwner     = () => `cadence_drive_owner_${_userId}`;

export function clearDriveOwner(): void {
  localStorage.removeItem(lsOwner());
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Gis = any;

let tokenClient: Gis = null;
let driveReady: Promise<void> | null = null;
let accessToken: string | null = sessionStorage.getItem(SS_TOKEN);
let fileId: string | null = null;
let status: DriveStatus = 'disconnected';
const listeners: Array<(s: DriveStatus) => void> = [];
let syncTimer: ReturnType<typeof setTimeout> | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let pendingState: AppState | null = null;
let flushInProgress = false;

function setStatus(s: DriveStatus): void {
  status = s;
  for (const cb of listeners) cb(s);
}

/** Call once per user open, before finishBoot. Loads per-user Drive state. */
export function initDriveForUser(userId: string): void {
  _userId = userId;
  fileId  = localStorage.getItem(lsFileId());
  status  = localStorage.getItem(lsConnected()) === '1' ? 'connected' : 'disconnected';
  if (syncTimer)  { clearTimeout(syncTimer);  syncTimer  = null; }
  if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
  pendingState    = null;
  flushInProgress = false;
}

export function getDeviceId(): string {
  let id = localStorage.getItem(LS_DEVICE_ID);
  if (!id) { id = crypto.randomUUID(); localStorage.setItem(LS_DEVICE_ID, id); }
  return id;
}

export function isDriveFeatureEnabled(): boolean { return Boolean(GOOGLE_CLIENT_ID); }
export function isDriveConnected(): boolean      { return !!localStorage.getItem(lsFileId()); }
export function getDriveStatus(): DriveStatus    { return status; }
export function getLocalTimestamp(): number      { return parseInt(localStorage.getItem(lsLocalTs()) ?? '0'); }

export function onStatusChange(cb: (s: DriveStatus) => void): () => void {
  listeners.push(cb);
  return () => { const i = listeners.indexOf(cb); if (i !== -1) listeners.splice(i, 1); };
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
      sessionStorage.setItem(SS_TOKEN, accessToken);
      resolve(accessToken);
    };
    tokenClient.error_callback = (err: Gis) => {
      cleanup();
      reject(new Error(err.type ?? 'popup_closed'));
    };
    const hint = localStorage.getItem(lsHint()) ?? undefined;
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
  if (resp.status === 401) { accessToken = null; sessionStorage.removeItem(SS_TOKEN); return doFetch(await requestToken('')); }
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

export async function connectDrive(): Promise<ConnectResult> {
  await initDriveClient();
  if (!tokenClient) throw new Error('Drive client not ready');
  setStatus('connecting');
  try {
    const token = await requestToken('consent');
    let googleId = '';
    let email    = '';
    try {
      const info = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
        headers: { Authorization: `Bearer ${token}` },
      }).then(r => r.json()) as Gis;
      googleId = (info.sub   as string) ?? '';
      email    = (info.email as string) ?? '';
    } catch { /* non-fatal */ }

    const existingOwner = localStorage.getItem(lsOwner());
    if (existingOwner && googleId && existingOwner !== googleId) {
      accessToken = null;
      sessionStorage.removeItem(SS_TOKEN);
      setStatus('disconnected');
      return { action: 'wrong_account', existingEmail: localStorage.getItem(lsHint()) ?? '', newEmail: email };
    }

    if (email)    localStorage.setItem(lsHint(), email);
    if (googleId) localStorage.setItem(lsOwner(), googleId);

    fileId = await findOrCreateFile();
    localStorage.setItem(lsFileId(), fileId);
    localStorage.setItem(lsConnected(), '1');

    const driveData = await loadFromCloud();
    setStatus('connected');

    if (!driveData) return { action: 'none' };

    const driveTs     = driveData._lastModified ?? 0;
    const driveDevice = driveData._deviceId;
    const localTs     = getLocalTimestamp();
    const myDevice    = getDeviceId();
    const { _lastModified: _a, _deviceId: _b, ...clean } = driveData;
    const cleanState  = clean as AppState;
    const sameDevice  = driveDevice === myDevice;
    const localHasData = localTs > 0;

    if (sameDevice) {
      if (driveTs > localTs) {
        localStorage.setItem(lsLocalTs(), String(driveTs));
        return { action: 'apply', state: cleanState };
      }
      return { action: 'none' };
    }

    if (!localHasData) {
      localStorage.setItem(lsLocalTs(), String(driveTs));
      return { action: 'apply', state: cleanState };
    }

    return { action: 'conflict', state: cleanState };

  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    setStatus(msg.includes('popup_closed') || msg.includes('access_denied') ? 'disconnected' : 'error');
    throw e;
  }
}

export function disconnectDrive(): void {
  if (syncTimer)  { clearTimeout(syncTimer);  syncTimer  = null; }
  if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
  pendingState = null;
  if (accessToken) {
    (window as Gis).google?.accounts?.oauth2?.revoke(accessToken, () => {});
    accessToken = null;
    sessionStorage.removeItem(SS_TOKEN);
  }
  fileId = null;
  localStorage.removeItem(lsFileId());
  localStorage.removeItem(lsConnected());
  localStorage.removeItem(lsHint());
  setStatus('disconnected');
}

async function flushSync(): Promise<void> {
  if (!fileId || !pendingState || flushInProgress) return;
  if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
  flushInProgress = true;
  const state = pendingState;
  pendingState = null;
  setStatus('syncing');
  try {
    const ts = Date.now();
    const { id: _id, ...stateWithoutId } = state;
    const payload = JSON.stringify({ ...stateWithoutId, _lastModified: ts, _deviceId: getDeviceId() });
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
    localStorage.setItem(lsLocalTs(), String(ts));
    setStatus(pendingState ? 'pending' : 'connected');
  } catch {
    pendingState = pendingState ?? state;
    setStatus('error');
    retryTimer = setTimeout(() => { retryTimer = null; void flushSync(); }, 30_000);
  } finally {
    flushInProgress = false;
  }
}

export function syncToCloud(state: AppState): void {
  localStorage.setItem(lsLocalTs(), String(Date.now()));
  if (!isDriveConnected()) return;
  pendingState = state;
  setStatus('pending');
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(() => { syncTimer = null; void flushSync(); }, 30_000);
}

export async function manualSync(): Promise<void> {
  if (syncTimer)  { clearTimeout(syncTimer);  syncTimer  = null; }
  if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
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

export async function loadFromCloud(): Promise<(AppState & { _lastModified?: number; _deviceId?: string }) | null> {
  if (!fileId) return null;
  try {
    const resp = await driveRequest(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`);
    if (!resp.ok) return null;
    return await resp.json() as AppState & { _lastModified?: number; _deviceId?: string };
  } catch {
    return null;
  }
}
