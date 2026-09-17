import { useState } from 'preact/hooks';
import { t } from '../../services/i18nService';
import { showModal, closeModal, renderModalBody, confirmModal } from '../../components/modal';
import { fmtSessionDateTime } from '../sessionNaming';
import { fmtLongTime } from './sessionUiShared';
import {
  restoreLiveBackup, discardLiveBackup, postponeLiveBackup, type LiveBackupOffer,
} from '../liveBackup';
import type { RecoveryFailure } from '../recovery';
import { showRecoveryFailures } from './RecoveryFailureModal';

// ── A recording found on Drive but not on this device (2026-09-17) ─────────────
// What the live backup is for: this device lost its local data mid-recording
// (or before the recording could be saved), and the copy on Drive is all that
// is left. Offered only on the device that recorded it — see matchDevice.
//
// Unlike the local recovery failure, this one has a "Later": the question is
// asked on a guess when the device id changed and only the phone model matched,
// and a wrong guess must not corner anyone.

/** Offers on screen right now, so a second sweep (the library mounts again)
 *  does not stack a second dialog for the same recording. */
const _showing = new Set<string>();

function OfferBody({ offer, onClose }: { offer: LiveBackupOffer; onClose: (failure: RecoveryFailure | null) => void }) {
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { meta } = offer;

  const recover = async () => {
    setBusy(true);
    setError(null);
    try {
      const failure = await restoreLiveBackup(offer, (done, total) => setProgress({ done, total }));
      onClose(failure);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
      setProgress(null);
    }
  };

  const abandon = () => {
    confirmModal(
      t('sessions.liveBackup.offer.abandonTitle'),
      t('sessions.liveBackup.offer.abandonMessage'),
      t('sessions.liveBackup.offer.abandon'),
      () => {
        setBusy(true);
        void discardLiveBackup(offer.sessionId, true).finally(() => onClose(null));
      },
    );
  };

  const later = () => { postponeLiveBackup(offer.sessionId); onClose(null); };

  const progressText = progress === null ? null
    : progress.done < progress.total
      ? t('sessions.liveBackup.offer.downloading', { done: progress.done, total: progress.total })
      : t('sessions.liveBackup.offer.rebuilding');

  return (
    <div class="space-y-3 text-sm">
      <p class="text-muted leading-relaxed">{t('sessions.liveBackup.offer.intro')}</p>
      <div>
        <p class="text-primary font-semibold break-words">{meta.name || t('sessions.liveBackup.offer.unnamed')}</p>
        <p class="text-xs text-dim">
          {fmtSessionDateTime(meta.date)} · {t('sessions.liveBackup.offer.saved', { duration: fmtLongTime(meta.durationS) })}
        </p>
      </div>
      {offer.match === 'likely' && (
        <p class="text-xs text-dim leading-relaxed">{t('sessions.liveBackup.offer.sameDevice')}</p>
      )}
      {progressText && <p class="text-accent">{progressText}</p>}
      {error && <p class="text-xs font-mono text-danger break-words">{t('sessions.liveBackup.offer.failed', { error })}</p>}

      <div class="flex items-center justify-end gap-2 pt-3 border-t border-border">
        <button class="btn-ghost mr-auto" disabled={busy} onClick={later}>{t('sessions.liveBackup.offer.later')}</button>
        <button class="btn-danger" disabled={busy} onClick={abandon}>{t('sessions.liveBackup.offer.abandon')}</button>
        <button class="btn-primary" disabled={busy} onClick={() => { void recover(); }}>{t('sessions.liveBackup.offer.recover')}</button>
      </div>
    </div>
  );
}

/** One dialog per offer, one after the other. `onSettled` runs after each —
 *  a recovered recording has just joined the library. */
export function showLiveBackupOffers(offers: LiveBackupOffer[], onSettled: () => void): void {
  const [first, ...rest] = offers.filter(o => !_showing.has(o.sessionId));
  if (!first) return;
  _showing.add(first.sessionId);
  const { el, cleanup } = renderModalBody(
    <OfferBody
      offer={first}
      onClose={(failure) => {
        closeModal();
        cleanup();
        _showing.delete(first.sessionId);
        onSettled();
        // Downloaded fine, but rebuilding it failed: the recording is now a
        // local draft like any interrupted one, and gets the same dialog.
        if (failure) showRecoveryFailures([failure], onSettled, () => showLiveBackupOffers(rest, onSettled));
        else showLiveBackupOffers(rest, onSettled);
      }}
    />,
  );
  // No ✕ and no click-outside: "Later" is the way out that decides nothing.
  showModal(t('sessions.liveBackup.offer.title'), el, [], { dismissable: false });
}
