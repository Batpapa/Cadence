import { effect, signal } from '@preact/signals';
import { appState } from '../store';
import { isDriveConnected, registerDrivePendingWork } from '../services/driveService';
import { refreshStorageEstimate, storageQuota, storageUsage, FULL_RATIO } from '../services/storageService';
import { driveOnlyAudio, fetchSyncedAudio, freedAudioIds, sessionDbUserId } from './db';
import { TUNE_ANALYSER_MODULE_KEY, type TuneAnalyserModuleData } from './model';
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
// automatic pass (db.ts's audioFreed); the button that downloads everything
// takes no notice of that: it is a request.
//
// There was a third, "on demand" — playing a passage downloaded its recording
// without asking. It went when a passage stopped needing its recording at all
// (2026-10-10, lot 5 #13); a device that had it reads as manual.

export type AudioDownloadMode = 'manual' | 'auto';

const LS_MODE = 'cadence_audio_download_mode';
const LS_WIFI_ONLY = 'cadence_audio_download_wifi_only';

/** This device's choice for the user who is open. */
export const audioDownloadMode = signal<AudioDownloadMode>('manual');
/** Automatic only: false once the user allowed mobile data too. */
export const downloadOnWifiOnly = signal(true);

function key(prefix: string): string | null {
  const uid = sessionDbUserId();
  return uid ? `${prefix}:${uid}` : null;
}

function readSettings(): void {
  const mode = (() => { try { return localStorage.getItem(key(LS_MODE) ?? ''); } catch { return null; } })();
  audioDownloadMode.value = mode === 'auto' ? mode : 'manual';
  const wifi = (() => { try { return localStorage.getItem(key(LS_WIFI_ONLY) ?? ''); } catch { return null; } })();
  downloadOnWifiOnly.value = wifi !== '0';
}

function write(prefix: string, value: string): void {
  const k = key(prefix);
  if (!k) return;
  try { localStorage.setItem(k, value); } catch { /* kept for this page's life */ }
}

export function setAudioDownloadMode(mode: AudioDownloadMode): void {
  audioDownloadMode.value = mode;
  write(LS_MODE, mode);
  void runAutoDownloads();
}

export function setDownloadOnWifiOnly(wifiOnly: boolean): void {
  downloadOnWifiOnly.value = wifiOnly;
  write(LS_WIFI_ONLY, wifiOnly ? '1' : '0');
  void runAutoDownloads();
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

// ── The automatic pass ──────────────────────────────────────────────────────

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

export const autoDownloadStatus = signal<AutoDownloadStatus | null>(null);

let _running = false;
/** "Download everything" is running: the automatic pass stands aside rather
 *  than download a second recording alongside it. */
let _allRunning = false;
let _awaitingToken = false;

async function pendingForAuto(): Promise<{ list: Array<{ id: string; bytes: number }>; freed: number }> {
  const freedIds = freedAudioIds();
  const all = await driveOnlyAudio();
  const list = all.filter(r => !freedIds.has(r.id));
  return { list, freed: all.length - list.length };
}

/** One pass: downloads what is missing, one recording at a time, until done or
 *  blocked. Never interactive, never throws. */
export async function runAutoDownloads(): Promise<void> {
  if (_running || _allRunning || !sessionDbUserId()) return;
  if (audioDownloadMode.value !== 'auto' || !isDriveConnected()) { autoDownloadStatus.value = null; return; }
  _running = true;
  _awaitingToken = false;
  try {
    for (;;) {
      const { list, freed } = await pendingForAuto();
      const bytes = list.reduce((sum, r) => sum + r.bytes, 0);
      const status = (blocked: AutoDownloadBlock | null, current: string | null = null) => {
        autoDownloadStatus.value = { remaining: list.length, bytes, current, blocked, freed };
      };
      const next = list[0];
      if (!next) { status(null); return; }
      if (audioDownloadMode.value !== 'auto') { autoDownloadStatus.value = null; return; }
      if (!navigator.onLine) { status('offline'); return; }
      if (downloadOnWifiOnly.value && !onUnmeteredNetwork()) { status('wifi'); return; }
      if (await wouldFillStorage(next.bytes)) { status('space'); return; }
      status(null, next.id);
      try {
        await fetchSyncedAudio(next.id, false);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        console.warn('[sessions] automatic download of a recording failed:', e);
        if (/needs_auth|auth_failed/.test(message)) { _awaitingToken = true; status('token'); }
        else status('failed');
        return;
      }
    }
  } catch (e) {
    console.warn('[sessions] automatic downloads stopped:', e);
  } finally {
    _running = false;
  }
}

// ── Everything, on request ──────────────────────────────────────────────────

export interface DownloadAllResult { ok: number; failed: number; stoppedForSpace: boolean }

/** Every recording on Drive that is not here, freed ones included — this is a
 *  request. One at a time; only the first may raise a sign-in window, the one
 *  the click paid for (same rule as the upload backlog). */
export async function downloadAllAudio(
  onProgress?: (done: number, total: number) => void,
): Promise<DownloadAllResult> {
  _allRunning = true;
  try {
    const list = await driveOnlyAudio();
    let ok = 0, failed = 0;
    for (const [i, r] of list.entries()) {
      if (await wouldFillStorage(r.bytes)) return { ok, failed, stoppedForSpace: true };
      try {
        if (await fetchSyncedAudio(r.id, i === 0)) ok++;
        else failed++;
      } catch (e) {
        console.warn('[sessions] download failed for ' + r.id, e);
        failed++;
      }
      onProgress?.(i + 1, list.length);
    }
    return { ok, failed, stoppedForSpace: false };
  } finally {
    _allRunning = false;
    void runAutoDownloads();
  }
}

// ── Wiring ──────────────────────────────────────────────────────────────────

const FOREGROUND_EVERY_MS = 10 * 60_000;
let _wired = false;

/** Called once a user is open (main.ts's finishBoot), after the upload retry:
 *  sending what only this device has comes before fetching what Drive has. */
export function initAudioDownloads(): void {
  readSettings();
  setTimeout(() => { void runAutoDownloads(); }, 12_000);
  if (_wired) return;
  _wired = true;
  const run = () => { void runAutoDownloads(); };
  window.addEventListener('online', run);
  // Back on Wi-Fi, or off it.
  onNetworkChange(run);
  let lastForeground = Date.now();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    // Spaced out, as for the uploads — unless it was only waiting for the
    // network, which coming back to the app is a good moment to look at again.
    const waiting = autoDownloadStatus.value?.blocked;
    if (Date.now() - lastForeground < FOREGROUND_EVERY_MS && waiting !== 'offline' && waiting !== 'wifi') return;
    lastForeground = Date.now();
    run();
  });
  // A sync that brings a recording made elsewhere: the set of recordings on
  // Drive is what changed. Compared as a key, so the thousand other edits a
  // state goes through cost nothing.
  let syncedKey = '';
  effect(() => {
    const mod = appState.value.modules?.[TUNE_ANALYSER_MODULE_KEY] as TuneAnalyserModuleData | undefined;
    const next = Object.keys(mod?.syncedAudio ?? {}).sort().join(',');
    if (next === syncedKey) return;
    const first = syncedKey === '';
    syncedKey = next;
    if (!first) setTimeout(run, 2000);
  });
  registerDrivePendingWork({
    // Asked again once the token is in hand (driveService), so it must not
    // depend on the token being missing — only on having stopped for one.
    pending: () => _awaitingToken && audioDownloadMode.value === 'auto',
    resume: run,
  });
}
