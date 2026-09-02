import { signal, computed, type Signal } from '@preact/signals';
import type { AppState } from '../types';
import { t } from '../services/i18nService';
import { showModal, closeModal, renderModalBody } from './modal';
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

type Side = 'local' | 'drive';

/** One side of the choice, as a selectable card: which copy, how much is in it,
 *  when it was last touched, and what picking it costs the other side. */
function SideCard({ side, state, ts, choice }: {
  side: Side; state: AppState; ts: number; choice: Signal<Side | null>;
}) {
  const selected = choice.value === side;
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={() => { choice.value = side; }}
      class={'w-full text-left rounded-lg border px-3 py-2.5 cursor-pointer transition-colors '
        + (selected ? 'border-accent bg-accent/10' : 'border-border bg-bg hover:border-accent/60')}
    >
      <div class="flex items-center gap-2">
        {/* Drawn rather than a checkbox glyph so the whole card reads as one
            control; aria-checked above is what actually announces the state. */}
        <span
          class={'w-3.5 h-3.5 rounded-full border shrink-0 flex items-center justify-center '
            + (selected ? 'border-accent' : 'border-border')}
          aria-hidden="true"
        >
          {selected && <span class="w-1.5 h-1.5 rounded-full bg-accent" />}
        </span>
        <span class={'text-xs font-semibold ' + (selected ? 'text-accent' : 'text-primary')}>
          {t(side === 'local' ? 'settings.sync.conflict.local' : 'settings.sync.conflict.drive')}
        </span>
      </div>
      <div class="text-xs text-muted mt-1 ml-[22px]">
        {t('settings.sync.conflict.stats', {
          cards: Object.keys(state.cards ?? {}).length,
          reviews: countReviews(state),
        })}
      </div>
      <div class="text-xs text-dim mt-0.5 ml-[22px]">
        {ts > 0
          ? t('settings.sync.conflict.lastModified', { date: new Date(ts).toLocaleString() })
          : t('settings.sync.conflict.lastModifiedUnknown')}
      </div>
      <div class="text-xs text-dim mt-1 ml-[22px] italic">
        {t(side === 'local' ? 'settings.sync.conflict.localOverwrites' : 'settings.sync.conflict.driveOverwrites')}
      </div>
    </button>
  );
}

function ConflictBody({ remote, driveTs, choice }: {
  remote: AppState; driveTs: number; choice: Signal<Side | null>;
}) {
  return (
    <div class="space-y-3">
      <p class="text-sm text-muted leading-relaxed">{t('settings.sync.conflict.message')}</p>
      <div class="space-y-2" role="radiogroup" aria-label={t('settings.sync.conflict.title')}>
        <SideCard side="local" state={appState.value} ts={getLocalTimestamp()} choice={choice} />
        <SideCard side="drive" state={remote} ts={driveTs} choice={choice} />
      </div>
      <p class="text-xs text-dim leading-relaxed">{t('settings.sync.conflict.snapshotNote')}</p>
    </div>
  );
}

/** Local and Drive diverged: the user picks a side, then confirms.
 *
 *  Non-dismissable BY DESIGN, and it has to stay that way: there is no sane
 *  default here — one of the two copies is about to be overwritten either way,
 *  so an escape hatch would just mean answering later with less context, while
 *  every flush path stays frozen. `showModal(..., dismissable: false)` removes
 *  the ✕, the Escape handler and the click-outside, and the single action is
 *  disabled until a side is actually chosen, so the modal cannot be left
 *  without an answer.
 *
 *  While it is open, setConflictPending(true) freezes every flush path — a
 *  background push used to be able to answer in the user's place. */
export function showDriveConflictModal(remote: AppState, driveTs: number, version: string): void {
  setConflictPending(true);

  const choice = signal<Side | null>(null);
  const { el, cleanup } = renderModalBody(
    <ConflictBody remote={remote} driveTs={driveTs} choice={choice} />,
  );

  const resolve = async () => {
    const picked = choice.value;
    if (!picked) return; // unreachable — the button is disabled until then
    setConflictPending(false);
    closeModal();
    // renderModalBody's tree is ours to tear down: the shell only detaches the
    // node it was handed, and onDismiss never fires on a modal that cannot be
    // dismissed.
    cleanup();

    if (picked === 'local') {
      // The side being discarded is Drive's copy — stash it before the push
      // overwrites it.
      await saveSnapshot(appState.value.id, 'conflict-keep-local', remote);
      // The user arbitrated over exactly the version they were shown: adopt it
      // as base so the push's precondition passes over it — a THIRD write
      // landing meanwhile still fails it and re-asks.
      adoptDriveVersionAsBase(version);
      // Local wins: push it to Drive now, which also re-establishes the base.
      syncToCloud(appState.value);
      void manualSync();
    } else {
      // Also discards any buffered upload and settles the status (green) —
      // see markSyncedAfterApply.
      await applyDriveState(remote, driveTs, version, 'conflict-use-drive');
    }
  };

  showModal(t('settings.sync.conflict.title'), el, [
    {
      label: t('common.confirm'),
      primary: true,
      disabled: computed(() => choice.value === null),
      onClick: resolve,
    },
  ], false);
}
