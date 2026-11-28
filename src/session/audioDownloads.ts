import { effect, signal } from '@preact/signals';
import { appState } from '../store';
import { isDriveConnected, registerDrivePendingWork } from '../services/driveService';
import { refreshStorageEstimate, storageQuota, storageUsage, FULL_RATIO } from '../services/storageService';
import { driveOnlyAudio, fetchSyncedAudio, freedAudioIds, sessionDbUserId } from './db';
import { analyserModuleOf, type SyncedAudio } from './model';
import { userKey, type UserKey } from '../userLocalKeys';
import { onUnmeteredNetwork, onNetworkChange } from './network';

// ── Bringing the recordings onto this device (2026-10-09) ────────────────────
// A recording copied to Drive can be heard on the user's other devices, but
// only once it is downloaded there — and until now only from the analysis's own
// summary. Asked by two users the same week: hear the passages of a card from a
// phone whose recordings are on Drive, and have everything on the phone before
// leaving the Wi-Fi.
//
// Two modes, chosen per device and per user — a phone and a computer of the
// same person have different disks and different data plans, so this is never
// in the synced state:
//   - manual (the default): nothing comes down on its own. A passage only on
//     Drive is played straight from there (remotePassage.ts); downloading a
//     whole recording asks first;
//   - automatic: everything comes here in the background, newest first, one at
//     a time — on Wi-Fi only unless told otherwise.
// Recordings freed from this device on purpose are left on Drive by the
// automatic pass (companionAudio.ts's audioFreed); the button that downloads
// everything takes no notice of that: it is a request.
//
// There was a third, "on demand" — playing a passage downloaded its recording
// without asking. It went when a passage stopped needing its recording at all
// (2026-10-10, lot 5 #13); a device that had it reads as manual.
//
// One instance per module since 2026-11-28 (the Transcription module's
// recordings come down the same way): each its own choices on this device,
// its own pass.

export type AudioDownloadMode = 'manual' | 'auto';

export type AutoDownloadBlock = 'offline' | 'wifi' | 'space' | 'token' | 'failed';

export interface AutoDownloadStatus {
  /** What is left to bring here, freed recordings excepted. */
  remaining: number;
  bytes: number;
  /** The one coming down now. */
  current: string | null;
  /** Why it is not going on, when it is not. */
  blocked: AutoDownloadBlock | null;
  /** Freed on purpose, so left on Drive. */
  freed: number;
}

export interface DownloadAllResult { ok: number; failed: number; stoppedForSpace: boolean }

/** What one module's recordings come down through — its companionAudio. */
export interface AudioDownloadsHost {
  log: string;
  userId: () => string | null;
  driveOnly: () => Promise<Array<{ id: string; bytes: number }>>;
  fetch: (id: string, interactive: boolean) => Promise<Blob | null>;
  freedIds: () => ReadonlySet<string>;
  /** The Drive copies the synced state records: a new one is a recording made
   *  elsewhere, to bring here. */
  synced: () => Readonly<Record<string, SyncedAudio>> | undefined;
  keys: { mode: UserKey; wifiOnly: UserKey };
}

// ── Whether the storage may take it ─────────────────────────────────────────

/** Whether `bytes` more would take the origin past the point where the
 *  storage warning turns red — where a recording in progress starts losing
 *  pieces. Unknown figures do not stop anything. */
async function wouldFillStorage(bytes: number): Promise<boolean> {
  await refreshStorageEstimate();
  const usage = storageUsage.value, quota = storageQuota.value;
  if (usage === null || quota === null || quota <= 0) return false;
  return (usage + bytes) / quota >= FULL_RATIO;
}

export type AudioDownloads = ReturnType<typeof audioDownloads>;

export function audioDownloads(host: AudioDownloadsHost) {
  /** This device's choice for the user who is open. */
  const mode = signal<AudioDownloadMode>('manual');
  /** Automatic only: false once the user allowed mobile data too. */
  const wifiOnly = signal(true);

  function key(name: UserKey): string | null {
    const uid = host.userId();
    return uid ? userKey(name, uid) : null;
  }

  function readSettings(): void {
    const m = (() => { try { return localStorage.getItem(key(host.keys.mode) ?? ''); } catch { return null; } })();
    mode.value = m === 'auto' ? m : 'manual';
    const wifi = (() => { try { return localStorage.getItem(key(host.keys.wifiOnly) ?? ''); } catch { return null; } })();
    wifiOnly.value = wifi !== '0';
  }

  function write(name: UserKey, value: string): void {
    const k = key(name);
    if (!k) return;
    try { localStorage.setItem(k, value); } catch { /* kept for this page's life */ }
  }

  function setMode(m: AudioDownloadMode): void {
    mode.value = m;
    write(host.keys.mode, m);
    void runAuto();
  }

  function setWifiOnly(only: boolean): void {
    wifiOnly.value = only;
    write(host.keys.wifiOnly, only ? '1' : '0');
    void runAuto();
  }

  // ── The automatic pass ────────────────────────────────────────────────────

  const status = signal<AutoDownloadStatus | null>(null);

  let _running = false;
  /** "Download all" is running: the automatic pass stands aside rather
   *  than download a second recording alongside it. */
  let _allRunning = false;
  let _awaitingToken = false;

  async function pendingForAuto(): Promise<{ list: Array<{ id: string; bytes: number }>; freed: number }> {
    const freedIds = host.freedIds();
    const all = await host.driveOnly();
    const list = all.filter(r => !freedIds.has(r.id));
    return { list, freed: all.length - list.length };
  }

  /** One pass: downloads what is missing, one recording at a time, until done or
   *  blocked. Never interactive, never throws. */
  async function runAuto(): Promise<void> {
    if (_running || _allRunning || !host.userId()) return;
    if (mode.value !== 'auto' || !isDriveConnected()) { status.value = null; return; }
    _running = true;
    _awaitingToken = false;
    try {
      for (;;) {
        const { list, freed } = await pendingForAuto();
        const bytes = list.reduce((sum, r) => sum + r.bytes, 0);
        const set = (blocked: AutoDownloadBlock | null, current: string | null = null) => {
          status.value = { remaining: list.length, bytes, current, blocked, freed };
        };
        const next = list[0];
        if (!next) { set(null); return; }
        if (mode.value !== 'auto') { status.value = null; return; }
        if (!navigator.onLine) { set('offline'); return; }
        if (wifiOnly.value && !onUnmeteredNetwork()) { set('wifi'); return; }
        if (await wouldFillStorage(next.bytes)) { set('space'); return; }
        set(null, next.id);
        try {
          await host.fetch(next.id, false);
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          console.warn(`${host.log} automatic download of a recording failed:`, e);
          if (/needs_auth|auth_failed/.test(message)) { _awaitingToken = true; set('token'); }
          else set('failed');
          return;
        }
      }
    } catch (e) {
      console.warn(`${host.log} automatic downloads stopped:`, e);
    } finally {
      _running = false;
    }
  }

  // ── Everything, on request ────────────────────────────────────────────────

  /** Every recording on Drive that is not here, freed ones included — this is a
   *  request. One at a time; only the first may raise a sign-in window, the one
   *  the click paid for (same rule as the upload backlog). */
  async function downloadAll(
    onProgress?: (done: number, total: number) => void,
  ): Promise<DownloadAllResult> {
    _allRunning = true;
    try {
      const list = await host.driveOnly();
      let ok = 0, failed = 0;
      for (const [i, r] of list.entries()) {
        if (await wouldFillStorage(r.bytes)) return { ok, failed, stoppedForSpace: true };
        try {
          if (await host.fetch(r.id, i === 0)) ok++;
          else failed++;
        } catch (e) {
          console.warn(`${host.log} download failed for ${r.id}`, e);
          failed++;
        }
        onProgress?.(i + 1, list.length);
      }
      return { ok, failed, stoppedForSpace: false };
    } finally {
      _allRunning = false;
      void runAuto();
    }
  }

  // ── Wiring ────────────────────────────────────────────────────────────────

  const FOREGROUND_EVERY_MS = 10 * 60_000;
  let _wired = false;

  /** Called once a user is open (main.ts's finishBoot), after the upload retry:
   *  sending what only this device has comes before fetching what Drive has. */
  function init(): void {
    readSettings();
    setTimeout(() => { void runAuto(); }, 12_000);
    if (_wired) return;
    _wired = true;
    const run = () => { void runAuto(); };
    window.addEventListener('online', run);
    // Back on Wi-Fi, or off it.
    onNetworkChange(run);
    let lastForeground = Date.now();
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;
      // Spaced out, as for the uploads — unless it was only waiting for the
      // network, which coming back to the app is a good moment to look at again.
      const waiting = status.value?.blocked;
      if (Date.now() - lastForeground < FOREGROUND_EVERY_MS && waiting !== 'offline' && waiting !== 'wifi') return;
      lastForeground = Date.now();
      run();
    });
    // A sync that brings a recording made elsewhere: the set of recordings on
    // Drive is what changed. Compared as a key, so the thousand other edits a
    // state goes through cost nothing.
    let syncedKey = '';
    effect(() => {
      const next = Object.keys(host.synced() ?? {}).sort().join(',');
      if (next === syncedKey) return;
      const first = syncedKey === '';
      syncedKey = next;
      if (!first) setTimeout(run, 2000);
    });
    registerDrivePendingWork({
      // Asked again once the token is in hand (driveService), so it must not
      // depend on the token being missing — only on having stopped for one.
      pending: () => _awaitingToken && mode.value === 'auto',
      resume: run,
    });
  }

  return { mode, wifiOnly, setMode, setWifiOnly, status, runAuto, downloadAll, init };
}

// ── The analyser's ──────────────────────────────────────────────────────────

export const analyserDownloads = audioDownloads({
  log: '[sessions]',
  userId: sessionDbUserId,
  driveOnly: driveOnlyAudio,
  fetch: fetchSyncedAudio,
  freedIds: freedAudioIds,
  // Read through the signal: the effect that watches it re-runs on a sync.
  synced: () => analyserModuleOf(appState.value)?.syncedAudio,
  keys: { mode: 'audioDownloadMode', wifiOnly: 'audioDownloadWifiOnly' },
});

/** This device's choice for the user who is open. */
export const audioDownloadMode = analyserDownloads.mode;
export const setAudioDownloadMode = analyserDownloads.setMode;
export const setDownloadOnWifiOnly = analyserDownloads.setWifiOnly;
export const autoDownloadStatus = analyserDownloads.status;
export const runAutoDownloads = analyserDownloads.runAuto;
export const downloadAllAudio = analyserDownloads.downloadAll;
export const initAudioDownloads = analyserDownloads.init;
