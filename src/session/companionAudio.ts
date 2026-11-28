import { signal } from '@preact/signals';
import type { SyncedAudio } from './model';
import { onNetworkChange, onUnmeteredNetwork } from './network';
import { userKey, type UserKey } from '../userLocalKeys';
import { bootSettled } from '../bootSettled';

// ── A module's recordings, on this device and on Drive ───────────────────────
// Written for the analyser (session/db.ts, where every rule below was learnt,
// most of them the hard way) and made common on 2026-11-28 for the
// Transcription module, whose recordings go to Drive the same way (the user:
// "comme l'analyse"). One instance per module, each with its own local
// database, its own records on the synced state, its own name for the files
// on Drive and its own per-device lists — what one module has sent or freed
// says nothing about the other's. The code is one: a rule fixed here is fixed
// for both.
//
// The recording always lives in this device's local database. It may ALSO have
// been copied to the user's Drive as a file of its own (model.ts's SyncedAudio),
// which is what makes it playable on their other devices.
//
// The two are not alternatives, they are a cache and a durable copy: uploading
// never removes the local blob, and downloading on another device stores one.
// So no step below can leave a recording existing nowhere, which is the property
// that really matters here — recordings are irreplaceable.
//
// Downloads are never a side effect of READING: a recording is tens of
// megabytes and opening a page must not spend them, so `load` never reaches
// for the network. They happen when asked — a button, a passage played from a
// card — or, since 2026-10-09, in the background when this device was told to
// bring everything here (audioDownloads.ts). All of them go through `fetch`.
//
// store.ts and driveService are imported lazily, for session/db.ts's reason
// (its storeModule): they read sessionStorage at evaluation, which a test
// importing this without them would trip over.

function storeModule(): Promise<typeof import('../store')> {
  return import('../store');
}

function driveModule(): Promise<typeof import('../services/driveService')> {
  return import('../services/driveService');
}

/** Just enough of AppState to find a module's data. */
export interface AppStateLike { modules?: Record<string, unknown> }

/** What a module tells the common code about itself. */
export interface CompanionAudioHost {
  /** The logs' tag: '[sessions]'. */
  log: string;
  /** The user this module's local database is open for. */
  userId: () => string | null;
  /** That database's recordings, by record id. */
  local: {
    get: (id: string) => Promise<Blob | undefined>;
    put: (id: string, blob: Blob) => Promise<void>;
    delete: (id: string) => Promise<void>;
    keys: () => Promise<string[]>;
  };
  /** The Drive copies the synced state records, by record id. */
  synced: (user: AppStateLike) => Readonly<Record<string, SyncedAudio>> | undefined;
  /** Records one Drive copy — inside mutate(), the module's slice created when
   *  absent. */
  record: (user: AppStateLike, id: string, entry: SyncedAudio) => void;
  /** Drops the records of `ids` — inside mutate(), the map removed once
   *  empty; nothing created. */
  drop: (user: AppStateLike, ids: string[]) => void;
  /** Every record of the module (analyses, transcriptions), finished ones only. */
  ids: (user: AppStateLike) => string[];
  /** What orders them, the latest first: compared as strings. */
  recency: (user: AppStateLike, id: string) => string;
  /** The type a record says its recording has, for a blob that says none. */
  mimeType: (id: string) => Promise<string | undefined>;
  /** Whether new recordings are copied to Drive (the module's synced choice). */
  syncByDefault: (user: AppStateLike) => boolean;
  /** The file's name on Drive — the record's id in it, so that an orphan can
   *  be traced back (services/driveOrphans.ts reads it). */
  fileName: (id: string, mimeType: string) => string;
  /** This device's lists and choice, per user (userLocalKeys.ts). */
  keys: { wanted: UserKey; freed: UserKey; wifiOnly: UserKey };
  /** A copy just landed on Drive. */
  onUploaded?: (id: string) => void;
}

/** What Drive says about a recording's copy, asked without fetching it.
 *  `needsAuth`: no token, and this was not asked from a click — GIS cannot
 *  renew one silently. */
export type SyncedAudioProbe =
  | { status: 'ok'; bytes: number }
  | { status: 'gone' }
  | { status: 'needsAuth' }
  | { status: 'offline' };

/** Where each recording's automatic upload stands, for a page's cloud and the
 *  settings: 'uploading' while one runs, 'wifi' while held until this device is
 *  on Wi-Fi, 'waiting' once one has failed and will be tried again. Absent
 *  otherwise. */
export type AutoUploadState = 'uploading' | 'waiting' | 'wifi';

export type CompanionAudio = ReturnType<typeof companionAudio>;

/** The audio extension a recording carries on Drive, from its type. */
export function audioExtensionFor(mimeType: string): string {
  if (mimeType.includes('mp4')) return 'm4a';
  if (mimeType.includes('ogg')) return 'ogg';
  if (mimeType.includes('mpeg')) return 'mp3';
  return 'webm';
}

export function companionAudio(host: CompanionAudioHost) {
  const { log } = host;

  const syncedNow = async (): Promise<Readonly<Record<string, SyncedAudio>>> => {
    const { appState } = await storeModule();
    return host.synced(appState.value) ?? {};
  };

  /** Whether this recording is on Drive as well as on this device. */
  async function isSynced(id: string): Promise<boolean> {
    return !!(await syncedNow())[id];
  }

  async function syncedOf(id: string): Promise<SyncedAudio | undefined> {
    return (await syncedNow())[id];
  }

  async function syncByDefault(): Promise<boolean> {
    const { appState } = await storeModule();
    return host.syncByDefault(appState.value);
  }

  async function recordSynced(id: string, entry: SyncedAudio): Promise<void> {
    const { mutate } = await storeModule();
    await mutate(user => host.record(user, id, entry));
  }

  /** Drops the Drive record, and sends the Drive file to the user's trash unless
   *  `fileAlreadyGone` — which is the 404 case, where doing it again would be
   *  noise. The trash rather than a deletion since 2026-10-01: a snapshot, here
   *  or on another device, may still hold the record, and for thirty days the
   *  recording stays within reach of it. */
  async function dropSynced(id: string, fileAlreadyGone = false): Promise<void> {
    const entry = await syncedOf(id);
    if (!entry) return;
    if (!fileAlreadyGone) await (await driveModule()).trashCompanionFile(entry.fileId);
    const { mutate } = await storeModule();
    await mutate(user => host.drop(user, [id]));
  }

  // ── This device's lists ─────────────────────────────────────────────────────

  /** A set of record ids this DEVICE keeps about one of its users, in
   *  localStorage — never in the synced state, since what one device has sent or
   *  freed says nothing about another. Per user: one device can hold several,
   *  each with its own Drive. */
  function deviceIdList(name: UserKey) {
    const key = () => { const uid = host.userId(); return uid ? userKey(name, uid) : null; };
    const read = (): string[] => {
      const k = key();
      if (!k) return [];
      try {
        const ids = JSON.parse(localStorage.getItem(k) ?? '[]') as unknown;
        return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : [];
      } catch { return []; }
    };
    const set = (id: string, on: boolean): void => {
      const k = key();
      if (!k) return;
      const ids = read().filter(x => x !== id);
      if (on) ids.push(id);
      try {
        if (ids.length) localStorage.setItem(k, JSON.stringify(ids));
        else localStorage.removeItem(k);
      } catch { /* storage refused: nothing here is the only copy of anything */ }
    };
    return { read, set };
  }

  // ── Wi-Fi only, for the automatic copy (2026-10-09) ────────────────────────
  // Per device and per user, like the download side's (audioDownloads.ts): a
  // phone has a data plan, the computer of the same person does not. Unlike
  // there, the default is to send on any network — that copy is what keeps a
  // recording safe, and it always went out at once before this choice existed.

  const uploadOnWifiOnly = signal(false);

  function readUploadWifiOnly(): void {
    const uid = host.userId();
    try { uploadOnWifiOnly.value = !!uid && localStorage.getItem(userKey(host.keys.wifiOnly, uid)) === '1'; }
    catch { uploadOnWifiOnly.value = false; }
  }

  function setUploadOnWifiOnly(wifiOnly: boolean): void {
    uploadOnWifiOnly.value = wifiOnly;
    const uid = host.userId();
    if (uid) {
      try { localStorage.setItem(userKey(host.keys.wifiOnly, uid), wifiOnly ? '1' : '0'); } catch { /* this page's life */ }
    }
    publishUploadState();
    void retryWantedUploads();
  }

  function uploadHeldForWifi(): boolean {
    return uploadOnWifiOnly.value && !onUnmeteredNetwork();
  }

  // ── Automatic uploads that failed, tried again (2026-10-09) ────────────────
  // A user found three recordings that had never reached Drive, weeks later
  // (2026-10-08). The automatic upload after a recording was fired once: a
  // network error was logged and forgotten, and only a missing token was waited
  // out — in memory, so not past a restart either. Nothing was lost, the
  // recordings were on the phone; but the copy that protects them against the
  // browser wiping its storage was quietly not there.
  //
  // So the automatic uploads this device wanted are written down, per user, and
  // stay written down until one goes through: tried again at launch, when the
  // network comes back, when the app returns to the foreground, and when a token
  // arrives. Only those — never the backlog of recordings that predate the
  // option or Drive itself, which stays the backlog button's job (an explicit
  // consent: it can be gigabytes on someone's data plan).

  const uploadsWanted = deviceIdList(host.keys.wanted);
  const readWanted = uploadsWanted.read;

  const autoUploadState = signal<Readonly<Record<string, AutoUploadState>>>({});
  const _uploading = new Set<string>();

  function publishUploadState(): void {
    const next: Record<string, AutoUploadState> = {};
    const held = uploadHeldForWifi();
    for (const id of readWanted()) next[id] = held ? 'wifi' : 'waiting';
    for (const id of _uploading) if (next[id]) next[id] = 'uploading';
    autoUploadState.value = next;
  }

  function markUploadWanted(id: string, on: boolean): void {
    uploadsWanted.set(id, on);
    publishUploadState();
  }

  /** The last attempt failed for want of a token. Read synchronously by the
   *  token renewal (DrivePendingWork.pending), inside a pointerdown: a window
   *  is only worth raising when something is actually stuck on one — not for a
   *  recording that fails on a full Drive. */
  let _awaitingToken = false;

  /** One attempt at a wanted upload. Never throws, never interactive: what
   *  happened is in `autoUploadState`. */
  async function attemptWantedUpload(id: string): Promise<void> {
    _uploading.add(id);
    publishUploadState();
    try {
      await upload(id, false);
      // upload() crossed it off, a success being one whoever asked.
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      // Nothing left to send: the record was deleted, or its audio freed
      // without a Drive copy — both deliberate.
      if (message === 'no_local_audio') markUploadWanted(id, false);
      else if (/needs_auth|auth_failed/.test(message)) _awaitingToken = true;
      console.warn(`${log} automatic upload of the recording failed:`, e);
    } finally {
      _uploading.delete(id);
      publishUploadState();
    }
  }

  let _retryRunning = false;

  /** Tries every wanted upload again, one at a time — tens of megabytes each,
   *  and a burst would only compete with itself. */
  async function retryWantedUploads(): Promise<void> {
    if (_retryRunning || !host.userId()) return;
    const ids = readWanted();
    if (ids.length === 0) return;
    const drive = await driveModule();
    // Disconnected from Drive, or the option switched off since: kept, and
    // sent if either comes back — they were wanted when they were made.
    if (!drive.isDriveConnected() || !navigator.onLine || !await syncByDefault()) return;
    if (uploadHeldForWifi()) return;
    _retryRunning = true;
    _awaitingToken = false;
    try {
      const { appState } = await storeModule();
      const known = new Set(host.ids(appState.value));
      for (const id of ids) {
        // Not saved yet: a recording writes its audio before its record
        // (liveSession.stop), and a retry can land between the two. The upload
        // that save started is already under way.
        if (!known.has(id) || _uploading.has(id)) continue;
        await attemptWantedUpload(id);
        // No token: every other one would fail the same way. The next one
        // that arrives sends them all.
        if (_awaitingToken) break;
      }
    } finally {
      _retryRunning = false;
    }
  }

  let _retryWired = false;
  const FOREGROUND_RETRY_EVERY_MS = 10 * 60_000;

  /** Called once a user is open (main.ts's finishBoot). The launch pass waits
   *  for boot's work with Drive (bootSettled.ts): reading Drive is also what
   *  fetches a token in the browser, and a copy of Drive applied meanwhile may
   *  name recordings this one does not. */
  function initUploadRetry(): void {
    readUploadWifiOnly();
    publishUploadState();
    void bootSettled.then(() => retryWantedUploads());
    if (_retryWired) return;
    _retryWired = true;
    const retry = () => { void retryWantedUploads(); };
    window.addEventListener('online', retry);
    // Onto Wi-Fi, or off it: what was held may go, or what goes may be held.
    onNetworkChange(() => { publishUploadState(); retry(); });
    // Spaced out: a phone comes back to the foreground every few minutes, and an
    // upload that keeps failing halfway (a weak signal) would spend tens of
    // megabytes of data each time.
    let lastForegroundTry = Date.now();
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible' || Date.now() - lastForegroundTry < FOREGROUND_RETRY_EVERY_MS) return;
      lastForegroundTry = Date.now();
      retry();
    });
    void driveModule().then(drive => drive.registerDrivePendingWork({
      pending: () => _awaitingToken && readWanted().length > 0,
      resume: retry,
    }));
  }

  // ── Saving, and the copy that follows ──────────────────────────────────────

  /** After a recording is stored here: copies it to Drive when `sync` says so;
   *  omitted, the user's standing preference decides. Not awaited past the
   *  decision — an upload can take minutes on a phone connection. */
  async function queueUpload(id: string, sync?: boolean): Promise<void> {
    const wantSync = sync ?? await syncByDefault();
    if (!wantSync) return;
    // Without Drive there is nothing to retry towards, and nothing is queued: a
    // recording made before Drive was connected belongs to the backlog, which
    // only ever goes up on the user's say-so (BackfillRow).
    if (!(await driveModule()).isDriveConnected()) return;
    // Remembered BEFORE it is attempted: an app closed mid-upload — the phone
    // put back in a pocket right after stopping — is a failure too, and the
    // next launch must know about it.
    markUploadWanted(id, true);
    // Told to wait for Wi-Fi, and not on it: written down, and sent by the
    // retry when the network changes.
    if (uploadHeldForWifi()) return;
    // Never interactive: this runs on its own after a recording is saved, and a
    // consent window raised by something the user did not just click is the
    // behaviour the Drive work spent so long removing.
    void attemptWantedUpload(id);
  }

  /** Writes the recording to this device, then `queueUpload`. The local write
   *  is awaited; the upload is NOT, because it can take minutes for a long
   *  recording on a phone connection and stopping a session would appear to
   *  hang. Callers that need to know how the upload went — a page's own
   *  button — call `upload` directly and await that. */
  async function save(id: string, audio: Blob, sync?: boolean): Promise<void> {
    await host.local.put(id, audio);
    // Usage just moved by however long the recording was — tens or hundreds of
    // megabytes. Re-read it so the header's capacity warning reflects reality
    // now rather than at the next launch, which is a whole evening too late.
    void (await import('../services/storageService')).refreshStorageEstimate();
    await queueUpload(id, sync);
  }

  /** Uploads in flight by record, so that two askers share one upload: the
   *  automatic one and a retry landing together, or a click on a page's cloud
   *  during either, would otherwise each put a copy on Drive. */
  const _uploadsInFlight = new Map<string, Promise<void>>();

  /** Copies this recording to Drive. Resolves once the file is there and
   *  recorded; rejects on any failure, having changed nothing.
   *
   *  `interactive` may raise a consent window, so it is true only when a click led
   *  here — see driveService's getToken. */
  function upload(id: string, interactive = true): Promise<void> {
    const running = _uploadsInFlight.get(id);
    if (running) return running;
    const p = runUpload(id, interactive).finally(() => _uploadsInFlight.delete(id));
    _uploadsInFlight.set(id, p);
    return p;
  }

  async function runUpload(id: string, interactive: boolean): Promise<void> {
    if (await isSynced(id)) {
      markUploadWanted(id, false);
      return;
    }
    const audio = await host.local.get(id);
    if (!audio) throw new Error('no_local_audio');
    const mimeType = audio.type || await host.mimeType(id) || 'audio/webm';
    const fileId = await (await driveModule())
      .uploadCompanionFile(host.fileName(id, mimeType), audio, interactive);
    await recordSynced(id, { fileId, mimeType, bytes: audio.size });
    markUploadWanted(id, false);
    host.onUploaded?.(id);
  }

  /** The recordings this device holds that are NOT on Drive.
   *
   *  Exists because `syncByDefault` only ever applied to recordings saved
   *  after it was switched on. A user who turned it on reasonably expected their
   *  library to follow, found it had not, and reported the sync as broken
   *  (2026-09-10) — it was working exactly as written, which is its own kind of
   *  bug. Nothing else in the app could see, let alone fix, that backlog.
   *
   *  Keyed off the records the module knows about rather than off the audio
   *  store: a blob left behind by a deleted record is an orphan, and uploading
   *  orphans to someone's Drive is not a favour. */
  async function pendingUploads(): Promise<{ ids: string[]; bytes: number }> {
    const { appState } = await storeModule();
    const user = appState.value;
    const synced = host.synced(user) ?? {};
    const ids: string[] = [];
    let bytes = 0;
    for (const id of host.ids(user)) {
      if (synced[id]) continue;
      const blob = await host.local.get(id);
      if (!blob) continue;   // recorded elsewhere, or the audio was freed here
      ids.push(id);
      bytes += blob.size;
    }
    return { ids, bytes };
  }

  /** Uploads that backlog, one at a time, reporting progress.
   *
   *  Sequential on purpose: these are tens of megabytes each on a phone
   *  connection, and a parallel burst would compete with itself and with
   *  whatever else the app is doing. Failures are counted rather than thrown —
   *  one recording that will not upload must not abandon the twenty after it,
   *  and every one of them stays on the device either way. */
  async function uploadPending(
    onProgress?: (done: number, total: number) => void,
  ): Promise<{ ok: number; failed: number }> {
    const { ids } = await pendingUploads();
    let ok = 0, failed = 0;
    for (const [i, id] of ids.entries()) {
      try {
        // Only the first may raise a consent window: it is the one the click
        // paid for. After that the token is in hand, and a popup per recording
        // would be indefensible.
        await upload(id, i === 0);
        ok++;
      } catch (e) {
        console.warn(`${log} backlog upload failed for ${id}`, e);
        failed++;
      }
      onProgress?.(i + 1, ids.length);
    }
    return { ok, failed };
  }

  /** Confronts the "copied to Drive" records with what is actually in the folder,
   *  and drops the ones whose file is gone.
   *
   *  Each record is a BELIEF, written when an upload returned and never checked
   *  again. A file deleted from the Drive itself — which the user is entitled to
   *  do, and which `drive.file` makes invisible to us until we look — leaves the
   *  app announcing a backup it no longer has. That is the one direction that
   *  must never be wrong: believing a recording is safe when it is not is the
   *  2026-09-09 loss with a reassuring figure on top.
   *
   *  Only ever from a listing that SUCCEEDED. A failed one would read as "the
   *  folder is empty" and drop every record at once — so anything short of a
   *  complete answer changes nothing. Dropping a record is not destructive
   *  either way: the recording stays on this device, and it rejoins the upload
   *  backlog, which is exactly where a recording with no Drive copy belongs.
   *
   *  Returns how many were dropped; zero for "nothing to do" and for "could not
   *  look" alike, which the caller does not need to tell apart. */
  async function reconcile(): Promise<number> {
    const drive = await driveModule();
    if (!drive.isDriveConnected() || !drive.hasDriveToken()) return 0;

    let onDrive: Set<string>;
    try {
      const root = await drive.findCompanionPath([], false);
      if (!root) return 0;
      onDrive = new Set((await drive.listCompanionChildren(root, false)).map(c => c.id));
    } catch (e) {
      console.warn(`${log} could not check which recordings are still on Drive`, e);
      return 0;
    }

    const stale = Object.entries(await syncedNow())
      .filter(([, entry]) => entry && !onDrive.has(entry.fileId))
      .map(([id]) => id);
    if (stale.length === 0) return 0;

    const { mutate } = await storeModule();
    await mutate(user => host.drop(user, stale));
    return stale.length;
  }

  /** The mirror of the backlog above: the recordings this device holds whose
   *  copy on Drive is PROVEN. The same walk, the opposite condition.
   *
   *  Proven file by file, never from the global sync status. That status says
   *  the blob is up to date; it says nothing about the companion files, which
   *  run on their own schedule — confusing the two is exactly what produced the
   *  backlog above on 2026-09-10, and here it would delete recordings that had
   *  never been uploaded at all. */
  async function freeable(): Promise<{ ids: string[]; bytes: number }> {
    const { appState } = await storeModule();
    const user = appState.value;
    const synced = host.synced(user) ?? {};
    const ids: string[] = [];
    let bytes = 0;
    for (const id of host.ids(user)) {
      if (!synced[id]) continue;
      const blob = await host.local.get(id);
      if (!blob) continue;   // already freed here, or recorded elsewhere
      ids.push(id);
      bytes += blob.size;
    }
    return { ids, bytes };
  }

  /** Frees them. Nothing is lost: `fetch` brings any of them back on demand,
   *  which is what makes this safe to offer as one button. */
  async function freeSynced(): Promise<{ count: number; bytes: number }> {
    const { appState } = await storeModule();
    const user = appState.value;
    const synced = host.synced(user) ?? {};
    let count = 0, bytes = 0;
    for (const id of host.ids(user)) {
      if (!synced[id]) continue;
      const blob = await host.local.get(id);
      if (!blob) continue;
      // Re-read and delete one at a time rather than from a list gathered
      // earlier: the figure reported is then what actually went.
      try { await forget(id); count++; bytes += blob.size; }
      catch (e) { console.warn(`${log} could not free the audio of ${id}`, e); }
    }
    return { count, bytes };
  }

  /** Deletes the Drive copy, leaving this device's untouched. */
  async function unsync(id: string): Promise<void> {
    await dropSynced(id);
  }

  /** After a conflict settled in THIS device's favour: takes back out of the
   *  trash the recordings that decision resurrected — records another device
   *  deleted, whose Drive copy went to the trash with them. Same reasoning, and
   *  same narrowing to what the discarded state no longer had, as the
   *  attachments' reuploadResurrected. Drive unreachable: nothing touched. */
  async function untrashResurrected(discarded: AppStateLike): Promise<number> {
    const there = host.synced(discarded) ?? {};
    const candidates = Object.entries(await syncedNow()).filter(([id]) => !there[id]);
    if (candidates.length === 0) return 0;
    const drive = await driveModule();
    let untrashed = 0;
    for (const [, entry] of candidates) {
      try {
        if (await drive.companionFileSize(entry.fileId, false) !== 'gone') continue;
      } catch { return untrashed; }
      if (await drive.untrashCompanionFile(entry.fileId, false)) untrashed++;
    }
    return untrashed;
  }

  /** The recording as held on THIS device. Never reaches for the network — see
   *  this file's header. */
  function load(id: string): Promise<Blob | undefined> {
    return host.local.get(id);
  }

  async function probe(id: string, interactive = false): Promise<SyncedAudioProbe | null> {
    const entry = await syncedOf(id);
    if (!entry) return null;
    const drive = await driveModule();
    if (!interactive && !drive.hasDriveToken()) return { status: 'needsAuth' };
    try {
      const size = await drive.companionFileSize(entry.fileId, interactive);
      return size === 'gone' ? { status: 'gone' } : { status: 'ok', bytes: size || entry.bytes };
    } catch (e) {
      return /needs_auth/.test(String(e)) ? { status: 'needsAuth' } : { status: 'offline' };
    }
  }

  /** The Drive copy's bytes for one use — a visit, a share — and deliberately
   *  NOT kept: the user freed this space, and using it once is no reason to
   *  take it back. */
  async function downloadOnce(
    id: string, onProgress?: (fraction: number) => void, signal?: AbortSignal,
  ): Promise<Blob | null> {
    const entry = await syncedOf(id);
    if (!entry) return null;
    const blob = await (await driveModule()).downloadCompanionFile(entry.fileId, true, onProgress && ((loaded, total) => {
      const of = total ?? entry.bytes;
      if (of > 0) onProgress(Math.min(1, loaded / of));
    }), signal);
    if (!blob) return null;
    return blob.type ? blob : new Blob([blob], { type: entry.mimeType });
  }

  /** How far each download in flight has got, 0 to 1, by record id — for
   *  whatever shows it: a passage's button, a page, the settings. */
  const downloadProgress = signal<Readonly<Record<string, number>>>({});

  /** Recordings that arrived on this device during this page's life, so a screen
   *  already showing one as absent can pick it up — the background pass does not
   *  know who is looking. */
  const arrivals = signal<ReadonlySet<string>>(new Set());

  /** Recordings whose audio was freed from THIS device on purpose (2026-10-09):
   *  a page's "forget the audio", or the settings' "free up space". The
   *  automatic download leaves them on Drive — which is what makes "only bring
   *  the next ones here" possible. An explicit request ignores it. */
  const audioFreed = deviceIdList(host.keys.freed);

  /** Keeps on this device a recording already brought down for one visit
   *  (downloadOnce), without fetching it again — what runDownload does once it
   *  has the bytes. */
  async function keepHere(id: string, blob: Blob): Promise<void> {
    await host.local.put(id, blob);
    audioFreed.set(id, false);
    arrivals.value = new Set([...arrivals.value, id]);
    void (await import('../services/storageService')).refreshStorageEstimate();
  }

  const _downloadsInFlight = new Map<string, Promise<Blob | null>>();

  /** Downloads a recording this device does not have, and caches it locally so the
   *  next playback — and any clip extracted from it — costs nothing.
   *
   *  Returns null when the Drive file is gone: the user may have deleted it from
   *  their own Drive, which is their right. The record is dropped in that case
   *  rather than left pointing at nothing, so the UI stops offering a download
   *  that cannot work. */
  function fetch(id: string, interactive = true): Promise<Blob | null> {
    // One download per recording, whoever asks: the background pass and a tap on
    // the same passage would otherwise fetch it twice.
    const running = _downloadsInFlight.get(id);
    if (running) return running;
    const p = runDownload(id, interactive).finally(() => {
      _downloadsInFlight.delete(id);
      const { [id]: _, ...rest } = downloadProgress.value;
      downloadProgress.value = rest;
    });
    _downloadsInFlight.set(id, p);
    return p;
  }

  async function runDownload(id: string, interactive: boolean): Promise<Blob | null> {
    const entry = await syncedOf(id);
    if (!entry) return null;
    downloadProgress.value = { ...downloadProgress.value, [id]: 0 };
    const blob = await (await driveModule()).downloadCompanionFile(entry.fileId, interactive, (loaded, total) => {
      const of = total ?? entry.bytes;
      if (of > 0) downloadProgress.value = { ...downloadProgress.value, [id]: Math.min(1, loaded / of) };
    });
    if (!blob) {
      await dropSynced(id, true);
      return null;
    }
    // Drive can hand back a generic content type; keep the one that was recorded
    // so the <audio> element and the clip decoder get what they expect.
    const typed = blob.type ? blob : new Blob([blob], { type: entry.mimeType });
    await host.local.put(id, typed);
    // Here again, so no longer "freed on purpose": whoever brought it back
    // wanted it.
    audioFreed.set(id, false);
    arrivals.value = new Set([...arrivals.value, id]);
    void (await import('../services/storageService')).refreshStorageEstimate();
    return typed;
  }

  function freedIds(): ReadonlySet<string> {
    return new Set(audioFreed.read());
  }

  /** The recordings that are on Drive and not on this device, most recent first,
   *  with the size Drive holds. Their keys only are read from the audio store —
   *  never the blobs. */
  async function driveOnly(): Promise<Array<{ id: string; bytes: number }>> {
    const { appState } = await storeModule();
    const user = appState.value;
    const known = new Set(host.ids(user));
    const here = new Set(await host.local.keys());
    return Object.entries(host.synced(user) ?? {})
      .filter(([id, entry]) => entry && known.has(id) && !here.has(id))
      .sort(([a], [b]) => host.recency(user, b).localeCompare(host.recency(user, a)))
      .map(([id, entry]) => ({ id, bytes: entry.bytes }));
  }

  /** Storage-saving: frees THIS device's copy, keeping the record.
   *
   *  Local only, deliberately — the two controls divide cleanly: the cloud button
   *  acts on Drive and nothing else, this acts on the device and nothing else.
   *  So with a Drive copy in place this is reversible (the page falls back to
   *  offering the download), and without one it is the end of the recording,
   *  which is what its confirmation has to say. */
  async function forget(id: string): Promise<void> {
    await host.local.delete(id);
    markUploadWanted(id, false);
    // Freed on purpose — kept from coming back on its own. Without a Drive copy
    // there is nothing that could bring it back, and nothing to remember.
    if (await isSynced(id)) audioFreed.set(id, true);
    if (arrivals.value.has(id)) {
      arrivals.value = new Set([...arrivals.value].filter(x => x !== id));
    }
  }

  /** A record deleted: this device's lists forget it. */
  function forgetMarks(id: string): void {
    markUploadWanted(id, false);
    audioFreed.set(id, false);
  }

  return {
    userId: host.userId,
    isSynced, syncedOf, syncByDefault,
    uploadOnWifiOnly, setUploadOnWifiOnly,
    autoUploadState, initUploadRetry,
    save, queueUpload, upload, pendingUploads, uploadPending,
    reconcile, freeable, freeSynced, unsync, untrashResurrected,
    load, probe, downloadOnce, keepHere, fetch, downloadProgress, arrivals,
    freedIds, driveOnly, forget, forgetMarks,
  };
}
