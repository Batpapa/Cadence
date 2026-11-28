import { useEffect, useRef, useState } from 'preact/hooks';
import { t } from '../../services/i18nService';
import { appState, mutate, navigate } from '../../store';
import { GearIcon, ExternalLinkIcon, ResetIcon, UploadIcon, CloudUpIcon, TrashIcon } from '../../components/icons';
import { downloadIcon } from '../../components/playbackIcons';
import { alertModal, confirmModal } from '../../components/modal';
import type { ContextMenuEntry } from '../../components/contextMenu';
import { mountScoreViewer, type ScoreViewer } from '../../components/scoreViewer';
import type { AudioSyncBinding } from '../../components/viewerShared';
import { mountScoreFollow } from '../../session/ui/ScoreFollowView';
import { fmtTime, TitleRow, NotOnDriveBtn, driveAudioStateOf } from '../../session/ui/sessionUiShared';
import { confirmDownload } from '../../session/ui/PassRow';
import { followFrom, followTo, type FollowAudio } from '../../session/scoreFollowClient';
import { fetchRemotePassage } from '../../session/audio/remotePassage';
import { COMPANION_GONE, isDriveConnected, readCompanionRange } from '../../services/driveService';
import { downloadBlob } from '../../services/fileTransfer';
import { audioExtension } from '../../services/zip';
import { detectAudioFile } from '../../session/audio/clipExtract';
import { sanitizeFileBase } from '../../services/attachmentNames';
import { fmtDate } from '../../services/dateFormat';
import { formatBytes } from '../../utils';
import { currentAbc, editTranscriptionTree, transcriptionModuleOf, transcriptionTreeOf, type TranscriptionRecord } from '../model';
import { FolderPicker } from '../../components/folderBrowser';
import { placeSession } from '../../session/sessionTree';
import { saveCorrection, revertToDraft, renameTranscription, deleteTranscription } from '../actions';
import { transcriptionAudio, transcriptionDownloads } from '../audioSync';
import { SOURCE_ICON, sourceName, startRedo } from './setup';
import { showExportAbcModal } from './exportModal';
import { showAddToCard } from './cardModals';
import { abcHeader } from './library';

// ── A transcription ──────────────────────────────────────────────────────────
// Laid out as an analysis is (SessionSummary.tsx): its title row — the name,
// renamed by a tap, the ⋯ and the bin — the line that says what it is, then
// its score, in the score viewer itself (components/scoreViewer.ts — the one a
// card's score opens in), editable, its audio sync on the recording it was
// written out of; the draft as the transcriber wrote it kept apart, to go
// back to. Then into the cards (cardModals.tsx).
//
// Its recording as an analysis's (2026-11-28, the user: "comme l'analyse"):
// here, on Drive, or both (audioSync.ts); its ⋯ menu ends with the same
// "Audio" section, and a recording only on Drive is followed from there.

/** A transfer that did not go through, said. */
function alertTransfer(e: unknown): void {
  if (e instanceof Error && e.message === COMPANION_GONE) { alertGone(); return; }
  alertModal(
    t('sessions.syncAudio.failed.title'),
    t('sessions.syncAudio.failed.message', { error: e instanceof Error ? e.message : String(e) }),
  );
}

function alertGone(): void {
  alertModal(t('sessions.syncAudio.gone.title'), t('transcription.syncAudio.gone.message'));
}

/** The audio sync on the transcription's own recording: its passage. From
 *  this device, or from Drive — the toggle then wearing the cloud. */
function followRecording(record: TranscriptionRecord, getAudio: () => Promise<FollowAudio | undefined>, fromDrive: boolean): AudioSyncBinding {
  return {
    fromDrive,
    // Followed whatever the verdict (viewerShared.ts): the score was written
    // from this very recording.
    forcedByDefault: true,
    plays: (version) => /^K:/m.test(version),
    mount: (host, version, face, expanded, onState, forced, transpose, below, editor) =>
      mountScoreFollow(host, {
        target: { kind: 'passage', start: record.from, end: record.to, home: true, loose: true },
        version, face, expanded, onState, forced, transpose, below, editor,
        getAudio,
      }),
  };
}

/** The passage a score follows when its recording is only on Drive: fetched
 *  on its own, as a detection's is (PassRow's followAudioFromDrive); the whole
 *  recording only for a format no passage can be read from — asked first in
 *  the manual mode, and kept here then. Undefined when it could not be had,
 *  the user told why. */
async function followFromDrive(r: TranscriptionRecord): Promise<FollowAudio | undefined> {
  const entry = transcriptionModuleOf(appState.value)?.syncedAudio?.[r.id];
  if (!entry) return undefined;
  const from = followFrom(r.from);
  const to = followTo(r.to);
  try {
    const clip = await fetchRemotePassage(
      (s, e) => readCompanionRange(entry.fileId, s, e, true),
      { bytes: entry.bytes, duration: r.duration },
      from, to, entry.fileId,
    );
    if (clip) return { blob: clip.blob, start: from, id: `transcription:${r.id}:${from}` };
  } catch (e) {
    alertTransfer(e);
    return undefined;
  }
  if (transcriptionDownloads.mode.value === 'manual' && !await confirmDownload(entry.bytes)) return undefined;
  try {
    const blob = await transcriptionAudio.fetch(r.id);
    if (!blob) { alertGone(); return undefined; }
    return { blob, start: 0, id: `transcription:${r.id}` };
  } catch (e) {
    alertTransfer(e);
    return undefined;
  }
}

/** What it is, in a line, as an analysis's detail: where it came from, when,
 *  the passage, the dance said, and the metre and key the score has now. */
function detailLine(r: TranscriptionRecord): string {
  const abc = currentAbc(r);
  const whole = r.from <= 0.05 && r.to >= r.duration - 0.05;
  return [
    r.origin && r.origin !== r.name ? r.origin : sourceName(r.source),
    fmtDate(r.createdAt),
    whole ? fmtTime(r.duration) : t('transcription.info.passage', { from: fmtTime(r.from), to: fmtTime(r.to) }),
    r.settings.dance,
    abcHeader(abc, 'M'),
    abcHeader(abc, 'K'),
  ].filter(Boolean).join(' · ');
}

/** The recording saved as a file, named after the transcription; its
 *  extension from its type, or its head when the type says nothing (the
 *  analysis's download, SessionSummary.tsx). */
async function downloadRecording(r: TranscriptionRecord, audio: Blob): Promise<void> {
  let ext = audioExtension(audio.type || r.mimeType);
  if (ext === 'bin') ext = (await detectAudioFile(audio))?.extension ?? ext;
  downloadBlob(audio, `${sanitizeFileBase(r.name) || 'transcription'}.${ext}`);
}

export function TranscriptionScreen({ id }: { id: string }) {
  const record = transcriptionModuleOf(appState.value)?.transcriptions[id];
  const hostRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<ScoreViewer | null>(null);
  /** The recording on this device: undefined while it is looked for, null
   *  when this device does not hold it. */
  const [audio, setAudio] = useState<Blob | null | undefined>(undefined);
  /** Bumped to show the score afresh (back to the draft): the viewer reads
   *  its text once, at its mounting. */
  const [epoch, setEpoch] = useState(0);
  /** Set while going back to the draft: the edit on screen is dropped, not
   *  written over the draft just restored. */
  const dropPending = useRef(false);
  const present = !!record;

  /** Its Drive copy, read live: it arrives with a sync from the device that
   *  made it (SessionSummary's `synced`, for the same reason). */
  const synced = transcriptionModuleOf(appState.value)?.syncedAudio?.[id] ?? null;
  const driveOn = isDriveConnected();
  /** A copy on a Drive this device is connected to — the only kind it can
   *  reach without having it. */
  const reachable = !!synced && driveOn;
  /** An upload, removal or download of this page's in flight. */
  const [busySync, setBusySync] = useState(false);
  /** The last one failed: the cloud stays red afterwards. */
  const [syncFailed, setSyncFailed] = useState(false);
  /** The recording brought down from Drive for THIS visit — a file to save,
   *  a transcription done again — not kept here: keeping it is "Keep on this
   *  device" (the analysis's rule, 2026-11-05). */
  const [temp, setTemp] = useState<Blob | null>(null);
  /** That download's progress, 0–1, while it runs. */
  const [tempProgress, setTempProgress] = useState<number | null>(null);
  const [downloading, setDownloading] = useState(false);

  const driveState = driveAudioStateOf({
    busy: busySync, failed: syncFailed, synced: !!synced, auto: transcriptionAudio.autoUploadState.value[id],
  });
  // Brought here in the background meanwhile (audioDownloads.ts), or kept
  // from this page: picked up without a reload.
  const downloadProgress = transcriptionAudio.downloadProgress.value[id];
  const arrived = transcriptionAudio.arrivals.value.has(id);

  useEffect(() => {
    let live = true;
    void transcriptionAudio.load(id).then(b => { if (live) setAudio(b ?? null); }, () => { if (live) setAudio(null); });
    return () => { live = false; };
  }, [id, arrived]);

  /** Whether the recording can be had at all, here or from Drive: what the
   *  viewer is mounted afresh for — not for the recording merely moving. One
   *  brought here while its audio sync is on (the whole file the sync asked
   *  to download) remounted the viewer, and turned the sync off under the
   *  user's finger (seen 2026-11-28). */
  const ready = audio !== undefined;
  const available = !!audio || reachable;

  // The viewer, mounted once the recording is known (its audio sync needs
  // it), afresh at each epoch; its corrections written as they are saved. Gone
  // with the transcription (deleted elsewhere): its sound and its keys too.
  useEffect(() => {
    const host = hostRef.current;
    const r = transcriptionModuleOf(appState.value)?.transcriptions[id];
    if (!host || !r || !ready) return;
    // The recording each time the sync is turned on: this device's when it
    // has it now, else Drive's — fetched once for the viewer. The cloud on
    // the tab says where it was when the viewer opened.
    let fromDriveOnce: Promise<FollowAudio | undefined> | null = null;
    const follow = available
      ? followRecording(r, async () => {
        const blob = await transcriptionAudio.load(id).catch(() => undefined);
        if (blob) return { blob, start: 0, id: `transcription:${r.id}` };
        fromDriveOnce ??= followFromDrive(r).then(a => { if (!a) fromDriveOnce = null; return a; });
        return fromDriveOnce;
      }, !audio)
      : undefined;
    const viewer = mountScoreViewer(host, {
      text: currentAbc(r),
      name: `${sanitizeFileBase(r.name) || 'transcription'}.abc`,
      save: async (text) => {
        try { return (await saveCorrection(id, text)) ? 'saved' : 'failed'; } catch { return 'failed'; }
      },
      // On the face the user's preferences open a score on, as a card's: the
      // editor's face (the pencil) is one tap away, and opened on it the stave
      // had a line of room under the audio sync (tried 2026-11-28).
      // Offered, not switched on: switched on, the audio sync plays at once
      // (ScoreFollowView's autoplay) — at every opening of the page, looping,
      // which nobody asked for (seen 2026-11-28). One tap on its tab, as on a
      // card. No Play-along: of no use here (the user, 2026-11-28).
      ...(follow ? { audioSync: follow } : {}),
      playAlong: false,
    });
    viewerRef.current = viewer;
    return () => {
      // Left by a way that asks nothing (the header, the drawer, back): the
      // edit is written, not lost — the transcriber's draft is kept apart
      // whatever happens, "Back to the draft" one tap away (the review of
      // 2026-11-28).
      const pending = dropPending.current ? null : viewer.pendingText();
      dropPending.current = false;
      if (pending !== null) void saveCorrection(id, pending);
      viewer.dispose();
      viewerRef.current = null;
    };
    // eslint-disable-next-line
  }, [id, ready, available, epoch, present]);

  /** Leaving: an edit not saved asks first (the viewer's own question). */
  const leave = (go: () => void) => { if (!viewerRef.current?.guardLeave(go)) go(); };

  if (!record) return <p class="text-sm text-dim p-6">{t('transcription.notFound')}</p>;

  /** The recording for this visit, from Drive: the one already brought down,
   *  else a download whose progress the page shows. Null when it could not be
   *  had — the user told why — or while one is already coming. Asked from a
   *  click only: Drive's token cannot be renewed outside one. */
  const fetchTemp = (): Promise<Blob | null> => {
    if (temp) return Promise.resolve(temp);
    if (tempProgress !== null || busySync || !synced) return Promise.resolve(null);
    setTempProgress(0);
    return transcriptionAudio.downloadOnce(id, setTempProgress)
      .then(blob => {
        if (!blob) { alertGone(); return null; }
        setTemp(blob);
        return blob;
      })
      .catch((e: unknown) => { alertTransfer(e); return null; })
      .finally(() => setTempProgress(null));
  };

  /** Copies the recording to Drive — asked first: it spends the user's
   *  bandwidth and their Drive space; not red, nothing is lost by it. */
  const uploadToDrive = () => {
    if (busySync || synced || !audio) return;
    setSyncFailed(false);
    confirmModal(
      t('sessions.syncAudio.confirm.title'),
      t('sessions.syncAudio.confirm.message', { size: formatBytes(audio.size) }),
      t('sessions.syncAudio.confirm.ok'),
      () => {
        setBusySync(true);
        void transcriptionAudio.upload(id)
          .catch((e: unknown) => { setSyncFailed(true); alertTransfer(e); })
          .finally(() => setBusySync(false));
      },
      { destructive: false },
    );
  };

  /** Removes the Drive copy — red: with nothing here, the last copy there is. */
  const removeFromDrive = () => {
    if (busySync || !synced) return;
    setSyncFailed(false);
    confirmModal(
      t('sessions.syncAudio.remove.title'),
      t(audio ? 'sessions.syncAudio.remove.message' : 'transcription.syncAudio.remove.messageOnly', { size: formatBytes(synced.bytes) }),
      t('sessions.syncAudio.remove.ok'),
      () => {
        setBusySync(true);
        void transcriptionAudio.unsync(id).catch(alertTransfer).finally(() => setBusySync(false));
      },
    );
  };

  /** This device's copy, freed: undone by a download with a copy on Drive,
   *  the end of the recording without one — two messages. */
  const forgetHere = () => confirmModal(
    t('sessions.forgetAudio.title'),
    t(synced ? 'sessions.forgetAudio.messageSynced' : 'transcription.forgetAudio.message'),
    t('sessions.forgetAudio'),
    () => { void transcriptionAudio.forget(id).then(() => setAudio(null)); },
  );

  /** Keeps a recording only on Drive on this device: the one brought down for
   *  this visit, else a download. Never on its own from here — that is the
   *  automatic mode's to decide, where the user decided it. */
  const keepHere = () => {
    if (busySync) return;
    if (temp) { void transcriptionAudio.keepHere(id, temp).catch(alertTransfer); return; }
    setBusySync(true);
    void transcriptionAudio.fetch(id)
      .then(blob => { if (!blob) alertGone(); })
      .catch(alertTransfer)
      .finally(() => setBusySync(false));
  };

  /** The file, from wherever it is: here, or from Drive for this visit. */
  const saveAudioFile = () => {
    if (downloading) return;
    setDownloading(true);
    void (audio ? Promise.resolve(audio) : fetchTemp())
      .then(blob => (blob ? downloadRecording(record, blob) : undefined))
      .finally(() => setDownloading(false));
  };

  /** Nothing is offered that would start a second transfer over one in
   *  flight: this page's own, the automatic copy, or a download. */
  const transferring = busySync || driveState === 'uploading' || tempProgress !== null || downloadProgress !== undefined;
  const comingFromDrive = !audio ? (tempProgress ?? downloadProgress ?? null) : null;

  const corrected = record.abc !== undefined;
  const Icon = SOURCE_ICON[record.source];
  const fileName = `${sanitizeFileBase(record.name) || 'transcription'}.abc`;
  const audioIcon = <span class="flex items-center" dangerouslySetInnerHTML={{ __html: downloadIcon(14) }} />;
  // The analysis's order (SessionSummary's title menu): the export first,
  // with its icon; then the two that replace what is written, as re-analysing
  // is — its icon, not red, asked first, the question not red either: nothing
  // is deleted (2026-11-28, the user); then the score's own; then, under a
  // heading, what can be done with the recording — the analysis's section,
  // only what applies NOW (2026-11-28, the user), the two deletions red.
  const menu: ContextMenuEntry[] = [
    { label: t('transcription.menu.export'), icon: <UploadIcon size={14} />, onClick: () => showExportAbcModal(viewerRef.current?.pendingText() ?? currentAbc(record), fileName) },
    ...(corrected ? [{ label: t('transcription.menu.revert'), icon: <ResetIcon size={14} />, onClick: () => confirmModal(
      t('transcription.menu.revert'), t('transcription.revert.message'), t('transcription.revert.confirm'),
      () => { dropPending.current = true; void revertToDraft(id).then(() => setEpoch(e => e + 1)); },
      { destructive: false },
    ) }] : []),
    // Again, other settings or another passage (2026-11-28, the user: a
    // button for it after all) — the edit on screen settled first; from Drive
    // for this once when the recording is only there.
    ...(audio || temp || (reachable && !transferring) ? [{
      label: t('transcription.menu.redo'), icon: <ResetIcon size={14} />,
      onClick: () => leave(() => void startRedo(id, audio ? undefined : fetchTemp)),
    }] : []),
    { label: t('transcription.menu.prefs'), icon: <GearIcon size={14} />, onClick: () => viewerRef.current?.openPrefs() },
    { label: t('fileViewer.abc.openInAbcTools'), icon: <ExternalLinkIcon size={12} />, onClick: () => viewerRef.current?.openInAbcTools() },
    ...(audio || reachable ? [{ heading: t('sessions.menu.audio') }] : []),
    ...((audio || reachable) && !downloading && (audio || !transferring) ? [{
      label: t('sessions.menu.download'), icon: audioIcon, onClick: saveAudioFile,
    }] : []),
    ...(!audio && reachable && !transferring ? [{
      label: t('sessions.menu.keepHere', { size: formatBytes(synced!.bytes) }), icon: audioIcon, onClick: keepHere,
    }] : []),
    ...(audio && driveOn && !synced && !transferring ? [{
      label: t('sessions.menu.upload'), icon: <CloudUpIcon size={14} />, onClick: uploadToDrive,
    }] : []),
    ...(audio ? [{
      label: t('sessions.menu.forgetHere'), icon: <TrashIcon size={14} />, danger: true, onClick: forgetHere,
    }] : []),
    ...(reachable && !transferring ? [{
      label: t('sessions.menu.removeDrive'), icon: <TrashIcon size={14} />, danger: true, onClick: removeFromDrive,
    }] : []),
  ];

  return (
    <div class="h-full flex flex-col p-6 gap-3 view-enter">
      <div class="shrink-0">
        <TitleRow
          getName={() => record.name}
          getDefaultName={() => record.name}
          onRename={(name) => { void renameTranscription(id, name); }}
          onDelete={() => { void deleteTranscription(id).then(() => navigate({ view: 'transcriptions' })); }}
          deleteTexts={{
            label: t('transcription.delete.title'),
            title: t('transcription.delete.title'),
            message: t('transcription.delete.message', { name: record.name }),
          }}
          menu={menu}
        />
        {/* Where it lives, as an analysis's (AnalysisFolderPicker): nothing
            while there are no folders. */}
        <FolderPicker
          tree={transcriptionTreeOf(appState.value)}
          itemId={id}
          onPlace={(folderId) => { void mutate(s => editTranscriptionTree(s, tr => placeSession(tr, id, folderId))); }}
        />
        {/* The analyses' line under a name (AnalysisBrowser's Card): the
            source's glyph, what it is; corrected or not, in a word. At its
            end, the analysis's struck cloud: here but not on Drive, the one
            state of the recording nothing else on the page says. */}
        <div class="mt-1 text-xs text-dim flex items-start gap-1.5">
          <span class="shrink-0 flex items-center h-4" title={sourceName(record.source)}><Icon size={12} /></span>
          <span class="min-w-0 flex-1">
            {detailLine(record)}
            {corrected && <span class="text-warn"> · {t('transcription.corrected')}</span>}
          </span>
          {audio && driveOn && driveState !== 'on' && (
            <span class="shrink-0 -my-1.5"><NotOnDriveBtn state={driveState} onClick={uploadToDrive} /></span>
          )}
        </div>
        {comingFromDrive !== null && (
          <p class="text-xs text-accent mt-1 tabular-nums">{t('sessions.playFromDrive.downloading', { percent: Math.round(comingFromDrive * 100) })}</p>
        )}
        {audio === null && !reachable && <p class="text-xs text-warn mt-1">{t('transcription.audioElsewhere')}</p>}
      </div>

      {/* The viewer lays itself out in this box (scoreViewer.ts): its host
          is its own, this wrapper is what has the height. */}
      <div class="flex-1 min-h-0 flex flex-col">
        <div ref={hostRef} />
      </div>

      {/* One way into the cards, a new one or an existing one (cardModals.tsx
          — 2026-11-28, the user: a button saved). */}
      <button type="button" class="btn-primary w-full justify-center shrink-0" data-tour="transcription-to-card" onClick={() => leave(() => showAddToCard(record))}>
        {t('transcription.toCard.add')}
      </button>
    </div>
  );
}
