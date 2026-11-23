import { signal, type Signal } from '@preact/signals';
import { showModal, closeModalOf, renderModalBody, alertModal } from '../../components/modal';
import { showPreviewModal, type AudioSyncBinding } from '../../components/fileViewer';
import { transcribeAudio } from '../scoreFollowClient';
import { mountScoreFollow, failureText } from './ScoreFollowView';
import { t } from '../../services/i18nService';

// ── A recording written out, then followed (2026-11-23, the user) ────────────
// Hidden, for two testers: five taps in a row on the logo of "About"
// (aboutModal.tsx) pick a recording, written out as ABC in the worker
// (scoreFollowWorker.ts, transcription.ts); the score viewer then opens on
// it, its audio sync on, following the very recording. Nothing is kept: the
// score is not saved anywhere, the viewer reads it only.

function toBase64(text: string): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(text)));
}

/** The file's name without its extension. */
const baseName = (name: string): string => name.replace(/\.[^.]+$/, '') || name;

/** The worker's ABC (its M:, L:, Q:, K: lines and the tune) made a whole tune. */
const wholeTune = (abc: string, title: string): string => ['X: 1', `T: ${title}`, abc.trim()].join('\n');

/** The audio sync of the transcription: the recording itself, whole. Followed
 *  even when the alignment is judged poor — it is the recording's own score. */
function followFile(file: File): AudioSyncBinding {
  const id = `transcribed:${file.name}|${file.lastModified}`;
  return {
    fromDrive: false,
    plays: (version) => /^K:/m.test(version),
    mount: (host, version, face, expanded, onState, forced, transpose, below, editor) =>
      mountScoreFollow(host, {
        target: { kind: 'recording' }, version, face, expanded, onState, forced, transpose, below, editor,
        getAudio: async () => ({ blob: file, start: 0, id }),
      }),
  };
}

function Working({ name, ratio }: { name: string; ratio: Signal<number> }) {
  return (
    <div class="space-y-3">
      <p class="text-sm text-muted break-words">{t('transcribe.working', { name })}</p>
      <div class="h-1.5 rounded-full bg-surface overflow-hidden">
        <div class="h-full bg-accent transition-[width] duration-300" style={{ width: `${Math.round(ratio.value * 100)}%` }} />
      </div>
    </div>
  );
}

/** Transcribes `file`, then opens its score following it. A dialog says how
 *  far it has gone; closed, the work stops. */
export function transcribeRecording(file: File): void {
  const ratio = signal(0);
  const stop = new AbortController();
  const { el, cleanup } = renderModalBody(<Working name={file.name} ratio={ratio} />);
  showModal(t('transcribe.title'), el, [], { onDismiss: () => { cleanup(); stop.abort(); } });
  const done = () => { closeModalOf(el); cleanup(); };
  transcribeAudio(file, (r) => { ratio.value = r; }, stop.signal).then((result) => {
    if (stop.signal.aborted) return;
    done();
    if (typeof result === 'string') {
      alertModal(t('transcribe.title'), result === 'no_contour' ? t('transcribe.noNotes') : failureText(result));
      return;
    }
    if ('tooLong' in result) {
      alertModal(t('transcribe.title'), t('transcribe.tooLong', { seconds: String(Math.ceil(result.tooLong / 60)), max: String(result.max / 60) }));
      return;
    }
    const title = baseName(file.name);
    showPreviewModal(
      { name: `${title}.abc`, mimeType: 'text/vnd.abc', data: toBase64(wholeTune(result.abc, title)) },
      undefined,
      { audioSyncCarry: { binding: followFile(file), forced: true } },
    );
  }, (e: unknown) => {
    if (stop.signal.aborted) return;
    console.warn('[transcribe] failed', e);
    done();
    alertModal(t('transcribe.title'), t('transcribe.failed'));
  });
}
