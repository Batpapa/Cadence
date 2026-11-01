import { useEffect, useRef, useState } from 'preact/hooks';
import type { FileAttachment } from '../../types';
import type { AudioSyncState, AudioSyncView } from '../../components/fileViewer';
import { attachmentBlob, AttachmentNotHere } from '../../services/attachmentStore';
import { getAttachmentBlob } from '../../services/attachmentDb';
import { followAudio, type FollowAudio, type FollowStatus } from '../scoreFollowClient';
import { scoreContour, bareScore, meterOf } from '../../components/syncedScore';
import { showModal, closeModal, renderModalBody, alertModal } from '../../components/modal';
import { qualityColour, faded } from '../../components/followColour';
import { CloudIcon } from '../../components/icons';
import { t } from '../../services/i18nService';
import {
  mountScoreFollow, alignedVerdict, failureText, settingOfVersion, stageText, type FollowTarget,
} from './ScoreFollowView';

// ── Which of a card's recordings the score follows ───────────────────────────
// The part of components/cardAudioSync.ts loaded when it is used: the chooser
// for a card with several recordings, and the follow itself (ScoreFollowView,
// the whole recording as its target).
//
// The chooser lists them; one is picked by a press. "Compare" (2026-10-31,
// the user) aligns the score on to each in turn — the whole of each, the
// tempo found on a stretch then held loosely, as for a detection — and sorts
// them from the best aligned to the worst, each with its figure. It chooses
// none: the figure is one thing more to go by, against a press. The user
// waits for it, its button filling as a progress bar (each recording by its
// weight), and pressed again it is cancelled; a recording only on Drive comes
// down for it. An
// alignment made stays known to the page (scoreFollowClient), so the one
// then picked is followed at once.

const RECORDING: FollowTarget = { kind: 'recording' };

/** Which recording, for the alignments kept: two files of one size are not
 *  the same one. */
function recordingId(att: FileAttachment): string {
  return att.external?.id ?? `${att.name}|${att.data.length}`;
}

/** Each recording's bytes, asked once per opening of the viewer: another
 *  version is the same recording, and so is the one picked after comparing. */
const fetched = new WeakMap<FileAttachment, Promise<Blob>>();
function recordingBlob(att: FileAttachment): Promise<Blob> {
  let blob = fetched.get(att);
  if (!blob) {
    // Opening it is a gesture: Drive may ask for its token.
    blob = attachmentBlob(att, true);
    fetched.set(att, blob);
    blob.catch(() => fetched.delete(att));
  }
  return blob;
}

/** Why a recording could not be had, as opening it would say
 *  (withResolvedEntry) — its keys spelled out, so the i18n test sees them. */
function missingText(e: unknown, name: string): { title: string; message: string } {
  if (e instanceof AttachmentNotHere) {
    switch (e.reason) {
      case 'not-uploaded': return { title: t('attachment.missing.not-uploaded.title'), message: t('attachment.missing.not-uploaded.message', { name }) };
      case 'offline': return { title: t('attachment.missing.offline.title'), message: t('attachment.missing.offline.message', { name }) };
      case 'gone': return { title: t('attachment.missing.gone.title'), message: t('attachment.missing.gone.message', { name }) };
    }
  }
  return { title: t('attachment.failed.title'), message: t('attachment.failed.message', { name }) };
}

/** The recording as the follow reads it — or undefined, having said why. */
async function recordingAudio(att: FileAttachment): Promise<FollowAudio | undefined> {
  try {
    return { blob: await recordingBlob(att), start: 0, id: recordingId(att) };
  } catch (e) {
    if (!(e instanceof AttachmentNotHere)) console.warn('[audio-sync] could not resolve ' + att.name, e);
    const { title, message } = missingText(e, att.name);
    alertModal(title, message);
    return undefined;
  }
}

/** Whether this device holds the recording's bytes. */
async function isHere(att: FileAttachment): Promise<boolean> {
  if (!att.external) return true;
  try { return !!(await getAttachmentBlob(att.external.id)); } catch { return false; }
}

type RowState =
  | { kind: 'idle' }
  | { kind: 'working'; status: FollowStatus | null }
  | { kind: 'done'; verdict: AudioSyncState }
  | { kind: 'failed'; text: string };

/** Where a row sorts once compared: its share of notes on the score, an
 *  alignment of a part only below every figure, a failure last. */
function rank(s: RowState): number {
  if (s.kind === 'done') return s.verdict.kind !== 'aligning' && s.verdict.percent !== undefined ? s.verdict.percent : -1;
  return -2;
}

/** Bytes a recording weighs — its share of the compare's progress bar. */
function weightOf(att: FileAttachment): number {
  return att.external?.bytes ?? Math.floor((att.data.length * 3) / 4);
}

/** Settles when `signal` aborts: followAudio, stopped, never does. */
function aborted(signal: AbortSignal): Promise<'aborted'> {
  return new Promise((resolve) => {
    if (signal.aborted) resolve('aborted');
    else signal.addEventListener('abort', () => resolve('aborted'), { once: true });
  });
}

function RecordingChooser({ recordings, version, stop, onPick }: {
  recordings: FileAttachment[];
  /** The version on the viewer's screen, the one compared. */
  version: string;
  stop: AbortSignal;
  onPick: (att: FileAttachment) => void;
}) {
  const [states, setStates] = useState<RowState[]>(() => recordings.map(() => ({ kind: 'idle' })));
  const [order, setOrder] = useState<number[]>(() => recordings.map((_, i) => i));
  /** The compare under way — pressed again, it is cancelled. */
  const run = useRef<AbortController | null>(null);
  /** How far the compare has gone, 0–1, each recording counted by its weight. */
  const [progress, setProgress] = useState<number | null>(null);
  const [here, setHere] = useState<boolean[] | null>(null);
  useEffect(() => { void Promise.all(recordings.map(isHere)).then(setHere); }, []);

  const setRow = (i: number, s: RowState) => setStates(prev => prev.map((p, k) => (k === i ? s : p)));

  const compare = async () => {
    const own = new AbortController();
    run.current = own;
    const cut = own.signal;
    // The dialog closed: the compare goes with it.
    stop.addEventListener('abort', () => own.abort(), { once: true });
    const weights = recordings.map(weightOf);
    const total = weights.reduce((a, b) => a + b, 0);
    const share = (i: number) => (total > 0 ? weights[i]! / total : 1 / recordings.length);
    let before = 0;
    setProgress(0);
    const done: RowState[] = recordings.map(() => ({ kind: 'idle' }));
    const contour = await scoreContour(bareScore(version), meterOf(version));
    for (let i = 0; i < recordings.length && !cut.aborted; i++) {
      const att = recordings[i]!;
      let row: RowState;
      if (!contour) {
        row = { kind: 'failed', text: failureText('no_contour') };
      } else {
        setRow(i, { kind: 'working', status: null });
        try {
          const blob = await Promise.race([recordingBlob(att), aborted(cut)]);
          if (blob === 'aborted') break;
          const result = await Promise.race([
            followAudio({ blob, start: 0, id: recordingId(att) }, contour, settingOfVersion(version), null,
              (status) => {
                if (cut.aborted) return;
                setRow(i, { kind: 'working', status });
                setProgress(before + share(i) * status.ratio);
              }, cut),
            aborted(cut),
          ]);
          if (result === 'aborted') break;
          row = typeof result === 'string' ? { kind: 'failed', text: failureText(result) } : { kind: 'done', verdict: alignedVerdict(result, RECORDING) };
        } catch (e) {
          if (cut.aborted) break;
          if (!(e instanceof AttachmentNotHere)) console.warn('[audio-sync] could not compare ' + att.name, e);
          row = { kind: 'failed', text: e instanceof AttachmentNotHere ? missingText(e, att.name).title : failureText('error') };
        }
      }
      done[i] = row;
      setRow(i, row);
      before += share(i);
      setProgress(before);
    }
    if (stop.aborted) return;
    if (run.current === own) { run.current = null; setProgress(null); }
    if (cut.aborted) {
      // Cancelled: what was compared stays, the recording under way is not.
      setStates(prev => prev.map(s => (s.kind === 'working' ? { kind: 'idle' } : s)));
      return;
    }
    setOrder(recordings.map((_, i) => i).sort((a, b) => rank(done[b]!) - rank(done[a]!)));
  };

  const comparing = progress !== null;
  // The best figure so far is set in a pill.
  const best = Math.max(-1, ...states.map(rank));
  return (
    <div class="space-y-3">
      <p class="text-sm text-muted leading-relaxed">{t('cardAudioSync.intro')}</p>
      <div class="space-y-2">
        {order.map((i) => {
          const att = recordings[i]!;
          const s = states[i]!;
          return (
            <button
              key={i}
              type="button"
              class="flex items-center gap-3 w-full px-4 py-3 rounded-xl border border-border bg-bg text-left cursor-pointer transition-colors hoverable:border-accent"
              onClick={() => onPick(att)}
            >
              <span class="flex-1 min-w-0 flex items-center gap-1.5">
                <span class="text-sm font-medium text-primary truncate">{att.name}</span>
                {here && !here[i] && <span class="inline-flex items-center shrink-0 text-dim" title={t('cardAudioSync.onDrive')}><CloudIcon size={12} /></span>}
              </span>
              <RowFigure state={s} best={best >= 0 && rank(s) === best} />
            </button>
          );
        })}
      </div>
      <button
        type="button"
        class="btn-soft w-full relative overflow-hidden"
        onClick={() => { if (run.current) run.current.abort(); else void compare(); }}
      >
        {comparing && (
          <span
            class="absolute inset-y-0 left-0 bg-accent/30 transition-[width] duration-300 pointer-events-none"
            style={{ width: `${Math.round(progress * 100)}%` }}
          />
        )}
        <span class="relative">{comparing ? t('cardAudioSync.comparing') : t('cardAudioSync.compare')}</span>
      </button>
    </div>
  );
}

/** A row's end: how far its alignment has gone, then how well it fits — the
 *  toggle's colours and words (AudioSyncState). */
function RowFigure({ state, best }: { state: RowState; best: boolean }) {
  if (state.kind === 'idle') return null;
  if (state.kind === 'working') {
    const ratio = state.status?.ratio ?? 0;
    return <span class="shrink-0 text-xs text-accent font-mono" title={stageText(state.status)}>{Math.round(ratio * 100)} %</span>;
  }
  if (state.kind === 'failed') return <span class="shrink-0 text-xs text-danger max-w-[45%] text-right">{state.text}</span>;
  const v = state.verdict;
  const percent = v.kind !== 'aligning' ? v.percent : undefined;
  const colour = percent !== undefined ? qualityColour(percent / 100) : 'var(--color-danger)';
  // The best one in a pill of its colour: white on amber would not read, so
  // the pill is its colour faded, the figure the colour itself.
  return (
    <span
      class={`shrink-0 text-xs font-mono font-medium ${best ? 'px-2 py-0.5 rounded-full border' : ''}`}
      style={best ? { color: colour, borderColor: colour, background: faded(colour, 0.15) } : { color: colour }}
      title={v.title}
    >
      {percent !== undefined ? `${percent} %` : '—'}
    </span>
  );
}

/** Which of `recordings` to follow `version` with, or null when the question
 *  was walked away from. */
export function chooseRecording(recordings: FileAttachment[], version: string): Promise<FileAttachment | null> {
  return new Promise((resolve) => {
    const stop = new AbortController();
    let settled = false;
    // A comparison still running goes with the dialog: its worker is stopped.
    const finish = (att: FileAttachment | null) => {
      if (settled) return;
      settled = true;
      stop.abort();
      resolve(att);
    };
    let leave = () => {};
    const { el, cleanup } = renderModalBody(
      <RecordingChooser recordings={recordings} version={version} stop={stop.signal} onPick={(att) => { leave(); finish(att); }} />,
    );
    // closeModal only pops: the body is unmounted here, as onDismiss would.
    leave = () => { closeModal(); cleanup(); };
    showModal(t('fileViewer.abc.audioSync'), el, [], { onDismiss: () => { cleanup(); finish(null); } });
  });
}

/** The follow of `att`, the whole recording, in the viewer's `host`. */
export function mountRecordingFollow(host: HTMLElement, att: FileAttachment, opts: {
  version: string;
  face: 'sheet' | 'text';
  expanded: boolean;
  onState: (s: AudioSyncState) => void;
  forced: boolean;
}): AudioSyncView {
  return mountScoreFollow(host, { ...opts, target: RECORDING, getAudio: () => recordingAudio(att) });
}
