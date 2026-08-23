import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { t } from '../../services/i18nService';
import { showModal, closeModal } from '../../components/modal';
import { loadSessionAudio } from '../db';
import { shareSession, exportSessionFile } from '../../services/sessionShareService';
import { isScraperServerWarm } from '../../services/scraperServerStatus';
import { SHARE_MAX_AUDIO_BYTES } from '../sessionConfig';
import type { RecordedSession } from '../model';

// ── Share a session (annotations + optionally the audio) via a short key —
// same mechanism as card sharing (shareService.ts). showModal/closeModal are
// the shared modal shell (components/modal.ts) — out of scope for this
// migration, used as-is; everything INSIDE the modal body below is this
// component's own content.

const SHARE_ICON_FILE_UP = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>';
const SHARE_ICON_SHARE = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>';

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
          void navigator.clipboard.writeText(keyValue);
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        }}
      >
        {copied ? t('library.share.copied') : t('library.share.copy')}
      </button>
      <p class="text-xs text-muted text-center">{t('library.share.validity', { minutes: Math.floor(secondsRemaining / 60) })}</p>
    </>
  );
}

type UploadState =
  | { phase: 'idle' }
  | { phase: 'uploading' }
  | { phase: 'result'; key: string; secondsRemaining: number }
  | { phase: 'error'; message: string };

function ShareSessionModal({ session }: { session: RecordedSession }) {
  const [audioBlob, setAudioBlob] = useState<Blob | null | undefined>(undefined); // undefined = still checking
  const [includeAudio, setIncludeAudio] = useState(false);
  const [upload, setUpload] = useState<UploadState>({ phase: 'idle' });

  useEffect(() => {
    void loadSessionAudio(session.id).then(loaded => {
      const blob = loaded ?? null;
      setAudioBlob(blob);
      if (blob) setIncludeAudio(blob.size <= SHARE_MAX_AUDIO_BYTES);
    });
    // eslint-disable-next-line
  }, [session.id]);

  if (audioBlob === undefined) {
    return <p class="text-xs text-muted text-center py-2">{t('sessions.share.checking')}</p>;
  }
  if (upload.phase === 'uploading') {
    return <p class="text-xs text-muted text-center py-2">{isScraperServerWarm() ? t('sessions.share.uploading') : t('sessions.share.wakingServer')}</p>;
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

  const tooBig = audioBlob !== null && audioBlob.size > SHARE_MAX_AUDIO_BYTES;

  return (
    <div class="space-y-3">
      {audioBlob ? (
        <>
          <label class="flex items-center gap-2 cursor-pointer select-none">
            <input
              type="checkbox"
              class="card-checkbox"
              checked={includeAudio}
              onChange={(e) => setIncludeAudio((e.target as HTMLInputElement).checked)}
            />
            <span class="text-xs text-muted">{t('sessions.share.includeAudio', { mb: (audioBlob.size / 1048576).toFixed(0) })}</span>
          </label>
          {tooBig && <p class="text-xs text-warn">{t('sessions.share.tooBig')}</p>}
        </>
      ) : (
        <p class="text-xs text-dim">{t('sessions.share.noAudio')}</p>
      )}

      <div class="space-y-2 mt-1">
        <ShareChoiceCard
          icon={SHARE_ICON_FILE_UP}
          label={t('library.export.file')}
          desc={t('sessions.share.fileDesc')}
          color="var(--color-warn)"
          onClick={() => { void exportSessionFile(session, includeAudio ? audioBlob : null); closeModal(); }}
        />
        <ShareChoiceCard
          icon={SHARE_ICON_SHARE}
          label={t('library.share.label')}
          desc={t('library.share.desc')}
          color="var(--color-accent)"
          onClick={() => { void doUpload(includeAudio ? audioBlob : null); }}
        />
      </div>
    </div>
  );
}

/** Imperative bridge — showModal (the shared modal shell) still needs a plain
 *  HTMLElement body; everything inside it is this component's own JSX now.
 *  Same name/signature as the function it replaces. */
export function showShareSessionModal(session: RecordedSession): void {
  const body = document.createElement('div');
  render(<ShareSessionModal session={session} />, body);
  showModal(t('sessions.share.title'), body, []);
}
