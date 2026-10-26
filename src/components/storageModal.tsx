import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { showModal } from './modal';
import { t } from '../services/i18nService';
import { formatBytes, formatDiskBytes } from '../utils';
import { ensurePersistentStorage, storageReport, assessStorage, effectivePersisted, type StorageReport } from '../services/storageService';

// ── "Where your data lives" ──────────────────────────────────────────────────
// Reached from the header warning, which appears when the browser has not
// granted persistent storage — or, in the Android app, when the device is
// nearly full (`lowDisk`). The panel answers the two questions that warning
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

  const refresh = () => { void storageReport().then(setReport); };
  useEffect(refresh, []);

  if (!report) return <p class="text-xs text-muted text-center py-3">{t('storage.reading')}</p>;

  const risk = assessStorage(effectivePersisted(report.persisted), report.usage, report.quota, report.free);
  const used = report.usage !== null ? formatBytes(report.usage) : t('storage.unknown');

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
      <p class={`text-xs leading-relaxed ${risk === 'full' || risk === 'lowDisk' ? 'text-danger' : risk === 'none' ? 'text-muted' : 'text-warn'}`}>
        {t(risk === 'lowDisk' ? 'storage.lowDisk'
          : risk === 'full' ? 'storage.full'
          : risk === 'none' ? 'storage.safe'
            : risk === 'refused' ? 'storage.atRisk' : 'storage.unknownState')}
      </p>

      <div>
        <Row
          label={t('storage.durability')}
          value={t(report.persisted === true ? 'storage.durable'
            : report.persisted === false ? 'storage.evictable' : 'storage.unknown')}
          tone={report.persisted === true ? 'ok' : 'warn'}
        />
        <Row label={t('storage.used')} value={used} />
        {/* Only where it is measured for real (the Android app): unlike the
            quota, this is the disk itself. */}
        {report.free !== null && (
          <Row label={t('storage.deviceFree')} value={formatDiskBytes(report.free)} tone={risk === 'lowDisk' ? 'danger' : undefined} />
        )}
        {/* No « still available » row (removed 2026-10-26): Chromium reports a
            made-up quota, usage + 10 GiB whatever the disk holds, so the figure
            was false for most users — 10 GB on a phone with 3 GB left. An
            estimate that cannot be trusted is not shown at all. */}
      </div>

      {(risk === 'refused' || risk === 'unknown') && (
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
