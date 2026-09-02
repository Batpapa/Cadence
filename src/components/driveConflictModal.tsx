import { signal, computed, type Signal } from '@preact/signals';
import type { AppState } from '../types';
import { t } from '../services/i18nService';
import { showModal, closeModal, renderModalBody } from './modal';
import { applyExternalData } from '../services/migration';
import {
  markSyncedAfterApply, adoptDriveVersionAsBase, setConflictPending,
  syncToCloud, manualSync, getLocalTimestamp, getDeviceId,
} from '../services/driveService';
import { applyFromDrive, appState } from '../store';
import { saveSnapshot, countReviews, type SnapshotReason } from '../services/snapshotService';
import { statesEqual, diffStates, type StateDiff, type CollectionDiff } from '../services/stateDiff';

// ── Shared Drive-state application + conflict resolution ─────────────────────
// Used by both the settings connect flow and the startup reconciliation, so a
// conflict at boot gets the exact same explicit choice as a manual reconnect.

/** TEMPORARY, OFF DURING AN OBSERVATION PERIOD (user's call, 2026-09-03 — "juste
 *  pendant quelques jours").
 *
 *  When true, a divergence whose two copies hold identical content resolves
 *  itself without a modal — see showDriveConflictModal for why that case exists
 *  and why it is safe. It is off for now precisely BECAUSE it is safe and
 *  silent: resolving those cases invisibly would hide the very reports needed
 *  to confirm that a lost upload acknowledgement is what single-device users
 *  are hitting. Until then the modal still appears, but says plainly that the
 *  two copies match, so nobody is asked to arbitrate blind.
 *
 *  The comparison itself runs either way, and the console line below fires
 *  either way — that is the observation. Flip this back to true to enable the
 *  fix; nothing else needs to change. */
const RESOLVE_IDENTICAL_SILENTLY = false;

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

/** What applying this Drive copy would actually put in place — the same
 *  migration `applyDriveState` runs, on a clone so nothing here can disturb the
 *  copy the caller still holds. Comparing anything else would be unfair: a
 *  pre-migration Drive file differs from local in FORM, not in content.
 *
 *  Falls back to the raw payload if the migration chokes on it. This function
 *  only feeds a comparison and a read-only screen, so degrading is fine —
 *  whereas throwing would leave the user with no conflict screen at all, which
 *  is strictly worse than the behaviour this replaced. */
function normalisedDrive(raw: AppState): AppState {
  try {
    return applyExternalData(structuredClone(raw) as unknown as Record<string, unknown>, appState.value.id);
  } catch {
    return raw;
  }
}

// ── The difference screen ────────────────────────────────────────────────────

function Row({ label, local, drive, changed }: { label: string; local: number; drive: number; changed: number }) {
  if (local === 0 && drive === 0 && changed === 0) return null;
  const cell = (n: number, emphasise: boolean) => (
    <td class={'text-right py-1 tabular-nums ' + (n === 0 ? 'text-dim' : emphasise ? 'text-primary font-semibold' : 'text-muted')}>
      {n === 0 ? '—' : n}
    </td>
  );
  return (
    <tr class="border-t border-border">
      <td class="py-1 pr-3 text-muted">{label}</td>
      {cell(local, true)}
      {cell(drive, true)}
      {cell(changed, false)}
    </tr>
  );
}

const counts = (c: CollectionDiff) => ({ local: c.onlyLocal.length, drive: c.onlyDrive.length, changed: c.changed.length });

function DiffBody({ diff, driveDeviceId, identical }: { diff: StateDiff; driveDeviceId: string | null; identical: boolean }) {
  const sameDevice = driveDeviceId !== null && driveDeviceId === getDeviceId();
  const fmtDate = (ts: number | null) => (ts ? new Date(ts).toLocaleString() : null);
  const moduleTotals = diff.modules.reduce(
    (a, m) => ({ local: a.local + m.onlyLocal, drive: a.drive + m.onlyDrive, changed: a.changed + m.changed }),
    { local: 0, drive: 0, changed: 0 },
  );

  return (
    <div class="space-y-4">
      <p class="text-sm text-muted leading-relaxed">
        {identical
          ? t('settings.sync.diff.verdictIdentical')
          : diff.oneSided
            ? t(diff.oneSided === 'local' ? 'settings.sync.diff.verdictOnlyLocal' : 'settings.sync.diff.verdictOnlyDrive')
            : t('settings.sync.diff.verdictBoth')}
      </p>

      {/* The strongest diagnostic on this screen: a Drive copy written by THIS
          device means the divergence is almost certainly our own earlier push
          whose acknowledgement was lost, not a second writer. */}
      {sameDevice && (
        <p class="text-xs text-dim leading-relaxed border-l-2 border-border pl-3">
          {t('settings.sync.diff.sameDeviceHint')}
        </p>
      )}

      <div class="overflow-x-auto">
        <table class="w-full text-xs">
          <thead>
            <tr class="text-dim">
              <th class="text-left font-medium pb-1" />
              <th class="text-right font-medium pb-1 pl-3">{t('settings.sync.conflict.local')}</th>
              <th class="text-right font-medium pb-1 pl-3">{t('settings.sync.conflict.drive')}</th>
              <th class="text-right font-medium pb-1 pl-3">{t('settings.sync.diff.changed')}</th>
            </tr>
          </thead>
          <tbody>
            <Row label={t('settings.sync.diff.reviews')} local={diff.reviews.onlyLocal} drive={diff.reviews.onlyDrive} changed={0} />
            <Row label={t('settings.sync.diff.cards')} {...counts(diff.cards)} />
            <Row label={t('settings.sync.diff.decks')} {...counts(diff.decks)} />
            <Row label={t('settings.sync.diff.folders')} {...counts(diff.folders)} />
            <Row label={t('settings.sync.diff.profiles')} {...counts(diff.profiles)} />
            <Row label={t('settings.sync.diff.modules')} {...moduleTotals} />
          </tbody>
        </table>
      </div>

      {(diff.reviews.latestOnlyLocal || diff.reviews.latestOnlyDrive) && (
        <div class="text-xs text-dim space-y-0.5">
          {diff.reviews.latestOnlyLocal && (
            <div>{t('settings.sync.diff.latestLocal', { date: fmtDate(diff.reviews.latestOnlyLocal)! })}</div>
          )}
          {diff.reviews.latestOnlyDrive && (
            <div>{t('settings.sync.diff.latestDrive', { date: fmtDate(diff.reviews.latestOnlyDrive)! })}</div>
          )}
        </div>
      )}

      {diff.settings.length > 0 && (
        <div class="space-y-1">
          <div class="text-xs font-semibold text-primary">{t('settings.sync.diff.settings')}</div>
          {diff.settings.map(s => (
            <div key={s.field} class="text-xs text-muted">
              <span class="text-dim">{s.field}</span>{' : '}
              {JSON.stringify(s.local)} <span class="text-dim">→</span> {JSON.stringify(s.drive)}
            </div>
          ))}
        </div>
      )}

      {/* statesEqual said they differ, so if nothing above shows anything the
          difference is real but outside every category — ordering, or a field
          added since this screen was written. Say so rather than show a blank
          panel that reads as "nothing to see". */}
      {diff.summarised && !identical && (
        <p class="text-xs text-dim leading-relaxed">{t('settings.sync.diff.outsideCategories')}</p>
      )}
    </div>
  );
}

function showDiffModal(diff: StateDiff, driveDeviceId: string | null, identical: boolean): void {
  const { el, cleanup } = renderModalBody(<DiffBody diff={diff} driveDeviceId={driveDeviceId} identical={identical} />);
  showModal(
    t('settings.sync.diff.title'), el,
    [{ label: t('common.close'), onClick: () => { closeModal(); cleanup(); } }],
    true, '30rem',
    cleanup,   // also torn down if dismissed by Escape / click-outside / ✕
  );
}

// ── The choice ───────────────────────────────────────────────────────────────

type Side = 'local' | 'drive';

/** One side of the choice, as a selectable card: which copy, how much is in it,
 *  when it was last touched, and what picking it costs the other side. */
function SideCard({ side, state, ts, choice, deviceNote }: {
  side: Side; state: AppState; ts: number; choice: Signal<Side | null>; deviceNote?: string;
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
      {deviceNote && <div class="text-xs text-dim mt-0.5 ml-[22px]">{deviceNote}</div>}
      <div class="text-xs text-dim mt-1 ml-[22px] italic">
        {t(side === 'local' ? 'settings.sync.conflict.localOverwrites' : 'settings.sync.conflict.driveOverwrites')}
      </div>
    </button>
  );
}

function ConflictBody({ drive, driveTs, choice, driveDeviceId, identical }: {
  drive: AppState; driveTs: number; choice: Signal<Side | null>; driveDeviceId: string | null; identical: boolean;
}) {
  const deviceNote = driveDeviceId === null
    ? t('settings.sync.conflict.deviceUnknown')
    : driveDeviceId === getDeviceId()
      ? t('settings.sync.conflict.deviceSame')
      : t('settings.sync.conflict.deviceOther');
  return (
    <div class="space-y-3">
      <p class="text-sm text-muted leading-relaxed">{t('settings.sync.conflict.message')}</p>
      {/* The bookkeeping says "both moved" while the contents match — the case
          RESOLVE_IDENTICAL_SILENTLY exists for. Saying so turns a worrying
          choice into a harmless one. */}
      {identical && (
        <p class="text-xs text-primary leading-relaxed border-l-2 border-accent pl-3">
          {t('settings.sync.conflict.identicalNote')}
        </p>
      )}
      <div class="space-y-2" role="radiogroup" aria-label={t('settings.sync.conflict.title')}>
        <SideCard side="local" state={appState.value} ts={getLocalTimestamp()} choice={choice} />
        <SideCard side="drive" state={drive} ts={driveTs} choice={choice} deviceNote={deviceNote} />
      </div>
      <p class="text-xs text-dim leading-relaxed">{t('settings.sync.conflict.snapshotNote')}</p>
    </div>
  );
}

/** Resolve a Drive divergence — asking the user only if there is something to
 *  ask.
 *
 *  IDENTICAL COPIES ARE NOT A CONFLICT (2026-09-02). The bookkeeping can say
 *  "both sides moved" while the two files hold exactly the same thing: a push
 *  that reached Drive but whose acknowledgement never came back (tab killed,
 *  network dropped, PWA suspended mid-request) leaves Drive holding our own
 *  content under a version we never recorded, and the local edit counter still
 *  reads unsynced. `decideReconcile` cannot tell that apart from a second
 *  writer — it only sees counters — so the content itself is asked here, and
 *  when it matches there is nothing to arbitrate: adopt Drive's version as the
 *  new base and move on. Users on a SINGLE device were being handed this modal
 *  regularly, over two copies that were the same.
 *
 *  The check lives here rather than at either call site so the invariant holds
 *  for every caller, now and later, and it uses `statesEqual` (a total deep
 *  comparison) rather than the readable diff — a summary that missed a field
 *  would silently discard it.
 *
 *  Otherwise: non-dismissable BY DESIGN, and it has to stay that way. There is
 *  no sane default — one of the two copies is about to be overwritten either
 *  way — so an escape hatch would just mean answering later with less context
 *  while every flush path stays frozen. `showModal(..., dismissable: false)`
 *  removes the ✕, the Escape handler and the click-outside, and the single
 *  action is disabled until a side is chosen. While it is open,
 *  setConflictPending(true) freezes every flush path — a background push used
 *  to be able to answer in the user's place. */
export function showDriveConflictModal(
  remote: AppState, driveTs: number, version: string, driveDeviceId: string | null = null,
): void {
  const drive = normalisedDrive(remote);

  const identical = statesEqual(appState.value, drive);
  if (identical) {
    console.info('[drive] divergence sans différence de contenu'
      + (driveDeviceId === getDeviceId() ? ' — copie Drive écrite par cet appareil' : '')
      + (RESOLVE_IDENTICAL_SILENTLY ? ' — résolue sans intervention' : ' — modale affichée (période d observation)'));
    if (RESOLVE_IDENTICAL_SILENTLY) {
      // Nothing is applied: the two copies already hold the same thing, so only
      // the bookkeeping is behind. Recording the sync point adopts Drive's
      // version as the new base, which is what stops this recurring on every
      // boot, and settles the cloud indicator.
      markSyncedAfterApply(driveTs, version);
      return;
    }
  }

  setConflictPending(true);

  const choice = signal<Side | null>(null);
  const { el, cleanup } = renderModalBody(
    <ConflictBody drive={drive} driveTs={driveTs} choice={choice} driveDeviceId={driveDeviceId} identical={identical} />,
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
      // see markSyncedAfterApply. Applies the ORIGINAL payload, not the
      // normalised copy, so this path stays exactly what it has always been.
      await applyDriveState(remote, driveTs, version, 'conflict-use-drive');
    }
  };

  showModal(t('settings.sync.conflict.title'), el, [
    {
      label: t('settings.sync.conflict.seeDifferences'),
      align: 'start',
      onClick: () => showDiffModal(diffStates(appState.value, drive), driveDeviceId, identical),
    },
    {
      label: t('common.confirm'),
      primary: true,
      disabled: computed(() => choice.value === null),
      onClick: resolve,
    },
  ], false);
}
