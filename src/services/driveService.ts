import type { AppState } from '../types';
import { GOOGLE_CLIENT_ID } from '../config';
import { withTimeout } from '../utils';

export type DriveStatus = 'disconnected' | 'connecting' | 'pending' | 'syncing' | 'connected' | 'error';

export type ReconcileResult =
  | { action: 'none' }
  | { action: 'apply';    state: AppState; driveTs: number }  // fast-forward from Drive
  | { action: 'conflict'; state: AppState; driveTs: number }; // both sides moved — ask the user

export type ConnectResult =
  | ReconcileResult
  | { action: 'wrong_account'; existingEmail: string; newEmail: string };

const FILE_NAME     = 'cadence-data.json';
const SCOPE         = 'https://www.googleapis.com/auth/drive.file';
/** 2026-08-18: on some mobile browsers the consent popup can open but never
 *  actually navigate (stays on about:blank forever, no error callback ever
 *  fires) — e.g. when the click that triggered it wasn't recognised as a
 *  fresh user gesture. Neither GIS's callback nor error_callback ever fires
 *  in that case, so without this the whole flow (and the calling UI) hangs
 *  forever. Generous on purpose — a real consent flow (picking an account,
 *  entering a password, 2FA) can legitimately take a while. */
const OAUTH_TIMEOUT_MS = 60_000;
const GIS_LOAD_TIMEOUT_MS = 8_000;
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
const lsSyncedTs  = (uid = _state.userId) => `cadence_drive_synced_ts_${uid}`;
const lsHint      = (uid = _state.userId) => `cadence_drive_hint_${uid}`;
const lsOwner     = (uid = _state.userId) => `cadence_drive_owner_${uid}`;
const lsFailed    = (uid = _state.userId) => `cadence_drive_sync_failed_${uid}`;

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

/** Are there local edits that never made it to Drive? Derived from the two
 *  timestamps rather than in-memory state, so it survives a reload — which is
 *  the whole point: the tab that made the edits may be long gone. */
function hasUnsyncedChanges(uid = _state.userId): boolean {
  const local  = parseInt(localStorage.getItem(lsLocalTs(uid))  ?? '0');
  const synced = parseInt(localStorage.getItem(lsSyncedTs(uid)) ?? '0');
  return local > synced;
}

/** Call once per user open, before finishBoot. Reinitialises per-user Drive state. */
export function initDriveForUser(userId: string): void {
  if (_state.syncTimer)  { clearTimeout(_state.syncTimer);  }
  if (_state.retryTimer) { clearTimeout(_state.retryTimer); }
  // Reopening must not claim everything is safely in the cloud when it isn't:
  // the connected flag alone says nothing about whether the last edits were
  // ever pushed. Reconstruct the real state from the durable bookkeeping —
  // unsynced edits are 'pending', and 'error' if the last attempt also failed,
  // so a sync that died offline still looks wrong after a restart.
  const connected = localStorage.getItem(lsConnected(userId)) === '1';
  const unsynced  = connected && hasUnsyncedChanges(userId);
  _state = {
    userId,
    fileId:          localStorage.getItem(lsFileId(userId)),
    status:          !connected ? 'disconnected'
                   : !unsynced  ? 'connected'
                   : localStorage.getItem(lsFailed(userId)) === '1' ? 'error' : 'pending',
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
  localStorage.removeItem(lsSyncedTs(userId));
  localStorage.removeItem(lsHint(userId));
  localStorage.removeItem(lsOwner(userId));
  localStorage.removeItem(lsFailed(userId));
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

/** Chat apps' built-in browsers (WhatsApp, Instagram, Messenger, Line…) are
 *  known to block Google's OAuth consent screen — it shows as a blank/white
 *  screen with no error surfaced back to us. Since Cadence links circulate
 *  via WhatsApp, this is worth flagging proactively rather than waiting for
 *  a token request that may never resolve or reject. */
export function isLikelyInAppBrowser(): boolean {
  const ua = navigator.userAgent || '';
  if (/FBAN|FBAV|Instagram|Line\/|WhatsApp|Messenger/i.test(ua)) return true;
  // Generic Android WebView marker — catches other chat/social apps' in-app browsers.
  return /Android/.test(ua) && /; wv\)/.test(ua);
}

/** Sync base: `_lastModified` of the Drive content at the last moment local == Drive. */
function getSyncedTimestamp(): number {
  return parseInt(localStorage.getItem(lsSyncedTs()) ?? '0');
}

/** Record that local and Drive are identical at this content timestamp. */
export function markSynced(driveTs: number): void {
  localStorage.setItem(lsSyncedTs(), String(driveTs));
  localStorage.setItem(lsLocalTs(), String(driveTs));
  localStorage.removeItem(lsFailed());
}

/**
 * Re-arm the upload buffer after a reload that found unpushed local edits.
 * `pendingState` only ever lived in memory, so without this a restart leaves
 * flushSync() with nothing to send: the retry timer is gone, the manual sync
 * button is a no-op, and the edits sit local until some unrelated change
 * happens to call syncToCloud() again. Call it once the boot reconciliation
 * has decided local is the version to keep.
 */
export function resumePendingSync(state: AppState): void {
  if (!isDriveConnected() || !hasUnsyncedChanges() || _state.pendingState) return;
  _state.pendingState = state;
  setStatus(localStorage.getItem(lsFailed()) === '1' ? 'error' : 'pending');
  if (_state.syncTimer) clearTimeout(_state.syncTimer);
  _state.syncTimer = setTimeout(() => { _state.syncTimer = null; void flushSync(); }, 5_000);
}

/**
 * Three-way reconciliation between local state and the Drive copy, using the
 * last-synced timestamp as merge base:
 *  - Drive unchanged since base → keep local ('none'; a later flush uploads it)
 *  - Drive moved, local didn't  → safe fast-forward ('apply')
 *  - both moved                 → real divergence ('conflict', user decides)
 * Falls back to the device-id heuristic when no base was recorded yet
 * (pre-existing installs, fresh connects).
 */
export function reconcileDriveData(
  driveData: (AppState & { _lastModified?: number; _deviceId?: string }) | null,
): ReconcileResult {
  if (!driveData) return { action: 'none' };

  const driveTs     = driveData._lastModified ?? 0;
  const driveDevice = driveData._deviceId;
  const { _lastModified: _a, _deviceId: _b, ...clean } = driveData;
  const state      = clean as AppState;
  const localTs    = getLocalTimestamp();
  const syncedTs   = getSyncedTimestamp();
  const sameDevice = driveDevice === getDeviceId();

  if (syncedTs > 0) {
    const driveMoved = driveTs > syncedTs;
    const localMoved = localTs > syncedTs;
    if (!driveMoved) return { action: 'none' };
    if (!localMoved) return { action: 'apply', state, driveTs };
    // Same device writing on both sides means another tab of this browser —
    // the newer content wins, there is no cross-device divergence to arbitrate.
    if (sameDevice) return driveTs > localTs ? { action: 'apply', state, driveTs } : { action: 'none' };
    return { action: 'conflict', state, driveTs };
  }

  // No merge base yet: legacy heuristic (deviceId + timestamps).
  if (sameDevice) {
    return driveTs > localTs ? { action: 'apply', state, driveTs } : { action: 'none' };
  }
  if (localTs === 0) return { action: 'apply', state, driveTs };
  return { action: 'conflict', state, driveTs };
}

export function onStatusChange(cb: (s: DriveStatus) => void): () => void {
  listeners.push(cb);
  return () => { const i = listeners.indexOf(cb); if (i !== -1) listeners.splice(i, 1); };
}

const GIS_SCRIPT_ID = 'gis-client-script';

/** Injects the Google Identity Services script on first use rather than on every
 *  page load — most sessions never touch Drive at all, and there's no reason to
 *  ship a request to accounts.google.com for those. Idempotent: safe to call
 *  from every initDriveClient(). */
function loadGisScript(): void {
  if (document.getElementById(GIS_SCRIPT_ID)) return;
  const script = document.createElement('script');
  script.id = GIS_SCRIPT_ID;
  script.src = 'https://accounts.google.com/gsi/client';
  script.async = true;
  script.defer = true;
  document.head.appendChild(script);
}

export function initDriveClient(): Promise<void> {
  if (!GOOGLE_CLIENT_ID) return Promise.resolve();
  if (driveReady) return driveReady;
  loadGisScript();
  const ready = new Promise<void>((resolve) => {
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
  // Offline, the script never arrives and the poll above would spin forever —
  // leaving every caller awaiting a promise that never settles (a boot with no
  // network used to hang here silently, and a manual sync never even reached
  // its own error handling). Bound the wait, and drop the memo on failure so a
  // later attempt can retry once the network is back.
  driveReady = withTimeout(ready, GIS_LOAD_TIMEOUT_MS, 'gis_unavailable')
    .catch((e: Error) => { driveReady = null; throw e; });
  return driveReady;
}

function requestToken(prompt = ''): Promise<string> {
  const attempt = new Promise<string>((resolve, reject) => {
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
  return withTimeout(attempt, OAUTH_TIMEOUT_MS, 'oauth_timeout').catch((e: Error) => {
    // Neither callback will ever fire now — drop them so a very late,
    // unexpected resolution from the abandoned popup can't resurface.
    tokenClient.callback = null;
    tokenClient.error_callback = null;
    throw e;
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
    return reconcileDriveData(driveData);

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
  localStorage.removeItem(lsSyncedTs()); // merge base is meaningless once detached
  localStorage.removeItem(lsFailed());
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
    // Successful upload: local and Drive are identical again — new merge base.
    markSynced(ts);
    setStatus(_state.pendingState ? 'pending' : 'connected');
  } catch {
    _state.pendingState = _state.pendingState ?? state;
    // Persisted so the failure outlives the tab — otherwise a reload would
    // downgrade a known-failed sync to a merely-pending one (or, before the
    // status was derived from the timestamps at all, to a reassuring green).
    localStorage.setItem(lsFailed(), '1');
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
