import { useEffect } from 'preact/hooks';
import { t } from '../../services/i18nService';
import { appState } from '../../store';
import { showModal, renderModalBody, MODAL_W } from '../../components/modal';
import { SYNC_AUDIO_BY_DEFAULT } from '../../session/db';
import { AudioUploadsBlock, AudioDownloadsBlock, type AudioSettingsBinding } from '../../session/ui/audioSettingsBlocks';
import { transcriptionModuleOf } from '../model';
import { transcriptionAudio, transcriptionDownloads, setTranscriptionSyncByDefault } from '../audioSync';

// ── The module's settings (2026-11-28) ───────────────────────────────────────
// Behind a gear on the module's page, as the analyser's (sessionSettingsModal
// .tsx): its recordings and Drive — the way there, the way back — in the
// analyser's own blocks (audioSettingsBlocks.tsx), its own choices. Nothing
// else to set yet, so the gear is there only with Drive connected: without a
// Drive there is nothing for these to mean (the analyser's rule for the same
// blocks).

const TRANSCRIPTION_AUDIO: AudioSettingsBinding = {
  audio: transcriptionAudio,
  downloads: transcriptionDownloads,
  syncByDefault: () => transcriptionModuleOf(appState.value)?.syncAudioByDefault ?? SYNC_AUDIO_BY_DEFAULT,
  setSyncByDefault: setTranscriptionSyncByDefault,
  nameOf: (id) => transcriptionModuleOf(appState.value)?.transcriptions[id]?.name ?? '',
  get texts() {
    return { uploadManualDetail: t('transcription.syncAudio.manual.detail'), downloadHint: t('transcription.download.hint') };
  },
};

function SettingsBody() {
  // Checked against the folder the moment this panel opens, where the backlog
  // is read: a recording whose file is gone from Drive rejoins it (the
  // analyser's panel, for the reason given there).
  useEffect(() => { void transcriptionAudio.reconcile(); }, []);
  return (
    <div class="space-y-4">
      <AudioUploadsBlock binding={TRANSCRIPTION_AUDIO} />
      <hr class="border-border" />
      <AudioDownloadsBlock binding={TRANSCRIPTION_AUDIO} />
    </div>
  );
}

export function showTranscriptionSettingsModal(): void {
  const { el, cleanup } = renderModalBody(<SettingsBody />);
  // No footer: nothing to confirm, so nothing to press.
  showModal(t('transcription.settings.title'), el, [], { maxWidth: MODAL_W.m, onDismiss: cleanup });
}
