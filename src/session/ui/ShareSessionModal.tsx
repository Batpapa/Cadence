import { useEffect, useRef, useState } from 'preact/hooks';
import { t } from '../../services/i18nService';
import { showModal, closeModal, updateTopModal, renderModalBody } from '../../components/modal';
import { ArrowRightIcon } from '../../components/icons';
import { ChoiceCard, InlineStatus } from '../../components/ui';
import { loadSessionAudio, probeSyncedAudio, downloadSyncedAudioOnce, type SyncedAudioProbe } from '../db';
import { shareSession, exportSessionFile, packageSize } from '../../services/sessionShareService';
import { getShareCapacity, ShareTooLargeError, isAbortError } from '../../services/shareService';
import { exportAnalysisCSV, exportAnalysisTXT, exportAnalysisClipsZip, analysisTextReport } from '../../services/analysisExport';
import { isScraperServerWarm } from '../../services/scraperServerStatus';
import { formatBytes } from '../../utils';
import { copyText } from '../../services/fileTransfer';
import type { Analysis, Detection } from '../model';
import { tuneName, useTuneNames } from './tuneNames';
import { setDetectionOn } from '../detections';
import { getContext } from '../../store';

// ── Share a session (annotations + optionally the audio) via a short key —
// same mechanism as card sharing (shareService.ts). showModal/closeModal are
// the shared modal shell (components/modal.ts) — out of scope for this
// migration, used as-is; everything INSIDE the modal body below is this
// component's own content.

export const SHARE_ICON_FILE_UP = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>';
const SHARE_ICON_SHARE = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>';
export const SHARE_ICON_CSV = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="15" x2="21" y2="15"/><line x1="9" y1="9" x2="9" y2="21"/></svg>';
export const SHARE_ICON_TXT = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="14" y2="17"/></svg>';
export const SHARE_ICON_CLIPBOARD = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
const SHARE_ICON_CLIPS = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><line x1="20" y1="4" x2="8.12" y2="15.88"/><line x1="14.47" y1="14.48" x2="20" y2="20"/><line x1="8.12" y1="8.12" x2="12" y2="12"/></svg>';

/** One way out, as every dialog of the app offers them (ChoiceCard): the
 *  description on screen — it was only a tooltip, which a finger never sees —
 *  and the icon in the accent, where each row had a decorative colour of its
 *  own. The icons are the HTML strings above, hence the span. */
export function ShareChoiceCard({ icon, label, desc, onClick, disabled = false }: {
  icon: string; label: string; desc: string; onClick: () => void; disabled?: boolean;
}) {
  return (
    <ChoiceCard
      icon={<span class="flex items-center" dangerouslySetInnerHTML={{ __html: icon }} />}
      label={label}
      desc={desc}
      trailing={<ArrowRightIcon size={16} />}
      // ChoiceCard has no disabled state: greyed, and the click does nothing.
      class={disabled ? 'opacity-40 cursor-not-allowed pointer-events-none' : ''}
      onClick={disabled ? () => {} : onClick}
    />
  );
}

function ShareKeyResult({ keyValue, secondsRemaining }: { keyValue: string; secondsRemaining: number }) {
  const [copied, setCopied] = useState(false);
  return (
    <>
      <div class="text-center font-mono text-3xl font-bold tracking-[0.3em] text-primary py-2">{keyValue}</div>
      <button
        class="btn-primary w-full text-sm"
        onClick={() => {
          void copyText(keyValue).then(ok => {
            if (!ok) return;
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          });
        }}
      >
        {copied ? t('common.copied') : t('library.share.copy')}
      </button>
      <p class="text-xs text-muted text-center">{t('library.share.validity', { minutes: Math.floor(secondsRemaining / 60) })}</p>
    </>
  );
}

type UploadState =
  | { phase: 'idle' }
  /** `sent`/`total` once the body has started to go — a 3-hour recording from
   *  a phone takes minutes. */
  | { phase: 'uploading'; sent?: number; total?: number }
  /** In the share server's queue (shareService.ts), `position` counting this
   *  one. */
  | { phase: 'waiting'; position: number }
  | { phase: 'fetchingAudio' }
  | { phase: 'result'; key: string; secondsRemaining: number }
  | { phase: 'error'; message: string };

/** Room on the share server (2026-11-15: no fixed cap any more, it takes what
 *  fits on its disk, and what does not fit yet waits its turn). Asked when the
 *  package view opens — which also wakes the server. `max` null: a server
 *  older than the queue. `unknown`: the question failed, and the server
 *  decides at the upload. */
type CapacityState =
  | { status: 'checking' }
  | { status: 'ok'; available: number; max: number | null }
  | { status: 'unknown' };

/** The clips zip, from the click to the download. */
type ClipsState =
  | { phase: 'idle' }
  | { phase: 'fetchingAudio' }
  | { phase: 'cutting'; done: number; total: number }
  | { phase: 'error'; message: string };

function ShareSessionModal({ session }: { session: Analysis }) {
  const [audioBlob, setAudioBlob] = useState<Blob | null | undefined>(undefined); // undefined = still checking
  // When the recording is not on this device: what Drive ACTUALLY says about
  // its copy, asked when the modal opens. The record of an upload is a belief
  // (it once outlived a Drive emptied by hand — 2026-09-24), so the offer
  // follows the answer, never the record: available means sent along,
  // anything else is said as it is.
  const [remote, setRemote] = useState<SyncedAudioProbe | null>(null);
  const [probing, setProbing] = useState(false);
  const [includeAudio, setIncludeAudio] = useState(false);
  const [upload, setUpload] = useState<UploadState>({ phase: 'idle' });
  const [clips, setClips] = useState<ClipsState>({ phase: 'idle' });
  const [view, setView] = useState<'root' | 'package' | 'txt'>('root');
  const [copied, setCopied] = useState<'no' | 'yes' | 'failed'>('no');
  const [detailed, setDetailed] = useState(false);
  const [capacity, setCapacity] = useState<CapacityState | null>(null); // null: not asked yet
  // The wait in the queue and the upload after it: cancelled by the button,
  // and by the window closing — a key nobody will see is not worth the room
  // it takes from the next in line.
  const uploadCtrl = useRef<AbortController | null>(null);
  useEffect(() => () => uploadCtrl.current?.abort(), []);
  // The names as the screen shows them, not the recogniser's lower case. The
  // name index is primed here because nothing guarantees a screen that lists
  // detections ran first (a share from the analysis browser does not).
  useTuneNames();
  const nameOf = (d: Detection) => tuneName(d).text;
  // A blank line between sets, with set detection on (2026-10-19).
  const setBreaks = setDetectionOn(getContext().user);

  // The header belongs to the shell, not to this body, so the two levels are
  // kept in step from here — same title-plus-back-arrow the card export modal
  // shows, rather than a second back link drawn inside the content. The phase
  // matters as much as the view, and for the same reasons the reference modal
  // has: there is nothing to go back TO mid-upload, a generated key must not
  // be one stray click from being lost, and a failed upload belongs back at
  // the two destinations rather than out at the format list.
  useEffect(() => {
    const packageTitle = t('sessions.export.cds');
    // Same rule for the clips: nothing to go back to while they are cut, and
    // a failure goes back to the formats.
    if (clips.phase === 'fetchingAudio' || clips.phase === 'cutting') {
      updateTopModal({ title: t('sessions.export.clips'), onBack: undefined });
    } else if (clips.phase === 'error') {
      updateTopModal({ title: t('sessions.export.clips'), onBack: () => setClips({ phase: 'idle' }) });
    } else if (upload.phase === 'uploading' || upload.phase === 'waiting' || upload.phase === 'result') {
      updateTopModal({ title: packageTitle, onBack: undefined });
    } else if (upload.phase === 'error') {
      updateTopModal({ title: packageTitle, onBack: () => setUpload({ phase: 'idle' }) });
    } else if (view === 'txt') {
      updateTopModal({ title: 'TXT', onBack: () => setView('root') });
    } else if (view === 'package') {
      updateTopModal({ title: packageTitle, onBack: () => setView('root') });
    } else {
      updateTopModal({ title: t('sessions.export.title'), onBack: undefined });
    }
  }, [view, upload.phase, clips.phase]);

  useEffect(() => {
    void (async () => {
      const blob = (await loadSessionAudio(session.id)) ?? null;
      const probe = blob ? null : await probeSyncedAudio(session.id);
      setRemote(probe);
      setAudioBlob(blob);
      const bytes = blob?.size ?? (probe?.status === 'ok' ? probe.bytes : null);
      if (bytes !== null) setIncludeAudio(true);
    })();
    // eslint-disable-next-line
  }, [session.id]);

  // Only for the package: CSV and TXT never touch the share server.
  useEffect(() => {
    if (view !== 'package' || capacity !== null) return;
    setCapacity({ status: 'checking' });
    getShareCapacity().then(
      c => setCapacity({ status: 'ok', available: c.availableBytes, max: c.maxBytes }),
      () => setCapacity({ status: 'unknown' }),
    );
    // eslint-disable-next-line
  }, [view]);

  /** From the button, so a token window may open: the only way past "the
   *  Google connection needs renewing" that GIS allows. */
  const probeAgain = () => {
    setProbing(true);
    void probeSyncedAudio(session.id, true).then(probe => {
      setRemote(probe);
      if (probe?.status === 'ok') setIncludeAudio(true);
    }).finally(() => setProbing(false));
  };

  if (audioBlob === undefined) {
    return <p class="text-xs text-muted text-center py-2">{t('sessions.share.checking')}</p>;
  }
  if (upload.phase === 'uploading') {
    // No figure until the first bytes have gone: the server may still be
    // waking up.
    const { sent, total } = upload;
    if (sent === undefined || !total) {
      return <p class="text-xs text-muted text-center py-2">{isScraperServerWarm() ? t('sessions.share.uploading') : t('sessions.share.wakingServer')}</p>;
    }
    return (
      <div class="space-y-2 py-2">
        <p class="text-xs text-muted text-center">{t('sessions.share.uploadingProgress', { sent: formatBytes(sent), total: formatBytes(total) })}</p>
        <div class="knowledge-bar"><div class="knowledge-fill bg-accent" style={{ width: `${Math.min(100, Math.floor(sent / total * 100))}%` }} /></div>
      </div>
    );
  }
  if (upload.phase === 'waiting') {
    return (
      <div class="space-y-3 py-2 text-center">
        <p class="text-xs text-muted">{t('sessions.share.waitingInQueue', { position: upload.position })}</p>
        <button class="btn-ghost text-xs" onClick={() => uploadCtrl.current?.abort()}>{t('common.cancel')}</button>
      </div>
    );
  }
  if (upload.phase === 'fetchingAudio') {
    return <p class="text-xs text-muted text-center py-2">{t('sessions.share.fetchingAudio')}</p>;
  }
  if (upload.phase === 'error') {
    return <InlineStatus tone="error" class="justify-center py-2">{upload.message}</InlineStatus>;
  }
  if (upload.phase === 'result') {
    return <ShareKeyResult keyValue={upload.key} secondsRemaining={upload.secondsRemaining} />;
  }
  if (clips.phase === 'fetchingAudio') {
    return <p class="text-xs text-muted text-center py-2">{t('sessions.share.fetchingAudio')}</p>;
  }
  if (clips.phase === 'cutting') {
    return <p class="text-xs text-muted text-center py-2">{t('sessions.export.clipsCutting', { done: clips.done, total: clips.total })}</p>;
  }
  if (clips.phase === 'error') {
    return <InlineStatus tone="error" class="justify-center py-2">{clips.message}</InlineStatus>;
  }

  const doUpload = async (withAudio: Blob | null) => {
    setUpload({ phase: 'uploading' });
    const ctrl = new AbortController();
    uploadCtrl.current = ctrl;
    try {
      const { key, secondsRemaining } = await shareSession(session, withAudio, {
        signal: ctrl.signal,
        onWaiting: position => setUpload({ phase: 'waiting', position }),
        onProgress: (sent, total) => setUpload({ phase: 'uploading', sent, total }),
      });
      setUpload({ phase: 'result', key, secondsRemaining });
    } catch (e) {
      if (isAbortError(e)) { setUpload({ phase: 'idle' }); return; }
      // Larger than the server could ever hold — its own figure, which the
      // capacity asked at the opening may not have had: back to the choices,
      // the button greyed with the reason.
      if (e instanceof ShareTooLargeError) {
        setCapacity({ status: 'ok', available: 0, max: e.maxBytes });
        setUpload({ phase: 'idle' });
        return;
      }
      setUpload({ phase: 'error', message: t('theSession.error', { message: e instanceof Error ? e.message : String(e) }) });
    }
  };

  const remoteBytes = remote?.status === 'ok' ? remote.bytes : null;
  const audioBytes = audioBlob?.size ?? remoteBytes;
  // What the key would send, against the room on the share server. Greyed
  // while the server is asked — it may take a minute to wake — and, with the
  // two figures, when it could never fit. Too large for NOW says nothing
  // before the click (the user's call, 2026-11-16): the wait shows itself.
  // The file export never depends on any of it.
  const needed = packageSize(session, includeAudio ? audioBytes : null);
  const checkingRoom = capacity === null || capacity.status === 'checking';
  const neverFits = capacity?.status === 'ok' && capacity.max !== null && needed > capacity.max;

  /** The audio to send, fetched from Drive at the moment it is needed when it
   *  is not here. A failure says so and sends nothing: an analysis quietly
   *  shared without the sound the box promised is the defect this replaced. */
  const withAudio = async (send: (audio: Blob | null) => Promise<void> | void) => {
    if (!includeAudio) { await send(null); return; }
    if (audioBlob) { await send(audioBlob); return; }
    setUpload({ phase: 'fetchingAudio' });
    let fetched: Blob | null = null;
    try { fetched = await downloadSyncedAudioOnce(session.id); } catch { /* reported below */ }
    if (!fetched) {
      setUpload({ phase: 'error', message: t('sessions.share.fetchAudioFailed') });
      return;
    }
    setUpload({ phase: 'idle' });
    await send(fetched);
  };

  /** Every clip, in one zip — the recording fetched from Drive first when it
   *  is not here, as the package does, and with the same refusal to pretend:
   *  a recording that cannot be had, or a clip that cannot be cut, says so and
   *  downloads nothing. */
  const exportClips = async () => {
    let audio = audioBlob;
    if (!audio) {
      setClips({ phase: 'fetchingAudio' });
      try { audio = await downloadSyncedAudioOnce(session.id); } catch { /* reported below */ }
      if (!audio) {
        setClips({ phase: 'error', message: t('sessions.export.clipsFetchFailed') });
        return;
      }
    }
    const total = session.annotations.length;
    setClips({ phase: 'cutting', done: 0, total });
    try {
      await exportAnalysisClipsZip(session, audio, nameOf, (done, n) => setClips({ phase: 'cutting', done, total: n }));
      closeModal();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // Worded as the clip window words it (extractClipModal.tsx).
      const shown = msg.startsWith('clip_format_unsupported') || msg.startsWith('clip_cannot_copy') ? t('audioPlayer.clip.unsupported') : msg;
      setClips({ phase: 'error', message: t('sessions.export.clipsFailed', { message: shown }) });
    }
  };

  // TXT has two destinations for the same bytes, so it gets a level of its
  // own — the shape the card export modal already uses for its package.
  // The short setlist unless the box is ticked — for both destinations, which
  // carry the same text whichever it is.
  if (view === 'txt') {
    return (
      <div class="space-y-3">
        <label class="flex items-center gap-2 cursor-pointer select-none">
          <input
            type="checkbox"
            class="card-checkbox"
            checked={detailed}
            onChange={(e) => setDetailed((e.target as HTMLInputElement).checked)}
          />
          <span class="text-xs text-muted">{t('sessions.export.txtDetailed')}</span>
        </label>
        <div class="space-y-2">
          <ShareChoiceCard
            icon={SHARE_ICON_FILE_UP}
            label={t('library.export.file')}
            desc={t('sessions.export.txtDesc')}
            onClick={() => { exportAnalysisTXT(session, { detailed, nameOf, setBreaks }); closeModal(); }}
          />
          <ShareChoiceCard
            icon={SHARE_ICON_CLIPBOARD}
            label={copied === 'no' ? t('common.copyToClipboard') : t(copied === 'yes' ? 'common.copied' : 'common.copyFailed')}
            desc={t('common.copyToClipboardDesc')}
            onClick={() => {
              void copyText(analysisTextReport(session, { detailed, nameOf, setBreaks })).then(ok => {
                setCopied(ok ? 'yes' : 'failed');
                // Long enough to read the confirmation, short enough not to
                // feel stuck. A failure keeps the modal open: there is nothing
                // in the clipboard, so closing would look like success.
                if (ok) setTimeout(closeModal, 900);
              });
            }}
          />
        </div>
      </div>
    );
  }

  // Two levels, mirroring the card export modal: the root offers the FORMATS, and the .cds package — whose two destinations (a file, a share
  // key) are the same bytes going to different places — opens underneath.
  // The audio checkbox lives in that sub-view and nowhere else, because audio
  // is a property of the package: offering it beside CSV and TXT, which can
  // never carry it, is the kind of dead control people click and then distrust.
  if (view === 'package') {
    return (
      <div class="space-y-3">
        {audioBytes !== null ? (
          <>
            <label class="flex items-center gap-2 cursor-pointer select-none">
              <input
                type="checkbox"
                class="card-checkbox"
                checked={includeAudio}
                onChange={(e) => setIncludeAudio((e.target as HTMLInputElement).checked)}
              />
              <span class="text-xs text-muted">{t('sessions.share.includeAudio', { size: formatBytes(audioBytes) })}</span>
            </label>
            {!audioBlob && <p class="text-xs text-dim">{t('sessions.share.audioFromDrive')}</p>}
          </>
        ) : remote && remote.status !== 'gone' ? (
          // On Drive by the record, but Drive cannot be asked right now.
          // Greyed, with the reason — and, for a token, the one way through.
          <>
            <label class="flex items-center gap-2 select-none opacity-40 cursor-not-allowed">
              <input type="checkbox" class="card-checkbox" checked={false} disabled />
              <span class="text-xs text-muted">{t('sessions.share.includeAudioUnknown')}</span>
            </label>
            <p class="text-xs text-dim">
              {t(remote.status === 'needsAuth' ? 'sessions.share.audioNeedsAuth' : 'sessions.share.audioOffline')}
            </p>
            {remote.status === 'needsAuth' && (
              <button class="btn-ghost text-xs" disabled={probing} onClick={probeAgain}>
                {t(probing ? 'sessions.share.checking' : 'sessions.share.checkDrive')}
              </button>
            )}
          </>
        ) : remote?.status === 'gone' ? (
          <p class="text-xs text-dim">{t('sessions.share.audioGone')}</p>
        ) : (
          <p class="text-xs text-dim">{t('sessions.share.noAudio')}</p>
        )}

        <div class="space-y-2 mt-1">
          <ShareChoiceCard
            icon={SHARE_ICON_FILE_UP}
            label={t('library.export.file')}
            desc={t('sessions.share.fileDesc')}
            onClick={() => { void withAudio(async audio => { await exportSessionFile(session, audio); closeModal(); }); }}
          />
          <ShareChoiceCard
            icon={SHARE_ICON_SHARE}
            label={t('library.share.label')}
            desc={t('library.share.desc')}
            disabled={checkingRoom || neverFits}
            onClick={() => { void withAudio(doUpload); }}
          />
          {checkingRoom && (
            <p class="text-xs text-dim">{t(isScraperServerWarm() ? 'sessions.share.checkingRoom' : 'sessions.share.wakingServer')}</p>
          )}
          {neverFits && capacity?.status === 'ok' && capacity.max !== null && (
            <p class="text-xs text-warn">{t('sessions.share.tooBigForServer', { max: formatBytes(capacity.max), needed: formatBytes(needed) })}</p>
          )}        </div>
      </div>
    );
  }

  return (
    <div class="space-y-2">
      <ShareChoiceCard
        icon={SHARE_ICON_FILE_UP}
        label={t('sessions.export.cds')}
        desc={t('sessions.export.cdsDesc')}
        onClick={() => setView('package')}
      />
      {/* Read-only: neither comes back into Cadence, and neither carries audio. */}
      <ShareChoiceCard
        icon={SHARE_ICON_CSV}
        label="CSV"
        desc={t('sessions.export.csvDesc')}
        onClick={() => { exportAnalysisCSV(session, nameOf, { setBreaks }); closeModal(); }}
      />
      <ShareChoiceCard
        icon={SHARE_ICON_TXT}
        label="TXT"
        desc={t('sessions.export.txtDesc')}
        onClick={() => setView('txt')}
      />
      {/* Read-only too, and the one that needs the recording: greyed with the
          reason when it cannot be had, rather than failing after the click. */}
      <ShareChoiceCard
        icon={SHARE_ICON_CLIPS}
        label={t('sessions.export.clips')}
        desc={t('sessions.export.clipsDesc')}
        disabled={audioBytes === null || session.annotations.length === 0}
        onClick={() => { void exportClips(); }}
      />
      {session.annotations.length > 0 && audioBytes !== null && !audioBlob && (
        <p class="text-xs text-dim">{t('sessions.export.clipsFromDrive')}</p>
      )}
      {session.annotations.length > 0 && audioBytes === null && (
        <>
          <p class="text-xs text-dim">
            {t(remote?.status === 'needsAuth' ? 'sessions.share.audioNeedsAuth'
              : remote && remote.status !== 'gone' ? 'sessions.share.audioOffline'
              : 'sessions.export.clipsNoAudio')}
          </p>
          {remote?.status === 'needsAuth' && (
            <button class="btn-ghost text-xs" disabled={probing} onClick={probeAgain}>
              {t(probing ? 'sessions.share.checking' : 'sessions.share.checkDrive')}
            </button>
          )}
        </>
      )}
    </div>
  );
}

/** Imperative bridge — showModal (the shared modal shell) still needs a plain
 *  HTMLElement body; everything inside it is this component's own JSX now.
 *  Same name/signature as the function it replaces. */
export function showShareSessionModal(session: Analysis): void {
  // Unmounted on dismissal: a wait in the share queue, or an upload, stops
  // with the window rather than going on behind it.
  const { el, cleanup } = renderModalBody(<ShareSessionModal session={session} />);
  showModal(t('sessions.export.title'), el, [], { onDismiss: cleanup });
}
