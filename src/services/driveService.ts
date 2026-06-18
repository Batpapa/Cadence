import type { AppState } from '../types';
import { GOOGLE_CLIENT_ID } from '../config';

export type DriveStatus = 'disconnected' | 'connecting' | 'pending' | 'syncing' | 'connected' | 'error';

export type ConnectResult =
  | { action: 'none' }
  | { action: 'apply';         state: AppState }
  | { action: 'conflict';      state: AppState }
  | { action: 'wrong_account'; existingEmail: string; newEmail: string };

const FILE_NAME     = 'cadence-data.json';
const SCOPE         = 'https://www.googleapis.com/auth/drive.file';
const LS_DEVICE_ID  = 'cadence_device_id';
const SS_TOKEN      = 'cadence_access_token';
const SS_EXPIRES_AT = 'cadence_token_expires_at';

// ── Per-user state ────────────────────────────────────────────────────────────

interface DriveUserState {
  userId:         string;
  fileId:         string | null;
  status:         DriveStatus;
  syncTimer:      ReturnType<typeof setTimeout> | null;
  retryTimer:     ReturnType<typeof setTimeout> | null;
  pendingState:   AppState | null;
  flushInProgress: boolean;
}

let _state: DriveUserState = {
  userId: '', fileId: null, status: 'disconnected',
  syncTimer: null, retryTimer: null, pendingState: null, flushInProgress: false,
};

// Key helpers — accept an explicit userId for cross-user operations (e.g. clear on delete).
const lsFileId    = (uid = _state.userId) => `cadence_drive_file_id_${uid}`;
const lsConnected = (uid = _state.userId) => `cadence_drive_connected_${uid}`;
const lsLocalTs   = (uid = _state.userId) => `cadence_local_modified_${uid}`;
const lsHint      = (uid = _state.userId) => `cadence_drive_hint_${uid}`;
const lsOwner     = (uid = _state.userId) => `cadence_drive_owner_${uid}`;

// ── Session-level state (shared across users in the same tab) ─────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Gis = any;

let tokenClient:    Gis    = null;
let driveReady:     Promise<void> | null = null;
let accessToken:    string | null = sessionStorage.getItem(SS_TOKEN);
let tokenExpiresAt: number = parseInt(sessionStorage.getItem(SS_EXPIRES_AT) ?? '0');

const listeners: Array<(s: DriveStatus) => void> = [];

function setStatus(s: DriveStatus): void {
  _state.status = s;
  for (const cb of listeners) cb(s);
}

/** Call once per user open, before finishBoot. Reinitialises per-user Drive state. */
export function initDriveForUser(userId: string): void {
  if (_state.syncTimer)  { clearTimeout(_state.syncTimer);  }
  if (_state.retryTimer) { clearTimeout(_state.retryTimer); }
  _state = {
    userId,
    fileId:          localStorage.getItem(lsFileId(userId)),
    status:          localStorage.getItem(lsConnected(userId)) === '1' ? 'connected' : 'disconnected',
    syncTimer:       null,
    retryTimer:      null,
    pendingState:    null,
    flushInProgress: false,
  };
}

export function clearDriveOwner(): void {
  localStorage.removeItem(lsOwner());
}

export function clearDriveStateForUser(userId: string): void {
  localStorage.removeItem(lsFileId(userId));
  localStorage.removeItem(lsConnected(userId));
  localStorage.removeItem(lsLocalTs(userId));
  localStorage.removeItem(lsHint(userId));
  localStorage.removeItem(lsOwner(userId));
}

export function getDeviceId(): string {
  let id = localStorage.getItem(LS_DEVICE_ID);
  if (!id) { id = crypto.randomUUID(); localStorage.setItem(LS_DEVICE_ID, id); }
  return id;
}

export function isDriveFeatureEnabled(): boolean { return Boolean(GOOGLE_CLIENT_ID); }
export function isDriveConnected(): boolean      { return !!localStorage.getItem(lsFileId()); }
export function getDriveStatus(): DriveStatus    { return _state.status; }
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
      accessToken    = resp.access_token as string;
      tokenExpiresAt = Date.now() + ((resp.expires_in as number ?? 3600) * 1000) - 60_000;
      sessionStorage.setItem(SS_TOKEN, accessToken);
      sessionStorage.setItem(SS_EXPIRES_AT, String(tokenExpiresAt));
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
  if (accessToken && Date.now() < tokenExpiresAt) return accessToken;
  accessToken = null;
  sessionStorage.removeItem(SS_TOKEN); sessionStorage.removeItem(SS_EXPIRES_AT); tokenExpiresAt = 0;
  await initDriveClient();
  return requestToken('');
}

async function driveRequest(url: string, options: RequestInit = {}): Promise<Response> {
  const doFetch = (tok: string) => fetch(url, {
    ...options,
    headers: { ...(options.headers as Record<string, string> ?? {}), Authorization: `Bearer ${tok}` },
  });
  const resp = await doFetch(await getToken());
  if (resp.status === 401) {
    accessToken = null;
    sessionStorage.removeItem(SS_TOKEN); sessionStorage.removeItem(SS_EXPIRES_AT); tokenExpiresAt = 0;
    return doFetch(await requestToken(''));
  }
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
      sessionStorage.removeItem(SS_TOKEN); sessionStorage.removeItem(SS_EXPIRES_AT); tokenExpiresAt = 0;
      setStatus('disconnected');
      return { action: 'wrong_account', existingEmail: localStorage.getItem(lsHint()) ?? '', newEmail: email };
    }

    if (email)    localStorage.setItem(lsHint(), email);
    if (googleId) localStorage.setItem(lsOwner(), googleId);

    _state.fileId = await findOrCreateFile();
    localStorage.setItem(lsFileId(), _state.fileId);
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
  if (_state.syncTimer)  { clearTimeout(_state.syncTimer);  _state.syncTimer  = null; }
  if (_state.retryTimer) { clearTimeout(_state.retryTimer); _state.retryTimer = null; }
  _state.pendingState = null;
  if (accessToken) {
    (window as Gis).google?.accounts?.oauth2?.revoke(accessToken, () => {});
    accessToken = null;
    sessionStorage.removeItem(SS_TOKEN); sessionStorage.removeItem(SS_EXPIRES_AT); tokenExpiresAt = 0;
  }
  _state.fileId = null;
  localStorage.removeItem(lsFileId());
  localStorage.removeItem(lsConnected());
  localStorage.removeItem(lsHint());
  setStatus('disconnected');
}

async function flushSync(): Promise<void> {
  if (!_state.fileId || !_state.pendingState || _state.flushInProgress) return;
  if (_state.retryTimer) { clearTimeout(_state.retryTimer); _state.retryTimer = null; }
  _state.flushInProgress = true;
  const state = _state.pendingState;
  _state.pendingState = null;
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
      `https://www.googleapis.com/upload/drive/v3/files/${_state.fileId}?uploadType=multipart`,
      { method: 'PATCH', body: form }
    );
    localStorage.setItem(lsLocalTs(), String(ts));
    setStatus(_state.pendingState ? 'pending' : 'connected');
  } catch {
    _state.pendingState = _state.pendingState ?? state;
    setStatus('error');
    _state.retryTimer = setTimeout(() => { _state.retryTimer = null; void flushSync(); }, 30_000);
  } finally {
    _state.flushInProgress = false;
  }
}

export function syncToCloud(state: AppState): void {
  localStorage.setItem(lsLocalTs(), String(Date.now()));
  if (!isDriveConnected()) return;
  _state.pendingState = state;
  setStatus('pending');
  if (_state.syncTimer) clearTimeout(_state.syncTimer);
  _state.syncTimer = setTimeout(() => { _state.syncTimer = null; void flushSync(); }, 30_000);
}

export async function manualSync(): Promise<void> {
  if (_state.syncTimer)  { clearTimeout(_state.syncTimer);  _state.syncTimer  = null; }
  if (_state.retryTimer) { clearTimeout(_state.retryTimer); _state.retryTimer = null; }
  await flushSync();
}

export function initDriveVisibilitySync(): void {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && _state.pendingState) {
      if (_state.syncTimer) { clearTimeout(_state.syncTimer); _state.syncTimer = null; }
      void flushSync();
    }
  });
}

export async function loadFromCloud(): Promise<(AppState & { _lastModified?: number; _deviceId?: string }) | null> {
  if (!_state.fileId) return null;
  try {
    const resp = await driveRequest(`https://www.googleapis.com/drive/v3/files/${_state.fileId}?alt=media`);
    if (!resp.ok) return null;
    return await resp.json() as AppState & { _lastModified?: number; _deviceId?: string };
  } catch {
    return null;
  }
}
