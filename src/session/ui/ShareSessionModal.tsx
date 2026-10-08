import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { t } from '../../services/i18nService';
import { showModal, closeModal, updateTopModal } from '../../components/modal';
import { loadSessionAudio, probeSyncedAudio, downloadSyncedAudioOnce, type SyncedAudioProbe } from '../db';
import { shareSession, exportSessionFile } from '../../services/sessionShareService';
import { exportAnalysisCSV, exportAnalysisTXT, analysisTextReport } from '../../services/analysisExport';
import { isScraperServerWarm } from '../../services/scraperServerStatus';
import { SHARE_MAX_AUDIO_BYTES } from '../sessionConfig';
import { copyText, formatBytes } from '../../utils';
import type { Analysis, Detection } from '../model';
import { tuneName, useTuneNames } from './sessionUiShared';

// ── Share a session (annotations + optionally the audio) via a short key —
// same mechanism as card sharing (shareService.ts). showModal/closeModal are
// the shared modal shell (components/modal.ts) — out of scope for this
// migration, used as-is; everything INSIDE the modal body below is this
// component's own content.

const SHARE_ICON_FILE_UP = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>';
const SHARE_ICON_SHARE = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>';
const SHARE_ICON_CSV = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="15" x2="21" y2="15"/><line x1="9" y1="9" x2="9" y2="21"/></svg>';
const SHARE_ICON_TXT = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="14" y2="17"/></svg>';
const SHARE_ICON_CLIPBOARD = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';

function ShareChoiceCard({ icon, label, desc, color, onClick }: {
  icon: string; label: string; desc: string; color: string; onClick: () => void;
}) {
  const [hover, setHover] = useState(false);
  return (
    <button
      class="flex items-center gap-3.5 w-full px-4 py-3.5 rounded-xl border border-border bg-bg text-left cursor-pointer"
      style={{ transition: 'border-color 0.15s, background 0.15s', borderColor: hover ? color : undefined, background: hover ? `${color}12` : undefined }}
      title={desc}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={onClick}
    >
      <span class="shrink-0 flex items-center" style={{ color }} dangerouslySetInnerHTML={{ __html: icon }} />
      <div class="flex-1 text-sm font-medium text-primary">{label}</div>
      <span class="text-dim text-base leading-none shrink-0">›</span>
    </button>
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
  | { phase: 'uploading' }
  | { phase: 'fetchingAudio' }
  | { phase: 'result'; key: string; secondsRemaining: number }
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
  const [view, setView] = useState<'root' | 'package' | 'txt'>('root');
  const [copied, setCopied] = useState<'no' | 'yes' | 'failed'>('no');
  const [detailed, setDetailed] = useState(false);
  // The names as the screen shows them, not the recogniser's lower case. The
  // name index is primed here because nothing guarantees a screen that lists
  // detections ran first (a share from the analysis browser does not).
  useTuneNames();
  const nameOf = (d: Detection) => tuneName(d).text;

  // The header belongs to the shell, not to this body, so the two levels are
  // kept in step from here — same title-plus-back-arrow the card export modal
  // shows, rather than a second back link drawn inside the content. The phase
  // matters as much as the view, and for the same reasons the reference modal
  // has: there is nothing to go back TO mid-upload, a generated key must not
  // be one stray click from being lost, and a failed upload belongs back at
  // the two destinations rather than out at the format list.
  useEffect(() => {
    const packageTitle = t('sessions.export.cds');
    if (upload.phase === 'uploading' || upload.phase === 'result') {
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
  }, [view, upload.phase]);

  useEffect(() => {
    void (async () => {
      const blob = (await loadSessionAudio(session.id)) ?? null;
      const probe = blob ? null : await probeSyncedAudio(session.id);
      setRemote(probe);
      setAudioBlob(blob);
      const bytes = blob?.size ?? (probe?.status === 'ok' ? probe.bytes : null);
      if (bytes !== null) setIncludeAudio(bytes <= SHARE_MAX_AUDIO_BYTES);
    })();
    // eslint-disable-next-line
  }, [session.id]);

  /** From the button, so a token window may open: the only way past "the
   *  Google connection needs renewing" that GIS allows. */
  const probeAgain = () => {
    setProbing(true);
    void probeSyncedAudio(session.id, true).then(probe => {
      setRemote(probe);
      if (probe?.status === 'ok') setIncludeAudio(probe.bytes <= SHARE_MAX_AUDIO_BYTES);
    }).finally(() => setProbing(false));
  };

  if (audioBlob === undefined) {
    return <p class="text-xs text-muted text-center py-2">{t('sessions.share.checking')}</p>;
  }
  if (upload.phase === 'uploading') {
    return <p class="text-xs text-muted text-center py-2">{isScraperServerWarm() ? t('sessions.share.uploading') : t('sessions.share.wakingServer')}</p>;
  }
  if (upload.phase === 'fetchingAudio') {
    return <p class="text-xs text-muted text-center py-2">{t('sessions.share.fetchingAudio')}</p>;
  }
  if (upload.phase === 'error') {
    return <p class="text-xs text-muted text-center py-2">{upload.message}</p>;
  }
  if (upload.phase === 'result') {
    return <ShareKeyResult keyValue={upload.key} secondsRemaining={upload.secondsRemaining} />;
  }

  const doUpload = async (withAudio: Blob | null) => {
    setUpload({ phase: 'uploading' });
    try {
      const { key, secondsRemaining } = await shareSession(session, withAudio);
      setUpload({ phase: 'result', key, secondsRemaining });
    } catch (e) {
      setUpload({ phase: 'error', message: t('theSession.error', { message: e instanceof Error ? e.message : String(e) }) });
    }
  };

  const remoteBytes = remote?.status === 'ok' ? remote.bytes : null;
  const audioBytes = audioBlob?.size ?? remoteBytes;
  const tooBig = audioBytes !== null && audioBytes > SHARE_MAX_AUDIO_BYTES;

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
            color="var(--color-warn)"
            onClick={() => { exportAnalysisTXT(session, { detailed, nameOf }); closeModal(); }}
          />
          <ShareChoiceCard
            icon={SHARE_ICON_CLIPBOARD}
            label={copied === 'no' ? t('common.copyToClipboard') : t(copied === 'yes' ? 'common.copied' : 'common.copyFailed')}
            desc={t('common.copyToClipboardDesc')}
            color="var(--color-success)"
            onClick={() => {
              void copyText(analysisTextReport(session, { detailed, nameOf })).then(ok => {
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

  // Two levels, mirroring the card export modal: the root offers the three
  // FORMATS, and the .cds package — whose two destinations (a file, a share
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
            {tooBig && <p class="text-xs text-warn">{t('sessions.share.tooBig')}</p>}
          </>
        ) : remote && remote.status !== 'gone' ? (
          // On Drive by the record, but Drive cannot be asked right now.
          // Greyed, with the reason — and, for a token, the one way through.
          <>
            <label class="flex items-center gap-2 select-none opacity-50 cursor-not-allowed">
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
            color="var(--color-warn)"
            onClick={() => { void withAudio(async audio => { await exportSessionFile(session, audio); closeModal(); }); }}
          />
          <ShareChoiceCard
            icon={SHARE_ICON_SHARE}
            label={t('library.share.label')}
            desc={t('library.share.desc')}
            color="var(--color-accent)"
            onClick={() => { void withAudio(doUpload); }}
          />
        </div>
      </div>
    );
  }

  return (
    <div class="space-y-2">
      <ShareChoiceCard
        icon={SHARE_ICON_FILE_UP}
        label={t('sessions.export.cds')}
        desc={t('sessions.export.cdsDesc')}
        color="var(--color-warn)"
        onClick={() => setView('package')}
      />
      {/* Read-only: neither comes back into Cadence, and neither carries audio. */}
      <ShareChoiceCard
        icon={SHARE_ICON_CSV}
        label="CSV"
        desc={t('sessions.export.csvDesc')}
        color="var(--color-success)"
        onClick={() => { exportAnalysisCSV(session, nameOf); closeModal(); }}
      />
      <ShareChoiceCard
        icon={SHARE_ICON_TXT}
        label="TXT"
        desc={t('sessions.export.txtDesc')}
        color="var(--color-muted)"
        onClick={() => setView('txt')}
      />
    </div>
  );
}

/** Imperative bridge — showModal (the shared modal shell) still needs a plain
 *  HTMLElement body; everything inside it is this component's own JSX now.
 *  Same name/signature as the function it replaces. */
export function showShareSessionModal(session: Analysis): void {
  const body = document.createElement('div');
  render(<ShareSessionModal session={session} />, body);
  showModal(t('sessions.export.title'), body, []);
}
