import { useEffect, useState } from 'preact/hooks';
import { t } from '../../services/i18nService';
import { showModal, closeModal, renderModalBody } from '../../components/modal';
import { downloadBlob, formatBytes } from '../../utils';
import { audioExtension } from '../../services/zip';
import { fmtSessionDateTime } from '../sessionNaming';
import { orphanAudio, retryRecovery, abandonRecovery, settleRecoveryFailure, type RecoveryFailure } from '../recovery';

// ── A recording that could not be recovered (2026-09-17) ──────────────────────
// Deliberately impossible to close: no ✕, no Escape, no click outside, no back
// gesture. The only ways out are "retry" and "abandon", so nobody loses a
// recording by swatting a dialog away — they have to read it and choose.
//
// The abandon button's colour says what abandoning costs right now:
//  - no audio to lose → the usual primary blue;
//  - audio on the device, not yet kept → red;
//  - audio downloaded AND the user ticked that they have the file → green.
// Ticked by the user, not inferred: a browser never reports whether a download
// completed, and a button turning green over a download that silently failed
// would be the one lie this dialog cannot afford.

type AudioState =
  | { state: 'loading' }
  | { state: 'none' }
  | { state: 'ready'; blob: Blob }
  | { state: 'unreadable'; message: string };

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

function RecoveryFailureBody({ initial, onClose }: { initial: RecoveryFailure; onClose: () => void }) {
  const [failure, setFailure] = useState(initial);
  const [audio, setAudio] = useState<AudioState>({ state: 'loading' });
  const [launched, setLaunched] = useState(false);
  const [kept, setKept] = useState(false);
  const [busy, setBusy] = useState<'retry' | 'abandon' | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const session = failure.session;

  useEffect(() => {
    let mounted = true;
    orphanAudio(session).then(
      blob => { if (mounted) setAudio(blob ? { state: 'ready', blob } : { state: 'none' }); },
      err => { if (mounted) setAudio({ state: 'unreadable', message: errorText(err) }); },
    );
    return () => { mounted = false; };
    // eslint-disable-next-line
  }, []);

  const download = () => {
    if (audio.state !== 'ready') return;
    try {
      downloadBlob(audio.blob, `${session.name}.${audioExtension(audio.blob.type)}`);
      setLaunched(true);
      setActionError(null);
    } catch (err) {
      setActionError(`${t('sessions.recoveryFailed.downloadFailed')} ${errorText(err)}`);
    }
  };

  const retry = async () => {
    setBusy('retry');
    setActionError(null);
    try {
      const again = await retryRecovery(session);
      if (!again) { onClose(); return; }
      setFailure(again);
    } catch (err) {
      setFailure({ session, kind: 'error', message: errorText(err) });
    }
    setBusy(null);
  };

  const abandon = async () => {
    setBusy('abandon');
    setActionError(null);
    try {
      await abandonRecovery(session.id);
      onClose();
    } catch (err) {
      setActionError(`${t('sessions.recoveryFailed.abandonFailed')} ${errorText(err)}`);
      setBusy(null);
    }
  };

  // Unreadable audio counts as audio at stake: it may well be there, and
  // abandoning deletes it either way.
  const abandonClass = audio.state === 'none' ? 'btn-primary'
    : audio.state === 'ready' && kept ? 'btn-success'
    : 'btn-danger';

  return (
    <div class="space-y-3 text-sm">
      <p class="text-muted leading-relaxed">{t('sessions.recoveryFailed.intro')}</p>
      <div>
        <p class="text-primary font-semibold break-words">{session.name}</p>
        {session.date && <p class="text-xs text-dim">{fmtSessionDateTime(session.date)}</p>}
      </div>

      {failure.kind === 'interrupted' ? (
        <p class="text-muted leading-relaxed">{t('sessions.recoveryFailed.interrupted')}</p>
      ) : (
        <div class="space-y-1">
          <p class="text-muted leading-relaxed">{t('sessions.recoveryFailed.error')}</p>
          <p class="text-xs font-mono text-danger break-words">{failure.message}</p>
        </div>
      )}

      <div class="space-y-2 pt-1">
        {audio.state === 'loading' && <p class="text-dim">{t('sessions.recoveryFailed.audioLoading')}</p>}
        {audio.state === 'none' && <p class="text-muted">{t('sessions.recoveryFailed.noAudio')}</p>}
        {audio.state === 'unreadable' && (
          <div class="space-y-1">
            <p class="text-muted">{t('sessions.recoveryFailed.audioUnreadable')}</p>
            <p class="text-xs font-mono text-danger break-words">{audio.message}</p>
          </div>
        )}
        {audio.state === 'ready' && (
          <>
            <p class="text-muted leading-relaxed">
              {t('sessions.recoveryFailed.audioReady', { size: formatBytes(audio.blob.size) })}
            </p>
            <button class="btn-ghost border border-border" disabled={busy !== null} onClick={download}>
              {t('sessions.recoveryFailed.download')}
            </button>
            {launched && (
              <label class="flex items-center gap-2 cursor-pointer select-none text-primary">
                <input
                  type="checkbox"
                  class="card-checkbox"
                  checked={kept}
                  onChange={(e) => setKept((e.target as HTMLInputElement).checked)}
                />
                <span>{t('sessions.recoveryFailed.confirmKept')}</span>
              </label>
            )}
          </>
        )}
      </div>

      <p class="text-xs text-dim leading-relaxed">{t('sessions.recoveryFailed.abandonWarning')}</p>
      {actionError && <p class="text-xs text-danger break-words">{actionError}</p>}

      <div class="flex items-center justify-end gap-2 pt-3 border-t border-border">
        <button class="btn-ghost" disabled={busy !== null} onClick={() => { void retry(); }}>
          {busy === 'retry' ? t('sessions.recoveryFailed.retrying') : t('sessions.recoveryFailed.retry')}
        </button>
        <button
          class={abandonClass}
          disabled={busy !== null || audio.state === 'loading'}
          onClick={() => { void abandon(); }}
        >
          {t('sessions.recoveryFailed.abandon')}
        </button>
      </div>
    </div>
  );
}

/** One dialog per failed recording, one after the other. `onSettled` runs after
 *  each decision — the library re-reads its list, since a retry that worked
 *  just added an analysis to it. */
export function showRecoveryFailures(failures: RecoveryFailure[], onSettled: () => void): void {
  const [first, ...rest] = failures;
  if (!first) return;
  const { el, cleanup } = renderModalBody(
    <RecoveryFailureBody
      initial={first}
      onClose={() => {
        closeModal();
        cleanup();
        settleRecoveryFailure(first.session.id);
        onSettled();
        showRecoveryFailures(rest, onSettled);
      }}
    />,
  );
  // No footer actions: the buttons change colour with the body's state, and
  // the footer is declared up front, outside the body's tree.
  showModal(t('sessions.recoveryFailed.title'), el, [], { dismissable: false });
}
