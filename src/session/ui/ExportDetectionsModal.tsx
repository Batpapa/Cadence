import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { t } from '../../services/i18nService';
import { showModal, closeModal, updateTopModal } from '../../components/modal';
import { copyText } from '../../utils';
import { exportDetectedTunesCSV, exportDetectedTunesTXT, detectedTunesTextReport, type DetectedTuneLine } from '../../services/analysisExport';
import { ShareChoiceCard, SHARE_ICON_CSV, SHARE_ICON_TXT, SHARE_ICON_FILE_UP, SHARE_ICON_CLIPBOARD } from './ShareSessionModal';

// ── Export the Detections tab's selection (2026-10-28) ───────────────────────
// The card library's export, minus the Cadence Cards package: a tune heard is
// often a tune with no card, and a set the same. Same title, same two levels —
// the formats, then TXT's two destinations — so a user who has exported cards
// has nothing to learn here.

function ExportDetectionsModal({ lines }: { lines: DetectedTuneLine[] }) {
  const [view, setView] = useState<'root' | 'txt'>('root');
  const [copied, setCopied] = useState<'no' | 'yes' | 'failed'>('no');

  useEffect(() => {
    if (view === 'txt') updateTopModal({ title: 'TXT', onBack: () => setView('root') });
    else updateTopModal({ title: t('library.exportSelected'), onBack: undefined });
  }, [view]);

  if (view === 'txt') {
    return (
      <div class="space-y-2">
        <ShareChoiceCard
          icon={SHARE_ICON_FILE_UP}
          label={t('library.export.file')}
          desc={t('sessions.ranking.export.txtDesc')}
          color="var(--color-warn)"
          onClick={() => { exportDetectedTunesTXT(lines); closeModal(); }}
        />
        <ShareChoiceCard
          icon={SHARE_ICON_CLIPBOARD}
          label={copied === 'no' ? t('common.copyToClipboard') : t(copied === 'yes' ? 'common.copied' : 'common.copyFailed')}
          desc={t('common.copyToClipboardDesc')}
          color="var(--color-success)"
          onClick={() => {
            void copyText(detectedTunesTextReport(lines)).then(ok => {
              setCopied(ok ? 'yes' : 'failed');
              // A failure keeps the modal open: nothing reached the clipboard,
              // so closing would read as success.
              if (ok) setTimeout(closeModal, 900);
            });
          }}
        />
      </div>
    );
  }

  return (
    <div class="space-y-2">
      <ShareChoiceCard
        icon={SHARE_ICON_CSV}
        label="CSV"
        desc={t('library.export.csvDesc')}
        color="var(--color-success)"
        onClick={() => { exportDetectedTunesCSV(lines); closeModal(); }}
      />
      <ShareChoiceCard
        icon={SHARE_ICON_TXT}
        label="TXT"
        desc={t('sessions.ranking.export.txtDesc')}
        color="var(--color-muted)"
        onClick={() => setView('txt')}
      />
    </div>
  );
}

export function showExportDetectionsModal(lines: DetectedTuneLine[]): void {
  const body = document.createElement('div');
  render(<ExportDetectionsModal lines={lines} />, body);
  showModal(t('library.exportSelected'), body, []);
}
