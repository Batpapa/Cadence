import type { AppState } from '../types';
import { GOOGLE_CLIENT_ID } from '../config';
import { withTimeout } from '../utils';
import { decideReconcile } from './reconcilePolicy';

export type DriveStatus = 'disconnected' | 'connecting' | 'pending' | 'syncing' | 'connected' | 'error';

export type ReconcileResult =
  | { action: 'none' }
  | { action: 'apply';    state: AppState; driveTs: number; version: string }  // fast-forward from Drive
  | { action: 'conflict'; state: AppState; driveTs: number; version: string }; // both sides moved — ask the user

export type ConnectResult =
  | ReconcileResult
  | { action: 'wrong_account'; existingEmail: string; newEmail: string }
  // Another local user on this device already syncs with this same Google
  // account — both would bind to the same Drive file and overwrite each other.
  | { action: 'shared_account'; email: string };

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
const SYNC_DEBOUNCE_MS = 30_000;
/** Ceiling on the debounce: a steady edit stream (a long study session) keeps
 *  resetting the 30 s timer, so without this nothing would be pushed for the
 *  whole session — hours of work with no copy anywhere else. */
const MAX_PENDING_MS = 5 * 60_000;
const LS_DEVICE_ID  = 'cadence_device_id';
// Access tokens live in localStorage, not sessionStorage: they last about an
// hour, and Google's token model has no silent renewal — a new one can only be
// obtained from a user gesture. Keeping them per-tab meant every single app
// launch had to raise a consent window. Surviving a restart turns that into at
// most one window per hour. The trade-off is XSS exposure, bounded by the
// `drive.file` scope: only files Cadence itself created are reachable.
const LS_TOKEN      = 'cadence_access_token';
const LS_EXPIRES_AT = 'cadence_token_expires_at';
/** Which Google account the stored token belongs to — a device with two local
 *  users on two Google accounts must not reuse one's token for the other. */
const LS_TOKEN_OWNER = 'cadence_token_owner';

/** Thrown when a token is needed but this particular path may not raise a
 *  window (the tab is being hidden, or an automatic prompt was already
 *  declined). Not an error to report — the cloud button turns yellow. */
const NEEDS_AUTH = 'needs_auth';
/** Thrown when a token *was* asked for and the attempt failed — window blocked,
 *  closed, denied, timed out. Distinct from a network error, because it is the
 *  one that must stop the automatic paths from asking on a loop. */
const AUTH_FAILED = 'auth_failed';

/** An automatic (non-clicked) token request has already failed once. Until
 *  something changes — a granted token, a click, a fresh boot — the timers stop
 *  asking, so a declined window doesn't come back every 30 seconds. That was
 *  literally the "la fenêtre s'affiche très souvent" complaint. */
let autoPromptFailed = false;

// ── Per-user state ────────────────────────────────────────────────────────────

interface DriveUserState {
  userId:         string;
  fileId:         string | null;
  status:         DriveStatus;
  syncTimer:      ReturnType<typeof setTimeout> | null;
  retryTimer:     ReturnType<typeof setTimeout> | null;
  pendingState:   AppState | null;
  flushInProgress: boolean;
  /** When the OLDEST currently-unpushed edit happened — anchors the debounce ceiling. */
  firstPendingAt: number | null;
}

let _state: DriveUserState = {
  userId: '', fileId: null, status: 'disconnected',
  syncTimer: null, retryTimer: null, pendingState: null, flushInProgress: false,
  firstPendingAt: null,
};

// Key helpers — accept an explicit userId for cross-user operations (e.g. clear on delete).
const lsFileId    = (uid = _state.userId) => `cadence_drive_file_id_${uid}`;
const lsConnected = (uid = _state.userId) => `cadence_drive_connected_${uid}`;
const lsLocalTs   = (uid = _state.userId) => `cadence_local_modified_${uid}`;
const lsSyncedTs  = (uid = _state.userId) => `cadence_drive_synced_ts_${uid}`;
const lsHint      = (uid = _state.userId) => `cadence_drive_hint_${uid}`;
const lsOwner     = (uid = _state.userId) => `cadence_drive_owner_${uid}`;
const lsFailed    = (uid = _state.userId) => `cadence_drive_sync_failed_${uid}`;
// ── 2026-08-31 redesign (see reconcilePolicy.ts for the trust model) ──
/** Drive's server-side file `version` at the last sync point — the exact,
 *  clock-free answer to "has Drive moved since we last agreed?". */
const lsSyncedVersion = (uid = _state.userId) => `cadence_drive_synced_version_${uid}`;
/** Local edit counter and its value at the last sync point — the exact,
 *  clock-free answer to "has local moved since we last agreed?". */
const lsEditSeq   = (uid = _state.userId) => `cadence_edit_seq_${uid}`;
const lsSyncedSeq = (uid = _state.userId) => `cadence_synced_seq_${uid}`;

function getSyncedVersion(): string | null { return localStorage.getItem(lsSyncedVersion()); }
function getEditSeq(uid = _state.userId): number { return parseInt(localStorage.getItem(lsEditSeq(uid)) ?? '0'); }
function getSyncedSeq(uid = _state.userId): number { return parseInt(localStorage.getItem(lsSyncedSeq(uid)) ?? '0'); }
function bumpEditSeq(): void { localStorage.setItem(lsEditSeq(), String(getEditSeq() + 1)); }

/** An explicit user arbitration ("keep local" on the conflict modal) makes the
 *  version the user just LOOKED AT the new base, so the follow-up push's
 *  precondition passes over exactly the content that was arbitrated — while a
 *  third write landing in between still fails it and re-raises the question. */
export function adoptDriveVersionAsBase(version: string): void {
  localStorage.setItem(lsSyncedVersion(), version);
}

// ── Session-level state (shared across users in the same tab) ─────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Gis = any;

let tokenClient:    Gis    = null;
let driveReady:     Promise<void> | null = null;
let accessToken:    string | null = localStorage.getItem(LS_TOKEN);
let tokenExpiresAt: number = parseInt(localStorage.getItem(LS_EXPIRES_AT) ?? '0');

const listeners: Array<(s: DriveStatus) => void> = [];

function setStatus(s: DriveStatus): void {
  _state.status = s;
  for (const cb of listeners) cb(s);
}

function clearStoredToken(): void {
  accessToken = null;
  tokenExpiresAt = 0;
  localStorage.removeItem(LS_TOKEN);
  localStorage.removeItem(LS_EXPIRES_AT);
  localStorage.removeItem(LS_TOKEN_OWNER);
}

function hasValidToken(): boolean {
  return !!accessToken && Date.now() < tokenExpiresAt;
}

let reconcileHook: ((interactive: boolean) => Promise<boolean>) | null = null;

/** Registered by main.ts (which owns the apply/conflict UI this can't import).
 *  Resolves true only when the reconciliation concluded that local is the
 *  version to keep — i.e. the one case where pushing it up is correct. The
 *  `interactive` flag propagates down to the token request: a background
 *  flush (visibilitychange) must never raise a consent window from here. */
export function setReconcileHook(fn: (interactive: boolean) => Promise<boolean>): void { reconcileHook = fn; }

/** True while the conflict modal is on screen. Freezes every flush path: the
 *  user is arbitrating, and a background push (the visibilitychange flush was
 *  the culprit) would answer in their place — and then be silently reverted by
 *  their answer, losing whichever side it had pushed. */
let conflictPending = false;
export function setConflictPending(b: boolean): void { conflictPending = b; }

/** Drop the buffered upload — its contents no longer match what the user sees
 *  (Drive's version was just applied over it). */
export function discardPendingSync(): void { _state.pendingState = null; }

/** Boot could not read Drive. Local may be behind another device, so don't
 *  leave the cloud reassuringly green — an edit made now is precisely what
 *  turns "behind" into a divergence someone has to arbitrate. */
export function markReconcileFailed(): void {
  if (!isDriveConnected()) return;
  if (_state.status === 'connected') setStatus('error');
}

/** Are there local edits that never made it to Drive? Derived from the durable
 *  edit counters rather than in-memory state, so it survives a reload — which
 *  is the whole point: the tab that made the edits may be long gone. (Counters,
 *  not the old timestamps: a successful upload used to rewind the local stamp
 *  over edits made DURING the upload, silently marking them synced.) */
function hasUnsyncedChanges(uid = _state.userId): boolean {
  return getEditSeq(uid) > getSyncedSeq(uid);
}

/** Call once per user open, before finishBoot. Reinitialises per-user Drive state. */
export function initDriveForUser(userId: string): void {
  if (_state.syncTimer)  { clearTimeout(_state.syncTimer);  }
  if (_state.retryTimer) { clearTimeout(_state.retryTimer); }
  // Now that the token outlives the tab, opening a *different* local user must
  // not inherit the previous one's authorisation: two people on one device may
  // well be on two Google accounts, and the token decides whose Drive is written.
  const owner      = localStorage.getItem(lsOwner(userId));
  const tokenOwner = localStorage.getItem(LS_TOKEN_OWNER);
  if (owner && tokenOwner && owner !== tokenOwner) clearStoredToken();
  // Seed the edit counters for installs predating them (2026-08-31), keeping
  // the one bit the old timestamp bookkeeping carried: "unsynced edits exist".
  if (localStorage.getItem(lsEditSeq(userId)) === null) {
    const local  = parseInt(localStorage.getItem(lsLocalTs(userId))  ?? '0');
    const synced = parseInt(localStorage.getItem(lsSyncedTs(userId)) ?? '0');
    localStorage.setItem(lsEditSeq(userId), local > synced ? '1' : '0');
    localStorage.setItem(lsSyncedSeq(userId), '0');
  }
  // Reopening must not claim everything is safely in the cloud when it isn't:
  // the connected flag alone says nothing about whether the last edits were
  // ever pushed. Reconstruct the real state from the durable bookkeeping —
  // unsynced edits are 'pending', and 'error' if the last attempt also failed,
  // so a sync that died offline still looks wrong after a restart.
  autoPromptFailed = false; // a fresh boot may prompt again
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
    firstPendingAt:  null,
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
  localStorage.removeItem(lsSyncedVersion(userId));
  localStorage.removeItem(lsEditSeq(userId));
  localStorage.removeItem(lsSyncedSeq(userId));
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

/** Record a sync point: local and Drive agreed on this content.
 *  `version` null = the upload succeeded but its response didn't yield the new
 *  file version — drop the base so the next flush re-reads before pushing
 *  (safe direction) instead of trusting a stale one.
 *  `syncedSeq` = the edit counter FOR THE CONTENT THAT WAS SYNCED — captured
 *  before an upload starts, so edits made during it stay counted as unsynced. */
function recordSyncPoint(driveTs: number, version: string | null, syncedSeq: number): void {
  localStorage.setItem(lsSyncedTs(), String(driveTs));
  // Never move the local stamp backwards: edits made while an upload was in
  // flight are newer than the upload's timestamp.
  localStorage.setItem(lsLocalTs(), String(Math.max(getLocalTimestamp(), driveTs)));
  localStorage.setItem(lsSyncedSeq(), String(syncedSeq));
  if (version !== null) localStorage.setItem(lsSyncedVersion(), version);
  else localStorage.removeItem(lsSyncedVersion());
  localStorage.removeItem(lsFailed());
}

/** After Drive's copy was applied locally: local now IS the Drive content, so
 *  nothing is unsynced — the current edit counter becomes the sync point. */
export function markSyncedAfterApply(driveTs: number, version: string): void {
  recordSyncPoint(driveTs, version, getEditSeq());
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
  _state.firstPendingAt ??= Date.now();
  setStatus(localStorage.getItem(lsFailed()) === '1' ? 'error' : 'pending');
  if (_state.syncTimer) clearTimeout(_state.syncTimer);
  _state.syncTimer = setTimeout(() => { _state.syncTimer = null; void flushSync(autoMayPrompt()); }, 5_000);
}

/** Three-way reconciliation between local state and a Drive read. The whole
 *  decision table lives in reconcilePolicy.ts (pure, exhaustively unit-tested);
 *  this only feeds it from the durable bookkeeping and applies its verdict. */
export function reconcileDriveData(read: DriveFileRead): ReconcileResult {
  const driveTs = read.status === 'ok' ? (read.data._lastModified ?? 0) : 0;
  const decision = decideReconcile({
    hasData:       read.status === 'ok',
    driveTs,
    driveVersion:  read.version,
    syncedVersion: getSyncedVersion(),
    syncedTs:      getSyncedTimestamp(),
    localTs:       getLocalTimestamp(),
    editSeq:       getEditSeq(),
    syncedSeq:     getSyncedSeq(),
  });
  // Legacy install proven in sync content-wise: graduate to version-based
  // tracking on the spot — this is the no-op path virtually every existing
  // install takes on its first boot after this deploy.
  if (decision.adoptVersion) localStorage.setItem(lsSyncedVersion(), read.version);
  if (decision.action === 'none' || read.status !== 'ok') return { action: 'none' };
  const { _lastModified: _a, _deviceId: _b, ...clean } = read.data;
  return { action: decision.action, state: clean as AppState, driveTs, version: read.version };
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
      localStorage.setItem(LS_TOKEN, accessToken);
      localStorage.setItem(LS_EXPIRES_AT, String(tokenExpiresAt));
      const owner = localStorage.getItem(lsOwner());
      if (owner) localStorage.setItem(LS_TOKEN_OWNER, owner);
      resolve(accessToken);
    };
    tokenClient.error_callback = (err: Gis) => {
      cleanup();
      reject(new Error(err.type ?? 'popup_closed'));
    };
    // `login_hint`, not the older `hint` (deprecated in TokenClientConfig):
    // this is the parameter Google documents as skipping account selection,
    // and the app was passing the superseded spelling.
    const loginHint = localStorage.getItem(lsHint()) ?? undefined;
    tokenClient.requestAccessToken({ prompt, ...(loginHint ? { login_hint: loginHint } : {}) });
  });
  return withTimeout(attempt, OAUTH_TIMEOUT_MS, 'oauth_timeout').catch((e: Error) => {
    // Neither callback will ever fire now — drop them so a very late,
    // unexpected resolution from the abandoned popup can't resurface.
    tokenClient.callback = null;
    tokenClient.error_callback = null;
    throw e;
  });
}

/**
 * Google's token model has no silent renewal: obtaining a token opens a window.
 * Syncing must still be something users get for free rather than something they
 * have to remember to trigger, so the automatic paths DO ask — boot and the
 * post-edit timer both pass `interactive`. With the token now surviving in
 * localStorage for its full hour, the common case needs no window at all.
 *
 * The one thing that must not happen is asking again and again: see
 * `autoPromptFailed`. And `visibilitychange` stays silent — raising a window
 * as the user leaves the tab helps nobody.
 */
async function getToken(interactive: boolean): Promise<string> {
  if (hasValidToken()) return accessToken!;
  if (!interactive) throw new Error(NEEDS_AUTH);
  clearStoredToken();
  await initDriveClient();
  try {
    const tok = await requestToken('');
    autoPromptFailed = false;     // it worked — automatic paths may ask again
    return tok;
  } catch (e) {
    // Distinguishable from a network failure so the caller can decide whether
    // to keep prompting; a declined or blocked window must not become a loop.
    throw new Error(`${AUTH_FAILED}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function driveRequest(url: string, options: RequestInit = {}, interactive = false): Promise<Response> {
  const doFetch = (tok: string) => fetch(url, {
    ...options,
    headers: { ...(options.headers as Record<string, string> ?? {}), Authorization: `Bearer ${tok}` },
  });
  const resp = await doFetch(await getToken(interactive));
  if (resp.status === 401) {
    clearStoredToken();
    // A token rejected mid-flight needs a fresh one, which needs a gesture.
    if (!interactive) throw new Error(NEEDS_AUTH);
    return doFetch(await requestToken(''));
  }
  return resp;
}

/** Only ever runs from connectDrive(), i.e. behind a button — interactive.
 *  `created` matters: a file we just created is empty BY CONSTRUCTION, so
 *  local may push without reading it — whereas a *found* file holds someone's
 *  data, and failing to read it must abort the connect, never default to
 *  "push local over it". */
async function findOrCreateFile(): Promise<{ id: string; created: boolean }> {
  const q = encodeURIComponent(`name='${FILE_NAME}' and trashed=false`);
  const search = await driveRequest(
    `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id)&spaces=drive`, {}, true
  );
  const data = await search.json() as { files?: Array<{ id: string }> };
  if (data.files?.length) return { id: data.files[0]!.id, created: false };
  const create = await driveRequest('https://www.googleapis.com/drive/v3/files', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: FILE_NAME, mimeType: 'application/json' }),
  }, true);
  return { id: ((await create.json()) as { id: string }).id, created: true };
}

export async function connectDrive(allowSharedAccount = false): Promise<ConnectResult> {
  await initDriveClient();
  if (!tokenClient) throw new Error('Drive client not ready');
  setStatus('connecting');
  // A (re)connect starts from zero: whatever merge base or failure flag might
  // linger from a previous connection is void — the Drive file may have been
  // reverted, replaced, or written by anything while we were detached, and a
  // stale base would let the timestamp logic silently pick a side (2026-08-31:
  // this is exactly how a user lost hours — see the decision below).
  localStorage.removeItem(lsSyncedTs());
  localStorage.removeItem(lsSyncedVersion());
  localStorage.removeItem(lsFailed());
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
      clearStoredToken();
      setStatus('disconnected');
      return { action: 'wrong_account', existingEmail: localStorage.getItem(lsHint()) ?? '', newEmail: email };
    }

    // The Drive file is looked up by a constant name within this account, so
    // two local users syncing with the SAME Google account would bind to the
    // SAME file and wholesale-overwrite each other. Surface it before binding
    // anything; the user may still insist (allowSharedAccount).
    if (!allowSharedAccount && googleId) {
      const ownerPrefix = 'cadence_drive_owner_';
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i)!;
        if (!key.startsWith(ownerPrefix)) continue;
        const uid = key.slice(ownerPrefix.length);
        if (uid === _state.userId) continue;
        if (localStorage.getItem(key) === googleId && localStorage.getItem(lsConnected(uid)) === '1') {
          setStatus('disconnected');
          return { action: 'shared_account', email };
        }
      }
    }

    if (email)    localStorage.setItem(lsHint(), email);
    if (googleId) {
      localStorage.setItem(lsOwner(), googleId);
      // The token was obtained before the owner was known (first connect), so
      // stamp it here too — otherwise the cross-account guard in
      // initDriveForUser has nothing to compare against for this very token.
      localStorage.setItem(LS_TOKEN_OWNER, googleId);
    }

    const { id: fileId, created } = await findOrCreateFile();
    _state.fileId = fileId;
    localStorage.setItem(lsFileId(), _state.fileId);
    localStorage.setItem(lsConnected(), '1');

    // Just-created file: empty by construction, nothing to read or arbitrate —
    // local is the only copy and the connect flow pushes it.
    if (created) { setStatus('connected'); return { action: 'none' }; }

    // A FOUND file must be read; readDriveFile throws if it can't be (pushing
    // over data nobody has seen would erase it), and reports an unparseable
    // husk as 'empty' (looked, nothing usable — local may push, Drive's
    // revision history keeps the husk anyway).
    const file = await readDriveFile(true);
    setStatus('connected');
    // Deliberately NOT reconcileDriveData: connecting must behave as if this
    // device had never been connected. Across a disconnect gap, no bookkeeping
    // comparison holds — the file may since have been reverted to an older
    // revision, which is exactly what the user may be trying to make win. So:
    // if both sides hold anything, it is always the user's call — force the
    // conflict modal. The only two cases decided here are the ones with
    // genuinely nothing to arbitrate: an empty Drive (keep local, the connect
    // flow pushes it) and a never-modified local (take Drive's).
    if (file.status === 'empty') return { action: 'none' };
    const { _lastModified, _deviceId: _dev, ...clean } = file.data;
    const driveTs = _lastModified ?? 0;
    const state = clean as AppState;
    if (getLocalTimestamp() === 0 && getEditSeq() === 0) return { action: 'apply', state, driveTs, version: file.version };
    return { action: 'conflict', state, driveTs, version: file.version };

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
    clearStoredToken();
  }
  _state.fileId = null;
  localStorage.removeItem(lsFileId());
  localStorage.removeItem(lsConnected());
  localStorage.removeItem(lsHint());
  localStorage.removeItem(lsSyncedTs());      // merge bases are void once detached:
  localStorage.removeItem(lsSyncedVersion()); // the file may be reverted/replaced meanwhile
  localStorage.removeItem(lsFailed());
  setStatus('disconnected');
}

async function flushSync(interactive = false): Promise<void> {
  // The user is arbitrating a conflict: NOTHING may push. A background flush
  // here used to answer in their place — and then be silently reverted by
  // their answer, losing whichever side it had pushed.
  if (conflictPending) return;
  if (!_state.fileId || !_state.pendingState || _state.flushInProgress) return;
  if (_state.retryTimer) { clearTimeout(_state.retryTimer); _state.retryTimer = null; }
  _state.flushInProgress = true;
  // Consumed only once the push is committed to — restored by the catch if the
  // upload itself fails, untouched when we bail out before it.
  let consumed: AppState | null = null;
  try {
    // ── Precondition: never overwrite a Drive nobody has looked at. ──
    // A push is a WHOLE-FILE replacement, so it is only safe over content we
    // can prove is our own last sync point: Drive's server-side version must
    // equal the recorded base. Anything else — no base (fresh connect,
    // pre-redesign install), or a version moved by another device/tab/session,
    // however long ago this session last looked — goes through a full
    // reconciliation first, and only "local is the version to keep" may
    // proceed to push. This runs on EVERY flush: a session's age no longer
    // buys it the right to overwrite blind (a tab left open overnight was
    // exactly how a user lost hours of work).
    const base = getSyncedVersion();
    const mustReconcile = base === null || (await getDriveVersion(interactive)) !== base;
    if (mustReconcile) {
      if (!reconcileHook) return;        // registered at boot; nothing sane to do without it
      const localWins = await reconcileHook(interactive);
      // 'apply' replaced what the buffer holds; 'conflict' means the user is
      // mid-decision (conflictPending now blocks re-entry) — either way the
      // buffered state must not be pushed.
      if (!localWins) return;
      if (!_state.pendingState) return;  // the reconciliation may have cleared it
    }

    consumed = _state.pendingState;
    if (!consumed) return;
    const seq = getEditSeq();            // counter for the content being pushed, captured NOW:
    _state.pendingState = null;          // edits landing during the upload stay counted as unsynced
    setStatus('syncing');

    const ts = Date.now();
    const { id: _id, ...stateWithoutId } = consumed;
    // _lastModified/_deviceId still stamped: clients running the pre-redesign
    // code read them, and the transitional reconcile path does too.
    const payload = JSON.stringify({ ...stateWithoutId, _lastModified: ts, _deviceId: getDeviceId() });
    const resp = await driveRequest(
      `https://www.googleapis.com/upload/drive/v3/files/${_state.fileId}?uploadType=media&fields=version`,
      { method: 'PATCH', body: payload, headers: { 'Content-Type': 'application/json' } },
      interactive,
    );
    if (!resp.ok) throw new Error(`upload failed: ${resp.status}`);
    // The response carries the file's post-write version — the next flush's
    // precondition. If it can't be parsed, record no base: the next flush then
    // re-reads before pushing (safe), instead of trusting a stale one.
    let version: string | null = null;
    try {
      const v = ((await resp.json()) as { version?: string | number }).version;
      version = v != null ? String(v) : null;
    } catch { /* keep null */ }
    recordSyncPoint(ts, version, seq);
    _state.firstPendingAt = _state.pendingState ? Date.now() : null;
    setStatus(_state.pendingState ? 'pending' : 'connected');
  } catch (e) {
    if (consumed && !_state.pendingState) _state.pendingState = consumed;
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === NEEDS_AUTH || msg.startsWith(AUTH_FAILED)) {
      // Authorisation, not a sync failure: the data is safe locally, we just
      // don't have a usable token. Stay yellow — the cloud button reads as
      // "click to sync" — and don't persist a failure flag.
      if (msg.startsWith(AUTH_FAILED)) autoPromptFailed = true;
      setStatus('pending');
      return;                            // no timer retry: it would only re-ask
    }
    // Persisted so the failure outlives the tab — otherwise a reload would
    // downgrade a known-failed sync to a merely-pending one (or, before the
    // status was derived from the bookkeeping at all, to a reassuring green).
    localStorage.setItem(lsFailed(), '1');
    setStatus('error');
    _state.retryTimer = setTimeout(() => { _state.retryTimer = null; void flushSync(autoMayPrompt()); }, 30_000);
  } finally {
    _state.flushInProgress = false;
  }
}

/** Automatic paths ask for a token as readily as a click does — syncing should
 *  not be something users have to remember to do. The one exception is after an
 *  automatic prompt has already been declined or blocked, so it isn't reopened
 *  every 30 seconds. */
const autoMayPrompt = () => !autoPromptFailed;

// TODO(2026-08-31): two tabs of the same browser still diverge silently until
// one of them pushes — the divergence now SURFACES as a conflict instead of
// being silently "resolved" by wall-clock order, but it still happens. A
// BroadcastChannel "state changed — reload from IndexedDB" between tabs would
// remove it at the source. Deliberately postponed.
export function syncToCloud(state: AppState): void {
  const now = Date.now();
  localStorage.setItem(lsLocalTs(), String(now));
  bumpEditSeq();
  if (!isDriveConnected()) return;
  _state.pendingState = state;
  _state.firstPendingAt ??= now;
  setStatus('pending');
  if (_state.syncTimer) clearTimeout(_state.syncTimer);
  // Debounced — but never past MAX_PENDING_MS after the oldest unpushed edit.
  const delay = Math.max(0, Math.min(SYNC_DEBOUNCE_MS, _state.firstPendingAt + MAX_PENDING_MS - now));
  _state.syncTimer = setTimeout(() => { _state.syncTimer = null; void flushSync(autoMayPrompt()); }, delay);
}

/** The header's cloud button. A click clears any earlier refusal: the user is
 *  explicitly asking, so the automatic paths get to try again afterwards too. */
export async function manualSync(): Promise<void> {
  if (_state.syncTimer)  { clearTimeout(_state.syncTimer);  _state.syncTimer  = null; }
  if (_state.retryTimer) { clearTimeout(_state.retryTimer); _state.retryTimer = null; }
  autoPromptFailed = false;
  await flushSync(true);
}

export function initDriveVisibilitySync(): void {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && _state.pendingState) {
      if (_state.syncTimer) { clearTimeout(_state.syncTimer); _state.syncTimer = null; }
      void flushSync();
    }
  });
}

export type DriveFileRead =
  | { status: 'ok';    data: AppState & { _lastModified?: number; _deviceId?: string }; version: string }
  // The file exists but holds nothing parseable — the empty husk of an
  // interrupted first connect. Distinct from a FAILED read, which throws:
  // "looked and found nothing usable" may let local win; "never got to look"
  // must never.
  | { status: 'empty'; version: string };

/** Drive's server-side `version` for our file — a monotonic write counter,
 *  the clock-free ground truth for "has anyone written since we last agreed?". */
async function getDriveVersion(interactive: boolean): Promise<string> {
  if (!_state.fileId) throw new Error('drive_unreadable');
  const resp = await driveRequest(
    `https://www.googleapis.com/drive/v3/files/${_state.fileId}?fields=version`, {}, interactive
  );
  if (!resp.ok) throw new Error(`drive_unreadable: version ${resp.status}`);
  const version = ((await resp.json()) as { version?: string | number }).version;
  if (version == null || version === '') throw new Error('drive_unreadable: no version');
  return String(version);
}

/** The one read primitive: version + content, or a throw. `interactive` at
 *  boot: page load is the one moment Google's flow tolerates a token request
 *  without a click. Elsewhere (a background flush) leave it false.
 *
 *  Version is fetched BEFORE the content on purpose: if a write lands between
 *  the two requests, we hold content NEWER than the recorded version, and the
 *  next precondition check simply re-reads — the safe direction. The reverse
 *  order could pair a new version with old content and mask a write. */
export async function readDriveFile(interactive = false): Promise<DriveFileRead> {
  if (!_state.fileId) throw new Error('drive_unreadable');
  const version = await getDriveVersion(interactive);
  const resp = await driveRequest(`https://www.googleapis.com/drive/v3/files/${_state.fileId}?alt=media`, {}, interactive);
  if (!resp.ok) throw new Error(`drive_unreadable: content ${resp.status}`);
  let data: unknown = null;
  // A truncated/corrupt body is 'empty' (looked, nothing usable), never
  // silently conflated with a FAILED read — those throw above, before the
  // parse, and keep their "never got to look" meaning.
  try { data = await resp.json(); } catch { /* husk or corrupt — 'empty' below */ }
  if (!data || typeof data !== 'object') return { status: 'empty', version };
  return { status: 'ok', data: data as AppState & { _lastModified?: number; _deviceId?: string }, version };
}
