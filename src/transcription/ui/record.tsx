import { computed } from '@preact/signals';
import { t } from '../../services/i18nService';
import { showModal, closeModal, renderModalBody, askUnsavedChanges, MODAL_W } from '../../components/modal';
import { Take, RecorderRow, stampedName } from '../../components/recordMicModal';
import { audioExtension } from '../../services/zip';
import type { LiveSourceKind } from '../../session/audio/sources';
import { startSetup } from './state';

// ── A recording made to be transcribed ───────────────────────────────────────
// The microphone, or the sound the device plays: the attachment recorder's
// take (recordMicModal.tsx) and its recording row, then on to the setup with
// the take. Held in memory, as the attachment's: minutes, not the hours the
// analyser's crash-safe recorder was built for.

function RecordBody({ take }: { take: Take }) {
  return (
    <div class="space-y-3">
      <RecorderRow
        phase={take.phase.value}
        elapsedMs={() => take.elapsedMs()}
        level={() => take.level()}
        onStart={() => take.start()}
        onStop={() => void take.stop()}
      />
      {take.error.value && <p class="text-xs text-danger">{take.error.value}</p>}
    </div>
  );
}

/** From the tap: the take starts at once (the device's share picker, and the
 *  iPhone's audio session, both need the tap itself). */
export function showRecordForTranscription(kind: LiveSourceKind, folder: string | null = null): void {
  const take = new Take(kind);
  take.start();
  const { el, cleanup } = renderModalBody(<RecordBody take={take} />);
  const dispose = () => { take.release(); cleanup(); };
  const next = async () => {
    const blob = await take.settle();
    closeModal();
    dispose();
    if (!blob) return;
    const mimeType = blob.type.split(';')[0]!.trim() || 'audio/webm';
    const name = `${stampedName()}.${audioExtension(mimeType)}`;
    void startSetup(new File([blob], name, { type: mimeType }), name, kind, folder);
  };
  showModal(t(kind === 'device' ? 'transcription.record.titleDevice' : 'transcription.record.title'), el, [
    {
      label: t('transcription.record.next'),
      primary: true,
      disabled: computed(() => take.phase.value !== 'stopped'),
      onClick: () => void next(),
    },
  ], {
    maxWidth: MODAL_W.s,
    onDismiss: dispose,
    // A take is work: leaving asks first, as the attachment's recorder does.
    guardDismiss: (dismiss) => {
      if (!take.holdsTake) return false;
      askUnsavedChanges({
        message: t('unsaved.message.recording'),
        saveLabel: t('transcription.record.next'),
        save: async () => { await next(); return false; },
        discard: () => {},
        proceed: dismiss,
      });
      return true;
    },
  });
}
