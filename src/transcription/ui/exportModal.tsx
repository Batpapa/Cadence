import { render } from 'preact';
import { useState } from 'preact/hooks';
import { t } from '../../services/i18nService';
import { showModal, closeModal } from '../../components/modal';
import { copyText, downloadCadenceFile } from '../../services/fileTransfer';
import { ShareChoiceCard, SHARE_ICON_FILE_UP, SHARE_ICON_CLIPBOARD } from '../../session/ui/ShareSessionModal';

// ── Exporting a transcription's ABC ──────────────────────────────────────────
// A file or the clipboard, as the detections' text is exported
// (ExportDetectionsModal.tsx — the user, 2026-11-28: "like elsewhere").

function ExportAbc({ text, fileName }: { text: string; fileName: string }) {
  const [copied, setCopied] = useState<'no' | 'yes' | 'failed'>('no');
  return (
    <div class="space-y-2">
      <ShareChoiceCard
        icon={SHARE_ICON_FILE_UP}
        label={t('library.export.file')}
        desc={t('transcription.export.fileDesc', { name: fileName })}
        onClick={() => { downloadCadenceFile(text, fileName); closeModal(); }}
      />
      <ShareChoiceCard
        icon={SHARE_ICON_CLIPBOARD}
        label={copied === 'no' ? t('common.copyToClipboard') : t(copied === 'yes' ? 'common.copied' : 'common.copyFailed')}
        desc={t('common.copyToClipboardDesc')}
        onClick={() => {
          void copyText(text).then(ok => {
            setCopied(ok ? 'yes' : 'failed');
            // a failure keeps the dialog open: closing would read as success
            if (ok) setTimeout(closeModal, 900);
          });
        }}
      />
    </div>
  );
}

export function showExportAbcModal(text: string, fileName: string): void {
  const body = document.createElement('div');
  render(<ExportAbc text={text} fileName={fileName} />, body);
  showModal(t('transcription.menu.export'), body, [], { onDismiss: () => render(null, body) });
}
