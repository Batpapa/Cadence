import type { ComponentChild } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { t } from '../../services/i18nService';
import { formatBytes } from '../../utils';
import { IconButton } from '../../components/ui';
import { HelpIcon } from '../../components/icons';
import { CustomSelect } from '../../components/customSelect';
import { appState } from '../../store';
import { knowsNetworkType } from '../network';
import type { CompanionAudio, AutoUploadState } from '../companionAudio';
import type { AudioDownloads, AutoDownloadStatus, DownloadAllResult } from '../audioDownloads';

// ── A module's recordings and Drive, in its settings ─────────────────────────
// Out of sessionSettingsModal.tsx on 2026-11-28, when the Transcription module
// got the analyser's way with Drive: the same two blocks — the way there, the
// way back — drawn for either module from its own companionAudio and
// audioDownloads, with the few words that name what the module keeps.

/** What the blocks act on, and the words that are the module's own. */
export interface AudioSettingsBinding {
  audio: CompanionAudio;
  downloads: AudioDownloads;
  /** The module's synced choice, as stored (absence read as its default). */
  syncByDefault: () => boolean;
  setSyncByDefault: (on: boolean) => Promise<void>;
  /** A record's name, for the line that says which one is coming down. */
  nameOf: (id: string) => string;
  /** The manual copy's detail, and the way back's explanation: where the
   *  module's own buttons are. */
  texts: { uploadManualDetail: string; downloadHint: string };
}

/** A block's heading, with its explanation on demand — SettingRow's `?`,
 *  for a block whose choice is not a checkbox. */
export function BlockTitle({ label, hint }: { label: string; hint: ComponentChild }) {
  const [hintOpen, setHintOpen] = useState(false);
  return (
    <>
      <div class="flex items-center gap-1.5">
        <span class="text-sm text-primary flex-1 min-w-0">{label}</span>
        <IconButton
          label={t('settings.explain')}
          on={hintOpen}
          aria-expanded={hintOpen}
          onClick={() => setHintOpen(o => !o)}
        >
          <HelpIcon size={14} />
        </IconButton>
      </div>
      {/* A div, not a p: a hint may hold more than a sentence — the name
          template's list of fields. */}
      {hintOpen && (
        <div class="text-xs text-dim leading-relaxed px-3 py-2 rounded-lg border border-border bg-bg">{hint}</div>
      )}
    </>
  );
}

/** One choice among a few, drawn as a card with its own radio dot — the export
 *  choice's look (settingsModal.tsx), so the two read as the same control. */
function ChoiceCard({ selected, label, detail, onSelect, aside, footer }: {
  selected: boolean; label: string; detail?: string; onSelect: () => void;
  /** Beside the label — a control of its own, so the card is not a <button>
   *  (one may not hold another) and that control keeps its clicks. */
  aside?: ComponentChild;
  /** Under the detail. */
  footer?: ComponentChild;
}) {
  return (
    <div
      role="radio"
      tabIndex={0}
      aria-checked={selected}
      onClick={onSelect}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(); } }}
      class={'w-full text-left rounded-lg border px-3 py-2 transition-colors cursor-pointer '
        + (selected ? 'border-accent bg-accent/10' : 'border-border bg-bg hover:border-accent/60')}
    >
      <div class="flex items-start gap-2">
        <span
          class={'mt-[3px] w-3.5 h-3.5 rounded-full border shrink-0 flex items-center justify-center '
            + (selected ? 'border-accent' : 'border-border')}
          aria-hidden="true"
        >
          {selected && <span class="w-1.5 h-1.5 rounded-full bg-accent" />}
        </span>
        <span class="min-w-0 flex-1">
          <span class="flex items-center gap-2">
            <span class={'text-sm flex-1 min-w-0 ' + (selected ? 'text-accent' : 'text-primary')}>{label}</span>
            {aside && <span class="shrink-0" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>{aside}</span>}
          </span>
          {detail && <span class="block text-xs text-muted leading-snug mt-0.5">{detail}</span>}
          {footer}
        </span>
      </div>
    </div>
  );
}

/** Wi-Fi only, or any network — beside an "Automatic" choice. Only where it
 *  can mean something: a device that tells its networks apart
 *  (knowsNetworkType). Elsewhere it would be a choice with no effect. */
function NetworkSelect({ wifiOnly, onChange }: { wifiOnly: boolean; onChange: (wifiOnly: boolean) => void }) {
  if (!knowsNetworkType()) return null;
  // The app's own select, never a native one: same list everywhere, themed,
  // and closed by the back gesture like any other overlay.
  return (
    <CustomSelect
      value={wifiOnly ? 'wifi' : 'always'}
      options={[
        { value: 'wifi', label: t('sessions.download.network.wifi') },
        { value: 'always', label: t('sessions.download.network.always') },
      ]}
      onChange={(v) => onChange(v === 'wifi')}
      align="right"
      triggerClass="flex items-center gap-1.5 text-xs bg-bg text-primary border border-border rounded px-2 py-0.5 cursor-pointer hover:border-accent"
    />
  );
}

function StatusLine({ text }: { text: string }) {
  return <span class="block text-xs text-primary leading-snug mt-1.5">{text}</span>;
}

/** Copies every recording this device holds that is not on Drive yet.
 *
 *  The setting above only ever applied to recordings saved AFTER it was
 *  switched on, which is not what "copy my recordings to Drive" sounds like — a
 *  user turned it on, saw nothing happen to their library, and reported the
 *  sync as broken. This is the missing half: the backlog, with its size stated
 *  before anything is spent, and disabled once there is none. */
function BackfillRow({ audio }: { audio: CompanionAudio }) {
  const [pending, setPending] = useState<{ ids: string[]; bytes: number } | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [result, setResult] = useState<{ ok: number; failed: number } | null>(null);

  const refresh = () => { void audio.pendingUploads().then(setPending); };
  // Re-read on every state change, not just on mount: the panel reconciles
  // its Drive records when it opens, and a recording whose file turned out to
  // be gone becomes work for this very button.
  useEffect(refresh, [appState.value]);

  if (!pending) return null;

  const nothingToDo = pending.ids.length === 0;

  const run = () => {
    setResult(null);
    setProgress({ done: 0, total: pending.ids.length });
    void audio.uploadPending((done, total) => setProgress({ done, total }))
      .then(r => { setResult(r); setProgress(null); refresh(); });
  };

  // No rule of its own: it belongs to the setting above it, and the panel draws
  // its separators between BLOCKS.
  return (
    <div class="space-y-2">
      {/* The same button as "download everything" below: the two are each
          other's mirror. */}
      <button class="btn-outline w-full" disabled={nothingToDo || progress !== null} onClick={run}>
        {progress
          ? t('sessions.syncAudio.backfill.running', { done: String(progress.done), total: String(progress.total) })
          : nothingToDo
            ? t('sessions.syncAudio.backfill.allDone')
            : t('sessions.syncAudio.backfill.action', {
              count: String(pending.ids.length),
              size: formatBytes(pending.bytes),
            })}
      </button>
      {result && (
        <p class={result.failed ? 'text-xs text-warn' : 'text-xs text-success'}>
          {result.failed
            ? t('sessions.syncAudio.backfill.partial', { ok: String(result.ok), failed: String(result.failed) })
            : t('sessions.syncAudio.backfill.done', { ok: String(result.ok) })}
        </p>
      )}
    </div>
  );
}

/** Where the automatic copies stand, from the per-recording states
 *  companionAudio.ts publishes. Nothing when nothing is pending: the button
 *  below says the rest. */
function autoUploadLine(states: Readonly<Record<string, AutoUploadState>>): string | null {
  const all = Object.values(states);
  const count = (s: AutoUploadState) => all.filter(x => x === s).length;
  if (count('uploading')) return t('sessions.syncAudio.status.uploading', { count: all.length });
  if (count('wifi')) return t('sessions.syncAudio.status.wifi', { count: count('wifi') });
  if (count('waiting')) return t('sessions.syncAudio.status.failed', { count: count('waiting') });
  return null;
}

/** How this user's new recordings reach Drive (2026-10-09, laid out like the
 *  way back below at the user's request). The choice itself is the module's
 *  synced one — a user's recordings are protected on all their devices or
 *  none; the network it may use is this device's (companionAudio.ts). */
export function AudioUploadsBlock({ binding }: { binding: AudioSettingsBinding }) {
  const { audio } = binding;
  const auto = binding.syncByDefault();
  const line = auto ? autoUploadLine(audio.autoUploadState.value) : null;
  return (
    <div class="space-y-2">
      <BlockTitle label={t('sessions.syncAudio.title')} hint={t('sessions.syncAudio.hint')} />
      <div class="space-y-1.5" role="radiogroup" aria-label={t('sessions.syncAudio.title')}>
        <ChoiceCard
          selected={!auto}
          label={t('sessions.syncAudio.mode.manual')}
          detail={binding.texts.uploadManualDetail}
          onSelect={() => { void binding.setSyncByDefault(false); }}
        />
        <ChoiceCard
          selected={auto}
          label={t('sessions.syncAudio.mode.auto')}
          detail={t('sessions.syncAudio.mode.auto.detail')}
          onSelect={() => { void binding.setSyncByDefault(true); }}
          aside={auto ? <NetworkSelect wifiOnly={audio.uploadOnWifiOnly.value} onChange={audio.setUploadOnWifiOnly} /> : undefined}
          footer={line ? <StatusLine text={line} /> : undefined}
        />
      </div>
      {/* No "N audios on Drive — X MB" line any more (2026-10-09, the user):
          Settings → Storage already says it. */}
      <BackfillRow audio={audio} />
    </div>
  );
}

/** Where the automatic mode stands, in one line under its choices. */
function autoDownloadLine(s: AutoDownloadStatus | null, progress: Readonly<Record<string, number>>, nameOf: (id: string) => string): string | null {
  if (!s) return null;
  const left = { count: s.remaining, size: formatBytes(s.bytes) };
  if (s.current) {
    return t('sessions.download.status.downloading', { name: nameOf(s.current), percent: Math.round((progress[s.current] ?? 0) * 100), ...left });
  }
  switch (s.blocked) {
    case 'offline': return t('sessions.download.status.offline', left);
    case 'wifi':    return t('sessions.download.status.wifi', left);
    case 'space':   return t('sessions.download.status.space', left);
    case 'token':   return t('sessions.download.status.token', left);
    case 'failed':  return t('sessions.download.status.failed', left);
  }
  // Everything is here: the button below already says so. What it does not
  // say is what was left on Drive on purpose.
  return s.freed > 0 ? t('sessions.download.status.freed', { count: s.freed }) : null;
}

/** Spelt out rather than built from the mode, so the key check
 *  (i18nKeys.test.ts) can see every one of them. */
const DOWNLOAD_MODES = [
  ['manual', 'sessions.download.mode.manual', 'sessions.download.mode.manual.detail'],
  ['auto', 'sessions.download.mode.auto', 'sessions.download.mode.auto.detail'],
] as const;

/** How the recordings that are on Drive come onto this device (2026-10-09):
 *  see audioDownloads.ts. Per device, so it says so. */
export function AudioDownloadsBlock({ binding }: { binding: AudioSettingsBinding }) {
  const { audio, downloads } = binding;
  const mode = downloads.mode.value;
  const line = mode === 'auto' ? autoDownloadLine(downloads.status.value, audio.downloadProgress.value, binding.nameOf) : null;
  // Looked at now, so the line says where things stand rather than nothing
  // until the next pass — and a pass that had stopped (no Wi-Fi then) gets
  // another go. One pass at a time, so this cannot start a second.
  useEffect(() => { if (downloads.mode.value === 'auto') void downloads.runAuto(); }, []);
  return (
    <div class="space-y-2">
      <BlockTitle label={t('sessions.download.title')} hint={binding.texts.downloadHint} />
      <div class="space-y-1.5" role="radiogroup" aria-label={t('sessions.download.title')}>
        {DOWNLOAD_MODES.map(([m, label, detail]) => (
          <ChoiceCard
            key={m}
            selected={mode === m}
            label={t(label)}
            detail={t(detail)}
            onSelect={() => downloads.setMode(m)}
            aside={m === 'auto' && mode === 'auto'
              ? <NetworkSelect wifiOnly={downloads.wifiOnly.value} onChange={downloads.setWifiOnly} />
              : undefined}
            footer={m === 'auto' && line ? <StatusLine text={line} /> : undefined}
          />
        ))}
      </div>
      <DownloadAllRow audio={audio} downloads={downloads} />
    </div>
  );
}

/** Every recording that is on Drive and not here, in one go, whatever the mode
 *  — promised to a user who wanted everything on the phone before leaving the
 *  Wi-Fi. The mirror of BackfillRow, and the same discipline: the size is
 *  stated before anything is spent. Freed recordings included: it is a request. */
function DownloadAllRow({ audio, downloads }: { audio: CompanionAudio; downloads: AudioDownloads }) {
  const [pending, setPending] = useState<{ count: number; bytes: number } | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [result, setResult] = useState<DownloadAllResult | null>(null);

  const refresh = () => {
    void audio.driveOnly().then(list => setPending({ count: list.length, bytes: list.reduce((s, r) => s + r.bytes, 0) }));
  };
  // A download landing elsewhere changes the figure too.
  useEffect(refresh, [appState.value, audio.arrivals.value]);

  if (!pending) return null;
  const nothingToDo = pending.count === 0;

  const run = () => {
    setResult(null);
    setProgress({ done: 0, total: pending.count });
    void downloads.downloadAll((done, total) => setProgress({ done, total }))
      .then(r => { setResult(r); setProgress(null); refresh(); });
  };

  return (
    <div class="space-y-2">
      <button class="btn-outline w-full" disabled={nothingToDo || progress !== null} onClick={run}>
        {progress
          ? t('sessions.download.all.running', { done: progress.done, total: progress.total })
          : nothingToDo
            ? t('sessions.download.all.allDone')
            : t('sessions.download.all.action', { count: pending.count, size: formatBytes(pending.bytes) })}
      </button>
      {result && (
        <p class={result.failed || result.stoppedForSpace ? 'text-xs text-warn' : 'text-xs text-success'}>
          {result.stoppedForSpace
            ? t('sessions.download.all.space', { ok: result.ok })
            : result.failed
              ? t('sessions.download.all.partial', { ok: result.ok, failed: result.failed })
              : t('sessions.download.all.done', { ok: result.ok })}
        </p>
      )}
    </div>
  );
}
