import type { AppState } from '../types';
import { t } from '../services/i18nService';
import { showModal, closeModal } from './modal';
import { applyExternalData } from '../services/migration';
import { markSynced, syncToCloud, manualSync } from '../services/driveService';
import { applyFromDrive, appState } from '../store';

// ── Shared Drive-state application + conflict resolution ─────────────────────
// Used by both the settings connect flow and the startup reconciliation, so a
// conflict at boot gets the exact same explicit choice as a manual reconnect.

/** Apply a Drive copy locally and record the new merge base. */
export async function applyDriveState(raw: AppState, driveTs: number): Promise<void> {
  await applyFromDrive(s => { Object.assign(s, applyExternalData(raw as unknown as Record<string, unknown>, s.id)); });
  markSynced(driveTs);
}

/** Local and Drive diverged: let the user pick a side (non-dismissable). */
export function showDriveConflictModal(remote: AppState, driveTs: number): void {
  const body = document.createElement('p');
  body.className = 'text-sm text-muted leading-relaxed';
  body.textContent = t('settings.sync.conflict.message');
  showModal(t('settings.sync.conflict.title'), body, [
    {
      label: t('settings.sync.conflict.keepLocal'),
      onClick: () => {
        closeModal();
        // Local wins: push it to Drive now, which also re-establishes the base.
        syncToCloud(appState.value);
        void manualSync();
      },
    },
    {
      label: t('settings.sync.conflict.useDrive'),
      onClick: async () => {
        closeModal();
        await applyDriveState(remote, driveTs);
      },
    },
  ], false);
}
