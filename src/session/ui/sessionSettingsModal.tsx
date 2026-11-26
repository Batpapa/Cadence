import type { ComponentChild } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { t } from '../../services/i18nService';
import { formatBytes } from '../../utils';
import { showModal, closeAllModals, renderModalBody, confirmModal, MODAL_W } from '../../components/modal';
import { IconButton, Switch } from '../../components/ui';
import {
  setSyncAudioByDefault, SYNC_AUDIO_BY_DEFAULT, pendingAudioUploads, uploadPendingAudio,
  setAutoLiveBackup, AUTO_LIVE_BACKUP_BY_DEFAULT, reconcileSyncedAudio,
  driveOnlyAudio, audioArrivals, audioDownloadProgress,
  autoUploadState, uploadOnWifiOnly, setUploadOnWifiOnly, type AutoUploadState
} from '../db';
import { knowsNetworkType } from '../network';
import {
  audioDownloadMode, downloadOnWifiOnly, setAudioDownloadMode, setDownloadOnWifiOnly,
  autoDownloadStatus, downloadAllAudio, runAutoDownloads,
  type AutoDownloadStatus, type DownloadAllResult,
} from '../audioDownloads';
import { isDriveConnected } from '../../services/driveService';
import { editAnalyserModule, analyserModuleOf } from '../model';
import { detectionsOnCards, setDetectionOn } from '../detections';
import { appState, mutate, getContext } from '../../store';
import { listLiveBackups, restoreLiveBackup, discardLiveBackup, type LiveBackupEntry } from '../liveBackup';
import { keepRecordings, setKeepRecordings } from '../keepRecordings';
import { showRecoveryFailures } from './RecoveryFailureModal';
import {
  fmtSessionDateTime, parseNameTemplate, usesFolder, defaultNameTemplate,
  TEMPLATE_FIELDS
} from '../sessionNaming';
import { fmtLongTime } from './sessionUiShared';
import { HelpIcon, ChevronDownIcon } from '../../components/icons';
import { recognitionIndexesOf, storedRecognitionIndexes, type RecognitionIndexChoice } from '../recognition/recognitionIndexes';
import { CustomSelect } from '../../components/customSelect';

// Out of sessionModule.tsx since 2026-11-26.

// ── This module's own settings ────────────────────────────────────────────────
// Behind a gear on the module's screen rather than inline on it: there is one
// preference today and it concerns what the module does ELSEWHERE (on card
// pages), which is not something the library screen is otherwise about.
//
// Stored on the module's slice, never on User — the core holds no flag about a
// panel it does not know exists. Saved on change with no confirmation, like the
// score playback preferences: one value, undone by setting it back.

/** One setting per row, explanation on demand — the same `?` as the general
 *  settings (components/settingsModal.tsx's Row), for the same reason: three
 *  permanent paragraphs of small grey text turned this panel into a wall.
 *
 *  The button sits OUTSIDE the label: inside it, pressing it would toggle the
 *  setting as well. */
function SettingRow({ checked, onToggle, label, hint, children }: {
  checked: boolean;
  onToggle: (next: boolean) => void;
  label: string;
  hint: string;
  children?: ComponentChild;
}) {
  const [hintOpen, setHintOpen] = useState(false);
  return (
    <div>
      {/* The general settings' row: label and `?` on the left, the app's one
          on/off switch on the right (it was a checkbox here — a box is for
          picking items, a switch for turning an option on). */}
      <div class="flex items-center gap-1.5">
        <span class="text-sm text-primary min-w-0">{label}</span>
        <IconButton
          label={t('settings.explain')}
          on={hintOpen}
          aria-expanded={hintOpen}
          onClick={() => setHintOpen(o => !o)}
        >
          <HelpIcon size={14} />
        </IconButton>
        <span class="ml-auto shrink-0 flex">
          <Switch checked={checked} onChange={onToggle} label={label} />
        </span>
      </div>
      {hintOpen && (
        <p class="text-xs text-dim leading-relaxed mt-2 px-3 py-2 rounded-lg border border-border bg-bg">{hint}</p>
      )}
      {children}
    </div>
  );
}

/** The indexes a recognition searches, on or off, most preferred first
 *  (recognitionIndexes.ts) — for the analyses started from now on. At least
 *  one stays on: its switch is then locked, since nothing to search is not a
 *  recognition. */
function RecognitionIndexesBlock() {
  const [hintOpen, setHintOpen] = useState(false);
  const choices = recognitionIndexesOf(appState.value);
  const save = (next: RecognitionIndexChoice[]) => {
    void mutate(s => editAnalyserModule(s, m => {
      // Written whole, both values of every switch (see the field's doc).
      m.recognitionIndexes = storedRecognitionIndexes(s, next);
    }));
  };
  const move = (from: number, to: number) => {
    const next = [...choices];
    const [entry] = next.splice(from, 1);
    next.splice(to, 0, entry!);
    save(next);
  };
  const onCount = choices.filter(c => c.on).length;
  const label = t('sessions.indexes.title');
  return (
    <div class="space-y-2">
      <div class="flex items-center gap-1.5">
        <span class="text-sm text-primary min-w-0">{label}</span>
        <IconButton label={t('settings.explain')} on={hintOpen} aria-expanded={hintOpen} onClick={() => setHintOpen(o => !o)}>
          <HelpIcon size={14} />
        </IconButton>
      </div>
      {hintOpen && (
        <p class="text-xs text-dim leading-relaxed px-3 py-2 rounded-lg border border-border bg-bg">{t('sessions.indexes.hint')}</p>
      )}
      <div class="rounded-lg border border-border divide-y divide-border/50">
        {choices.map((c, i) => {
          const name = t(c.id === 'cards' ? 'sessions.indexes.cards' : 'sessions.indexes.thesession');
          return (
            <div key={c.id} class="flex items-center gap-1 px-3 py-1.5">
              <span class="text-xs text-dim w-4 shrink-0">{i + 1}</span>
              <span class={`text-sm min-w-0 flex-1 truncate ${c.on ? 'text-primary' : 'text-dim'}`}>{name}</span>
              <IconButton label={t('sessions.indexes.up')} disabled={i === 0} onClick={() => move(i, i - 1)}>
                <span class="flex rotate-180"><ChevronDownIcon size={12} /></span>
              </IconButton>
              <IconButton label={t('sessions.indexes.down')} disabled={i === choices.length - 1} onClick={() => move(i, i + 1)}>
                <ChevronDownIcon size={12} />
              </IconButton>
              <span class={`shrink-0 flex ml-1 ${c.on && onCount === 1 ? 'opacity-50 pointer-events-none' : ''}`}>
                <Switch
                  checked={c.on}
                  label={name}
                  onChange={(on) => { if (!on && onCount === 1) return; save(choices.map(x => (x.id === c.id ? { ...x, on } : x))); }}
                />
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Copies every recording this device holds that is not on Drive yet.
 *
 *  The setting above only ever applied to sessions saved AFTER it was switched
 *  on, which is not what "copy my recordings to Drive" sounds like — a user
 *  turned it on, saw nothing happen to their library, and reported the sync as
 *  broken. This is the missing half: the backlog, with its size stated before
 *  anything is spent, and disabled once there is none. */
function BackfillRow() {
  const [pending, setPending] = useState<{ ids: string[]; bytes: number } | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [result, setResult] = useState<{ ok: number; failed: number } | null>(null);

  const refresh = () => { void pendingAudioUploads().then(setPending); };
  // Re-read on every state change, not just on mount: the panel reconciles
  // its Drive records when it opens, and a recording whose file turned out to
  // be gone becomes work for this very button.
  useEffect(refresh, [appState.value]);

  if (!pending) return null;

  const nothingToDo = pending.ids.length === 0;

  const run = () => {
    setResult(null);
    setProgress({ done: 0, total: pending.ids.length });
    void uploadPendingAudio((done, total) => setProgress({ done, total }))
      .then(r => { setResult(r); setProgress(null); refresh(); });
  };

  // No rule of its own: it belongs to the setting above it, and the panel draws
  // its separators between BLOCKS (see SessionSettingsBody).
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

/** Where the automatic mode stands, in one line under its choices. */
function autoDownloadLine(s: AutoDownloadStatus | null, progress: Readonly<Record<string, number>>): string | null {
  if (!s) return null;
  const left = { count: s.remaining, size: formatBytes(s.bytes) };
  if (s.current) {
    const name = analyserModuleOf(appState.value)
      ?.sessions?.[s.current]?.name ?? '';
    return t('sessions.download.status.downloading', { name, percent: Math.round((progress[s.current] ?? 0) * 100), ...left });
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
function AudioDownloadsBlock() {
  const mode = audioDownloadMode.value;
  const line = mode === 'auto' ? autoDownloadLine(autoDownloadStatus.value, audioDownloadProgress.value) : null;
  // Looked at now, so the line says where things stand rather than nothing
  // until the next pass — and a pass that had stopped (no Wi-Fi then) gets
  // another go. One pass at a time, so this cannot start a second.
  useEffect(() => { if (audioDownloadMode.value === 'auto') void runAutoDownloads(); }, []);
  return (
    <div class="space-y-2">
      <BlockTitle label={t('sessions.download.title')} hint={t('sessions.download.hint')} />
      <div class="space-y-1.5" role="radiogroup" aria-label={t('sessions.download.title')}>
        {DOWNLOAD_MODES.map(([m, label, detail]) => (
          <ChoiceCard
            key={m}
            selected={mode === m}
            label={t(label)}
            detail={t(detail)}
            onSelect={() => setAudioDownloadMode(m)}
            aside={m === 'auto' && mode === 'auto'
              ? <NetworkSelect wifiOnly={downloadOnWifiOnly.value} onChange={setDownloadOnWifiOnly} />
              : undefined}
            footer={m === 'auto' && line ? <StatusLine text={line} /> : undefined}
          />
        ))}
      </div>
      <DownloadAllRow />
    </div>
  );
}

/** A block's heading, with its explanation on demand — SettingRow's `?`,
 *  for a block whose choice is not a checkbox. */
function BlockTitle({ label, hint }: { label: string; hint: ComponentChild }) {
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

/** Where the automatic copies stand, from the per-recording states db.ts
 *  publishes. Nothing when nothing is pending: the button below says the rest. */
function autoUploadLine(states: Readonly<Record<string, AutoUploadState>>): string | null {
  const all = Object.values(states);
  const count = (s: AutoUploadState) => all.filter(x => x === s).length;
  if (count('uploading')) return t('sessions.syncAudio.status.uploading', { count: all.length });
  if (count('wifi')) return t('sessions.syncAudio.status.wifi', { count: count('wifi') });
  if (count('waiting')) return t('sessions.syncAudio.status.failed', { count: count('waiting') });
  return null;
}

/** How this user's new recordings reach Drive (2026-10-09, laid out like the
 *  way back below at the user's request). The choice itself is the synced
 *  `syncAudioByDefault` — a user's recordings are protected on all their
 *  devices or none; the network it may use is this device's (db.ts). */
function AudioUploadsBlock() {
  const mod = analyserModuleOf(appState.value);
  const auto = mod?.syncAudioByDefault ?? SYNC_AUDIO_BY_DEFAULT;
  const line = auto ? autoUploadLine(autoUploadState.value) : null;
  return (
    <div class="space-y-2">
      <BlockTitle label={t('sessions.syncAudio.title')} hint={t('sessions.syncAudio.hint')} />
      <div class="space-y-1.5" role="radiogroup" aria-label={t('sessions.syncAudio.title')}>
        <ChoiceCard
          selected={!auto}
          label={t('sessions.syncAudio.mode.manual')}
          detail={t('sessions.syncAudio.mode.manual.detail')}
          onSelect={() => { void setSyncAudioByDefault(false); }}
        />
        <ChoiceCard
          selected={auto}
          label={t('sessions.syncAudio.mode.auto')}
          detail={t('sessions.syncAudio.mode.auto.detail')}
          onSelect={() => { void setSyncAudioByDefault(true); }}
          aside={auto ? <NetworkSelect wifiOnly={uploadOnWifiOnly.value} onChange={setUploadOnWifiOnly} /> : undefined}
          footer={line ? <StatusLine text={line} /> : undefined}
        />
      </div>
      {/* No "N audios on Drive — X MB" line any more (2026-10-09, the user):
          Settings → Storage already says it. */}
      <BackfillRow />
    </div>
  );
}

/** Every recording that is on Drive and not here, in one go, whatever the mode
 *  — promised to a user who wanted everything on the phone before leaving the
 *  Wi-Fi. The mirror of BackfillRow, and the same discipline: the size is
 *  stated before anything is spent. Freed recordings included: it is a request. */
function DownloadAllRow() {
  const [pending, setPending] = useState<{ count: number; bytes: number } | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [result, setResult] = useState<DownloadAllResult | null>(null);

  const refresh = () => {
    void driveOnlyAudio().then(list => setPending({ count: list.length, bytes: list.reduce((s, r) => s + r.bytes, 0) }));
  };
  // A download landing elsewhere changes the figure too.
  useEffect(refresh, [appState.value, audioArrivals.value]);

  if (!pending) return null;
  const nothingToDo = pending.count === 0;

  const run = () => {
    setResult(null);
    setProgress({ done: 0, total: pending.count });
    void downloadAllAudio((done, total) => setProgress({ done, total }))
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

/** The live backups sitting on Drive, and what to do with each.
 *
 *  The automatic offer only ever appears on the device that recorded (see
 *  matchDevice), and that recognition can fail: a desktop browser whose data
 *  was cleared regenerates its id, and has no phone model to fall back on. This
 *  is the way in that never fails — someone who knows a backup exists comes
 *  looking for it here.
 *
 *  Opened on demand, never on the settings opening: listing costs Drive
 *  requests and may want a sign-in window, and most people have no backup at
 *  all. */
function DriveBackupsRow() {
  const [entries, setEntries] = useState<LiveBackupEntry[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    setLoading(true);
    setError(null);
    listLiveBackups(true)
      .then(setEntries)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  };

  const recover = (entry: LiveBackupEntry) => {
    if (!entry.meta) return;
    setBusyId(entry.sessionId);
    setError(null);
    restoreLiveBackup({ sessionId: entry.sessionId, folderId: entry.folderId, meta: entry.meta }, (done, total) => setProgress({ done, total }))
      .then(failure => {
        setBusyId(null);
        setProgress(null);
        if (failure) { showRecoveryFailures([failure], () => {}); return; }
        // Straight to what was just recovered: the library behind this dialog
        // read its list before any of this happened.
        closeAllModals();
        getContext().navigate({ view: 'sessions', sessionId: entry.sessionId });
      })
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : String(e));
        setBusyId(null);
        setProgress(null);
      });
  };

  const remove = (entry: LiveBackupEntry) => {
    confirmModal(
      t('sessions.liveBackup.offer.abandonTitle'),
      t('sessions.liveBackup.offer.abandonMessage'),
      t('sessions.liveBackup.offer.abandon'),
      () => {
        setBusyId(entry.sessionId);
        void discardLiveBackup(entry.sessionId, true).finally(() => {
          setBusyId(null);
          setEntries(list => (list ?? []).filter(e => e.sessionId !== entry.sessionId));
        });
      },
    );
  };

  // Same as BackfillRow: no separator here, it is part of the block above.
  return (
    <div class="space-y-2">
      {entries === null ? (
        <button class="btn-outline w-full" disabled={loading} onClick={load}>
          {loading ? t('sessions.liveBackup.list.loading') : t('sessions.liveBackup.list.show')}
        </button>
      ) : entries.length === 0 ? (
        <p class="text-xs text-muted">{t('sessions.liveBackup.list.empty')}</p>
      ) : (
        <div class="space-y-2">
          <p class="text-xs text-muted leading-relaxed">{t('sessions.liveBackup.list.hint')}</p>
          {entries.map(entry => (
            <div key={entry.sessionId} class="flex items-center gap-2 p-2 rounded border border-border">
              <div class="min-w-0 flex-1">
                <p class="text-sm text-primary truncate">
                  {entry.meta ? (entry.meta.name || t('sessions.liveBackup.offer.unnamed')) : t('sessions.liveBackup.list.unreadable')}
                </p>
                <p class="text-2xs text-dim truncate">
                  {entry.meta ? `${fmtSessionDateTime(entry.meta.date)} · ${fmtLongTime(entry.meta.durationS)} · ` : ''}
                  {formatBytes(entry.bytes)}
                </p>
              </div>
              {entry.meta && (
                <button
                  class="btn-primary text-xs shrink-0"
                  disabled={busyId !== null}
                  onClick={() => recover(entry)}
                >
                  {busyId === entry.sessionId && progress
                    ? t('sessions.liveBackup.offer.downloading', { done: progress.done, total: progress.total })
                    : t('sessions.liveBackup.offer.recover')}
                </button>
              )}
              <button class="btn-danger text-xs shrink-0" disabled={busyId !== null} onClick={() => remove(entry)}>
                {t('sessions.liveBackup.list.delete')}
              </button>
            </div>
          ))}
        </div>
      )}
      {error && <p class="text-xs text-danger break-words">{t('sessions.liveBackup.list.failed', { error })}</p>}
    </div>
  );
}

/** Stores both name templates — see TuneAnalyserModuleData.nameTemplate and
 *  nameTemplateNoFolder. A blank one is removed, and so is the usual name's
 *  template left as it was shown: absence is the default, the one each can
 *  have, and it keeps the usual name in the language of the day. Nothing is
 *  written when nothing changed, which is the common case: every field left,
 *  and the panel closing, come through here. */
function setNameTemplates(main: string, noFolder: string): void {
  const a = main.trim() === defaultNameTemplate() ? '' : main.trim(), b = noFolder.trim();
  const current = analyserModuleOf(appState.value);
  if ((current?.nameTemplate ?? '') === a && (current?.nameTemplateNoFolder ?? '') === b) return;
  void mutate(s => editAnalyserModule(s, m => {
    if (a) m.nameTemplate = a; else delete m.nameTemplate;
    if (b) m.nameTemplateNoFolder = b; else delete m.nameTemplateNoFolder;
  }));
}

/** What is wrong with a template, said under its field. Never blocking: a
 *  template is used as it stands, the wrong parts as text (sessionNaming.ts). */
function TemplateWarnings({ value, folderForbidden }: { value: string; folderForbidden?: boolean }) {
  const parsed = parseNameTemplate(value);
  return (
    <>
      {parsed.unknown.length > 0 && (
        <p class="text-xs text-warn break-words">
          {t('sessions.nameTemplate.unknown', { fields: parsed.unknown.map(u => `{${u}}`).join(', ') })}
        </p>
      )}
      {parsed.unclosed && <p class="text-xs text-warn">{t('sessions.nameTemplate.unclosed')}</p>}
      {folderForbidden && usesFolder(value) && <p class="text-xs text-warn">{t('sessions.nameTemplate.noFolder.folderField')}</p>}
    </>
  );
}

type TemplateInputKey = 'main' | 'noFolder';

/** The name new recordings get (2026-10-16) — see sessionNaming.ts. Stored when
 *  a field is left, on Enter, and when the panel closes with a field still
 *  being typed in, so nothing typed is lost and the synced blob is not
 *  rewritten at every keystroke.
 *
 *  A template using {folder} shows a second field, for a recording started
 *  outside any folder (the user's design, 2026-10-16).
 *
 *  Never an example name computed for show: what is said is only what is
 *  wrong with a template (the user's call, 2026-10-16). An empty main field
 *  shows the usual name's template greyed, as its placeholder — automatic
 *  until something is typed, like an embedded link's name (2026-10-16). */
function NameTemplateBlock() {
  const mod = analyserModuleOf(appState.value);
  const [main, setMain] = useState(mod?.nameTemplate ?? '');
  const [noFolder, setNoFolder] = useState(mod?.nameTemplateNoFolder ?? '');
  /** The field the list of fields inserts into: the one last focused. */
  const [target, setTarget] = useState<TemplateInputKey>('main');
  const mainRef = useRef<HTMLInputElement>(null);
  const noFolderRef = useRef<HTMLInputElement>(null);
  const drafts = useRef({ main, noFolder });
  drafts.current = { main, noFolder };
  useEffect(() => () => setNameTemplates(drafts.current.main, drafts.current.noFolder), []);
  const commit = () => setNameTemplates(main, noFolder);

  const withFolder = usesFolder(main);
  const into: TemplateInputKey = withFolder ? target : 'main';

  /** At the caret, keeping the field focused — a field's name is pressed
   *  without taking the focus (onPointerDown), so a phone keeps its keyboard
   *  up. */
  const insert = (field: string) => {
    const input = (into === 'main' ? mainRef : noFolderRef).current;
    const value = into === 'main' ? main : noFolder;
    const token = `{${field}}`;
    const start = input?.selectionStart ?? value.length, end = input?.selectionEnd ?? value.length;
    (into === 'main' ? setMain : setNoFolder)(value.slice(0, start) + token + value.slice(end));
    requestAnimationFrame(() => {
      if (!input) return;
      input.focus({ preventScroll: true });
      input.setSelectionRange(start + token.length, start + token.length);
    });
  };

  // The fields live behind the title's `?` with the explanation (the user's
  // call, 2026-10-16): a row of them always on show was noise for anyone who
  // sets this once. Each one still inserts itself at the caret — except
  // {folder} into the field for outside any folder, where it has no value.
  const hint = (
    <>
      <p>{t('sessions.nameTemplate.hint')}</p>
      <ul class="mt-2 space-y-0.5">
        {TEMPLATE_FIELDS.map(([field, key]) => (
          <li key={field}>
            {field === 'folder' && into === 'noFolder' ? (
              <span class="font-mono text-dim">{`{${field}}`}</span>
            ) : (
              <button
                type="button"
                class="font-mono text-primary hover:text-accent cursor-pointer"
                onPointerDown={(e) => e.preventDefault()}
                onClick={() => insert(field)}
              >
                {`{${field}}`}
              </button>
            )}
            {' '}{t(key)}
          </li>
        ))}
      </ul>
    </>
  );

  const inputProps = (key: TemplateInputKey) => ({
    type: 'text',
    class: 'input text-sm w-full px-2 py-1',
    onFocus: () => setTarget(key),
    onKeyDown: (e: KeyboardEvent) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); },
  });

  return (
    <div class="space-y-2">
      <BlockTitle label={t('sessions.nameTemplate.title')} hint={hint} />
      <input
        {...inputProps('main')}
        ref={mainRef}
        placeholder={defaultNameTemplate()}
        value={main}
        onInput={(e) => setMain((e.target as HTMLInputElement).value)}
        onBlur={commit}
      />
      <TemplateWarnings value={main} />
      {withFolder && (
        <>
          <label class="block text-xs text-muted">{t('sessions.nameTemplate.noFolder.label')}</label>
          <input
            {...inputProps('noFolder')}
            ref={noFolderRef}
            placeholder={t('sessions.nameTemplate.noFolder.placeholder')}
            value={noFolder}
            onInput={(e) => setNoFolder((e.target as HTMLInputElement).value)}
            onBlur={commit}
          />
          <TemplateWarnings value={noFolder} folderForbidden />
        </>
      )}
      {/* No "back to the usual template" button (the user's call, 2026-10-16):
          emptying the field does it, and the greyed template says so. */}
    </div>
  );
}

function SessionSettingsBody() {
  // Read straight off appState rather than through db.ts's async accessors:
  // this component already re-renders on every state change.
  const mod = analyserModuleOf(appState.value);
  // Checked against the folder the moment this panel opens, because this is
  // where the backlog below is READ. Until now it reported what the library believed:
  // a user who emptied their Drive by hand was told 17 recordings were safe
  // when six were (reported 2026-09-24). A recording whose file is gone
  // rejoins the backlog below, which is the honest place for it.
  useEffect(() => { void reconcileSyncedAudio(); }, []);
  // Copying recordings to Drive is meaningless without a Drive to copy them to,
  // and a checkbox that silently does nothing is worse than one that says why.
  const driveOn = isDriveConnected();

  return (
    <div class="space-y-4">
      {/* First, at the user's request (2026-10-16). */}
      <NameTemplateBlock />
      <hr class="border-border" />

      <SettingRow
        checked={detectionsOnCards(appState.value)}
        label={t('sessions.detectionsOnCards')}
        hint={t('sessions.detectionsOnCards.hint')}
        onToggle={(next) => {
          void mutate(s => editAnalyserModule(s, m => {
            // Written only to turn it OFF — absence is the default here as
            // everywhere else in this codebase.
            if (next) delete m.detectionsOnCards; else m.detectionsOnCards = false;
          }));
        }}
      />

      {/* On by default. Written only to turn it OFF: absence is the default. */}
      <SettingRow
        checked={setDetectionOn(appState.value)}
        label={t('sessions.setDetection')}
        hint={t('sessions.setDetection.hint')}
        onToggle={(next) => {
          void mutate(s => editAnalyserModule(s, m => {
            if (next) delete m.experimentalSets; else m.experimentalSets = false;
          }));
        }}
      />

      <hr class="border-border" />
      <RecognitionIndexesBlock />
      <hr class="border-border" />

      {/* On by default; this device's own (keepRecordings.ts). */}
      <SettingRow
        checked={keepRecordings.value}
        label={t('sessions.keepRecordings')}
        hint={t('sessions.keepRecordings.hint')}
        onToggle={setKeepRecordings}
      />

      {/* Absent entirely without Drive rather than shown disabled: there is no
          Drive to copy to, so the setting has nothing to mean. */}
      {/* One block per subject, a rule between blocks and never inside one: a
          setting and the button that acts on the same thing belong together.
          The recording being made comes before the recording already saved —
          it is the one that can be lost outright. */}
      {driveOn && <hr class="border-border" />}

      {driveOn && (
        <div class="space-y-2">
          {/* Nothing to back up of a recording that will not be kept; the
              backups already on Drive stay listed below. */}
          {keepRecordings.value && (
            <SettingRow
              checked={mod?.autoLiveBackup ?? AUTO_LIVE_BACKUP_BY_DEFAULT}
              label={t('sessions.autoLiveBackup')}
              hint={t('sessions.autoLiveBackup.hint')}
              onToggle={(next) => { void setAutoLiveBackup(next); }}
            />
          )}
          <DriveBackupsRow />
        </div>
      )}

      {driveOn && <hr class="border-border" />}

      {driveOn && <AudioUploadsBlock />}

      {/* The way back from Drive: after the way there. */}
      {driveOn && <hr class="border-border" />}
      {driveOn && <AudioDownloadsBlock />}
    </div>
  );
}

export function showSessionSettingsModal(): void {
  const { el, cleanup } = renderModalBody(<SessionSettingsBody />);
  // No footer: nothing to confirm, so nothing to press.
  showModal(t('sessions.settings.title'), el, [], { maxWidth: MODAL_W.m, onDismiss: cleanup });
}
