import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { showModal } from './modal';
import { t } from '../services/i18nService';
import { formatBytes } from '../utils';
import { appState } from '../store';
import { ensurePersistentStorage, storageReport, assessStorage, type StorageReport } from '../services/storageService';

// ── "Where your data lives" ──────────────────────────────────────────────────
// Reached from the header warning, which only appears when the browser has not
// granted persistent storage. The panel answers the two questions that warning
// raises — is my work safe, and how much room is left — and offers the one
// action that can change the first.

function Row({ label, value, tone }: { label: string; value: string; tone?: 'warn' | 'danger' | 'ok' }) {
  const colour = tone === 'danger' ? 'text-danger' : tone === 'warn' ? 'text-warn' : tone === 'ok' ? 'text-success' : 'text-primary';
  return (
    <div class="flex items-baseline justify-between gap-4 py-1.5 border-b border-border/50 last:border-0">
      <span class="text-xs text-muted shrink-0">{label}</span>
      <span class={`text-xs font-medium text-right ${colour}`}>{value}</span>
    </div>
  );
}

function StorageBody() {
  const [report, setReport] = useState<StorageReport | null>(null);
  const [asking, setAsking] = useState(false);
  // What the browser answered to the button, as opposed to what it answered at
  // boot: the row above already shows the state, but a button that changes
  // nothing visible when the answer is "no" reads as a button that is broken.
  const [outcome, setOutcome] = useState<'granted' | 'refused' | null>(null);

  const refresh = () => { void storageReport(appState.value.id).then(setReport); };
  useEffect(refresh, []);

  if (!report) return <p class="text-xs text-muted text-center py-3">{t('storage.reading')}</p>;

  const risk = assessStorage(report.persisted);
  const used = report.usage !== null ? formatBytes(report.usage) : t('storage.unknown');
  const free = report.quota !== null && report.usage !== null ? formatBytes(report.quota - report.usage) : t('storage.unknown');

  const ask = () => {
    setAsking(true);
    setOutcome(null);
    void ensurePersistentStorage().then(granted => {
      setAsking(false);
      // null — no StorageManager at all — is not a grant, and saying so is more
      // useful than leaving the button silent.
      setOutcome(granted === true ? 'granted' : 'refused');
      refresh();
    });
  };

  return (
    <div class="space-y-4">
      {/* The verdict first, in words, because "persistent storage: false" is
          not something anyone should have to interpret. */}
      <p class={`text-xs leading-relaxed ${risk === 'none' ? 'text-muted' : 'text-warn'}`}>
        {t(risk === 'none' ? 'storage.safe' : risk === 'refused' ? 'storage.atRisk' : 'storage.unknownState')}
      </p>

      <div>
        <Row
          label={t('storage.durability')}
          value={t(risk === 'none' ? 'storage.durable' : risk === 'refused' ? 'storage.evictable' : 'storage.unknown')}
          tone={risk === 'none' ? 'ok' : 'warn'}
        />
        <Row label={t('storage.used')} value={used} />
        <Row label={t('storage.free')} value={free} />
        <Row
          label={t('storage.recordings')}
          value={report.audioBytes !== null
            ? t('storage.recordingsValue', { count: String(report.audioCount ?? 0), size: formatBytes(report.audioBytes) })
            : t('storage.unknown')}
        />
      </div>

      {risk !== 'none' && (
        <button class="btn-primary w-full text-sm" disabled={asking} onClick={ask}>
          {t(asking ? 'storage.asking' : 'storage.askAgain')}
        </button>
      )}

      {outcome && (
        <p class={`text-xs leading-relaxed ${outcome === 'granted' ? 'text-success' : 'text-warn'}`}>
          {t(outcome === 'granted' ? 'storage.askGranted' : 'storage.askRefused')}
        </p>
      )}
    </div>
  );
}

export function showStorageModal(): void {
  const body = document.createElement('div');
  render(<StorageBody />, body);
  showModal(t('storage.title'), body, [], { maxWidth: '22rem' });
}
