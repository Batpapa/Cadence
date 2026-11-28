import type { ComponentChild } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { t } from '../../services/i18nService';
import { formatBytes } from '../../utils';
import { showModal, closeAllModals, renderModalBody, confirmModal, MODAL_W } from '../../components/modal';
import { IconButton, Switch } from '../../components/ui';
import {
  setSyncAudioByDefault, SYNC_AUDIO_BY_DEFAULT,
  setAutoLiveBackup, AUTO_LIVE_BACKUP_BY_DEFAULT, reconcileSyncedAudio, analyserAudio,
} from '../db';
import { analyserDownloads } from '../audioDownloads';
import { AudioUploadsBlock, AudioDownloadsBlock, BlockTitle, type AudioSettingsBinding } from './audioSettingsBlocks';
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

// Out of sessionModule.tsx since 2026-11-26.

/** The analyser's recordings, for the blocks it shares with the Transcription
 *  module (audioSettingsBlocks.tsx). */
const ANALYSER_AUDIO: AudioSettingsBinding = {
  audio: analyserAudio,
  downloads: analyserDownloads,
  syncByDefault: () => analyserModuleOf(appState.value)?.syncAudioByDefault ?? SYNC_AUDIO_BY_DEFAULT,
  setSyncByDefault: setSyncAudioByDefault,
  nameOf: (id) => analyserModuleOf(appState.value)?.sessions?.[id]?.name ?? '',
  get texts() {
    return { uploadManualDetail: t('sessions.syncAudio.mode.manual.detail'), downloadHint: t('sessions.download.hint') };
  },
};

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

      {driveOn && <AudioUploadsBlock binding={ANALYSER_AUDIO} />}

      {/* The way back from Drive: after the way there. */}
      {driveOn && <hr class="border-border" />}
      {driveOn && <AudioDownloadsBlock binding={ANALYSER_AUDIO} />}
    </div>
  );
}

export function showSessionSettingsModal(): void {
  const { el, cleanup } = renderModalBody(<SessionSettingsBody />);
  // No footer: nothing to confirm, so nothing to press.
  showModal(t('sessions.settings.title'), el, [], { maxWidth: MODAL_W.m, onDismiss: cleanup });
}
