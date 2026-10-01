import { useState } from 'preact/hooks';
import { t } from '../services/i18nService';
import { saveFailure, reportSaveRecovered } from '../services/saveHealth';
import { retrySave } from '../store';
import { showModal, closeModal, renderModalBody } from './modal';
import { showStorageModal } from './storageModal';

/** What went wrong, what it costs, and that nothing has to be done beyond
 *  making room — in that order, because the person reading this may be in the
 *  middle of a session with a phone on the table.
 *
 *  Reads the signal live: a retry that succeeds while this is open shows it. */
function SaveFailureBody() {
  const failure = saveFailure.value;
  const [retrying, setRetrying] = useState(false);
  if (!failure) {
    return <p class="text-sm text-success leading-relaxed">{t('saveFailure.recovered')}</p>;
  }
  const library = failure.kinds.includes('library');
  const recording = failure.kinds.includes('recording');
  return (
    <div class="space-y-3 text-sm leading-relaxed">
      <p class="text-primary font-medium">
        {failure.quota ? t('saveFailure.quota') : t('saveFailure.other', { reason: failure.reason })}
      </p>
      {library && <p class="text-muted">{t('saveFailure.library')}</p>}
      {recording && <p class="text-muted">{t('saveFailure.recording')}</p>}
      <p class="text-muted">{t(library ? 'saveFailure.retryAuto' : 'saveFailure.makeRoom')}</p>
      {library && (
        <button
          class="btn-ghost text-xs"
          disabled={retrying}
          onClick={() => { setRetrying(true); void retrySave().finally(() => setRetrying(false)); }}
        >
          {retrying ? t('saveFailure.retrying') : t('saveFailure.retryNow')}
        </button>
      )}
    </div>
  );
}

/** Closing it acknowledges the recording's lost chunks — nothing will bring
 *  them back, so the red pill has told its story. The library failure stays
 *  until a write goes through: that one is still costing something. */
export function showSaveFailureModal(): void {
  const { el, cleanup } = renderModalBody(<SaveFailureBody />);
  const acknowledge = () => { reportSaveRecovered('recording'); cleanup(); };
  showModal(t('saveFailure.title'), el, [
    { label: t('saveFailure.openStorage'), onClick: () => { closeModal(); acknowledge(); showStorageModal(); } },
    { label: t('common.close'), primary: true, onClick: () => { closeModal(); acknowledge(); } },
  ], { maxWidth: '26rem', onDismiss: acknowledge });
}
