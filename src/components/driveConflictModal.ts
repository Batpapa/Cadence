import type { AppState } from '../types';
import { t } from '../services/i18nService';
import { showModal, closeModal } from './modal';
import { applyExternalData } from '../services/migration';
import {
  markSyncedAfterApply, adoptDriveVersionAsBase, setConflictPending,
  syncToCloud, manualSync, getLocalTimestamp,
} from '../services/driveService';
import { applyFromDrive, appState } from '../store';
import { saveSnapshot, countReviews, type SnapshotReason } from '../services/snapshotService';

// ── Shared Drive-state application + conflict resolution ─────────────────────
// Used by both the settings connect flow and the startup reconciliation, so a
// conflict at boot gets the exact same explicit choice as a manual reconnect.

/** Apply a Drive copy locally and record the new merge base. The local copy is
 *  about to be wholesale-replaced (IndexedDB included), so it is snapshotted
 *  FIRST — no sync decision is allowed to be an irreversible loss. */
export async function applyDriveState(
  raw: AppState, driveTs: number, version: string, reason: SnapshotReason = 'apply-drive',
): Promise<void> {
  await saveSnapshot(appState.value.id, reason, appState.value);
  await applyFromDrive(s => { Object.assign(s, applyExternalData(raw as unknown as Record<string, unknown>, s.id)); });
  markSyncedAfterApply(driveTs, version);
}

/** "Cards: 214 · Reviews: 1890" + "Last modified: …" for one side of the choice. */
function sideBlock(titleKey: string, state: AppState, ts: number): HTMLElement {
  const el = document.createElement('div');
  el.className = 'rounded border border-border bg-bg px-3 py-2';
  const title = document.createElement('div');
  title.className = 'text-xs font-semibold text-primary';
  title.textContent = t(titleKey);
  const stats = document.createElement('div');
  stats.className = 'text-xs text-muted mt-0.5';
  stats.textContent = t('settings.sync.conflict.stats', {
    cards: Object.keys(state.cards ?? {}).length,
    reviews: countReviews(state),
  });
  const when = document.createElement('div');
  when.className = 'text-xs text-dim mt-0.5';
  when.textContent = ts > 0
    ? t('settings.sync.conflict.lastModified', { date: new Date(ts).toLocaleString() })
    : t('settings.sync.conflict.lastModifiedUnknown');
  el.append(title, stats, when);
  return el;
}

/** Local and Drive diverged: let the user pick a side (non-dismissable).
 *  While it is open, setConflictPending(true) freezes every flush path — a
 *  background push used to be able to answer in the user's place. */
export function showDriveConflictModal(remote: AppState, driveTs: number, version: string): void {
  setConflictPending(true);

  const body = document.createElement('div');
  body.className = 'space-y-3';
  const msg = document.createElement('p');
  msg.className = 'text-sm text-muted leading-relaxed';
  msg.textContent = t('settings.sync.conflict.message');
  const note = document.createElement('p');
  note.className = 'text-xs text-dim leading-relaxed';
  note.textContent = t('settings.sync.conflict.snapshotNote');
  body.append(
    msg,
    sideBlock('settings.sync.conflict.local', appState.value, getLocalTimestamp()),
    sideBlock('settings.sync.conflict.drive', remote, driveTs),
    note,
  );

  showModal(t('settings.sync.conflict.title'), body, [
    {
      label: t('settings.sync.conflict.keepLocal'),
      onClick: () => {
        void (async () => {
          setConflictPending(false);
          closeModal();
          // The side being discarded is Drive's copy — stash it before the
          // push overwrites it.
          await saveSnapshot(appState.value.id, 'conflict-keep-local', remote);
          // The user arbitrated over exactly the version they were shown:
          // adopt it as base so the push's precondition passes over it — a
          // THIRD write landing meanwhile still fails it and re-asks.
          adoptDriveVersionAsBase(version);
          // Local wins: push it to Drive now, which also re-establishes the base.
          syncToCloud(appState.value);
          void manualSync();
        })();
      },
    },
    {
      label: t('settings.sync.conflict.useDrive'),
      onClick: () => {
        void (async () => {
          setConflictPending(false);
          closeModal();
          // Also discards any buffered upload and settles the status (green) —
          // see markSyncedAfterApply.
          await applyDriveState(remote, driveTs, version, 'conflict-use-drive');
        })();
      },
    },
  ], false);
}
