import { useEffect, useRef, useState } from 'preact/hooks';
import { t } from '../../services/i18nService';
import { appState, mutate, navigate } from '../../store';
import { GearIcon, ExternalLinkIcon, ResetIcon, UploadIcon } from '../../components/icons';
import { downloadIcon } from '../../components/playbackIcons';
import { confirmModal } from '../../components/modal';
import { mountScoreViewer, type ScoreViewer } from '../../components/scoreViewer';
import type { AudioSyncBinding } from '../../components/viewerShared';
import { mountScoreFollow } from '../../session/ui/ScoreFollowView';
import { fmtTime, TitleRow } from '../../session/ui/sessionUiShared';
import { downloadBlob } from '../../services/fileTransfer';
import { audioExtension } from '../../services/zip';
import { detectAudioFile } from '../../session/audio/clipExtract';
import { sanitizeFileBase } from '../../services/attachmentNames';
import { fmtDate } from '../../services/dateFormat';
import { currentAbc, editTranscriptionTree, transcriptionModuleOf, transcriptionTreeOf, type TranscriptionRecord } from '../model';
import { FolderPicker } from '../../components/folderBrowser';
import { placeSession } from '../../session/sessionTree';
import { saveCorrection, revertToDraft, renameTranscription, deleteTranscription } from '../actions';
import { getTranscriptionAudio } from '../audioDb';
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

/** The audio sync on the transcription's own recording: its passage. */
function followRecording(record: TranscriptionRecord, audio: Blob): AudioSyncBinding {
  const id = `transcription:${record.id}`;
  return {
    fromDrive: false,
    // Followed whatever the verdict (viewerShared.ts): the score was written
    // from this very recording.
    forcedByDefault: true,
    plays: (version) => /^K:/m.test(version),
    mount: (host, version, face, expanded, onState, forced, transpose, below, editor) =>
      mountScoreFollow(host, {
        target: { kind: 'passage', start: record.from, end: record.to, home: true, loose: true },
        version, face, expanded, onState, forced, transpose, below, editor,
        getAudio: async () => ({ blob: audio, start: 0, id }),
      }),
  };
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
  /** The recording: undefined while it is looked for, null when this device
   *  does not hold it. */
  const [audio, setAudio] = useState<Blob | null | undefined>(undefined);
  /** Bumped to show the score afresh (back to the draft): the viewer reads
   *  its text once, at its mounting. */
  const [epoch, setEpoch] = useState(0);
  /** Set while going back to the draft: the edit on screen is dropped, not
   *  written over the draft just restored. */
  const dropPending = useRef(false);
  const present = !!record;

  useEffect(() => {
    let live = true;
    void getTranscriptionAudio(id).then(b => { if (live) setAudio(b ?? null); }, () => { if (live) setAudio(null); });
    return () => { live = false; };
  }, [id]);

  // The viewer, mounted once the recording is known (its audio sync needs
  // it), afresh at each epoch; its corrections written as they are saved. Gone
  // with the transcription (deleted elsewhere): its sound and its keys too.
  useEffect(() => {
    const host = hostRef.current;
    const r = transcriptionModuleOf(appState.value)?.transcriptions[id];
    if (!host || !r || audio === undefined) return;
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
      ...(audio ? { audioSync: followRecording(r, audio) } : {}),
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
  }, [id, audio, epoch, present]);

  /** Leaving: an edit not saved asks first (the viewer's own question). */
  const leave = (go: () => void) => { if (!viewerRef.current?.guardLeave(go)) go(); };

  if (!record) return <p class="text-sm text-dim p-6">{t('transcription.notFound')}</p>;

  const corrected = record.abc !== undefined;
  const Icon = SOURCE_ICON[record.source];
  const fileName = `${sanitizeFileBase(record.name) || 'transcription'}.abc`;
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
          // The analysis's order (SessionSummary's title menu): the export
          // first, with its icon; then the two that replace what is written,
          // as re-analysing is — its icon, not red, asked first, the question
          // not red either: nothing is deleted (2026-11-28, the user); then
          // the rest.
          menu={[
            { label: t('transcription.menu.export'), icon: <UploadIcon size={14} />, onClick: () => showExportAbcModal(viewerRef.current?.pendingText() ?? currentAbc(record), fileName) },
            ...(corrected ? [{ label: t('transcription.menu.revert'), icon: <ResetIcon size={14} />, onClick: () => confirmModal(
              t('transcription.menu.revert'), t('transcription.revert.message'), t('transcription.revert.confirm'),
              () => { dropPending.current = true; void revertToDraft(id).then(() => setEpoch(e => e + 1)); },
              { destructive: false },
            ) }] : []),
            // Again, other settings or another passage (2026-11-28, the user:
            // a button for it after all) — the edit on screen settled first.
            ...(audio ? [{ label: t('transcription.menu.redo'), icon: <ResetIcon size={14} />, onClick: () => leave(() => void startRedo(id)) }] : []),
            // The recording, whole, as kept here — a take's only copy until
            // Drive keeps them (the review of 2026-11-28, the user: yes).
            ...(audio ? [{ label: t('transcription.menu.downloadAudio'), icon: <span class="flex items-center" dangerouslySetInnerHTML={{ __html: downloadIcon(14) }} />, onClick: () => void downloadRecording(record, audio) }] : []),
            { label: t('transcription.menu.prefs'), icon: <GearIcon size={14} />, onClick: () => viewerRef.current?.openPrefs() },
            { label: t('fileViewer.abc.openInAbcTools'), icon: <ExternalLinkIcon size={12} />, onClick: () => viewerRef.current?.openInAbcTools() },
          ]}
        />
        {/* Where it lives, as an analysis's (AnalysisFolderPicker): nothing
            while there are no folders. */}
        <FolderPicker
          tree={transcriptionTreeOf(appState.value)}
          itemId={id}
          onPlace={(folderId) => { void mutate(s => editTranscriptionTree(s, tr => placeSession(tr, id, folderId))); }}
        />
        {/* The analyses' line under a name (AnalysisBrowser's Card): the
            source's glyph, what it is; corrected or not, in a word. */}
        <div class="mt-1 text-xs text-dim flex items-start gap-1.5">
          <span class="shrink-0 flex items-center h-4" title={sourceName(record.source)}><Icon size={12} /></span>
          <span class="min-w-0">
            {detailLine(record)}
            {corrected && <span class="text-warn"> · {t('transcription.corrected')}</span>}
          </span>
        </div>
        {audio === null && <p class="text-xs text-warn mt-1">{t('transcription.audioElsewhere')}</p>}
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
