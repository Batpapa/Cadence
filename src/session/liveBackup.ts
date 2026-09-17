import { signal } from '@preact/signals';
import { appState } from '../store';
import {
  isDriveConnected, hasDriveToken, getDeviceId,
  companionPathId, findCompanionPath, forgetCompanionPath, listCompanionChildren,
  uploadCompanionFileInto, replaceCompanionFileContent, downloadCompanionFile, deleteCompanionFile,
  type DriveChild,
} from '../services/driveService';
import { audioExtension } from '../services/zip';
import {
  collectChunkRecords, appendChunk, clearChunks, putSessionWindows, deleteSessionWindows,
  listDraftSessions, saveSessionMeta, loadSessionAudio, syncAudioByDefault,
} from './db';
import { TUNE_ANALYSER_MODULE_KEY, type Analysis, type TuneAnalyserModuleData, type WindowResult } from './model';
import type { LiveSession } from './liveSession';
import { retryRecovery, type RecoveryFailure } from './recovery';
import {
  BACKUP_META_NAME, planAudioParts, audioPartName, windowsPartName, parseBackupFileName, parseBackupMeta,
  selectAudioParts, mergeWindowParts, matchDevice, decideBackup,
  type LiveBackupMeta, type DeviceMatch, type DeviceSignature,
} from './liveBackupPlan';

// ── Live backup to Drive: the transfers (2026-09-17) ────────────────────────────
// The rules live in liveBackupPlan.ts; this file does what they decide. See
// there for the folder layout and why the feature exists.
//
// Phase 1 is a MANUAL press on the live screen. Nothing here runs on a timer
// yet — the automatic ten-minute backup is phase 2, and will call the same
// backupLiveSession.
//
// Everything is best-effort on the way out: a backup that fails must never
// disturb the recording it protects, and a cleanup that fails is retried at the
// next sweep. The only thing ever deleted is a backup whose recording is safe
// elsewhere, or one the user threw away (decideBackup).

const BACKUPS_DIR = 'live-backups';
const FOLDER_MIME = 'application/vnd.google-apps.folder';

// ── Where each recording's backup stands, for the live screen ─────────────────

export interface LiveBackupStatus {
  /** When the last press completed, or null if none has. */
  lastAt: number | null;
  busy: boolean;
  /** The last press failed, and why. Cleared by the next attempt. */
  error: string | null;
}

/** By session id. A signal, so the indicator follows a press it did not start. */
export const liveBackupStatus = signal<Record<string, LiveBackupStatus>>({});

function setStatus(sessionId: string, patch: Partial<LiveBackupStatus>): void {
  const prev = liveBackupStatus.value[sessionId] ?? { lastAt: null, busy: false, error: null };
  liveBackupStatus.value = { ...liveBackupStatus.value, [sessionId]: { ...prev, ...patch } };
}

/** What has already reached Drive for a recording in this page's life. Only
 *  CONFIRMED uploads move these forward, so a part whose answer was lost is sent
 *  again — which the reassembly absorbs (selectAudioParts). */
interface Progress { lastSeq: number; windowCount: number; metaFileId: string | null }
const _progress = new Map<string, Progress>();
const _inFlight = new Map<string, Promise<void>>();
/** Recordings this page knows to have a backup — it sent one, or restored from
 *  one. settleLiveBackup only spends a request on these. */
const _known = new Set<string>();

// ── Which device this is ───────────────────────────────────────────────────────

type UADataNavigator = Navigator & {
  userAgentData?: {
    getHighEntropyValues(hints: string[]): Promise<{ model?: string; platform?: string; platformVersion?: string }>;
  };
};

/** The GPU as WebGL names it — "ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 Laptop
 *  GPU (0x00002820) Direct3D11 vs_5_0 ps_5_0, D3D11)" on a real machine. Empty
 *  where the browser declines to say. */
function webglRenderer(): string {
  try {
    const gl = document.createElement('canvas').getContext('webgl');
    if (!gl) return '';
    const dbg = gl.getExtension('WEBGL_debug_renderer_info') as { UNMASKED_RENDERER_WEBGL: number } | null;
    const value = dbg ? (gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) as unknown) : null;
    // Handed back rather than left to the collector: a page may only hold so
    // many live contexts, and this one is needed for a single string.
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return typeof value === 'string' ? value : '';
  } catch { return ''; }
}

let _signature: Promise<DeviceSignature> | null = null;

/** What this machine looks like. Asked once: none of it changes under a
 *  running page. */
function deviceSignature(): Promise<DeviceSignature> {
  _signature ??= (async () => {
    const uad = (navigator as UADataNavigator).userAgentData;
    let model = '', platform = '', platformVersion = '';
    if (uad?.getHighEntropyValues) {
      try {
        const hints = await uad.getHighEntropyValues(['model', 'platform', 'platformVersion']);
        model = hints.model ?? '';
        platform = hints.platform ?? '';
        // Major only — see DeviceSignature.
        platformVersion = (hints.platformVersion ?? '').split('.')[0] ?? '';
      } catch { /* leaves the fields empty, which matchDevice reads as "unknown" */ }
    }
    return {
      model,
      platform: platform || navigator.platform || '',
      platformVersion,
      renderer: webglRenderer(),
      cores: navigator.hardwareConcurrency || 0,
    };
  })();
  return _signature;
}

// ── Sending ──────────────────────────────────────────────────────────────────

/** Sends whatever this recording has that Drive does not: new audio chunks, new
 *  analysis windows, and a fresh meta.json. One press at a time per recording —
 *  a second press while one runs joins it. Rejects on failure, after recording
 *  the reason in `liveBackupStatus`. */
export function backupLiveSession(live: LiveSession, interactive: boolean): Promise<void> {
  const running = _inFlight.get(live.sessionId);
  if (running) return running;
  const p = runBackup(live, interactive).finally(() => _inFlight.delete(live.sessionId));
  _inFlight.set(live.sessionId, p);
  return p;
}

async function runBackup(live: LiveSession, interactive: boolean): Promise<void> {
  const id = live.sessionId;
  setStatus(id, { busy: true, error: null });
  let progress = _progress.get(id);
  if (!progress) { progress = { lastSeq: -1, windowCount: 0, metaFileId: null }; _progress.set(id, progress); }
  _known.add(id);
  try {
    const folderId = await companionPathId([BACKUPS_DIR, id], interactive);

    const mimeType = live.mimeType || 'audio/webm';
    const ext = audioExtension(mimeType);
    const chunks = await collectChunkRecords(id, progress.lastSeq);
    const parts = planAudioParts(chunks.map(c => ({ seq: c.seq, size: c.blob.size, blob: c.blob })));
    for (const part of parts) {
      const blob = new Blob(part.chunks.map(c => c.blob), { type: mimeType });
      await uploadCompanionFileInto(folderId, audioPartName(part.first, part.last, ext), blob, interactive);
      progress.lastSeq = part.last;
    }

    // Taken from memory, not the database: the session already holds every
    // window, and reading them back would only copy what is right here.
    const total = live.windows.length;
    if (total > progress.windowCount) {
      const slice = live.windows.slice(progress.windowCount, total);
      const blob = new Blob([JSON.stringify(slice)], { type: 'application/json' });
      await uploadCompanionFileInto(folderId, windowsPartName(progress.windowCount, total - 1), blob, interactive);
      progress.windowCount = total;
    }

    // Last, so a meta.json never describes parts that did not make it.
    const meta: LiveBackupMeta = {
      schema: 1,
      sessionId: id,
      name: live.name,
      date: new Date(live.startedAt || Date.now()).toISOString(),
      mimeType,
      source: live.sourceKind === 'device' ? 'device' : 'live',
      durationS: live.getElapsedMs() / 1000,
      deviceId: getDeviceId(),
      deviceModel: (await deviceSignature()).model,
      device: await deviceSignature(),
      updatedAt: Date.now(),
    };
    const metaBlob = new Blob([JSON.stringify(meta)], { type: 'application/json' });
    if (progress.metaFileId) await replaceCompanionFileContent(progress.metaFileId, metaBlob, interactive);
    else progress.metaFileId = await uploadCompanionFileInto(folderId, BACKUP_META_NAME, metaBlob, interactive);

    setStatus(id, { busy: false, error: null, lastAt: Date.now() });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    // The folder or meta.json is gone from Drive — the user deleted it there.
    // Whatever was sent went with it, so the next press starts from scratch
    // rather than sending only the tail of a recording nobody holds the head of.
    if (/: 404$/.test(message)) {
      forgetCompanionPath([BACKUPS_DIR, id]);
      _progress.delete(id);
    }
    setStatus(id, { busy: false, error: message });
    throw e;
  }
}

// ── Throwing away ────────────────────────────────────────────────────────────

const LS_DISCARDED = 'cadence_live_backup_discarded';

function discardedIds(): Set<string> {
  try { return new Set(JSON.parse(localStorage.getItem(LS_DISCARDED) ?? '[]') as string[]); } catch { return new Set(); }
}

/** Kept short: every cancelled recording lands here whether or not it ever had
 *  a backup (this page cannot know what another one sent), and the entries that
 *  matter are the recent ones a sweep has not reached yet. */
const MAX_DISCARDED = 200;

function setDiscarded(id: string, on: boolean): void {
  const ids = discardedIds();
  ids.delete(id);
  if (on) ids.add(id);
  try { localStorage.setItem(LS_DISCARDED, JSON.stringify([...ids].slice(-MAX_DISCARDED))); } catch { /* the sweep will just ask again */ }
}

/** The user threw this recording away: deletes its backup now if Drive can be
 *  reached, and otherwise remembers to, so a later sweep does not offer to
 *  recover a recording the user deleted. */
export async function discardLiveBackup(sessionId: string, interactive = false): Promise<void> {
  setDiscarded(sessionId, true);
  _progress.delete(sessionId);
  _known.delete(sessionId);
  if (!isDriveConnected() || (!interactive && !hasDriveToken())) return;
  try {
    const folderId = await findCompanionPath([BACKUPS_DIR, sessionId], interactive);
    if (!folderId || await deleteCompanionFile(folderId, interactive)) {
      forgetCompanionPath([BACKUPS_DIR, sessionId]);
      setDiscarded(sessionId, false);
    }
  } catch { /* remembered above — the next sweep retries */ }
}

// ── Finding backups, and cleaning up after them ──────────────────────────────

export interface LiveBackupOffer {
  sessionId: string;
  folderId: string;
  meta: LiveBackupMeta;
  match: DeviceMatch;
  /** The backup's files, as listed when it was found. */
  files: DriveChild[];
}

/** Every backup on Drive, whichever device made it, with nothing deleted and
 *  nothing offered. For the module's settings, where someone goes LOOKING —
 *  the only way in on a device that cannot recognise itself any more, which is
 *  every desktop browser once its local data has been cleared (the device id
 *  is regenerated and there is no phone model to fall back on). Measured on a
 *  real backup, 2026-09-17: same machine, wiped, `matchDevice` said 'other'
 *  and nothing was ever proposed. */
export interface LiveBackupEntry {
  sessionId: string;
  folderId: string;
  /** Null when meta.json is missing or unreadable: it can still be deleted. */
  meta: LiveBackupMeta | null;
  bytes: number;
}

export async function listLiveBackups(interactive = true): Promise<LiveBackupEntry[]> {
  if (!isDriveConnected()) return [];
  const root = await findCompanionPath([BACKUPS_DIR], interactive);
  if (!root) return [];
  const folders = (await listCompanionChildren(root, interactive)).filter(f => f.mimeType === FOLDER_MIME);
  const entries: LiveBackupEntry[] = [];
  for (const f of folders) {
    const files = await listCompanionChildren(f.id, interactive);
    entries.push({
      sessionId: f.name,
      folderId: f.id,
      meta: await readMeta(files, interactive),
      bytes: files.reduce((sum, x) => sum + Number(x.size ?? 0), 0),
    });
  }
  // Most recent first, like the analyses library.
  return entries.sort((a, b) => (b.meta?.date ?? '').localeCompare(a.meta?.date ?? ''));
}

/** Recordings the user put off deciding about, for this page's life. */
const _postponed = new Set<string>();

const SWEEP_MIN_INTERVAL_MS = 2 * 60_000;
let _lastSweepAt = 0;

export function postponeLiveBackup(sessionId: string): void { _postponed.add(sessionId); }

async function readMeta(files: DriveChild[], interactive: boolean): Promise<LiveBackupMeta | null> {
  // Normally one. Two if an upload of it landed but its answer did not; the
  // most recent says the most.
  let best: LiveBackupMeta | null = null;
  for (const f of files.filter(f => f.name === BACKUP_META_NAME)) {
    try {
      const blob = await downloadCompanionFile(f.id, interactive);
      const meta = blob ? parseBackupMeta(JSON.parse(await blob.text())) : null;
      if (meta && (!best || meta.updatedAt > best.updatedAt)) best = meta;
    } catch { /* unreadable: counts as absent */ }
  }
  return best;
}

/** Applies decideBackup to one backup folder: deletes it, reports it as worth
 *  offering, or leaves it. */
async function settleFolder(
  sessionId: string, folderId: string, recordingHereId: string | undefined, interactive: boolean,
): Promise<LiveBackupOffer | null> {
  const files = await listCompanionChildren(folderId, interactive);
  const meta = await readMeta(files, interactive);
  const mod = appState.value.modules?.[TUNE_ANALYSER_MODULE_KEY] as TuneAnalyserModuleData | undefined;
  const drafts = await listDraftSessions();
  const audio = await loadSessionAudio(sessionId);
  const match = meta ? matchDevice(meta, getDeviceId(), await deviceSignature()) : null;

  const decision = decideBackup({
    match,
    discarded: discardedIds().has(sessionId),
    recordingHere: sessionId === recordingHereId,
    localDraft: drafts.some(d => d.id === sessionId),
    finalized: !!mod?.sessions?.[sessionId],
    audioSynced: !!mod?.syncedAudio?.[sessionId],
    audioHere: !!audio && audio.size > 0,
    syncByDefault: await syncAudioByDefault(),
  });

  if (decision === 'delete') {
    if (await deleteCompanionFile(folderId, interactive)) {
      forgetCompanionPath([BACKUPS_DIR, sessionId]);
      setDiscarded(sessionId, false);
      _progress.delete(sessionId);
      _known.delete(sessionId);
    }
    return null;
  }
  if (decision === 'offer' && meta && match) return { sessionId, folderId, meta, match, files };
  return null;
}

/** Goes through every backup on Drive: deletes those no longer needed and
 *  returns those to offer for recovery here. Silent and harmless without a
 *  token — it never raises a sign-in window — and never throws. */
export async function sweepLiveBackups(recordingHereId?: string): Promise<LiveBackupOffer[]> {
  if (!isDriveConnected() || !hasDriveToken()) return [];
  // The library runs this on every visit, and a visit is often a round trip
  // from one analysis back to the list. Nothing a sweep looks at changes that
  // fast; what does (a save, an upload landing) settles its own backup.
  if (Date.now() - _lastSweepAt < SWEEP_MIN_INTERVAL_MS) return [];
  _lastSweepAt = Date.now();
  try {
    const root = await findCompanionPath([BACKUPS_DIR]);
    if (!root) return [];
    const folders = (await listCompanionChildren(root)).filter(f => f.mimeType === FOLDER_MIME);
    const offers: LiveBackupOffer[] = [];
    for (const f of folders) {
      if (_postponed.has(f.name)) continue;
      try {
        const offer = await settleFolder(f.name, f.id, recordingHereId, false);
        if (offer) offers.push(offer);
      } catch (e) {
        console.warn('[live-backup] could not settle ' + f.name, e);
      }
    }
    return offers;
  } catch (e) {
    console.warn('[live-backup] sweep failed', e);
    return [];
  }
}

/** One recording's backup, after something changed for it — it was saved, or
 *  its audio reached Drive. A no-op unless this page sent a backup for it, so a
 *  normal recording without one costs no request. */
export function settleLiveBackup(sessionId: string): Promise<void> {
  // Saving a recording and its upload landing both settle it, and they arrive
  // close together: without this the second would read a folder the first is
  // deleting, and log a 404 for nothing.
  const running = _settling.get(sessionId);
  if (running) return running;
  const p = runSettle(sessionId).finally(() => _settling.delete(sessionId));
  _settling.set(sessionId, p);
  return p;
}

const _settling = new Map<string, Promise<void>>();

async function runSettle(sessionId: string): Promise<void> {
  if (!_known.has(sessionId) && !discardedIds().has(sessionId)) return;
  if (!isDriveConnected() || !hasDriveToken()) return;
  try {
    const folderId = await findCompanionPath([BACKUPS_DIR, sessionId]);
    if (folderId) await settleFolder(sessionId, folderId, undefined, false);
  } catch (e) {
    console.warn('[live-backup] could not settle ' + sessionId, e);
  }
}

// ── Recovering from a backup ─────────────────────────────────────────────────

/** Brings a recording back from its Drive backup: downloads its parts into a
 *  local draft, then hands over to the ordinary crash recovery, which rebuilds
 *  the detections and saves the analysis. Returns that recovery's failure, if
 *  any; throws when the download itself fails. The backup is left on Drive
 *  until the recording is safe elsewhere. */
export async function restoreLiveBackup(
  offer: { sessionId: string; folderId: string; meta: LiveBackupMeta },
  onProgress?: (done: number, total: number) => void,
): Promise<RecoveryFailure | null> {
  const id = offer.sessionId;
  const files = await listCompanionChildren(offer.folderId, true);
  const parsed = files.map(f => ({ f, kind: parseBackupFileName(f.name) }));
  const audioParts = selectAudioParts(parsed.flatMap(({ f, kind }) =>
    kind?.kind === 'audio' ? [{ id: f.id, first: kind.first, last: kind.last }] : []));
  const windowParts = parsed.flatMap(({ f, kind }) =>
    kind?.kind === 'windows' ? [{ id: f.id, first: kind.first }] : []);
  const total = audioParts.length + windowParts.length;
  let done = 0;
  onProgress?.(done, total);

  // From a clean slate: leftovers under this id would be stitched in.
  await clearChunks(id);
  await deleteSessionWindows(id);

  for (const part of audioParts) {
    const blob = await downloadCompanionFile(part.id, true);
    if (!blob) throw new Error('backup_part_missing');
    // Drive may hand back a generic type; the recording's own is what decoding expects.
    await appendChunk(id, part.first, new Blob([blob], { type: offer.meta.mimeType }));
    onProgress?.(++done, total);
  }

  const windowSets: Array<{ first: number; windows: WindowResult[] }> = [];
  for (const part of windowParts) {
    const blob = await downloadCompanionFile(part.id, true);
    if (!blob) throw new Error('backup_part_missing');
    windowSets.push({ first: part.first, windows: JSON.parse(await blob.text()) as WindowResult[] });
    onProgress?.(++done, total);
  }
  await putSessionWindows(id, mergeWindowParts(windowSets));

  const draft: Analysis = {
    id,
    name: offer.meta.name,
    date: offer.meta.date,
    duration: offer.meta.durationS,
    mimeType: offer.meta.mimeType,
    source: offer.meta.source,
    status: 'recording',
    annotations: [],
  };
  await saveSessionMeta(draft);

  const failure = await retryRecovery(draft);
  if (!failure) {
    // Known from here on, so settleLiveBackup looks at it — it goes once the
    // audio is safe (copied to Drive, or kept here with copying off).
    _known.add(id);
    void settleLiveBackup(id);
  }
  return failure;
}
